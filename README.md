# Polymarket AI Trading Bot

An AI-powered trading bot for [Polymarket](https://polymarket.com) that uses **Claude** to analyze prediction markets and identify mispriced probabilities.

## How It Works

1. **Fetch markets** — pulls the top active markets from Polymarket by volume
2. **AI analysis** — sends each market question to Claude, which estimates the true probability and confidence level
3. **Edge detection** — compares Claude's estimate to the market price; if the difference (edge) exceeds a threshold, it flags a trade
4. **Risk management** — sizes each bet using a Kelly-inspired formula, respects daily budget limits
5. **Execute** — places a market order (or simulates it in dry-run mode)

## Setup

### 1. Install dependencies

```bash
pip install -r requirements.txt
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env` with your keys:

| Variable | Description |
|---|---|
| `ANTHROPIC_API_KEY` | Your Anthropic API key ([get one here](https://console.anthropic.com)) |
| `POLY_PRIVATE_KEY` | Your wallet private key (for live trading) |
| `POLY_API_KEY` | Polymarket CLOB API key |
| `POLY_API_SECRET` | Polymarket CLOB API secret |
| `POLY_API_PASSPHRASE` | Polymarket CLOB API passphrase |
| `MAX_BET_USDC` | Max USDC per trade (default: `10`) |
| `MIN_EDGE` | Minimum edge % to trigger a trade (default: `0.05` = 5%) |
| `MAX_DAILY_SPEND_USDC` | Daily budget cap (default: `100`) |
| `DRY_RUN` | Set to `false` for live trading (default: `true`) |

To get Polymarket API keys, connect your wallet at [polymarket.com](https://polymarket.com) and follow the CLOB API docs.

## Usage

### Scan markets (no trading)

```bash
python main.py --scan
```

Analyzes the top markets and prints a table of Claude's probability estimates vs. market prices — no orders placed.

### Single run (dry-run by default)

```bash
python main.py
```

### Single run with real trades

```bash
python main.py --live
```

### Continuous loop (every 5 minutes)

```bash
python main.py --loop 300
```

## Architecture

```
main.py                  # CLI entry point
bot/
  market_client.py       # Polymarket API wrapper (Gamma + CLOB)
  analyzer.py            # Claude AI probability estimator
  trader.py              # Bot orchestration + risk management
```

## Risk Warnings

- **Prediction markets are risky.** Claude's analysis may be wrong, outdated, or incomplete.
- **Always test in dry-run mode first** before enabling live trading.
- **Start with small bet sizes** (e.g., $1–$5) and a low daily budget.
- **Claude has a knowledge cutoff** — it may lack recent information about fast-moving events.
- This bot is for educational purposes. Trading on prediction markets involves financial risk.

## Configuration Tuning

| Setting | Conservative | Moderate | Aggressive |
|---|---|---|---|
| `MIN_EDGE` | 15% | 8% | 4% |
| `MAX_BET_USDC` | $2 | $10 | $25 |
| `MIN_CONFIDENCE` | HIGH | MEDIUM | LOW |
| `MAX_DAILY_SPEND_USDC` | $20 | $100 | $500 |
