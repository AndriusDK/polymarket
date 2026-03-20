"""
Setup screen — Blade Runner themed credential + config entry.
All fields stored in memory; no .env file needed.
"""

from dataclasses import dataclass

from textual import on
from textual.app import ComposeResult
from textual.screen import Screen
from textual.widgets import Button, Input, Label, Static, Switch
from textual.containers import Container, Vertical, Horizontal


ASCII_ART = """\
██████╗  ██████╗ ████████╗
██╔══██╗██╔═══██╗╚══██╔══╝
██████╔╝██║   ██║   ██║
██╔══██╗██║   ██║   ██║
██████╔╝╚██████╔╝   ██║
╚═════╝  ╚═════╝    ╚═╝
POLYMARKET AI TRADING SYSTEM  v1.0\
"""


@dataclass
class BotCredentials:
    # AI
    anthropic_api_key: str = ""
    # Polymarket
    poly_private_key: str = ""
    poly_api_key: str = ""
    poly_api_secret: str = ""
    poly_api_passphrase: str = ""
    # Config
    max_bet_usdc: float = 10.0
    min_edge: float = 0.05
    max_daily_spend: float = 100.0
    dry_run: bool = True
    markets_to_scan: int = 20


class SetupScreen(Screen):
    """
    Full-screen setup form with Blade Runner aesthetic.
    Emits a 'launch' message when the user submits.
    """

    CSS_PATH = "blade_runner.tcss"

    class Launch(Screen.Message):
        def __init__(self, creds: BotCredentials) -> None:
            super().__init__()
            self.creds = creds

    def compose(self) -> ComposeResult:
        with Container(id="setup-screen"):
            with Vertical(id="setup-box"):
                yield Static(ASCII_ART, id="ascii-art")
                yield Static(
                    '"More human than human is our motto."',
                    id="setup-subtitle",
                )
                yield Static("─" * 64, id="divider")

                # ── AI credentials ──
                yield Static("◈  ANTHROPIC", classes="section-label")
                yield Static("API Key", classes="field-label")
                yield Input(
                    placeholder="sk-ant-...",
                    id="anthropic-key",
                    password=True,
                    classes="secret",
                )

                # ── Polymarket credentials ──
                yield Static("◈  POLYMARKET  (leave blank for scan-only)", classes="section-label")
                yield Static("Wallet Private Key", classes="field-label")
                yield Input(
                    placeholder="0x...  (required for live trading)",
                    id="poly-private-key",
                    password=True,
                    classes="secret",
                )

                with Horizontal(classes="row-2"):
                    with Vertical():
                        yield Static("API Key", classes="field-label")
                        yield Input(placeholder="key", id="poly-api-key", password=True, classes="secret")
                    with Vertical():
                        yield Static("API Secret", classes="field-label")
                        yield Input(placeholder="secret", id="poly-api-secret", password=True, classes="secret")

                yield Static("API Passphrase", classes="field-label")
                yield Input(
                    placeholder="passphrase",
                    id="poly-api-passphrase",
                    password=True,
                    classes="secret",
                )

                # ── Bot config ──
                yield Static("◈  BOT CONFIG", classes="section-label")

                with Horizontal(classes="row-2"):
                    with Vertical():
                        yield Static("Max Bet (USDC)", classes="field-label")
                        yield Input(placeholder="10", value="10", id="max-bet")
                    with Vertical():
                        yield Static("Min Edge  (e.g. 0.05 = 5%)", classes="field-label")
                        yield Input(placeholder="0.05", value="0.05", id="min-edge")

                with Horizontal(classes="row-2"):
                    with Vertical():
                        yield Static("Daily Budget (USDC)", classes="field-label")
                        yield Input(placeholder="100", value="100", id="max-daily")
                    with Vertical():
                        yield Static("Markets to Scan", classes="field-label")
                        yield Input(placeholder="20", value="20", id="markets-count")

                with Horizontal(classes="switch-row"):
                    yield Static("Dry Run (simulate trades)", classes="switch-label")
                    yield Switch(value=True, id="dry-run-switch")
                    yield Static("ON", id="dry-run-label", classes="switch-value")

                yield Static("─" * 64, id="divider")
                yield Button("▶  INITIATE REPLICANT DETECTION", id="btn-launch", variant="primary")

    @on(Switch.Changed, "#dry-run-switch")
    def _dry_run_toggled(self, event: Switch.Changed) -> None:
        label = self.query_one("#dry-run-label", Static)
        if event.value:
            label.update("ON")
            label.remove_class("red")
            label.add_class("amber")
        else:
            label.update("OFF — LIVE")
            label.remove_class("amber")
            label.add_class("red")

    @on(Button.Pressed, "#btn-launch")
    def _launch(self) -> None:
        def _float(widget_id: str, default: float) -> float:
            try:
                return float(self.query_one(f"#{widget_id}", Input).value or default)
            except ValueError:
                return default

        def _int(widget_id: str, default: int) -> int:
            try:
                return int(self.query_one(f"#{widget_id}", Input).value or default)
            except ValueError:
                return default

        creds = BotCredentials(
            anthropic_api_key=self.query_one("#anthropic-key", Input).value.strip(),
            poly_private_key=self.query_one("#poly-private-key", Input).value.strip(),
            poly_api_key=self.query_one("#poly-api-key", Input).value.strip(),
            poly_api_secret=self.query_one("#poly-api-secret", Input).value.strip(),
            poly_api_passphrase=self.query_one("#poly-api-passphrase", Input).value.strip(),
            max_bet_usdc=_float("max-bet", 10.0),
            min_edge=_float("min-edge", 0.05),
            max_daily_spend=_float("max-daily", 100.0),
            markets_to_scan=_int("markets-count", 20),
            dry_run=self.query_one("#dry-run-switch", Switch).value,
        )

        if not creds.anthropic_api_key:
            self.notify(
                "Anthropic API key is required.",
                title="Missing Credential",
                severity="error",
            )
            return

        self.post_message(self.Launch(creds))
