#!/usr/bin/env python3
"""
Polymarket AI Trading Bot
=========================
Uses Claude to analyze prediction markets and place trades when it
detects mispriced probabilities.

Usage:
    python main.py              # single run, dry-run mode
    python main.py --live       # single run with real trades
    python main.py --loop 300   # repeat every 5 minutes (dry-run)
    python main.py --scan       # just scan & print opportunities, no trades
"""

import argparse
import json
import logging
import os
import sys
import time

from dotenv import load_dotenv
from rich.console import Console
from rich.table import Table
from rich import print as rprint

load_dotenv()

from bot.analyzer import ClaudeAnalyzer
from bot.market_client import PolymarketClient
from bot.trader import BotConfig, TradingBot

console = Console()


def setup_logging(level: str = "INFO") -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%H:%M:%S",
    )
    # Silence noisy third-party loggers
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    logging.getLogger("httpx").setLevel(logging.WARNING)


def print_banner() -> None:
    console.print(
        "\n[bold cyan]"
        "  ╔═══════════════════════════════════════╗\n"
        "  ║   Polymarket AI Trading Bot  🤖💰     ║\n"
        "  ║   Powered by Claude                   ║\n"
        "  ╚═══════════════════════════════════════╝"
        "[/bold cyan]\n"
    )


def print_opportunities_table(analyses) -> None:
    """Pretty-print a table of trading opportunities."""
    table = Table(title="Trading Opportunities", show_lines=True)
    table.add_column("Question", style="white", max_width=50)
    table.add_column("Market", justify="right")
    table.add_column("Claude", justify="right")
    table.add_column("Edge", justify="right")
    table.add_column("Conf", justify="center")
    table.add_column("Signal", justify="center")

    for a in analyses:
        edge_str = f"{a.edge:+.1%}"
        edge_color = "green" if a.edge > 0 else "red"
        signal = a.trade_signal or "PASS"
        signal_color = "green" if signal == "BUY_YES" else ("red" if signal == "BUY_NO" else "dim")

        table.add_row(
            a.market.question[:50],
            f"{a.market.yes_price:.1%}",
            f"{a.yes_probability:.1%}",
            f"[{edge_color}]{edge_str}[/{edge_color}]",
            a.confidence,
            f"[{signal_color}]{signal}[/{signal_color}]",
        )

    console.print(table)


def cmd_scan(args: argparse.Namespace) -> None:
    """Scan markets and print analysis without trading."""
    config = BotConfig.from_env()
    config.dry_run = True

    poly = PolymarketClient()
    analyzer = ClaudeAnalyzer(model=config.claude_model)

    console.print(f"[bold]Fetching top {config.markets_to_analyze} markets...[/bold]")
    markets = poly.get_active_markets(
        limit=config.markets_to_analyze,
        min_volume=config.min_volume,
        min_liquidity=config.min_liquidity,
    )
    console.print(f"  Found {len(markets)} markets\n")

    console.print("[bold]Analyzing with Claude...[/bold]")
    analyses = []
    for i, market in enumerate(markets, 1):
        console.print(f"  [{i}/{len(markets)}] {market.question[:70]}")
        analysis = analyzer.analyze_market(market)
        if analysis:
            analyses.append(analysis)

    print_opportunities_table(analyses)

    # Print reasoning for top opportunities
    opportunities = sorted(
        [a for a in analyses if abs(a.edge) >= config.min_edge],
        key=lambda a: abs(a.edge),
        reverse=True,
    )
    if opportunities:
        console.print("\n[bold yellow]Top Opportunities - Reasoning:[/bold yellow]")
        for a in opportunities[:5]:
            console.print(
                f"\n[cyan]{a.market.question[:80]}[/cyan]\n"
                f"  Edge: [{'green' if a.edge > 0 else 'red'}]{a.edge:+.1%}[/]\n"
                f"  {a.reasoning}"
            )


def cmd_run(args: argparse.Namespace) -> None:
    """Run a single bot cycle."""
    config = BotConfig.from_env()

    if args.live:
        config.dry_run = False
        console.print("[bold red]⚠  LIVE MODE - Real money will be spent![/bold red]")
    else:
        console.print("[bold yellow]DRY RUN mode - no real orders will be placed[/bold yellow]")

    bot = TradingBot(config)
    summary = bot.run()
    console.print(summary)

    if summary.trades:
        console.print("\n[bold]Trades this cycle:[/bold]")
        for t in summary.trades:
            color = "green" if t.signal == "BUY_YES" else "red"
            mode = "[DRY]" if t.dry_run else "[LIVE]"
            console.print(
                f"  {mode} [{color}]{t.signal}[/{color}] ${t.amount_usdc:.2f} — "
                f"{t.market_question[:60]}\n"
                f"       Edge: {t.edge:+.1%}  Conf: {t.confidence}\n"
                f"       {t.reasoning}"
            )


def cmd_loop(args: argparse.Namespace) -> None:
    """Run the bot in a loop every N seconds."""
    interval = args.loop
    console.print(
        f"[bold]Running bot every {interval}s. Press Ctrl+C to stop.[/bold]\n"
    )
    cycle = 0
    while True:
        cycle += 1
        console.rule(f"[cyan]Cycle {cycle}[/cyan]")
        cmd_run(args)
        console.print(f"\nSleeping {interval}s until next cycle...")
        time.sleep(interval)


def main() -> None:
    parser = argparse.ArgumentParser(
        description="Polymarket AI Trading Bot powered by Claude",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--scan",
        action="store_true",
        help="Scan and display market opportunities without trading",
    )
    parser.add_argument(
        "--live",
        action="store_true",
        help="Place real orders (default is dry-run)",
    )
    parser.add_argument(
        "--loop",
        type=int,
        metavar="SECONDS",
        help="Run continuously every N seconds",
    )
    parser.add_argument(
        "--log-level",
        default=os.getenv("LOG_LEVEL", "INFO"),
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
    )

    args = parser.parse_args()
    setup_logging(args.log_level)
    print_banner()

    # Validate required env vars
    if not os.getenv("ANTHROPIC_API_KEY"):
        console.print("[bold red]Error: ANTHROPIC_API_KEY is not set.[/bold red]")
        console.print("Copy .env.example to .env and fill in your API keys.")
        sys.exit(1)

    try:
        if args.scan:
            cmd_scan(args)
        elif args.loop:
            cmd_loop(args)
        else:
            cmd_run(args)
    except KeyboardInterrupt:
        console.print("\n[yellow]Interrupted by user.[/yellow]")


if __name__ == "__main__":
    main()
