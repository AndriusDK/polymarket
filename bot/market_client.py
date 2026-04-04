"""
Polymarket CLOB API client wrapper.
Handles market discovery, order book fetching, and order placement.
"""

import logging
import os
from dataclasses import dataclass
from typing import Optional

import requests

logger = logging.getLogger(__name__)

GAMMA_API = "https://gamma-api.polymarket.com"
CLOB_API = "https://clob.polymarket.com"


@dataclass
class Market:
    condition_id: str
    question: str
    description: str
    end_date: str
    active: bool
    # YES token id
    yes_token_id: str
    # NO token id
    no_token_id: str
    # Current mid-price for YES (0-1)
    yes_price: float
    # Current mid-price for NO (0-1)
    no_price: float
    volume: float
    liquidity: float

    @property
    def implied_yes_prob(self) -> float:
        return self.yes_price

    def __str__(self) -> str:
        return (
            f"[{self.condition_id[:8]}...] {self.question[:80]}\n"
            f"  YES: {self.yes_price:.1%}  NO: {self.no_price:.1%}  "
            f"Volume: ${self.volume:,.0f}  Liquidity: ${self.liquidity:,.0f}"
        )


class PolymarketClient:
    """
    Thin wrapper around Polymarket APIs.

    - Gamma API: market metadata (no auth required)
    - CLOB API: order book prices and order placement (auth required for trading)
    """

    def __init__(
        self,
        api_key: Optional[str] = None,
        api_secret: Optional[str] = None,
        api_passphrase: Optional[str] = None,
        private_key: Optional[str] = None,
    ):
        self.api_key = api_key or os.getenv("POLY_API_KEY", "")
        self.api_secret = api_secret or os.getenv("POLY_API_SECRET", "")
        self.api_passphrase = api_passphrase or os.getenv("POLY_API_PASSPHRASE", "")
        self.private_key = private_key or os.getenv("POLY_PRIVATE_KEY", "")

        self._session = requests.Session()
        self._session.headers.update({"User-Agent": "polymarket-ai-bot/1.0"})

        # Lazy-load the py-clob-client only when trading is needed
        self._clob_client = None

    def _get_clob_client(self):
        """Initialize py-clob-client for authenticated operations."""
        if self._clob_client is not None:
            return self._clob_client

        if not self.private_key:
            raise RuntimeError(
                "POLY_PRIVATE_KEY is required for trading. "
                "Set it in your .env file."
            )

        try:
            from py_clob_client.client import ClobClient
            from py_clob_client.clob_types import ApiCreds
        except ImportError:
            raise RuntimeError(
                "py-clob-client is not installed. Run: pip install py-clob-client"
            )

        creds = ApiCreds(
            api_key=self.api_key,
            api_secret=self.api_secret,
            api_passphrase=self.api_passphrase,
        )
        self._clob_client = ClobClient(
            host=CLOB_API,
            chain_id=137,  # Polygon mainnet
            key=self.private_key,
            creds=creds,
        )
        return self._clob_client

    # ------------------------------------------------------------------
    # Market Discovery
    # ------------------------------------------------------------------

    def get_active_markets(
        self,
        limit: int = 50,
        min_volume: float = 10_000,
        min_liquidity: float = 1_000,
    ) -> list[Market]:
        """
        Fetch active markets sorted by volume descending.
        Uses the Gamma metadata API (no auth required).
        """
        params = {
            "active": "true",
            "closed": "false",
            "limit": min(limit * 3, 300),  # fetch extra, filter below
            "_order": "volume",
            "volume_num_min": min_volume,
        }
        try:
            resp = self._session.get(f"{GAMMA_API}/markets", params=params, timeout=15)
            resp.raise_for_status()
        except requests.RequestException as e:
            logger.error("Failed to fetch markets from Gamma API: %s", e)
            return []

        raw_markets = resp.json()
        markets: list[Market] = []

        for raw in raw_markets:
            try:
                market = self._parse_gamma_market(raw)
            except Exception as e:
                logger.debug("Skipping market parse error: %s", e)
                continue

            if market is None:
                continue
            if market.liquidity < min_liquidity:
                continue

            markets.append(market)
            if len(markets) >= limit:
                break

        logger.info("Fetched %d active markets", len(markets))
        return markets

    def _parse_gamma_market(self, raw: dict) -> Optional[Market]:
        """Parse a single market dict from the Gamma API."""
        tokens = raw.get("tokens", [])
        if len(tokens) < 2:
            return None

        # Find YES and NO tokens
        yes_token = next((t for t in tokens if t.get("outcome", "").upper() == "YES"), None)
        no_token = next((t for t in tokens if t.get("outcome", "").upper() == "NO"), None)

        if yes_token is None or no_token is None:
            return None

        yes_price = float(yes_token.get("price", 0) or 0)
        no_price = float(no_token.get("price", 0) or 0)

        # Skip markets with no price data
        if yes_price == 0 and no_price == 0:
            return None

        return Market(
            condition_id=raw.get("conditionId", raw.get("id", "")),
            question=raw.get("question", ""),
            description=raw.get("description", ""),
            end_date=raw.get("endDate", raw.get("endDateIso", "")),
            active=raw.get("active", True),
            yes_token_id=yes_token.get("token_id", yes_token.get("tokenId", "")),
            no_token_id=no_token.get("token_id", no_token.get("tokenId", "")),
            yes_price=yes_price,
            no_price=no_price,
            volume=float(raw.get("volumeNum", raw.get("volume", 0)) or 0),
            liquidity=float(raw.get("liquidityNum", raw.get("liquidity", 0)) or 0),
        )

    def get_order_book(self, token_id: str) -> dict:
        """Fetch order book for a token from the CLOB API."""
        try:
            resp = self._session.get(
                f"{CLOB_API}/book",
                params={"token_id": token_id},
                timeout=10,
            )
            resp.raise_for_status()
            return resp.json()
        except requests.RequestException as e:
            logger.warning("Failed to fetch order book for %s: %s", token_id[:12], e)
            return {}

    def get_best_prices(self, token_id: str) -> tuple[float, float]:
        """
        Returns (best_bid, best_ask) for a token.
        Falls back to (0, 1) if unavailable.
        """
        book = self.get_order_book(token_id)
        bids = book.get("bids", [])
        asks = book.get("asks", [])

        best_bid = float(bids[0]["price"]) if bids else 0.0
        best_ask = float(asks[0]["price"]) if asks else 1.0

        return best_bid, best_ask

    # ------------------------------------------------------------------
    # Trading
    # ------------------------------------------------------------------

    def place_market_order(
        self,
        token_id: str,
        side: str,  # "BUY" or "SELL"
        amount_usdc: float,
        dry_run: bool = True,
    ) -> dict:
        """
        Place a market order.

        Args:
            token_id: The outcome token to trade.
            side: "BUY" to buy YES shares, "SELL" to sell.
            amount_usdc: Dollar amount to spend.
            dry_run: If True, simulates without placing a real order.

        Returns:
            Order response dict.
        """
        if dry_run:
            logger.info(
                "[DRY RUN] Would place %s order: $%.2f of token %s",
                side, amount_usdc, token_id[:16],
            )
            return {
                "status": "dry_run",
                "side": side,
                "amount_usdc": amount_usdc,
                "token_id": token_id,
            }

        try:
            from py_clob_client.clob_types import MarketOrderArgs, OrderType, BalanceAllowanceParams, AssetType
            from py_clob_client.order_builder.constants import BUY, SELL
        except ImportError:
            raise RuntimeError("py-clob-client is not installed.")

        client = self._get_clob_client()

        if side.upper() == "SELL":
            # Query actual on-chain token balance — takingAmount from buy is approximate
            try:
                params = BalanceAllowanceParams(
                    asset_type=AssetType.CONDITIONAL,
                    token_id=token_id,
                    signature_type=0,
                )
                bal = client.get_balance_allowance(params=params)
                actual_shares = float(bal.get("balance", 0)) / 1e6
                if actual_shares > 0:
                    logger.info("SELL: using actual token balance %.6f (requested %.6f)", actual_shares, amount_usdc)
                    amount_usdc = actual_shares
                else:
                    logger.warning("SELL: on-chain balance is 0, falling back to requested amount %.6f", amount_usdc)
            except Exception as e:
                logger.warning("SELL: could not fetch token balance (%s), using requested amount", e)

        order_args = MarketOrderArgs(
            token_id=token_id,
            amount=amount_usdc,  # USDC for BUY; actual token shares for SELL
            side=BUY if side.upper() == "BUY" else SELL,
        )
        signed_order = client.create_market_order(order_args)
        response = client.post_order(signed_order, OrderType.FOK)

        logger.info("Order placed: %s", response)
        return response
