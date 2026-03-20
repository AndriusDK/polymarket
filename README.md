# Polymarket AI Trading Bot

An AI-powered trading bot for [Polymarket](https://polymarket.com) with a **Blade Runner cyberpunk UI** — runs entirely in your browser, no installs required.

## Quick Start

```
1. Open  frontend/index.html  in your browser
2. Paste your Anthropic API key
3. Click INITIATE SYSTEM
4. Click RUN CYCLE on the dashboard
```

No Python. No Node. No terminal. Just a browser.

## Screens

### Setup Screen
- Blade Runner ASCII art header with scanline overlay
- Enter your Anthropic API key (required for AI analysis)
- Optionally enter Polymarket wallet credentials (only needed for live trading)
- Configure: max bet, min edge, daily budget, markets to scan
- Dry Run toggle (ON by default — safe mode)

### Dashboard
- **Markets table** — populates live as Claude analyzes each market (click any row to expand reasoning)
- **Stats panel** — markets fetched / analyzed / opportunities / trades / budget remaining
- **Progress bar** — shows scan progress during analysis
- **Activity log** — full Claude reasoning, trade signals, errors
- **Toolbar**:
  - `RUN CYCLE` — single scan-and-trade pass
  - `AUTO 5min` — loop every 5 minutes automatically
  - `STOP` — gracefully cancel
  - `SETTINGS` — return to setup

## How It Works

1. **Fetches markets** from the Polymarket Gamma API (public, no auth needed)
2. **Sends each market** to Claude, which estimates the true probability
3. **Compares** Claude's estimate vs market price — flags edge opportunities
4. **Sizes bets** using Kelly-inspired formula (proportional to edge + confidence)
5. **Simulates trades** (dry run) or shows what it would do

## Getting API Keys

| Key | Where |
|---|---|
| Anthropic | [console.anthropic.com](https://console.anthropic.com) |
| Polymarket | Connect wallet at [polymarket.com](https://polymarket.com) |

## Project Structure

```
frontend/
  index.html              # Open this in your browser
  css/
    theme.css             # Core Blade Runner theme
    setup.css             # Setup screen styles
    dashboard.css         # Dashboard styles
  js/
    api.js                # Polymarket Gamma + Claude API calls
    app.js                # Screen logic, bot cycle, UI updates
bot/                      # Python backend (optional, needs Python)
  market_client.py
  analyzer.py
  trader.py
tui/                      # Terminal UI (optional, needs Python)
```

## Risk Warnings

- Always test in **Dry Run** first
- Claude has a knowledge cutoff — may miss recent events
- Prediction markets are risky — this is for educational purposes
- Start small: $2–5 max bet, $20 daily budget
