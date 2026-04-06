"""
Trading bot core logic.
Orchestrates market fetching, AI analysis, and order execution.
"""

import logging
import os
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from .analyzer import Analysis, ClaudeAnalyzer
from .market_client import Market, PolymarketClient

logger = logging.getLogger(__name__)


@dataclass
class BotConfig:
    # Risk management
    max_bet_usdc: float = 10.0
    min_edge: float = 0.05          # Minimum 5% edge to trade
    min_confidence: str = "MEDIUM"  # Minimum confidence level
    max_daily_spend_usdc: float = 100.0

    # Market filtering
    markets_to_analyze: int = 20
    min_volume: float = 10_000
    min_liquidity: float = 1_000

    # Execution
    dry_run: bool = True
    sleep_between_analyses: float = 1.0  # seconds, to avoid rate limits

    # Model
    claude_model: str = "claude-sonnet-4-6"

    @classmethod
    def from_env(cls) -> "BotConfig":
        return cls(
            max_bet_usdc=float(os.getenv("MAX_BET_USDC", 10.0)),
            min_edge=float(os.getenv("MIN_EDGE", 0.05)),
            max_daily_spend_usdc=float(os.getenv("MAX_DAILY_SPEND_USDC", 100.0)),
            dry_run=os.getenv("DRY_RUN", "true").lower() != "false",
            claude_model=os.getenv("CLAUDE_MODEL", "claude-sonnet-4-6"),
        )


@dataclass
class TradeRecord:
    timestamp: str
    market_question: str
    signal: str  # BUY_YES or BUY_NO
    token_id: str
    amount_usdc: float
    market_price: float
    claude_probability: float
    edge: float
    confidence: str
    reasoning: str
    dry_run: bool
    result: dict = field(default_factory=dict)


@dataclass
class RunSummary:
    markets_fetched: int = 0
    markets_analyzed: int = 0
    opportunities_found: int = 0
    trades_placed: int = 0
    total_spent_usdc: float = 0.0
    skipped_budget: int = 0
    trades: list[TradeRecord] = field(default_factory=list)

    def __str__(self) -> str:
        mode = "DRY RUN" if any(t.dry_run for t in self.trades) else "LIVE"
        return (
            f"\n{'='*60}\n"
            f"  RUN SUMMARY [{mode}]\n"
            f"{'='*60}\n"
            f"  Markets fetched:      {self.markets_fetched}\n"
            f"  Markets analyzed:     {self.markets_analyzed}\n"
            f"  Opportunities found:  {self.opportunities_found}\n"
            f"  Trades placed:        {self.trades_placed}\n"
            f"  Total spent (USDC):   ${self.total_spent_usdc:.2f}\n"
            f"{'='*60}"
        )


class TradingBot:
    """
    AI-powered Polymarket trading bot.

    Workflow:
    1. Fetch active markets from Polymarket
    2. Ask Claude to estimate probability for each market
    3. If Claude's estimate differs from market price by > min_edge → trade
    4. Apply risk management (position sizing, daily budget)
    """

    CONFIDENCE_RANK = {"LOW": 0, "MEDIUM": 1, "HIGH": 2}

    def __init__(self, config: BotConfig):
        self.config = config
        self.poly = PolymarketClient()
        self.analyzer = ClaudeAnalyzer(model=config.claude_model)
        self._daily_spent = 0.0

    def run(self) -> RunSummary:
        """Execute one full bot cycle."""
        summary = RunSummary()
        now = datetime.now(timezone.utc).isoformat()

        logger.info(
            "Bot starting at %s | dry_run=%s, max_bet=$%.0f, min_edge=%.0f%%, model=%s",
            now, self.config.dry_run, self.config.max_bet_usdc,
            self.config.min_edge * 100, self.config.claude_model,
        )

        # 1. Fetch markets
        markets = self.poly.get_active_markets(
            limit=self.config.markets_to_analyze,
            min_volume=self.config.min_volume,
            min_liquidity=self.config.min_liquidity,
        )
        summary.markets_fetched = len(markets)
        if not markets:
            logger.warning("No markets found. Exiting.")
            return summary

        # 2. Analyze markets with Claude
        logger.info("Analyzing %d markets with Claude...", len(markets))
        analyses = self._analyze_with_progress(markets, summary)
        summary.markets_analyzed = len(analyses)

        # 3. Find trading opportunities
        opportunities = self._filter_opportunities(analyses)
        summary.opportunities_found = len(opportunities)

        if not opportunities:
            logger.info("No trading opportunities found this cycle.")
            return summary

        logger.info("Found %d opportunities. Evaluating trades...", len(opportunities))

        # 4. Execute trades
        for analysis in opportunities:
            if self._daily_spent >= self.config.max_daily_spend_usdc:
                logger.warning("Daily budget exhausted ($%.2f). Stopping.", self._daily_spent)
                summary.skipped_budget += 1
                continue

            record = self._execute_trade(analysis)
            if record:
                summary.trades.append(record)
                summary.trades_placed += 1
                summary.total_spent_usdc += record.amount_usdc
                self._daily_spent += record.amount_usdc

        return summary

    def _analyze_with_progress(
        self, markets: list[Market], summary: RunSummary
    ) -> list[Analysis]:
        """Run analysis with logging progress."""
        results = []
        for i, market in enumerate(markets, 1):
            logger.debug(
                "  [%d/%d] Analyzing: %s",
                i, len(markets), market.question[:70]
            )
            analysis = self.analyzer.analyze_market(market)
            if analysis:
                results.append(analysis)
                logger.debug(
                    "         Claude: YES=%.1f%%  Market: YES=%.1f%%  "
                    "Edge=%+.1f%%  Conf=%s",
                    analysis.yes_probability * 100,
                    market.yes_price * 100,
                    analysis.edge * 100,
                    analysis.confidence,
                )

            if i < len(markets):
                time.sleep(self.config.sleep_between_analyses)

        logger.info("Analyzed %d/%d markets.", len(results), len(markets))
        return results

    def _filter_opportunities(self, analyses: list[Analysis]) -> list[Analysis]:
        """Filter analyses to those worth trading, sorted by edge descending."""
        min_conf_rank = self.CONFIDENCE_RANK.get(self.config.min_confidence, 1)

        opportunities = [
            a for a in analyses
            if (
                not a.insufficient_knowledge
                and a.trade_signal is not None
                and abs(a.edge) >= self.config.min_edge
                and self.CONFIDENCE_RANK.get(a.confidence, 0) >= min_conf_rank
            )
        ]
        # Sort by absolute edge descending (best opportunities first)
        opportunities.sort(key=lambda a: abs(a.edge), reverse=True)
        return opportunities

    def _size_bet(self, analysis: Analysis) -> float:
        """
        Kelly-inspired position sizing.
        Uses a fraction of max_bet proportional to confidence and edge.
        """
        edge = abs(analysis.edge)
        conf_multiplier = {"LOW": 0.25, "MEDIUM": 0.6, "HIGH": 1.0}.get(
            analysis.confidence, 0.5
        )
        # Scale bet: full size at 20%+ edge, smaller for smaller edges
        edge_multiplier = min(edge / 0.20, 1.0)
        bet = self.config.max_bet_usdc * conf_multiplier * edge_multiplier

        # Also cap by remaining daily budget
        remaining = self.config.max_daily_spend_usdc - self._daily_spent
        return round(min(bet, remaining), 2)

    def _execute_trade(self, analysis: Analysis) -> TradeRecord | None:
        """Size and place a single trade."""
        signal = analysis.trade_signal  # BUY_YES or BUY_NO
        if signal is None:
            return None

        amount = self._size_bet(analysis)
        if amount < 1.0:
            logger.info("Bet size too small ($%.2f), skipping.", amount)
            return None

        market = analysis.market
        if signal == "BUY_YES":
            token_id = market.yes_token_id
            market_price = market.yes_price
        else:
            token_id = market.no_token_id
            market_price = market.no_price

        logger.info(
            "  TRADE: %s $%.2f of %s | Edge=%+.1f%% | Conf=%s",
            signal, amount, market.question[:60],
            analysis.edge * 100, analysis.confidence,
        )

        result = self.poly.place_market_order(
            token_id=token_id,
            side="BUY",
            amount_usdc=amount,
            dry_run=self.config.dry_run,
        )

        return TradeRecord(
            timestamp=datetime.now(timezone.utc).isoformat(),
            market_question=market.question,
            signal=signal,
            token_id=token_id,
            amount_usdc=amount,
            market_price=market_price,
            claude_probability=analysis.yes_probability,
            edge=analysis.edge,
            confidence=analysis.confidence,
            reasoning=analysis.reasoning,
            dry_run=self.config.dry_run,
            result=result,
        )
