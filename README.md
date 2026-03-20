# Polymarket AI Trading Bot

An AI-powered trading bot for [Polymarket](https://polymarket.com) with a **Blade Runner cyberpunk TUI** — no config files, everything entered in the UI.

## What It Does

1. **Setup screen** — enter your API keys and bot config directly in the terminal UI
2. **Dashboard** — scan markets, watch Claude analyze each one live, and see trade signals
3. **AI analysis** — Claude estimates the true probability for each market; if it differs from the market price by more than your threshold, it flags a trade
4. **Risk management** — Kelly-inspired position sizing, daily budget cap, dry-run mode

## Setup

```bash
pip install -r requirements.txt
python main.py
```

That's it. No `.env` file needed.

## Screens

### Setup Screen
Enter your credentials once per session:

| Field | Description |
|---|---|
| **Anthropic API Key** | Required — powers the AI analysis |
| **Wallet Private Key** | Optional — only needed for live trading |
| **Poly API Key/Secret/Passphrase** | Optional — only needed for live trading |
| **Max Bet (USDC)** | Maximum per trade |
| **Min Edge** | Minimum probability gap to trigger a trade (e.g. `0.05` = 5%) |
| **Daily Budget** | Max total spend per session |
| **Dry Run** | Toggle — ON = simulate only, OFF = real orders |

### Dashboard
- **Markets table** — live-updated as Claude analyzes each market
- **Stats panel** — fetched, analyzed, opportunities, trades placed, budget remaining
- **Log** — full reasoning from Claude for every market
- **Toolbar buttons**:
  - `RUN CYCLE` — single scan-and-trade pass
  - `AUTO 5 min` — loop every 5 minutes automatically
  - `STOP` — gracefully stop the auto-loop
  - `SETTINGS` — return to setup screen

## Getting API Keys

| Key | Where to get it |
|---|---|
| Anthropic | [console.anthropic.com](https://console.anthropic.com) |
| Polymarket | Connect wallet at [polymarket.com](https://polymarket.com) → API section |

## Risk Warnings

- **Always test in Dry Run first** before enabling live trading.
- Claude has a knowledge cutoff — it may lack data on very recent events.
- Prediction markets are inherently risky. This is for educational purposes.
- Start with small values: Max Bet $2–5, Daily Budget $20.

## Project Structure

```
main.py              # Launcher
tui/
  app.py             # Textual app root
  setup_screen.py    # Credential + config entry screen
  dashboard_screen.py# Live trading dashboard
  blade_runner.tcss  # Cyberpunk CSS theme
bot/
  market_client.py   # Polymarket Gamma + CLOB API wrapper
  analyzer.py        # Claude probability estimator
  trader.py          # Bot config + risk management
```
