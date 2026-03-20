"""
Claude AI analyzer module.
Uses Claude to estimate probabilities for Polymarket prediction markets.
"""

import logging
import os
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

import anthropic

from .market_client import Market

logger = logging.getLogger(__name__)

ANALYSIS_PROMPT = """\
You are a prediction market analyst. Your job is to estimate the true probability
of a binary outcome for a Polymarket prediction market question.

Today's date: {today}

Market Question:
{question}

Market Description:
{description}

Market End Date: {end_date}

Current Market Prices:
- YES: {yes_price:.1%} (market's implied probability)
- NO:  {no_price:.1%}

Your task:
1. Think carefully about the question based on current world knowledge.
2. Estimate the TRUE probability that YES resolves (0.0 to 1.0).
3. Identify your confidence level: LOW, MEDIUM, or HIGH.
4. Briefly explain your reasoning (2-4 sentences max).
5. Flag if you have insufficient knowledge to analyze this market.

Respond ONLY in this exact JSON format (no markdown, no extra text):
{{
  "yes_probability": <float 0.0-1.0>,
  "confidence": "<LOW|MEDIUM|HIGH>",
  "reasoning": "<your reasoning>",
  "insufficient_knowledge": <true|false>
}}
"""


@dataclass
class Analysis:
    market: Market
    yes_probability: float
    confidence: str  # LOW, MEDIUM, HIGH
    reasoning: str
    insufficient_knowledge: bool
    edge: float  # yes_probability - market yes_price (positive = market underpricing YES)

    @property
    def trade_signal(self) -> Optional[str]:
        """Returns 'BUY_YES', 'BUY_NO', or None."""
        if self.insufficient_knowledge:
            return None
        if self.confidence == "LOW":
            return None
        if self.edge > 0:
            return "BUY_YES"
        if self.edge < 0:
            return "BUY_NO"
        return None

    def __str__(self) -> str:
        signal = self.trade_signal or "PASS"
        return (
            f"Question: {self.market.question[:80]}\n"
            f"  Market YES: {self.market.yes_price:.1%}  |  "
            f"Claude YES: {self.yes_probability:.1%}  |  "
            f"Edge: {self.edge:+.1%}  |  "
            f"Confidence: {self.confidence}  |  Signal: {signal}\n"
            f"  Reasoning: {self.reasoning}"
        )


class ClaudeAnalyzer:
    """Uses Claude to analyze Polymarket prediction markets."""

    def __init__(
        self,
        api_key: Optional[str] = None,
        model: str = "claude-sonnet-4-6",
    ):
        self.model = model
        self.client = anthropic.Anthropic(
            api_key=api_key or os.getenv("ANTHROPIC_API_KEY")
        )

    def analyze_market(self, market: Market) -> Optional[Analysis]:
        """
        Ask Claude to estimate the probability for a market.
        Returns None if analysis fails.
        """
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        prompt = ANALYSIS_PROMPT.format(
            today=today,
            question=market.question,
            description=market.description or "No description provided.",
            end_date=market.end_date or "Unknown",
            yes_price=market.yes_price,
            no_price=market.no_price,
        )

        try:
            message = self.client.messages.create(
                model=self.model,
                max_tokens=512,
                messages=[{"role": "user", "content": prompt}],
            )
        except anthropic.APIError as e:
            logger.error("Claude API error for market %s: %s", market.condition_id[:8], e)
            return None

        raw = message.content[0].text.strip()
        return self._parse_response(raw, market)

    def _parse_response(self, raw: str, market: Market) -> Optional[Analysis]:
        """Parse Claude's JSON response into an Analysis object."""
        import json

        # Strip markdown code fences if present
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]

        try:
            data = json.loads(raw)
        except json.JSONDecodeError as e:
            logger.warning("Failed to parse Claude response as JSON: %s\nRaw: %s", e, raw[:200])
            return None

        yes_prob = float(data.get("yes_probability", -1))
        if not (0.0 <= yes_prob <= 1.0):
            logger.warning("Invalid yes_probability from Claude: %s", yes_prob)
            return None

        confidence = data.get("confidence", "LOW").upper()
        if confidence not in ("LOW", "MEDIUM", "HIGH"):
            confidence = "LOW"

        return Analysis(
            market=market,
            yes_probability=yes_prob,
            confidence=confidence,
            reasoning=data.get("reasoning", ""),
            insufficient_knowledge=bool(data.get("insufficient_knowledge", False)),
            edge=yes_prob - market.yes_price,
        )

    def analyze_markets_batch(
        self,
        markets: list[Market],
        progress_callback=None,
    ) -> list[Analysis]:
        """
        Analyze a list of markets sequentially.
        Returns only successfully analyzed markets.
        """
        results = []
        for i, market in enumerate(markets):
            logger.debug("Analyzing market %d/%d: %s", i + 1, len(markets), market.question[:60])
            analysis = self.analyze_market(market)
            if analysis is not None:
                results.append(analysis)
            if progress_callback:
                progress_callback(i + 1, len(markets), analysis)
        return results
