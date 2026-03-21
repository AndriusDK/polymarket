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
    time:  new Date(c[0]),
    open:  parseFloat(c[1]),
    high:  parseFloat(c[2]),
    low:   parseFloat(c[3]),
    close: parseFloat(c[4]),
  }));
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

async function fetchCryptoMarkets(asset, { maxMinutes = 20 } = {}) {
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
    markets.push(parsed);
  }

  return {
    markets: markets.sort((a, b) => new Date(a.endDate) - new Date(b.endDate)),
    debug: { total: raw.length, asset: nAsset, inWindow: nAsset, parsed: nParsed },
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
  "Current {ticker}/USD : {currentPrice}",
  "Gap             : {gapSign}{gap} ({gapPct}%) — {ticker} is {direction} the target",
  "Momentum        : {momentumSign}{momentum}/min (avg last 3 closed candles)",
  "Avg volatility  : ±{volatility}/min (avg high-low range)",
  "Candle trend    : {bullCount} bullish, {bearCount} bearish of last 5 → {trendLabel}",
  "Expected drift  : {expectedDrift} pts over remaining time at current momentum",
  "",
  "1-min candles newest→oldest (Open / High / Low / Close):",
  "{candles}",
  "",
  "── POLYMARKET ODDS ────────────────────────────────────────────────",
  "UP price  : {upPrice} ({upPct}% implied)",
  "DOWN price: {downPrice} ({downPct}% implied)",
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
  "4. Near-resolution arb: |gap| > 2× volatility AND timeRemaining < 90s AND market odds ≥ 50% in gap direction → HIGH confidence",
  "   (upPrice ≥ 0.50 for BUY_UP, downPrice ≥ 0.50 for BUY_DOWN. Otherwise market already priced reversal — SKIP.)",
  "5. Aligned: gap direction = momentum direction AND timeRemaining < 300s → MEDIUM/HIGH",
  "6. Market lag: market odds haven't caught up to clear gap+momentum signal → exploit mispricing",
  "7. Too uncertain: |effective gap| < 0.03% of price AND momentum is tiny → SKIP",
  "",
  "Bet only when estimated true probability exceeds 60%. When in doubt, SKIP.",
  "",
  'Respond ONLY as JSON (no markdown, no extra text):',
  '{',
  '  "signal": "BUY_UP" | "BUY_DOWN" | "SKIP",',
  '  "confidence": "LOW" | "MEDIUM" | "HIGH",',
  '  "edge": <estimated true prob minus market price, e.g. 0.12>,',
  '  "reasoning": "<max 2 sentences>"',
  '}',
].join("\n");

async function analyzeCryptoMarket(market, cryptoData, anthropicKey, { model = "claude-haiku-4-5-20251001", signal } = {}, asset = "btc") {
  const cfg = CRYPTO_CONFIG[asset];
  const { candles, spot, priceToBeat } = cryptoData;
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

  const candleStr = candles.slice(0, 5).map(c => {
    const hh = c.time.getUTCHours().toString().padStart(2, "0");
    const mm = c.time.getUTCMinutes().toString().padStart(2, "0");
    const dir = c.close > c.open ? "▲" : c.close < c.open ? "▼" : "→";
    return `  ${hh}:${mm}  O=${c.open.toFixed(pd)} H=${c.high.toFixed(pd)} L=${c.low.toFixed(pd)} C=${c.close.toFixed(pd)} ${dir}`;
  }).join("\n");

  const fmtVol = v => v >= 1e6 ? (v/1e6).toFixed(1)+"M" : v >= 1e3 ? (v/1e3).toFixed(0)+"K" : String(Math.round(v));

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
    .replace("{upPrice}",           market.upPrice.toFixed(3))
    .replace("{upPct}",             (market.upPrice * 100).toFixed(1))
    .replace("{downPrice}",         market.downPrice.toFixed(3))
    .replace("{downPct}",           (market.downPrice * 100).toFixed(1))
    .replace("{volume}",            fmtVol(market.volume))
    .replace("{momentumThreshold}", momentumThreshold);

  const metrics = { gap, volatility, timeRemaining, momentum, spot, priceToBeat };

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
    reasoning: `Heuristic: gap=${gap.toFixed(2)}, effGap=${effectiveGap.toFixed(2)}, vol=±${volatility.toFixed(2)}, ${timeRemaining}s left`,
    timeRemaining, gap, priceToBeat: null, spot: null,
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

  let signal     = ["BUY_UP", "BUY_DOWN", "SKIP"].includes(parsed.signal) ? parsed.signal : "SKIP";
  let confidence = (parsed.confidence || "LOW").toUpperCase();
  if (!["LOW", "MEDIUM", "HIGH"].includes(confidence)) confidence = "LOW";
  const edge = parseFloat(parsed.edge) || 0;

  const { gap, momentum, timeRemaining, volatility, spot } = metrics;
  const expectedDrift     = (momentum ?? 0) * (timeRemaining / 60);
  const effectiveGap      = gap + expectedDrift;
  const momentumConflicts = momentum != null && Math.sign(momentum) !== 0 && Math.sign(momentum) !== Math.sign(gap);

  const vol          = volatility ?? 0;
  const gapDominant  = vol > 0 && Math.abs(effectiveGap) > 3 * vol;
  const momThreshold = (spot || 70000) * 0.00007;

  if (signal !== "SKIP") {
    if (effectiveGap * gap <= 0) {
      signal = "SKIP"; confidence = "LOW";
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
    reasoning: parsed.reasoning || "",
    timeRemaining,
    gap,
    priceToBeat: metrics.priceToBeat,
    spot:        metrics.spot,
  };
}

const parseBtcResponse = parseCryptoResponse;
