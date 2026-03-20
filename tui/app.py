"""
Blade Runner TUI App — wires together setup and dashboard screens.
"""

from textual.app import App, ComposeResult

from .setup_screen import BotCredentials, SetupScreen
from .dashboard_screen import DashboardScreen


class PolymarketBotApp(App):
    """Main Textual application."""

    TITLE = "Polymarket AI Bot"
    CSS_PATH = "blade_runner.tcss"

    def on_mount(self) -> None:
        self.push_screen(SetupScreen())

    def on_setup_screen_launch(self, message: SetupScreen.Launch) -> None:
        self.push_screen(DashboardScreen(message.creds))
