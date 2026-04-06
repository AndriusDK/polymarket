"""
Main dashboard screen — Blade Runner themed live trading view.
Shows market scan progress, Claude analysis, trade log and stats.
"""

import threading
import time
from datetime import datetime, timezone
from typing import Optional

from rich.text import Text
from textual import on, work
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Button, DataTable, Label, RichLog, Static
from textual.containers import Container, Horizontal, Vertical
from textual.reactive import reactive

from .setup_screen import BotCredentials


# ── Colour palette (matches CSS vars) ──
C_CYAN    = "bright_cyan"
C_MAGENTA = "bright_magenta"
C_AMBER   = "dark_orange"
C_GREEN   = "bright_green"
C_RED     = "bright_red"
C_DIM     = "grey50"
C_TEXT    = "grey84"


def _now() -> str:
    return datetime.now(timezone.utc).strftime("%H:%M:%S")


class DashboardScreen(Screen):
    CSS_PATH = "blade_runner.tcss"

    # Reactive stats — updating these auto-refreshes the stats panel
    markets_fetched: reactive[int]  = reactive(0)
    markets_analyzed: reactive[int] = reactive(0)
    opportunities: reactive[int]    = reactive(0)
    trades_placed: reactive[int]    = reactive(0)
    total_spent: reactive[float]    = reactive(0.0)
    bot_status: reactive[str]       = reactive("IDLE")

    def __init__(self, creds: BotCredentials) -> None:
        super().__init__()
        self.creds = creds
        self._running = False
        self._stop_event = threading.Event()

    # ── Layout ────────────────────────────────────────────────────────

    def compose(self) -> ComposeResult:
        mode = "⚡ LIVE" if not self.creds.dry_run else "◎ DRY RUN"

        # Header bar
        with Horizontal(id="header-bar"):
            yield Static(
                "◈  POLYMARKET  AI  TRADING  SYSTEM  ◈",
                id="header-title",
            )
            yield Static(f"EDGE ≥ {self.creds.min_edge:.0%}  |  MAX ${self.creds.max_bet_usdc:.0f}/trade",
                         id="header-status")
            yield Static(mode, id="header-mode")

        # Markets table + Stats
        with Container(id="markets-panel", classes="panel"):
            yield DataTable(id="markets-table", cursor_type="row", zebra_stripes=True)

        with Vertical(id="stats-panel", classes="panel"):
            yield Static(_stat("Markets fetched",   "0",    "cyan"),    id="s-fetched")
            yield Static(_stat("Markets analyzed",  "0",    "cyan"),    id="s-analyzed")
            yield Static(_stat("Opportunities",     "0",    "amber"),   id="s-opps")
            yield Static(_stat("Trades placed",     "0",    "magenta"), id="s-trades")
            yield Static(_stat("Total spent",       "$0.00","green"),   id="s-spent")
            yield Static(_stat("Daily budget left", f"${self.creds.max_daily_spend:.0f}", "green"), id="s-budget")
            yield Static("", id="s-spacer")
            yield Static(_stat("Status", "IDLE", "dim"), id="s-status")

        # Log
        with Container(id="log-panel", classes="panel"):
            yield RichLog(id="log", highlight=True, markup=True, wrap=True)

        # Toolbar
        with Horizontal(id="toolbar"):
            yield Button("▶  RUN CYCLE",    id="btn-run",    classes="toolbar-btn")
            yield Button("⟳  AUTO  5 min",  id="btn-auto",   classes="toolbar-btn")
            yield Button("■  STOP",         id="btn-stop",   classes="toolbar-btn")
            yield Button("◀  SETTINGS",     id="btn-back",   classes="toolbar-btn danger")
            yield Static("", id="toolbar-spacer")
            yield Static("↑↓ scroll log   Q quit", id="toolbar-hint")

    def on_mount(self) -> None:
        self._setup_table()
        self._log_banner()

    # ── Table setup ───────────────────────────────────────────────────

    def _setup_table(self) -> None:
        t = self.query_one("#markets-table", DataTable)
        t.add_columns(
            "  Question",
            "Market YES",
            "Claude YES",
            "Edge",
            "Conf",
            "Signal",
        )

    # ── Button handlers ───────────────────────────────────────────────

    @on(Button.Pressed, "#btn-run")
    def _btn_run(self) -> None:
        if self._running:
            self.notify("Bot is already running.", severity="warning")
            return
        self._run_cycle_worker()

    @on(Button.Pressed, "#btn-auto")
    def _btn_auto(self) -> None:
        if self._running:
            self.notify("Already running.", severity="warning")
            return
        self._auto_loop_worker()

    @on(Button.Pressed, "#btn-stop")
    def _btn_stop(self) -> None:
        self._stop_event.set()
        self._set_status("STOPPING…", "amber")
        self._log(f"[{C_AMBER}]Stop requested — finishing current operation…[/]")

    @on(Button.Pressed, "#btn-back")
    def _btn_back(self) -> None:
        self._stop_event.set()
        self.app.pop_screen()

    # ── Workers (run in threads so UI stays responsive) ───────────────

    @work(thread=True)
    def _run_cycle_worker(self) -> None:
        self._running = True
        self._stop_event.clear()
        self._run_single_cycle()
        self._running = False

    @work(thread=True)
    def _auto_loop_worker(self) -> None:
        self._running = True
        self._stop_event.clear()
        self._log(f"[{C_CYAN}]Auto-loop started — cycle every 5 minutes.[/]")
        cycle = 0
        while not self._stop_event.is_set():
            cycle += 1
            self._log(f"\n[{C_CYAN}]══ AUTO CYCLE {cycle} ══[/]")
            self._run_single_cycle()
            if self._stop_event.is_set():
                break
            self._log(f"[{C_DIM}]Sleeping 5 min until next cycle…[/]")
            for _ in range(300):
                if self._stop_event.is_set():
                    break
                time.sleep(1)
        self._set_status("IDLE", "dim")
        self._log(f"[{C_AMBER}]Auto-loop stopped.[/]")
        self._running = False

    def _run_single_cycle(self) -> None:
        """Core bot cycle — runs in a worker thread."""
        from bot.market_client import PolymarketClient
        from bot.analyzer import ClaudeAnalyzer
        from bot.trader import BotConfig, TradingBot
        import os

        # Inject credentials into env for the client libraries
        os.environ["ANTHROPIC_API_KEY"]    = self.creds.anthropic_api_key
        os.environ["POLY_PRIVATE_KEY"]     = self.creds.poly_private_key
        os.environ["POLY_API_KEY"]         = self.creds.poly_api_key
        os.environ["POLY_API_SECRET"]      = self.creds.poly_api_secret
        os.environ["POLY_API_PASSPHRASE"]  = self.creds.poly_api_passphrase

        config = BotConfig(
            max_bet_usdc=self.creds.max_bet_usdc,
            min_edge=self.creds.min_edge,
            max_daily_spend_usdc=self.creds.max_daily_spend,
            markets_to_analyze=self.creds.markets_to_scan,
            dry_run=self.creds.dry_run,
        )

        self._set_status("SCANNING…", "cyan")
        self._log(f"[{C_CYAN}][{_now()}] Fetching markets…[/]")

        poly     = PolymarketClient()
        analyzer = ClaudeAnalyzer(api_key=self.creds.anthropic_api_key)

        markets = poly.get_active_markets(
            limit=config.markets_to_analyze,
            min_volume=config.min_volume,
            min_liquidity=config.min_liquidity,
        )
        self.markets_fetched = len(markets)
        self._update_stats()
        self._log(f"[{C_TEXT}]  → Found [bold]{len(markets)}[/] active markets[/]")

        if not markets:
            self._log(f"[{C_RED}]No markets returned. Check connectivity.[/]")
            self._set_status("IDLE", "dim")
            return

        # Clear table for new cycle
        self.call_from_thread(self._reset_table)

        self._set_status("ANALYZING…", "cyan")
        analyses = []

        self._log(f"[{C_DIM}]  Analyzing {len(markets)} markets with Claude…[/]")
        for i, market in enumerate(markets):
            if self._stop_event.is_set():
                break

            analysis = analyzer.analyze_market(market)

            if analysis is None:
                continue

            analyses.append(analysis)
            self.markets_analyzed = len(analyses)
            self._update_stats()
            self.call_from_thread(self._add_table_row, analysis)

        self._log(f"[{C_TEXT}]  → Analyzed [bold]{len(analyses)}[/]/{len(markets)} markets[/]")

        # Filter opportunities
        opps = [
            a for a in analyses
            if not a.insufficient_knowledge
            and a.trade_signal is not None
            and abs(a.edge) >= config.min_edge
            and a.confidence in ("MEDIUM", "HIGH")
        ]
        opps.sort(key=lambda a: abs(a.edge), reverse=True)
        self.opportunities = len(opps)
        self._update_stats()

        if not opps:
            self._log(f"[{C_AMBER}]No opportunities above edge threshold.[/]")
            self._set_status("IDLE", "dim")
            return

        # Execute trades
        self._set_status("TRADING…", "magenta")
        daily_spent = 0.0

        for analysis in opps:
            if self._stop_event.is_set():
                break
            if daily_spent >= config.max_daily_spend_usdc:
                self._log(f"[{C_AMBER}]Daily budget exhausted.[/]")
                break

            signal = analysis.trade_signal
            token_id = (
                analysis.market.yes_token_id if signal == "BUY_YES"
                else analysis.market.no_token_id
            )
            edge = abs(analysis.edge)
            conf_mult = {"LOW": 0.25, "MEDIUM": 0.6, "HIGH": 1.0}.get(analysis.confidence, 0.5)
            edge_mult = min(edge / 0.20, 1.0)
            amount = round(config.max_bet_usdc * conf_mult * edge_mult, 2)
            amount = min(amount, config.max_daily_spend_usdc - daily_spent)

            if amount < 1.0:
                continue

            sig_color = C_GREEN if signal == "BUY_YES" else C_RED
            mode_tag = "[DRY]" if config.dry_run else "[LIVE]"

            self._log(
                f"\n[bold {sig_color}]{mode_tag} {signal}[/]  "
                f"${amount:.2f}  [bold]{analysis.market.question[:60]}[/]\n"
                f"  Edge: {analysis.edge:+.1%}  Conf: {analysis.confidence}\n"
                f"  [{C_DIM}]{analysis.reasoning}[/]"
            )

            result = poly.place_market_order(
                token_id=token_id,
                side="BUY",
                amount_usdc=amount,
                dry_run=config.dry_run,
            )

            daily_spent += amount
            self.trades_placed += 1
            self.total_spent += amount
            self._update_stats()

        self._set_status("IDLE", "dim")
        self._log(
            f"\n[{C_CYAN}]══ CYCLE COMPLETE — "
            f"{self.trades_placed} trade(s)  ${self.total_spent:.2f} spent ══[/]\n"
        )

    # ── Table helpers ─────────────────────────────────────────────────

    def _reset_table(self) -> None:
        t = self.query_one("#markets-table", DataTable)
        t.clear()

    def _add_table_row(self, analysis) -> None:
        t = self.query_one("#markets-table", DataTable)

        signal = analysis.trade_signal or "—"
        sig_color = "green" if signal == "BUY_YES" else ("red" if signal == "BUY_NO" else "grey50")
        edge_color = "green" if analysis.edge > 0 else "red"

        t.add_row(
            Text(analysis.market.question[:52], style="white"),
            Text(f"{analysis.market.yes_price:.1%}", style="grey84"),
            Text(f"{analysis.yes_probability:.1%}", style="bright_cyan"),
            Text(f"{analysis.edge:+.1%}", style=edge_color),
            Text(analysis.confidence, style="dark_orange"),
            Text(signal, style=sig_color),
        )

    # ── Stats helpers ─────────────────────────────────────────────────

    def _update_stats(self) -> None:
        self.call_from_thread(self._refresh_stats)

    def _refresh_stats(self) -> None:
        budget_left = self.creds.max_daily_spend - self.total_spent
        self.query_one("#s-fetched",  Static).update(_stat("Markets fetched",   str(self.markets_fetched),           "cyan"))
        self.query_one("#s-analyzed", Static).update(_stat("Markets analyzed",  str(self.markets_analyzed),          "cyan"))
        self.query_one("#s-opps",     Static).update(_stat("Opportunities",     str(self.opportunities),             "amber"))
        self.query_one("#s-trades",   Static).update(_stat("Trades placed",     str(self.trades_placed),             "magenta"))
        self.query_one("#s-spent",    Static).update(_stat("Total spent",       f"${self.total_spent:.2f}",          "green"))
        self.query_one("#s-budget",   Static).update(_stat("Budget left",       f"${budget_left:.2f}",               "green"))

    def _set_status(self, text: str, color: str) -> None:
        self.bot_status = text
        colors = {
            "cyan": C_CYAN, "amber": C_AMBER, "magenta": C_MAGENTA,
            "green": C_GREEN, "red": C_RED, "dim": C_DIM,
        }
        self.call_from_thread(
            lambda: self.query_one("#s-status", Static).update(
                _stat("Status", text, color)
            )
        )

    # ── Log helper ────────────────────────────────────────────────────

    def _log(self, text: str) -> None:
        self.call_from_thread(
            lambda: self.query_one("#log", RichLog).write(text)
        )

    def _log_banner(self) -> None:
        log = self.query_one("#log", RichLog)
        log.write(
            f"[bold bright_cyan]"
            f"  POLYMARKET AI TRADING SYSTEM  —  ONLINE\n"
            f"  {'DRY RUN MODE' if self.creds.dry_run else '⚡ LIVE TRADING MODE'}\n"
            f"  Edge threshold: {self.creds.min_edge:.0%}  |  "
            f"Max bet: ${self.creds.max_bet_usdc:.0f}  |  "
            f"Daily budget: ${self.creds.max_daily_spend:.0f}"
            f"[/]\n"
        )
        log.write(f"[grey50]Press [RUN CYCLE] to scan markets or [AUTO 5 min] to loop.[/]\n")


def _stat(key: str, val: str, color: str) -> str:
    colors = {
        "cyan":    "bright_cyan",
        "amber":   "dark_orange",
        "magenta": "bright_magenta",
        "green":   "bright_green",
        "red":     "bright_red",
        "dim":     "grey50",
    }
    c = colors.get(color, "white")
    return f"[grey50]{key}[/]  [{c}]{val}[/]"
