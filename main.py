#!/usr/bin/env python3
"""
Polymarket AI Trading Bot
─────────────────────────
Blade Runner themed terminal UI powered by Claude.

Usage:
    python main.py
"""

import sys


def main() -> None:
    try:
        from tui.app import PolymarketBotApp
    except ImportError as e:
        print(f"Missing dependency: {e}")
        print("Run:  pip install -r requirements.txt")
        sys.exit(1)

    app = PolymarketBotApp()
    app.run()


if __name__ == "__main__":
    main()
