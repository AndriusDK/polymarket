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
            from py_clob_client_v2 import ClobClient, ApiCreds
        except ImportError:
            raise RuntimeError(
                "py-clob-client-v2 is not installed. Run: pip install py-clob-client-v2"
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
        entry_price: float | None = None,
        max_slippage: float = 0.05,  # reject fills more than 5% worse than quoted price
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
            from py_clob_client_v2 import (
                MarketOrderArgs, OrderType, PartialCreateOrderOptions,
                BalanceAllowanceParams, AssetType, Side,
            )
        except ImportError:
            raise RuntimeError("py-clob-client-v2 is not installed. Run: pip install py-clob-client-v2")

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

        # Price limit: cap slippage so we get "no match" instead of a terrible fill.
        # BUY limit  = entry_price + max_slippage  (don't pay more than this)
        # SELL limit = entry_price - max_slippage  (don't accept less than this)
        price_limit = None
        if entry_price is not None and 0 < entry_price < 1:
            if side.upper() == "BUY":
                price_limit = round(min(entry_price + max_slippage, 0.92), 4)
            else:
                price_limit = round(max(entry_price - max_slippage, 0.03), 4)
            logger.info("%s price limit: %.4f (quoted %.4f, max slippage %.0f%%)",
                        side, price_limit, entry_price, max_slippage * 100)

        # FOK retry strategy: if the full order can't be filled at the price limit,
        # progressively widen the limit — never drop it entirely to avoid fills at
        # catastrophically bad prices (e.g. BUY at 81% quote → fills at 98% on retry).
        side_enum = Side.BUY if side.upper() == "BUY" else Side.SELL
        if side.upper() == "BUY":
            # Hard cap: never pay more than entry + 10%, absolute max 90%.
            # At 90%+ the risk/reward collapses — 10% left to make vs 90% to lose.
            hard_cap = round(min((entry_price or 0.80) + 0.10, 0.90), 4)
            retry_configs = [
                (amount_usdc,        price_limit),   # 1st: full size, entry + 5%
                (amount_usdc * 0.5,  price_limit),   # 2nd: half size, same price — thin book
                (amount_usdc * 0.5,  hard_cap),      # 3rd: half size, entry + 10% — widen price
                (1.00,               hard_cap),      # 4th: $1 minimum — last resort, any tiny fill beats nothing
            ]
        else:
            # SELL: progressively widen the floor — never go completely unlimited
            # to avoid exit fills at near-zero prices in thin books.
            def _sell_limit(pct_below):
                if entry_price is None:
                    return None
                return round(max(entry_price - pct_below, 0.03), 4)
            retry_configs = [
                (amount_usdc,        price_limit),          # 1st: -8%  floor
                (amount_usdc,        _sell_limit(0.18)),    # 2nd: -18% floor
                (amount_usdc * 0.75, _sell_limit(0.30)),    # 3rd: -30% floor, 75% size
                (amount_usdc * 0.5,  _sell_limit(0.40)),    # 4th: -40% floor, 50% size
            ]

        last_error = None
        for attempt_num, (attempt_amount, attempt_limit) in enumerate(retry_configs):
            try:
                if attempt_num > 0:
                    logger.info(
                        "FOK retry #%d: amount=%.4f limit=%s",
                        attempt_num, attempt_amount, attempt_limit,
                    )
                order_args = MarketOrderArgs(
                    token_id=token_id,
                    amount=attempt_amount,
                    side=side_enum,
                    price=attempt_limit if attempt_limit is not None else 0,
                    order_type=OrderType.FOK,
                )
                response = client.create_and_post_market_order(
                    order_args=order_args,
                    options=PartialCreateOrderOptions(tick_size="0.01"),
                    order_type=OrderType.FOK,
                )
                logger.info("Order placed: %s", response)
                return response
            except Exception as e:
                err_str = str(e).lower()
                if "fully filled" in err_str or "fok" in err_str:
                    last_error = e
                    logger.warning("FOK attempt #%d failed: %s", attempt_num, e)
                    continue
                raise  # non-FOK error, propagate immediately

        raise last_error  # all retries exhausted

    def place_limit_order(
        self,
        token_id: str,
        side: str,            # "BUY" or "SELL"
        price: float,         # 0 < price < 1
        size: float,          # number of shares (not USDC)
    ) -> dict:
        """
        Post a GTC (Good-Till-Cancelled) maker limit order. Sits in the book
        until filled or cancelled. Used by trend-sweep mode to pre-position
        bids at fair value before the market reprices. Also used for SELL exits.
        """
        try:
            from py_clob_client_v2 import (
                OrderArgs, OrderType, PartialCreateOrderOptions, Side,
                BalanceAllowanceParams, AssetType,
            )
        except ImportError:
            raise RuntimeError("py-clob-client-v2 is not installed. Run: pip install py-clob-client-v2")

        if not (0 < price < 1):
            raise ValueError(f"price must be between 0 and 1, got {price}")
        if size <= 0:
            raise ValueError(f"size must be positive, got {size}")

        client = self._get_clob_client()

        if side.upper() == "SELL":
            # Cap sell size to actual on-chain token balance to avoid "insufficient balance" errors.
            try:
                bal = client.get_balance_allowance(params=BalanceAllowanceParams(
                    asset_type=AssetType.CONDITIONAL,
                    token_id=token_id,
                    signature_type=0,
                ))
                actual_shares = float(bal.get("balance", 0)) / 1e6
                if actual_shares > 0:
                    logger.info("SELL GTC: on-chain balance %.6f, requested %.6f", actual_shares, size)
                    size = min(size, round(actual_shares, 4))
                else:
                    logger.warning("SELL GTC: on-chain balance is 0, using requested size %.4f", size)
            except Exception as e:
                logger.warning("SELL GTC: balance lookup failed (%s), using requested size", e)
        else:
            size = max(size, 5.0)  # Polymarket minimum: 5 shares per limit order

        side_enum = Side.BUY if side.upper() == "BUY" else Side.SELL

        response = client.create_and_post_order(
            order_args=OrderArgs(
                token_id=token_id,
                price=round(price, 4),
                size=round(size, 4),
                side=side_enum,
            ),
            options=PartialCreateOrderOptions(tick_size="0.01"),
            order_type=OrderType.GTC,
        )
        logger.info("GTC limit order placed: %s @ %.4f x %.4f → %s", side, price, size, response)
        return response

    def cancel_order(self, order_id: str) -> dict:
        """Cancel a single open order by ID."""
        client = self._get_clob_client()
        try:
            response = client.cancel(order_id=order_id)
            logger.info("Cancelled order %s: %s", order_id[:12], response)
            return response
        except Exception as e:
            logger.warning("Cancel failed for %s: %s", order_id[:12], e)
            raise

    def get_order(self, order_id: str) -> dict:
        """Fetch the live status of a single order (for fill polling)."""
        client = self._get_clob_client()
        try:
            return client.get_order(order_id=order_id)
        except Exception as e:
            logger.warning("get_order failed for %s: %s", order_id[:12], e)
            raise

    def get_avg_fill_price(
        self,
        order_id: str,
        token_id: str,
        after_sec: int = 0,
    ) -> Optional[float]:
        """
        Query trades for the asset after a given timestamp and compute the
        size-weighted avg fill price for our order. Used to record correct
        entry price for GTC maker bids that get price improvement.

        Matches by order_id (maker or taker side) — never falls back to
        unrelated trades, since that produced bogus "fill prices" equal to
        the recent market average instead of our actual fill.
        """
        try:
            from py_clob_client_v2 import TradeParams
        except ImportError:
            return None

        client = self._get_clob_client()

        # Derive our wallet address — needed to filter trades reliably and to
        # tell which side of each trade is ours. Don't rely on the client's
        # get_address() (may not exist on this lib version).
        my_addr = None
        try:
            from eth_account import Account
            if self.private_key:
                my_addr = Account.from_key(self.private_key).address.lower()
        except Exception as e:
            logger.warning("could not derive wallet address: %s", e)

        params = TradeParams(
            asset_id=token_id,
            after=int(after_sec) if after_sec else None,
        )
        try:
            trades = client.get_trades(params=params)
        except Exception as e:
            logger.warning("get_trades failed: %s", e)
            return None
        if not trades:
            logger.info("no trades returned for order %s", order_id[:12])
            return None

        # Log a sample so we can verify field names in the wild.
        try:
            sample = trades[0] if isinstance(trades, list) and trades else trades
            logger.info("get_trades returned %d trades for order %s; sample keys: %s",
                        len(trades) if isinstance(trades, list) else 1,
                        order_id[:12],
                        list(sample.keys())[:30] if isinstance(sample, dict) else type(sample).__name__)
        except Exception:
            pass

        def _norm(v):
            return str(v).lower() if v else ""

        order_id_l = _norm(order_id)
        matched = []
        for t in trades:
            if not isinstance(t, dict):
                continue
            ids = [
                _norm(t.get("maker_order_id")),  _norm(t.get("makerOrderId")),
                _norm(t.get("taker_order_id")),  _norm(t.get("takerOrderId")),
                _norm(t.get("order_id")),        _norm(t.get("orderId")),
            ]
            # Also check nested maker_orders list (some APIs return per-maker fills)
            for sub in (t.get("maker_orders") or t.get("makerOrders") or []):
                if isinstance(sub, dict):
                    ids.append(_norm(sub.get("order_id") or sub.get("orderId") or sub.get("maker_order_id")))
            if order_id_l in ids:
                matched.append(t)

        # If still nothing, fall back to address-matched trades.
        if not matched and my_addr:
            for t in trades:
                if not isinstance(t, dict):
                    continue
                addrs = [
                    _norm(t.get("maker_address")), _norm(t.get("makerAddress")),
                    _norm(t.get("taker_address")), _norm(t.get("takerAddress")),
                    _norm(t.get("owner")),
                ]
                for sub in (t.get("maker_orders") or t.get("makerOrders") or []):
                    if isinstance(sub, dict):
                        addrs.append(_norm(sub.get("maker_address") or sub.get("owner")))
                if my_addr in addrs:
                    matched.append(t)

        if not matched:
            logger.warning("no trades matched order %s or our address — fill price unknown", order_id[:12])
            return None

        total_usdc = 0.0
        total_shares = 0.0
        for t in matched:
            try:
                p = float(t.get("price", 0) or 0)
                s = float(t.get("size", 0) or t.get("matched_size", 0) or t.get("matchedSize", 0) or 0)
            except (TypeError, ValueError):
                continue
            # Also support per-maker fills (each sub-fill has its own price/size)
            sub_used = False
            for sub in (t.get("maker_orders") or t.get("makerOrders") or []):
                if not isinstance(sub, dict):
                    continue
                try:
                    sp = float(sub.get("price", 0) or 0)
                    ss = float(sub.get("matched_amount", 0) or sub.get("size", 0) or 0)
                except (TypeError, ValueError):
                    continue
                if 0 < sp < 1 and ss > 0:
                    total_usdc += sp * ss
                    total_shares += ss
                    sub_used = True
            if not sub_used and 0 < p < 1 and s > 0:
                total_usdc += p * s
                total_shares += s

        if total_shares > 0:
            avg = total_usdc / total_shares
            logger.info("avg fill price for order %s: %.4f over %.4f shares (matched %d trades)",
                        order_id[:12], avg, total_shares, len(matched))
            return avg
        return None
