/* ═══════════════════════════════════════════════════════════════════
   API Layer — Polymarket (Gamma) + Anthropic (Claude)
   ═══════════════════════════════════════════════════════════════════ */

const PROXY_URL = "proxy.php";
const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";

// ── Polymarket Gamma API ─────────────────────────────────────────

async function fetchMarkets({ limit = 50, minVolume = 10000, minLiquidity = 1000 } = {}) {
  const params = new URLSearchParams({
    active: "true",
    closed: "false",
    limit: String(Math.min(limit * 3, 300)),
    _order: "volume",
    volume_num_min: String(minVolume),
  });

  const resp = await fetch(`${PROXY_URL}?${params}`);
  if (!resp.ok) throw new Error(`Gamma API error: ${resp.status}`);
  const raw = await resp.json();

  const markets = [];
  for (const m of raw) {
    const parsed = parseGammaMarket(m);
    if (!parsed) continue;
    if (parsed.liquidity < minLiquidity) continue;
    markets.push(parsed);
    if (markets.length >= limit) break;
  }
  return markets;
}

// Fetch prices for specific markets by conditionId (for live PnL refresh)
async function fetchMarketPrices(conditionIds) {
  if (!conditionIds.length) return [];
  const params = new URLSearchParams();
  for (const id of conditionIds) params.append("condition_ids", id);
  const resp = await fetch(`${PROXY_URL}?${params}`);
  if (!resp.ok) throw new Error(`Gamma price refresh error: ${resp.status}`);
  const raw = await resp.json();
  return raw.map(parseGammaMarket).filter(Boolean);
}

function parseGammaMarket(raw) {
  // API returns outcomes/outcomePrices/clobTokenIds as stringified JSON arrays
  let outcomes, prices, tokenIds;
  try {
    outcomes = JSON.parse(raw.outcomes   || "[]");
    prices   = JSON.parse(raw.outcomePrices || "[]");
    tokenIds = JSON.parse(raw.clobTokenIds  || "[]");
  } catch {
    return null;
  }

  if (outcomes.length < 2 || prices.length < 2 || tokenIds.length < 2) return null;

  const yesIdx = outcomes.findIndex(o => o.toUpperCase() === "YES");
  const noIdx  = outcomes.findIndex(o => o.toUpperCase() === "NO");
  if (yesIdx === -1 || noIdx === -1) return null;

  const yesPrice = parseFloat(prices[yesIdx] || 0);
  const noPrice  = parseFloat(prices[noIdx]  || 0);
  if (yesPrice === 0 && noPrice === 0) return null;

  return {
    conditionId: raw.conditionId || raw.id || "",
    question:    raw.question || "",
    description: raw.description || "",
    endDate:     raw.endDate || raw.endDateIso || "",
    yesTokenId:  tokenIds[yesIdx] || "",
    noTokenId:   tokenIds[noIdx]  || "",
    yesPrice,
    noPrice,
    volume:    parseFloat(raw.volumeNum || raw.volume || 0),
    liquidity: parseFloat(raw.liquidityNum || raw.liquidity || 0),
  };
}

// ── Claude AI Analysis ───────────────────────────────────────────

const ANALYSIS_PROMPT = `You are a prediction market analyst. Your job is to estimate the true probability of a binary outcome for a Polymarket prediction market question.

Today's date: {today}

Market Question:
{question}

Market Description:
{description}

Market End Date: {endDate}

Current Market Prices:
- YES: {yesPrice} (market's implied probability)
- NO:  {noPrice}

Your task:
1. Think carefully about the question based on current world knowledge.
2. Estimate the TRUE probability that YES resolves (0.0 to 1.0).
3. Identify your confidence level: LOW, MEDIUM, or HIGH.
4. Briefly explain your reasoning (2-4 sentences max).
5. Flag if you have insufficient knowledge to analyze this market.

Respond ONLY in this exact JSON format (no markdown, no extra text):
{
  "yes_probability": <float 0.0-1.0>,
  "confidence": "<LOW|MEDIUM|HIGH>",
  "reasoning": "<your reasoning>",
  "insufficient_knowledge": <true|false>
}`;

// ── Heuristic fallback (no API key needed) ───────────────────────
// Uses market price, volume, liquidity, and time-to-expiry to
// produce a LOW-confidence signal without calling Claude.
function analyzeMarketHeuristic(market) {
  const yesPrice = market.yesPrice;
  const noPrice  = market.noPrice;

  // Assume market is mostly efficient; small random walk around midpoint
  // gives a "neutral" estimate = market price (0 edge).
  // But we flag extreme prices (< 5% or > 95%) as likely efficient too.
  const yesProbability = yesPrice;
  const edge = 0;

  return {
    market,
    yesProbability,
    confidence: "LOW",
    reasoning: "Heuristic mode (no API key): assuming market price reflects true probability. No edge detected.",
    insufficientKnowledge: true,
    edge,
    absEdge: 0,
    signal: null,
    heuristic: true,
  };
}

async function analyzeMarket(market, anthropicKey, { model = "claude-haiku-4-5-20251001", signal } = {}) {
  if (!anthropicKey) return analyzeMarketHeuristic(market);
  const today = new Date().toISOString().slice(0, 10);
  const prompt = ANALYSIS_PROMPT
    .replace("{today}",    today)
    .replace("{question}",  market.question)
    .replace("{description}", market.description || "No description provided.")
    .replace("{endDate}",   market.endDate || "Unknown")
    .replace("{yesPrice}",  (market.yesPrice * 100).toFixed(1) + "%")
    .replace("{noPrice}",   (market.noPrice * 100).toFixed(1) + "%");

  const resp = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: 512,
      messages: [{ role: "user", content: prompt }],
    }),
    signal,
  });

  if (!resp.ok) {
    const err = await resp.text();
    // On billing/auth errors fall back to heuristic rather than crashing
    const isBillingError = resp.status === 400 || resp.status === 402 || resp.status === 401 || resp.status === 403;
    if (isBillingError) {
      console.warn(`Claude API ${resp.status} — falling back to heuristic.`, err.slice(0, 120));
      if (typeof logEntry === "function") logEntry("warn", `<span class="red">⚠ Anthropic API ${resp.status} — no AI analysis (check key/credits), using heuristic fallback</span>`);
      return analyzeMarketHeuristic(market);
    }
    throw new Error(`Claude API ${resp.status}: ${err.slice(0, 200)}`);
  }

  const data = await resp.json();
  const raw = data.content[0].text.trim();
  return parseClaudeResponse(raw, market);
}

function parseClaudeResponse(raw, market) {
  let text = raw;
  // Strip markdown code fences if present
  if (text.startsWith("```")) {
    text = text.split("```")[1];
    if (text.startsWith("json")) text = text.slice(4);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Failed to parse Claude JSON: " + text.slice(0, 100));
  }

  const yesProb = parseFloat(parsed.yes_probability);
  if (isNaN(yesProb) || yesProb < 0 || yesProb > 1) {
    throw new Error("Invalid yes_probability: " + parsed.yes_probability);
  }

  let confidence = (parsed.confidence || "LOW").toUpperCase();
  if (!["LOW", "MEDIUM", "HIGH"].includes(confidence)) confidence = "LOW";

  const edge = yesProb - market.yesPrice;
  const absEdge = Math.abs(edge);

  let signal = null;
  if (!parsed.insufficient_knowledge && confidence !== "LOW") {
    if (edge > 0) signal = "BUY_YES";
    else if (edge < 0) signal = "BUY_NO";
  }

  return {
    market,
    yesProbability: yesProb,
    confidence,
    reasoning: parsed.reasoning || "",
    insufficientKnowledge: !!parsed.insufficient_knowledge,
    edge,
    absEdge,
    signal,
  };
}

// ── Kelly-inspired bet sizing ────────────────────────────────────

function sizeBet(analysis, maxBet, remainingBudget) {
  const confMult = { LOW: 0.25, MEDIUM: 0.6, HIGH: 1.0 }[analysis.confidence] || 0.5;
  const edgeMult = Math.min(analysis.absEdge / 0.20, 1.0);
  const bet = maxBet * confMult * edgeMult;
  return Math.round(Math.min(bet, remainingBudget) * 100) / 100;
}

// ── Binance — crypto real-time data ──────────────────────────────

const BINANCE_API = "https://api.binance.com/api/v3";

const CRYPTO_CONFIG = {
  btc: { symbol: "BTCUSDT", keywords: ["bitcoin up or down", "btc up or down"], label: "Bitcoin", ticker: "BTC" },
  eth: { symbol: "ETHUSDT", keywords: ["ethereum up or down", "eth up or down"], label: "Ethereum", ticker: "ETH" },
  sol: { symbol: "SOLUSDT", keywords: ["solana up or down", "sol up or down"],   label: "Solana",   ticker: "SOL" },
  xrp: { symbol: "XRPUSDT", keywords: ["xrp up or down", "ripple up or down"],  label: "XRP",      ticker: "XRP" },
};

async function fetchCryptoSpot(symbol) {
  const resp = await fetch(`${BINANCE_API}/ticker/price?symbol=${symbol}`);
  if (!resp.ok) throw new Error(`Binance spot ${resp.status}`);
  return parseFloat((await resp.json()).price);
}

async function fetchCryptoCandles(symbol, limit = 6) {
  const resp = await fetch(`${BINANCE_API}/klines?symbol=${symbol}&interval=1m&limit=${limit}`);
  if (!resp.ok) throw new Error(`Binance candles ${resp.status}`);
  return (await resp.json()).map(c => ({
    time:   new Date(c[0]),
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

// 5-min candles show sustained trend direction (vs 1-min micro-noise).
// Claude uses these alongside 1-min bars to distinguish a 1-min blip from
// a real trend change before committing to against-gap direction trades.
async function fetchCryptoCandles5m(symbol, limit = 3) {
  const resp = await fetch(`${BINANCE_API}/klines?symbol=${symbol}&interval=5m&limit=${limit}`);
  if (!resp.ok) throw new Error(`Binance 5m candles ${resp.status}`);
  return (await resp.json()).map(c => ({
    time:   new Date(c[0]),
    open:   parseFloat(c[1]),
    high:   parseFloat(c[2]),
    low:    parseFloat(c[3]),
    close:  parseFloat(c[4]),
    volume: parseFloat(c[5]),
  }));
}

async function fetchCryptoOrderBook(symbol) {
  const resp = await fetch(`${BINANCE_API}/depth?symbol=${symbol}&limit=50`);
  if (!resp.ok) throw new Error(`Binance depth ${resp.status}`);
  const data = await resp.json();
  return {
    bids: data.bids.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
    asks: data.asks.map(([p, q]) => ({ price: parseFloat(p), qty: parseFloat(q) })),
  };
}

async function fetchCryptoFundingRate(symbol) {
  const resp = await fetch(`https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`);
  if (!resp.ok) throw new Error(`Binance funding ${resp.status}`);
  const data = await resp.json();
  return parseFloat(data.lastFundingRate) || 0;
}

// Aggressive trades in the last 60s.  m=true ⇒ buyer was maker ⇒ aggressive SELL
// (someone hit the bid).  m=false ⇒ buyer was taker ⇒ aggressive BUY (lifted ask).
async function fetchCryptoAggTrades(symbol) {
  const startTime = Date.now() - 60_000;
  const resp = await fetch(`${BINANCE_API}/aggTrades?symbol=${symbol}&startTime=${startTime}&limit=1000`);
  if (!resp.ok) throw new Error(`Binance aggTrades ${resp.status}`);
  return (await resp.json()).map(t => ({
    price:        parseFloat(t.p),
    qty:          parseFloat(t.q),
    time:         t.T,
    isBuyerMaker: t.m,
  }));
}

// Open interest snapshot now vs ~5 min ago.  Rising OI + rising price = new longs
// (conviction).  Falling OI + rising price = short-covering (weak, likely to stall).
async function fetchCryptoOpenInterestDelta(symbol) {
  const resp = await fetch(`https://fapi.binance.com/futures/data/openInterestHist?symbol=${symbol}&period=5m&limit=2`);
  if (!resp.ok) throw new Error(`Binance OI ${resp.status}`);
  const data = await resp.json();
  if (!Array.isArray(data) || data.length < 2) return null;
  const prev = parseFloat(data[0].sumOpenInterest);
  const curr = parseFloat(data[1].sumOpenInterest);
  if (!prev || !curr) return null;
  return { current: curr, previous: prev, delta: curr - prev, pctChange: ((curr - prev) / prev) * 100 };
}

// Aggregate buy vs sell pressure from recent aggressive trades.
function analyzeAggTrades(trades) {
  if (!trades || trades.length === 0) return null;
  let buyVol = 0, sellVol = 0, buyCount = 0, sellCount = 0;
  for (const t of trades) {
    if (t.isBuyerMaker) { sellVol += t.qty; sellCount++; }
    else                { buyVol  += t.qty; buyCount++; }
  }
  const totalVol = buyVol + sellVol;
  const buyPct   = totalVol > 0 ? (buyVol / totalVol) : 0.5;
  const avgBuy   = buyCount  > 0 ? buyVol  / buyCount  : 0;
  const avgSell  = sellCount > 0 ? sellVol / sellCount : 0;
  const sizeRatio = avgSell > 0 ? avgBuy / avgSell : (avgBuy > 0 ? 99 : 1);
  let signal;
  if      (buyPct > 0.65) signal = "strong buy pressure — bullish";
  else if (buyPct > 0.55) signal = "mild buy pressure — slightly bullish";
  else if (buyPct < 0.35) signal = "strong sell pressure — bearish";
  else if (buyPct < 0.45) signal = "mild sell pressure — slightly bearish";
  else                    signal = "balanced flow — no clear pressure";
  return { buyVol, sellVol, totalVol, buyPct, buyCount, sellCount, avgBuy, avgSell, sizeRatio, signal };
}

// Tight-range order book: immediate walls within ±0.1% of current spot price.
// Catches resistance/support that's relevant in the next 30-60s vs the wider
// ±0.5% range used near the resolution target.
function analyzeTightBook(book, spot) {
  if (!book) return null;
  const range    = spot * 0.001;
  const bidsNear = book.bids.filter(b => b.price >= spot - range && b.price <= spot);
  const asksNear = book.asks.filter(a => a.price >= spot && a.price <= spot + range);
  const bidQty   = bidsNear.reduce((s, b) => s + b.qty, 0);
  const askQty   = asksNear.reduce((s, a) => s + a.qty, 0);
  const ratio    = askQty > 0 ? bidQty / askQty : (bidQty > 0 ? 99 : 1);
  let signal;
  if      (ratio > 2.5) signal = "tight bid wall — likely floor at current price";
  else if (ratio < 0.4) signal = "tight ask wall — likely ceiling at current price";
  else                  signal = "no tight walls — free movement";
  return { bidQty, askQty, ratio, signal };
}

// Summarise order book walls within 0.5% of priceToBeat
function analyzeOrderBook(book, priceToBeat) {
  const range    = priceToBeat * 0.005;
  const bidsNear = book.bids.filter(b => b.price >= priceToBeat - range && b.price <= priceToBeat);
  const asksNear = book.asks.filter(a => a.price >= priceToBeat && a.price <= priceToBeat + range);
  const bidQty   = bidsNear.reduce((s, b) => s + b.qty, 0);
  const askQty   = asksNear.reduce((s, a) => s + a.qty, 0);
  const largestBid = bidsNear.reduce((mx, b) => b.qty > mx.qty ? b : mx, { qty: 0, price: 0 });
  const largestAsk = asksNear.reduce((mx, a) => a.qty > mx.qty ? a : mx, { qty: 0, price: 0 });
  const ratio    = askQty > 0 ? bidQty / askQty : (bidQty > 0 ? 99 : 1);
  let signal;
  if      (ratio > 2)    signal = "strong bid support — bullish";
  else if (ratio > 1.3)  signal = "moderate bid support — mildly bullish";
  else if (ratio < 0.5)  signal = "strong ask resistance — bearish";
  else if (ratio < 0.77) signal = "moderate ask resistance — mildly bearish";
  else                   signal = "balanced order book";
  return { bidQty, askQty, largestBid, largestAsk, ratio, signal };
}

// Compare last completed candle volume vs prior average
function analyzeVolumeSpike(candles) {
  const closed = candles.slice(1);  // skip current (possibly incomplete)
  if (closed.length < 2 || closed[0].volume == null) return null;
  const recentVol = closed[0].volume;
  const priorVols = closed.slice(1, 5).map(c => c.volume ?? 0).filter(v => v > 0);
  const avgVol    = priorVols.length ? priorVols.reduce((s, v) => s + v, 0) / priorVols.length : recentVol;
  const ratio     = avgVol > 0 ? recentVol / avgVol : 1;
  let signal;
  if      (ratio > 2.5)  signal = "strong spike — high conviction momentum";
  else if (ratio > 1.5)  signal = "elevated — moderate momentum confirmation";
  else if (ratio < 0.5)  signal = "low volume — weak conviction, reduce confidence";
  else                   signal = "normal volume";
  return { recentVol, avgVol, ratio, signal };
}

async function fetchCryptoOpenAtTime(symbol, startTimeMs) {
  const resp = await fetch(
    `${BINANCE_API}/klines?symbol=${symbol}&interval=1m&startTime=${startTimeMs}&limit=1`
  );
  if (!resp.ok) throw new Error(`Binance historical ${resp.status}`);
  const data = await resp.json();
  return data.length ? parseFloat(data[0][1]) : null;
}

// Backward-compat aliases
const fetchBtcSpot       = ()    => fetchCryptoSpot("BTCUSDT");
const fetchBtcCandles    = (n)   => fetchCryptoCandles("BTCUSDT", n);
const fetchBtcOpenAtTime = (ms)  => fetchCryptoOpenAtTime("BTCUSDT", ms);

function parseCryptoMarket(raw) {
  let outcomes, prices, tokenIds;
  try {
    outcomes = JSON.parse(raw.outcomes      || "[]");
    prices   = JSON.parse(raw.outcomePrices || "[]");
    tokenIds = JSON.parse(raw.clobTokenIds  || "[]");
  } catch { return null; }

  const upIdx   = outcomes.findIndex(o => /^up$/i.test(o));
  const downIdx = outcomes.findIndex(o => /^down$/i.test(o));
  if (upIdx === -1 || downIdx === -1) return null;

  const upPrice   = parseFloat(prices[upIdx]   || 0);
  const downPrice = parseFloat(prices[downIdx] || 0);
  if (upPrice === 0 && downPrice === 0) return null;

  return {
    conditionId: raw.conditionId || raw.id || "",
    question:    raw.question || "",
    description: raw.description || "",
    startDate:   raw.startDate || raw.startDateIso || "",
    endDate:     raw.endDate   || raw.endDateIso   || "",
    slug:        raw.slug || raw.groupSlug || raw.marketSlug || "",
    upTokenId:   tokenIds[upIdx]   || "",
    downTokenId: tokenIds[downIdx] || "",
    upPrice,
    downPrice,
    volume:    parseFloat(raw.volumeNum    || raw.volume    || 0),
    liquidity: parseFloat(raw.liquidityNum || raw.liquidity || 0),
  };
}

async function fetchCryptoMarkets(asset, { maxMinutes = 20, minVolume = 1000 } = {}) {
  const cfg    = CRYPTO_CONFIG[asset];
  const now    = Date.now();
  const maxEnd = new Date(now + maxMinutes * 60_000).toISOString();

  const params = new URLSearchParams({
    active:       "true",
    closed:       "false",
    limit:        "500",
    end_date_min: new Date(now).toISOString(),
    end_date_max: maxEnd,
    _order:       "end_date_asc",
  });

  const resp = await fetch(`${PROXY_URL}?${params}`);
  if (!resp.ok) throw new Error(`${cfg.ticker} markets ${resp.status}`);
  const raw = await resp.json();

  // Debug: log first few questions so we can see what the API returns
  if (raw.length > 0 && raw.length < 10) {
    console.log(`[${cfg.ticker}] sample questions:`, raw.slice(0, 3).map(m => m.question));
  }

  let nAsset = 0, nParsed = 0;
  const markets = [];

  for (const m of raw) {
    const q = (m.question || "").toLowerCase();
    if (!cfg.keywords.some(kw => q.includes(kw))) continue;
    nAsset++;

    const parsed = parseCryptoMarket(m);
    if (!parsed) continue;
    nParsed++;
    if (parsed.volume < minVolume) continue;
    markets.push(parsed);
  }

  return {
    markets: markets.sort((a, b) => new Date(a.endDate) - new Date(b.endDate)),
    debug: { total: raw.length, asset: nAsset, inWindow: nAsset, parsed: nParsed, filtered: markets.length },
  };
}

const fetchBtcMarkets = (opts) => fetchCryptoMarkets("btc", opts);

// ── Claude crypto analysis ────────────────────────────────────────

const CRYPTO_PROMPT = [
  "You are a quantitative analyst for ultra-short-term {label} prediction markets on Polymarket.",
  "",
  "MARKET: {question}",
  "Time remaining until resolution: {timeRemaining} seconds",
  "Price to beat ({ticker}/USD at market open): {priceToBeat}",
  "",
  "── LIVE BINANCE DATA ──────────────────────────────────────────────",
  "UTC time        : {utcTime}",
  "Current {ticker}/USD : {currentPrice}",
  "Gap             : {gapSign}{gap} ({gapPct}%) — {ticker} is {direction} the target",
  "Gap at candle close (newest→oldest): {gapTrendBlock}",
  "Momentum        : {momentumSign}{momentum}/min (avg last 3 closed candles)",
  "Avg volatility  : ±{volatility}/min (avg high-low range)",
  "Candle trend    : {bullCount} bullish, {bearCount} bearish of last 5 → {trendLabel}",
  "Expected drift  : {expectedDrift} pts over remaining time at current momentum",
  "",
  "1-min candles newest→oldest (Open / High / Low / Close / Volume):",
  "{candles}",
  "",
  "5-min candles newest→oldest (longer-term trend — overrides 1-min noise):",
  "{candles5m}",
  "",
  "── ORDER BOOK DEPTH (near target ±0.5%) ──────────────────────────",
  "{orderBookBlock}",
  "",
  "── TIGHT ORDER BOOK (within ±0.1% of current spot) ───────────────",
  "{tightBookBlock}",
  "",
  "── VOLUME ANALYSIS ────────────────────────────────────────────────",
  "{volumeBlock}",
  "",
  "── AGGRESSIVE TAKER FLOW (last 60s) ──────────────────────────────",
  "{aggTradesBlock}",
  "",
  "── FUTURES OPEN INTEREST (5m delta) ──────────────────────────────",
  "{openInterestBlock}",
  "",
  "── FUTURES FUNDING RATE ───────────────────────────────────────────",
  "{fundingBlock}",
  "",
  "── BINANCE vs CHAINLINK ORACLE LEAD ──────────────────────────────",
  "{binanceLeadBlock}",
  "",
  "── POLYMARKET ODDS ────────────────────────────────────────────────",
  "UP price  : {upPrice} ({upPct}% implied)",
  "DOWN price: {downPrice} ({downPct}% implied)",
  "UP token trend (newest→oldest cycles): {oddsTrendBlock}",
  "Volume    : {volume}",
  "",
  "── DECISION RULES ─────────────────────────────────────────────────",
  "FRAMING: Always determine the LIKELY WINNER first, then check if the market underprices it.",
  "  • If gap > 0 (price ABOVE target): UP is currently winning. Bet UP if trend supports it.",
  "  • If gap < 0 (price BELOW target): DOWN is currently winning. Bet DOWN if trend supports it.",
  "  • If gap is near zero but trend is STRONG: the trend will decide — bet in the trend direction.",
  "  BUY_UP and BUY_DOWN are fully symmetric. Never default to SKIP just because candles are bearish.",
  "",
  "1. All 5 candles in same direction AND gap is in OPPOSITE direction → very likely gap will flip.",
  "   If price is above target but 5/5 bearish → price is heading below target → consider BUY_DOWN.",
  "   If price is below target but 5/5 bullish → price is heading above target → consider BUY_UP.",
  "   EXCEPTION: if |gap| > 10× avg volatility (gap is enormous), skip — not enough time to cross.",
  "2. HARD STOP — timeRemaining > 300s AND momentum opposes gap AND |momentum| > {momentumThreshold}/min",
  "   AND effective gap after drift stays on same side as current gap → SKIP (gap won't flip, trend not enough).",
  "   EXCEPTION: if effective gap flips sign, this is a BUY in the momentum direction, not a SKIP.",
  "3. Effective gap = gap + expectedDrift.",
  "   If effective gap is positive → UP is likely to win → evaluate BUY_UP.",
  "   If effective gap is negative → DOWN is likely to win → evaluate BUY_DOWN.",
  "   If effective gap is near zero (|effectiveGap| < 0.03% of price) → too uncertain → SKIP.",
  "3a. BINANCE DIRECTION OVERRIDE: The Binance gap (Binance vs priceToBeat) shown above is more predictive of the",
  "    final oracle resolution than the current oracle gap, because the oracle heartbeats toward Binance every ~25s.",
  "    When Binance gap CONTRADICTS oracle gap direction, USE THE BINANCE GAP as your primary direction signal.",
  "    The 'Implied winner' line above already shows this — trust it. Ignoring the Binance-implied direction when",
  "    it contradicts the oracle is the leading cause of wrong-direction trades.",
  "3b. TINY ORACLE GAP: When |oracle gap| < 1× avg volatility, the oracle gap is within noise — the Binance gap",
  "    and momentum are your only real signals. Hard cap confidence at MEDIUM in this case (oracle timing is uncertain).",
  "4. Near-resolution arb: |gap| > 2× volatility AND timeRemaining < 90s AND market odds ≥ 50% in gap direction → HIGH confidence",
  "   (upPrice ≥ 0.50 for BUY_UP, downPrice ≥ 0.50 for BUY_DOWN. Otherwise market already priced reversal — SKIP.)",
  "5. Aligned: gap direction = momentum direction AND timeRemaining < 300s → MEDIUM/HIGH",
  "6. Market lag: market odds haven't caught up to clear gap+momentum signal → exploit mispricing",
  "7. Too uncertain: |effective gap| < 0.03% of price AND momentum is tiny → SKIP",
  "",
  "8. ORDER BOOK: Bid/ask ratio > 2 near target = strong bid support → reinforces UP. Ratio < 0.5 = strong ask wall → reinforces DOWN. Use as supporting evidence alongside gap+momentum.",
  "9. VOLUME SPIKE: Last candle vol > 2× avg = strong conviction for current trend. Vol < 0.5× avg = weak signal, reduce confidence one level. Normal volume = no adjustment.",
  "10. FUNDING RATE: Rate > +0.05%/8h = overcrowded longs → bearish pressure on price (supports DOWN). Rate < -0.02%/8h = overcrowded shorts → bullish squeeze pressure (supports UP). Near zero = neutral.",
  "10a. AGGRESSIVE TAKER FLOW: Last-60s buy share is the most immediate directional signal — it shows who is paying the spread RIGHT NOW. Buy share > 60% = strong UP pressure (supports BUY_UP). Buy share < 40% = strong DOWN pressure (supports BUY_DOWN). When taker flow CONTRADICTS the 1-min candle direction, trust the flow (candles lag; flow leads). Combine with size ratio: avg buy size > 1.5× avg sell size = larger players are buying (stronger conviction).",
  "10b. OPEN INTEREST: Rising OI + price moving in trade direction = new positions opening, strong conviction → boost confidence by one level (cap at HIGH). Falling OI + price moving in trade direction = short-covering or longs taking profit, trend may exhaust → reduce confidence by one level. OI flat = no positioning signal, use other indicators.",
  "10c. TIGHT BOOK WALLS: Walls within ±0.1% of spot block immediate movement. Tight bid wall = floor at current price (price unlikely to fall through in next 30s, supports UP-side moves and against momentum down-moves). Tight ask wall = ceiling (price unlikely to break through, supports DOWN-side moves and against momentum up-moves). If your signal direction faces a same-side tight wall (e.g. BUY_UP with tight ask wall above), reduce confidence one level — the wall will dampen the move you need.",
  "11. GAP TREND: If gap at candle close is narrowing toward zero across candles, the leader is losing ground and a flip becomes more likely. If gap is widening or stable, the current leader is in control.",
  "12. UP TOKEN TREND: If the UP token price is falling across cycles, market participants are selling UP (bearish signal). If rising, they are buying UP (bullish). Token trend confirms or contradicts the price gap.",
  "13. MOMENTUM TRADE (zero/tiny gap): When |gap| < 0.05% of price BUT |expectedDrift| > 0.15% of price AND 4+ of the last 5 candles align with the momentum direction, this is a valid MOMENTUM TRADE.",
  "    The Polymarket token price tracks the underlying asset live — even before resolution, if {ticker} moves strongly in one direction, that token will rise 20-30%, hitting take-profit before the market closes.",
  "    You are NOT predicting the final resolution. You are predicting that the TOKEN PRICE will swing enough to take profit.",
  "    Rules: signal in momentum direction (BUY_UP if momentum > 0, BUY_DOWN if momentum < 0). Set \"momentum_trade\": true.",
  "    Confidence: HIGH only if 5/5 candles aligned AND volume spike ratio > 1.5 AND |Binance gap| > 1× avg volatility. MEDIUM if 4/5 candles aligned OR volume is normal OR Binance gap is small.",
  "    SKIP if timeRemaining < 150s (not enough drift time) or if candle trend contradicts momentum direction.",
  "    This is independent of gap direction — you're trading the MOVE, not the final score.",
  "",
  "",
  "── HARD FLOORS (these override everything above — no exceptions) ──",
  "H1. ENTRY PRICE FLOOR: If the token you would buy (BUY_UP→upPrice, BUY_DOWN→downPrice) is below 0.30,",
  "    the crowd is ≥70% against you.  Signal SKIP regardless of gap/momentum.  At 19¢ entry you need to 5x",
  "    your edge just to break even in expectation — almost never worth it in a 5-15 min window.",
  "H2. GAP-VS-VOLATILITY FLOOR: |effectiveGap| must exceed 1× avg volatility to be tradeable.",
  "    If effectiveGap is within one volatility unit, the gap is within normal price noise and the outcome",
  "    is essentially a coin-flip.  Signal SKIP.",
  "H3. AGAINST-GAP STRICTNESS: If you are betting AGAINST the current gap direction (gap sign ≠ signal direction,",
  "    e.g. gap is +$34 UP winning but you call BUY_DOWN), require |effectiveGap| > 2× volatility AND 5-min",
  "    candles confirming the reversal trend.  Otherwise SKIP — momentum forecasts reverse often enough that",
  "    without 5-min confirmation these trades are negative-EV.",
  "",
  "Bet only when estimated true probability exceeds 60%. When in doubt, SKIP.",
  "",
  'Respond ONLY as JSON (no markdown, no extra text):',
  '{',
  '  "signal": "BUY_UP" | "BUY_DOWN" | "SKIP",',
  '  "confidence": "LOW" | "MEDIUM" | "HIGH",',
  '  "edge": <estimated true prob minus market price, e.g. 0.12>,',
  '  "momentum_trade": <true if this is a momentum trade on tiny/zero gap, false otherwise>,',
  '  "reasoning": "<max 2 sentences>"',
  '}',
].join("\n");

async function analyzeCryptoMarket(market, cryptoData, anthropicKey, { model = "claude-haiku-4-5-20251001", signal, useH1Floor = true } = {}, asset = "btc") {
  const cfg = CRYPTO_CONFIG[asset];
  const { candles, spot, priceToBeat, oddsHistory } = cryptoData;
  const timeRemaining = Math.round((new Date(market.endDate) - Date.now()) / 1000);
  const gap       = spot - priceToBeat;
  const gapPct    = ((gap / priceToBeat) * 100);
  const direction = gap >= 0 ? "ABOVE" : "BELOW";

  // Use completed candles (skip index 0 = current, possibly incomplete)
  const refCandles = candles.slice(1, 4);
  const momentum   = refCandles.length
    ? refCandles.reduce((s, c) => s + (c.close - c.open), 0) / refCandles.length
    : 0;
  const volatility = refCandles.length
    ? refCandles.reduce((s, c) => s + (c.high - c.low), 0) / refCandles.length
    : 0;

  // Candle direction count (last 5) for trend awareness
  const last5 = candles.slice(0, 5);
  const bullCount = last5.filter(c => c.close > c.open).length;
  const bearCount = last5.filter(c => c.close < c.open).length;
  const trendLabel = bullCount > bearCount ? "bullish trend" : bearCount > bullCount ? "bearish trend" : "mixed";

  const expectedDrift = momentum * (timeRemaining / 60);

  // Relative momentum threshold: ~0.007% of spot (≈5 for BTC@70k, ≈0.24 for ETH@3500, ≈0.01 for SOL@150)
  const momentumThreshold = (spot * 0.00007).toFixed(3);

  // Price decimals: integers for large prices, 2dp for mid, 3dp for small
  const pd = spot >= 1000 ? 0 : spot >= 10 ? 2 : 3;

  const fmtQty = (q) => q >= 1e6 ? (q/1e6).toFixed(2)+"M" : q >= 1000 ? (q/1000).toFixed(1)+"K" : q.toFixed(2);

  const candleStr = candles.slice(0, 5).map(c => {
    const hh  = c.time.getUTCHours().toString().padStart(2, "0");
    const mm  = c.time.getUTCMinutes().toString().padStart(2, "0");
    const dir = c.close > c.open ? "▲" : c.close < c.open ? "▼" : "→";
    const vol = c.volume != null ? `  Vol=${fmtQty(c.volume)}` : "";
    return `  ${hh}:${mm}  O=${c.open.toFixed(pd)} H=${c.high.toFixed(pd)} L=${c.low.toFixed(pd)} C=${c.close.toFixed(pd)} ${dir}${vol}`;
  }).join("\n");

  // 5-min candles for trend confirmation (against-gap trades require 5m alignment)
  const candles5m = cryptoData.candles5m ?? null;
  let candles5mStr = "N/A (fetch failed)";
  if (candles5m && candles5m.length > 0) {
    const c5mBull = candles5m.filter(c => c.close > c.open).length;
    const c5mBear = candles5m.filter(c => c.close < c.open).length;
    const c5mTrend = c5mBull > c5mBear ? "bullish" : c5mBear > c5mBull ? "bearish" : "mixed";
    candles5mStr = candles5m.map(c => {
      const hh  = c.time.getUTCHours().toString().padStart(2, "0");
      const mm  = c.time.getUTCMinutes().toString().padStart(2, "0");
      const dir = c.close > c.open ? "▲" : c.close < c.open ? "▼" : "→";
      return `  ${hh}:${mm}  O=${c.open.toFixed(pd)} H=${c.high.toFixed(pd)} L=${c.low.toFixed(pd)} C=${c.close.toFixed(pd)} ${dir}`;
    }).join("\n") + `\n  Overall 5m trend: ${c5mTrend} (${c5mBull}▲ / ${c5mBear}▼ of ${candles5m.length})`;
  }

  // UTC time (session context: thin liquidity at night vs active US/EU hours)
  const utcTime = new Date().toUTCString().replace(/^.*, /, "").replace(/ GMT$/, " UTC");

  // Gap trend: gap (price vs target) at each candle close, newest→oldest.
  // Shows whether the gap is stable, narrowing (leader losing ground), or widening.
  const gapAtCloses = candles.slice(0, 5).map(c => {
    const g = c.close - priceToBeat;
    return (g >= 0 ? "+" : "") + g.toFixed(pd);
  });
  const gapVals = gapAtCloses.map(parseFloat);
  const avgDelta = gapVals.slice(0, -1).reduce((s, g, i) => s + (g - gapVals[i + 1]), 0) / (gapVals.length - 1);
  const gapTrendLabel = Math.abs(avgDelta) < spot * 0.00004
    ? "stable"
    : avgDelta * Math.sign(gap) > 0
      ? "widening (leader strengthening)"
      : "narrowing (leader losing ground)";
  const gapTrendBlock = `${gapAtCloses.join(", ")}  → ${gapTrendLabel}`;

  // Polymarket UP token price trend: last 3 observed prices, newest→oldest.
  // Rising = market buying UP; falling = market selling UP.
  let oddsTrendBlock = "N/A (first observation)";
  if (oddsHistory && oddsHistory.length >= 2) {
    const trendPcts = oddsHistory.map(o => (o.up * 100).toFixed(1) + "%");
    const delta = oddsHistory[0].up - oddsHistory[oddsHistory.length - 1].up;
    const trendDir = Math.abs(delta) < 0.01 ? "stable"
                   : delta > 0 ? `rising +${(delta * 100).toFixed(1)}% (market buying UP)`
                   : `falling ${(delta * 100).toFixed(1)}% (market selling UP)`;
    oddsTrendBlock = `${trendPcts.join(" → ")}  (${trendDir})`;
  }

  // Order book block
  let orderBookBlock = "N/A (unavailable)";
  if (cryptoData.orderBook) {
    const ob = analyzeOrderBook(cryptoData.orderBook, priceToBeat);
    const lbStr = ob.largestBid.qty > 0
      ? `${fmtQty(ob.largestBid.qty)} @ ${ob.largestBid.price.toFixed(pd)}`
      : "none";
    const laStr = ob.largestAsk.qty > 0
      ? `${fmtQty(ob.largestAsk.qty)} @ ${ob.largestAsk.price.toFixed(pd)}`
      : "none";
    orderBookBlock = [
      `Bids below target: ${fmtQty(ob.bidQty)} total | Asks above target: ${fmtQty(ob.askQty)} total | Ratio: ${ob.ratio.toFixed(2)}x`,
      `Largest bid wall: ${lbStr} | Largest ask wall: ${laStr}`,
      `Signal: ${ob.signal}`,
    ].join("\n");
  }

  // Volume spike block
  let volumeBlock = "N/A";
  const volSpike = analyzeVolumeSpike(candles);
  if (volSpike) {
    volumeBlock = `Last 1-min vol: ${fmtQty(volSpike.recentVol)} | 4-min avg: ${fmtQty(volSpike.avgVol)} | Spike ratio: ${volSpike.ratio.toFixed(2)}x → ${volSpike.signal}`;
  }

  // Binance vs Chainlink oracle lead block
  // Chainlink heartbeats every ~20-27s (or on 0.5% deviation). When Binance has moved
  // further than Chainlink in the gap direction, the next oracle tick will likely widen
  // the gap; when Binance has reversed toward target, the oracle may be near its peak.
  let binanceLeadBlock = "N/A (Chainlink not yet synced)";
  const binanceLead = cryptoData.binanceLead;
  if (binanceLead != null) {
    const binanceSpotVal = spot + binanceLead;  // spot is already Chainlink; recover Binance
    const binanceGap  = binanceSpotVal - priceToBeat;
    const oracleGap   = gap;  // spot - priceToBeat (Chainlink)
    const leadDir     = binanceLead >= 0 ? "above" : "below";
    const leadSign    = binanceLead >= 0 ? "+" : "";
    const gapConf     = Math.sign(binanceGap) === Math.sign(oracleGap)
      ? "confirms" : "CONTRADICTS";
    const impliedWinner = binanceGap > 0 ? "UP" : binanceGap < 0 ? "DOWN" : "TIED";
    const oracleWinner  = oracleGap  > 0 ? "UP" : oracleGap  < 0 ? "DOWN" : "TIED";
    binanceLeadBlock = [
      `Binance live  : ${binanceSpotVal.toFixed(pd)} | Oracle/Chainlink: ${spot.toFixed(pd)} | Lead: ${leadSign}${binanceLead.toFixed(pd)} (Binance is ${Math.abs(binanceLead).toFixed(pd)} ${leadDir} oracle)`,
      `Binance gap   : ${binanceGap >= 0 ? "+" : ""}${binanceGap.toFixed(pd)} vs priceToBeat | Oracle gap: ${oracleGap >= 0 ? "+" : ""}${oracleGap.toFixed(pd)} — Binance ${gapConf} oracle direction`,
      `Implied winner: ${impliedWinner} (Binance-based) vs ${oracleWinner} (oracle-based)${gapConf === "CONTRADICTS" ? " ← CONFLICT: use Binance as primary direction, oracle is lagging" : " ← both agree"}`,
    ].join("\n");
  }

  // Funding rate block
  let fundingBlock = "N/A (unavailable)";
  if (cryptoData.fundingRate != null) {
    const fr    = cryptoData.fundingRate;
    const frPct = (fr * 100).toFixed(4);
    let frSignal;
    if      (fr >  0.0005)  frSignal = "high positive — overcrowded longs, bearish pressure on spot";
    else if (fr >  0.0001)  frSignal = "mildly positive — longs paying, slight bearish lean";
    else if (fr < -0.0002)  frSignal = "negative — shorts paying, bullish squeeze pressure";
    else                    frSignal = "near neutral — no strong positioning skew";
    fundingBlock = `${frPct}%/8h → ${frSignal}`;
  }

  // Aggressive trades buy/sell pressure block (last 60s)
  let aggTradesBlock = "N/A (unavailable)";
  const aggTrades = analyzeAggTrades(cryptoData.aggTrades);
  if (aggTrades) {
    aggTradesBlock = [
      `Last 60s: ${aggTrades.buyCount} aggressive buys (${fmtQty(aggTrades.buyVol)}) | ${aggTrades.sellCount} aggressive sells (${fmtQty(aggTrades.sellVol)})`,
      `Buy share: ${(aggTrades.buyPct * 100).toFixed(1)}% of taker volume | Avg buy size: ${fmtQty(aggTrades.avgBuy)} | Avg sell size: ${fmtQty(aggTrades.avgSell)} (size ratio ${aggTrades.sizeRatio.toFixed(2)}x)`,
      `Signal: ${aggTrades.signal}`,
    ].join("\n");
  }

  // Open interest delta block (futures conviction signal)
  let openInterestBlock = "N/A (unavailable)";
  const oi = cryptoData.openInterest;
  if (oi) {
    const pctStr  = (oi.pctChange >= 0 ? "+" : "") + oi.pctChange.toFixed(2) + "%";
    let oiSignal;
    if      (oi.pctChange >  0.5) oiSignal = "rising fast — new positions opening (conviction building)";
    else if (oi.pctChange >  0.1) oiSignal = "slight rise — modest new positioning";
    else if (oi.pctChange < -0.5) oiSignal = "falling fast — positions closing (trend may be exhausting / short-covering rally)";
    else if (oi.pctChange < -0.1) oiSignal = "slight fall — modest deleveraging";
    else                          oiSignal = "flat — no positioning shift";
    openInterestBlock = `OI: ${fmtQty(oi.current)} (was ${fmtQty(oi.previous)} 5min ago) | Change: ${pctStr} → ${oiSignal}`;
  }

  // Tight-range order book block (±0.1% around current spot — immediate walls)
  let tightBookBlock = "N/A (unavailable)";
  if (cryptoData.orderBook) {
    const tb = analyzeTightBook(cryptoData.orderBook, spot);
    if (tb) {
      tightBookBlock = `Within ±0.1% of spot: bids ${fmtQty(tb.bidQty)} | asks ${fmtQty(tb.askQty)} | Ratio ${tb.ratio.toFixed(2)}x → ${tb.signal}`;
    }
  }

  const prompt = CRYPTO_PROMPT
    .replace(/{label}/g,            cfg.label)
    .replace(/{ticker}/g,           cfg.ticker)
    .replace("{question}",          market.question)
    .replace("{timeRemaining}",     String(timeRemaining))
    .replace("{priceToBeat}",       priceToBeat.toFixed(pd))
    .replace("{currentPrice}",      spot.toFixed(pd))
    .replace("{gapSign}",           gap >= 0 ? "+" : "-")
    .replace("{gap}",               Math.abs(gap).toFixed(pd))
    .replace("{gapPct}",            (gap >= 0 ? "+" : "") + gapPct.toFixed(3) + "%")
    .replace("{direction}",         direction)
    .replace("{momentumSign}",      momentum >= 0 ? "+" : "")
    .replace("{momentum}",          momentum.toFixed(pd))
    .replace("{volatility}",        volatility.toFixed(pd))
    .replace("{bullCount}",         String(bullCount))
    .replace("{bearCount}",         String(bearCount))
    .replace("{trendLabel}",        trendLabel)
    .replace("{expectedDrift}",     (expectedDrift >= 0 ? "+" : "") + expectedDrift.toFixed(pd))
    .replace("{candles}",           candleStr)
    .replace("{candles5m}",         candles5mStr)
    .replace("{orderBookBlock}",    orderBookBlock)
    .replace("{utcTime}",           utcTime)
    .replace("{gapTrendBlock}",     gapTrendBlock)
    .replace("{oddsTrendBlock}",    oddsTrendBlock)
    .replace("{volumeBlock}",       volumeBlock)
    .replace("{fundingBlock}",      fundingBlock)
    .replace("{aggTradesBlock}",    aggTradesBlock)
    .replace("{openInterestBlock}", openInterestBlock)
    .replace("{tightBookBlock}",    tightBookBlock)
    .replace("{binanceLeadBlock}",  binanceLeadBlock)
    .replace("{upPrice}",           market.upPrice.toFixed(3))
    .replace("{upPct}",             (market.upPrice * 100).toFixed(1))
    .replace("{downPrice}",         market.downPrice.toFixed(3))
    .replace("{downPct}",           (market.downPrice * 100).toFixed(1))
    .replace("{volume}",            fmtQty(market.volume))
    .replace("{momentumThreshold}", momentumThreshold);

  const metrics = { gap, volatility, timeRemaining, momentum, spot, priceToBeat, volSpikeRatio: volSpike?.ratio ?? null };

  if (!anthropicKey) return analyzeCryptoHeuristic(market, metrics);

  const fetchBody = JSON.stringify({
    model,
    max_tokens: 512,
    messages: [{ role: "user", content: prompt }],
  });

  let resp;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, attempt * 2000));
    resp = await fetch(ANTHROPIC_API, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": anthropicKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: fetchBody,
      signal,
    });
    if (resp.ok || resp.status !== 529) break;
    if (typeof logEntry === "function") logEntry("warn", `  ${cfg.ticker} analysis overloaded — retry ${attempt + 1}/2…`);
  }

  if (!resp.ok) {
    const err = await resp.text();
    const isBilling = [400, 401, 402, 403].includes(resp.status);
    if (isBilling) {
      console.warn(`Claude ${cfg.ticker} ${resp.status} — heuristic fallback`);
      if (typeof logEntry === "function") logEntry("warn", `<span class="red">⚠ Anthropic API ${resp.status} — no AI analysis (check key/credits), using heuristic fallback</span>`);
      return analyzeCryptoHeuristic(market, metrics);
    }
    throw new Error(`Claude ${cfg.ticker} ${resp.status}: ${err.slice(0, 100)}`);
  }

  const data = await resp.json();
  return parseCryptoResponse(data.content[0].text.trim(), market, metrics, useH1Floor);
}

const analyzeBtcMarket = (market, data, key, opts) => analyzeCryptoMarket(market, data, key, opts, "btc");

function analyzeCryptoHeuristic(market, { gap, volatility, timeRemaining, momentum, spot }) {
  const expectedDrift  = momentum * (timeRemaining / 60);
  const effectiveGap   = gap + expectedDrift;
  const gapToVol       = volatility > 0 ? Math.abs(effectiveGap) / volatility : 0;
  const momentumConflicts = Math.sign(momentum) !== 0 && Math.sign(momentum) !== Math.sign(gap);
  const momThreshold   = (spot || 70000) * 0.00007;

  let signal = "SKIP", confidence = "LOW", edge = 0;

  if (momentumConflicts && timeRemaining > 300 && Math.abs(momentum) > momThreshold) {
    // strong conflicting momentum with lots of time → SKIP
  } else if (effectiveGap * gap <= 0) {
    // expected drift erases or flips the gap → SKIP
  } else if (gapToVol > 2 && timeRemaining < 90) {
    signal     = gap > 0 ? "BUY_UP" : "BUY_DOWN";
    confidence = "HIGH";
    edge       = gap > 0 ? Math.max(0, 0.9 - market.upPrice) : Math.max(0, 0.9 - market.downPrice);
  } else if (gapToVol > 1.5 && timeRemaining < 120 && !momentumConflicts) {
    signal     = gap > 0 ? "BUY_UP" : "BUY_DOWN";
    confidence = "MEDIUM";
    edge       = gap > 0 ? Math.max(0, 0.72 - market.upPrice) : Math.max(0, 0.72 - market.downPrice);
  }

  return {
    market, signal, confidence, edge, absEdge: Math.abs(edge),
    reasoning:     `Heuristic: gap=${gap.toFixed(2)}, effGap=${effectiveGap.toFixed(2)}, vol=±${volatility.toFixed(2)}, ${timeRemaining}s left`,
    timeRemaining, gap, priceToBeat: null, spot: null,
    momentum, volatility, volSpikeRatio: null,
  };
}

const analyzeBtcHeuristic = (market, metrics) => analyzeCryptoHeuristic(market, { ...metrics, spot: metrics.spot || 70000 });

function parseCryptoResponse(raw, market, metrics, useH1Floor = true) {
  let text = raw;
  if (text.startsWith("```")) {
    text = text.split("```")[1];
    if (text.startsWith("json")) text = text.slice(4);
  }

  let parsed;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("Crypto JSON parse failed: " + text.slice(0, 80)); }

  let signal       = ["BUY_UP", "BUY_DOWN", "SKIP"].includes(parsed.signal) ? parsed.signal : "SKIP";
  let confidence   = (parsed.confidence || "LOW").toUpperCase();
  if (!["LOW", "MEDIUM", "HIGH"].includes(confidence)) confidence = "LOW";
  const edge         = parseFloat(parsed.edge) || 0;
  const momentumTrade = !!parsed.momentum_trade && signal !== "SKIP";

  const { gap, momentum, timeRemaining, volatility, spot } = metrics;
  const expectedDrift     = (momentum ?? 0) * (timeRemaining / 60);
  const effectiveGap      = gap + expectedDrift;
  const momentumConflicts = momentum != null && Math.sign(momentum) !== 0 && Math.sign(momentum) !== Math.sign(gap);

  const vol          = volatility ?? 0;
  const gapDominant  = vol > 0 && Math.abs(effectiveGap) > 3 * vol;
  const momThreshold = (spot || 70000) * 0.00007;

  if (signal !== "SKIP") {
    // ── Hard floor H1: entry price floor ─────────────────────────
    // If the token we'd buy is priced below 30¢, the crowd is ≥70% against us.
    const entryPrice = signal === "BUY_UP" ? market.upPrice : market.downPrice;
    if (entryPrice < 0.30) {
      signal = "SKIP"; confidence = "LOW";
    }
  }

  if (signal !== "SKIP") {
    // ── Hard floor H2: effective gap must exceed 1× volatility ───
    // If effectiveGap is within noise (< 1 volatility unit), the outcome is
    // essentially random — no edge to exploit.
    if (vol > 0 && Math.abs(effectiveGap) < vol) {
      signal = "SKIP"; confidence = "LOW";
    }
  }

  if (signal !== "SKIP") {
    if (effectiveGap * gap <= 0) {
      // Effective gap has flipped sign — momentum will drive price across the target.
      // This is the gap-flip trade.  Allow it when:
      //   1. The AI is betting WITH the effective-gap direction (not against it), AND
      //   2. The flip is large enough to be meaningful (> 0.03% of price).
      // Both failing → SKIP (signal contradicts data, or flip is noise-level).
      const minFlip  = (spot || 70000) * 0.0003;   // 0.03% of price (~$20 BTC, $0.60 ETH, $0.025 SOL)
      const aiWithFlip = (effectiveGap < 0 && signal === "BUY_DOWN") ||
                         (effectiveGap > 0 && signal === "BUY_UP");
      if (!aiWithFlip || Math.abs(effectiveGap) < minFlip) {
        signal = "SKIP"; confidence = "LOW";
      }
      // else: gap-flip trade confirmed — keep AI signal unchanged
    }
    else if (!gapDominant && momentumConflicts && timeRemaining > 180 && Math.abs(momentum) > momThreshold) {
      signal = "SKIP"; confidence = "LOW";
    }
    else if (momentumConflicts && timeRemaining > 200 && confidence === "HIGH") {
      confidence = "MEDIUM";
    }
  }

  return {
    market, signal, confidence, edge, absEdge: Math.abs(edge),
    reasoning:    parsed.reasoning || "",
    timeRemaining,
    gap,
    priceToBeat:   metrics.priceToBeat,
    spot:          metrics.spot,
    momentum:      metrics.momentum,
    volatility:    metrics.volatility,
    volSpikeRatio: metrics.volSpikeRatio,
    momentumTrade,
  };
}

const parseBtcResponse = parseCryptoResponse;
