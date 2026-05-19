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
  "── POLYMARKET CROWD POSITION (primary signal) ────────────────────",
  "UP price  : {upPrice} ({upPct}% implied)",
  "DOWN price: {downPrice} ({downPct}% implied)",
  "UP token trend (newest→oldest cycles): {oddsTrendBlock}",
  "Volume    : {volume}",
  "",
  "── POLYMARKET ORDER BOOK (UP token CLOB) ─────────────────────────",
  "{polyOrderBookBlock}",
  "",
  "── BINANCE REALITY CHECK (confirmer) ─────────────────────────────",
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
  "── BINANCE ORDER BOOK (near target ±0.5%) ────────────────────────",
  "{orderBookBlock}",
  "",
  "── VOLUME ANALYSIS ────────────────────────────────────────────────",
  "{volumeBlock}",
  "",
  "── FUTURES FUNDING RATE ───────────────────────────────────────────",
  "{fundingBlock}",
  "",
  "── DECISION FRAMEWORK ─────────────────────────────────────────────",
  "",
  "STEP 1 — IDENTIFY THE CROWD LEADER",
  "  UP price > DOWN price → crowd leader = UP (participants expect {ticker} to close ABOVE target)",
  "  DOWN price > UP price → crowd leader = DOWN (participants expect {ticker} to close BELOW target)",
  "  Prices within 5pp of 50/50 → crowd is uncertain → skip to STEP 3C",
  "",
  "STEP 2 — DOES BINANCE CONFIRM OR CONTRADICT THE CROWD?",
  "  Effective gap = current gap + expectedDrift",
  "  CONFIRM:     effective gap direction matches crowd leader AND candle/momentum support it",
  "  CONTRADICT:  effective gap direction opposes crowd leader, OR candle trend (4+/5) strongly disagrees",
  "  WEAK/MIXED:  effective gap is tiny (|effectiveGap| < 0.03% of price) or signals conflict",
  "",
  "STEP 3 — TRADE DECISION",
  "",
  "  A) CONFIRM — bet WITH the crowd:",
  "     Crowd leader = UP + Binance confirms → BUY_UP",
  "     Crowd leader = DOWN + Binance confirms → BUY_DOWN",
  "     • Skip if crowd leader token already > 82% implied (too little upside remaining)",
  "     • Confidence HIGH: strong crowd conviction (gap > 15pp) + strong Binance alignment",
  "     • Confidence MEDIUM: moderate conviction or one signal weaker",
  "",
  "  B) FADE — bet AGAINST the crowd when Binance clearly contradicts:",
  "     Crowd leader = UP + {ticker} clearly heading down (negative effective gap, 4+/5 bearish) → BUY_DOWN",
  "     Crowd leader = DOWN + {ticker} clearly heading up (positive effective gap, 4+/5 bullish) → BUY_UP",
  "     • Only fade with a STRONG contradicting signal — never fade on ambiguity",
  "     • Skip if crowd conviction > 75% AND Binance contradiction is borderline",
  "     • Confidence HIGH only if effective gap strongly opposes crowd AND candle trend is unanimous",
  "",
  "  C) UNCERTAIN — crowd near 50/50, Binance decides:",
  "     Positive effective gap (≥ 0.03% of price) → BUY_UP",
  "     Negative effective gap → BUY_DOWN",
  "     Near-zero effective gap → SKIP",
  "",
  "SUPPORTING SIGNALS (adjust confidence, don't override the primary framework):",
  "1. GAP TREND: narrowing gap = leader losing control, flip likely. Widening = leader strengthening.",
  "2. UP TOKEN TREND: falling UP price = crowd shifting DOWN. Rising = crowd moving UP.",
  "   ⚠ HARD DUMP / ⚡ HARD PUMP: aggressive crowd movement overrides weak gap signals.",
  "3. BINANCE ORDER BOOK: bid/ask ratio > 2 near target = strong buy support. < 0.5 = heavy selling.",
  "4. POLYMARKET ORDER BOOK: imbalance > 65% bids = active buying pressure. < 35% = active selling.",
  "   Thin book (< $50 total liquidity) = unreliable, ignore.",
  "5. VOLUME: last candle > 2× avg = conviction move. < 0.5× avg = weak, lower confidence one level.",
  "6. FUNDING RATE: > +0.05%/8h = overcrowded longs → bearish pressure. < -0.02%/8h = bullish squeeze.",
  "7. NEAR-RESOLUTION ARB: timeRemaining < 90s AND |gap| > 2× volatility AND crowd leader matches gap → HIGH confidence in crowd direction.",
  "8. HARD STOP: SKIP if timeRemaining > 300s AND momentum strongly opposes gap AND effective gap stays same side (no flip).",
  "9. MOMENTUM TRADE (crowd near 50/50 AND near-zero gap): if |gap| < 0.05% of price AND |expectedDrift| > 0.15% AND 4+/5 candles aligned → trade the momentum swing, not the resolution. Set momentum_trade: true. SKIP if timeRemaining < 150s.",
  "",
  "Bet only when estimated true probability exceeds 60%. When in doubt, SKIP.",
  "",
  'Respond ONLY as JSON (no markdown, no extra text):',
  '{',
  '  "signal": "BUY_UP" | "BUY_DOWN" | "SKIP",',
  '  "confidence": "LOW" | "MEDIUM" | "HIGH",',
  '  "edge": <estimated true prob minus market price, e.g. 0.12>,',
  '  "momentum_trade": <true if this is a momentum trade on tiny/zero gap, false otherwise>,',
  '  "reasoning": "<max 2 sentences, start with CONFIRM/FADE/UNCERTAIN to show which mode>"',
  '}',
].join("\n");

async function analyzeCryptoMarket(market, cryptoData, anthropicKey, { model = "claude-haiku-4-5-20251001", signal } = {}, asset = "btc") {
  const cfg = CRYPTO_CONFIG[asset];
  const { candles, spot, priceToBeat, oddsHistory, momentumFilterThreshold = 7, polyOrderBook = null } = cryptoData;
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
    const elapsedSecs = Math.max((oddsHistory[0].ts - oddsHistory[oddsHistory.length - 1].ts) / 1000, 1);
    const trendDir = Math.abs(delta) < 0.01 ? "stable"
                   : delta > 0 ? `rising +${(delta * 100).toFixed(1)}% (market buying UP)`
                   : `falling ${(delta * 100).toFixed(1)}% (market selling UP)`;
    oddsTrendBlock = `${trendPcts.join(" → ")}  (${trendDir})`;
    // Hard dump/pump alert: append when the move exceeds the configured threshold
    const dumpThreshold = momentumFilterThreshold / 100;
    if (delta <= -dumpThreshold) {
      oddsTrendBlock += `\n⚠ HARD DUMP: UP token fell ${(delta * 100).toFixed(1)}pp in ${elapsedSecs.toFixed(0)}s — crowd aggressively pricing DOWN`;
    } else if (delta >= dumpThreshold) {
      oddsTrendBlock += `\n⚡ HARD PUMP: UP token rose +${(delta * 100).toFixed(1)}pp in ${elapsedSecs.toFixed(0)}s — crowd aggressively pricing UP`;
    }
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

  let polyOrderBookBlock = "N/A (unavailable)";
  if (polyOrderBook && polyOrderBook.bids && polyOrderBook.asks) {
    const { bids, asks } = polyOrderBook;
    const bidNotional = bids.reduce((s, l) => s + l.price * l.size, 0);
    const askNotional = asks.reduce((s, l) => s + l.price * l.size, 0);
    const total = bidNotional + askNotional;
    const bestBid = bids.length > 0 ? (bids[0].price * 100).toFixed(1) : "—";
    const bestAsk = asks.length > 0 ? (asks[0].price * 100).toFixed(1) : "—";
    const spread  = (bids.length > 0 && asks.length > 0) ? ((asks[0].price - bids[0].price) * 100).toFixed(1) : "—";
    const imbalPct = total > 0 ? (bidNotional / total * 100) : 50;
    let imbalSignal;
    if      (imbalPct > 65) imbalSignal = "heavy BUY pressure → bullish";
    else if (imbalPct > 55) imbalSignal = "mild BUY pressure → slightly bullish";
    else if (imbalPct < 35) imbalSignal = "heavy SELL pressure → bearish";
    else if (imbalPct < 45) imbalSignal = "mild SELL pressure → slightly bearish";
    else                    imbalSignal = "balanced → neutral";
    const bidWalls = bids.filter(l => l.price * l.size > 50).map(l => `${(l.price*100).toFixed(1)}¢ ($${(l.price*l.size).toFixed(0)})`);
    const askWalls = asks.filter(l => l.price * l.size > 50).map(l => `${(l.price*100).toFixed(1)}¢ ($${(l.price*l.size).toFixed(0)})`);
    polyOrderBookBlock = [
      `Best bid: ${bestBid}¢ | Best ask: ${bestAsk}¢ | Spread: ${spread}pp`,
      `Bid liquidity: $${bidNotional.toFixed(0)} | Ask liquidity: $${askNotional.toFixed(0)} | Imbalance: ${imbalPct.toFixed(1)}% bids → ${imbalSignal}`,
      bidWalls.length > 0 ? `Bid walls: ${bidWalls.join(", ")}` : "No notable bid walls",
      askWalls.length > 0 ? `Ask walls: ${askWalls.join(", ")}` : "No notable ask walls",
    ].join("\n");
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
    .replace("{orderBookBlock}",    orderBookBlock)
    .replace("{utcTime}",           utcTime)
    .replace("{gapTrendBlock}",     gapTrendBlock)
    .replace("{oddsTrendBlock}",    oddsTrendBlock)
    .replace("{volumeBlock}",       volumeBlock)
    .replace("{fundingBlock}",      fundingBlock)
    .replace("{polyOrderBookBlock}", polyOrderBookBlock)
    .replace("{upPrice}",           market.upPrice.toFixed(3))
    .replace("{upPct}",             (market.upPrice * 100).toFixed(1))
    .replace("{downPrice}",         market.downPrice.toFixed(3))
    .replace("{downPct}",           (market.downPrice * 100).toFixed(1))
    .replace("{volume}",            fmtQty(market.volume))
    .replace("{momentumThreshold}", momentumThreshold);

  const metrics = { gap, volatility, timeRemaining, momentum, spot, priceToBeat, volSpikeRatio: volSpike?.ratio ?? null };

  if (!anthropicKey) return analyzeCryptoHeuristic(market, metrics);

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
    const isBilling = [400, 401, 402, 403].includes(resp.status);
    if (isBilling) {
      console.warn(`Claude ${cfg.ticker} ${resp.status} — heuristic fallback`);
      return analyzeCryptoHeuristic(market, metrics);
    }
    throw new Error(`Claude ${cfg.ticker} ${resp.status}: ${err.slice(0, 100)}`);
  }

  const data = await resp.json();
  return parseCryptoResponse(data.content[0].text.trim(), market, metrics);
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

function parseCryptoResponse(raw, market, metrics) {
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
