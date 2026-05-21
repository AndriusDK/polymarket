/* ═══════════════════════════════════════════════════════════════════
   App Controller — BTC / ETH / SOL 5-min & 15-min trading
   ═══════════════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────────

const state = {
  config: null,
  running: false,
  abortCtrl: null,
  stats: { trades: 0, spent: 0 },
  trades: [],          // open positions
  sessionPnl: 0,
  realizedPnl: 0,
  wins: 0,
  losses: 0,
  sessionStart: Date.now(),
  bootTime: null,      // set when first asset starts; used for startup cooldown
  btc: { timer: null, analyzed: new Map(), gapWatch: new Map(), gapPending: new Map(), pendingCheckTimer: null, accelTimer: null, running: false, oddsHistory: new Map(), volTrack: new Map(), pendingLimitOrders: new Map(), sweptWindows: new Set() },  // conditionId → endDateMs
  eth: { timer: null, analyzed: new Map(), gapWatch: new Map(), gapPending: new Map(), pendingCheckTimer: null, accelTimer: null, running: false, oddsHistory: new Map(), volTrack: new Map(), pendingLimitOrders: new Map(), sweptWindows: new Set() },
  sol: { timer: null, analyzed: new Map(), gapWatch: new Map(), gapPending: new Map(), pendingCheckTimer: null, accelTimer: null, running: false, oddsHistory: new Map(), volTrack: new Map(), pendingLimitOrders: new Map(), sweptWindows: new Set() },
  xrp: { timer: null, analyzed: new Map(), gapWatch: new Map(), gapPending: new Map(), pendingCheckTimer: null, accelTimer: null, running: false, oddsHistory: new Map(), volTrack: new Map(), pendingLimitOrders: new Map(), sweptWindows: new Set() },
  tradeHistory: [],    // { ts, pnl, asset, reason } — every closed position, used by profit chart
  recentStops: [],     // timestamps of recent stop-loss events (any asset) for stress detection
  stressHoldUntil: 0, // epoch ms: new entries blocked until this time (market-stress cool-down)
  consecutiveStops: 0, // count of consecutive stop losses — resets on any non-stop close
  stopCooldownActive: false, // true = skip next 1 trade window (crash phase circuit breaker)
  chainlinkPrices:   { btc: null, eth: null, sol: null, xrp: null }, // live Chainlink prices from RTDS
  chainlinkPricesAt: { btc: 0,    eth: 0,    sol: 0,    xrp: 0    }, // epoch ms of last update per asset
};

// ── DOM refs ─────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// ── Screen switching ─────────────────────────────────────────────

function showScreen(id) {
  $$(".screen").forEach(s => s.classList.remove("active"));
  $(`#${id}`).classList.add("active");
}

// ── Clock ────────────────────────────────────────────────────────

function startClock() {
  const tick = () => {
    const el = $("#header-clock");
    if (el) el.textContent = new Date().toLocaleTimeString('da-DK', {
      timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
    }) + " CPH";
  };
  tick();
  setInterval(tick, 1000);
}

// ── Settings persistence ──────────────────────────────────────────

const SETTINGS_KEY = "polymarket_ai_settings";

// Fields to persist: [elementId, type]
const PERSIST_FIELDS = [
  ["anthropic-key",       "value"],
  ["claude-model",        "value"],
  ["poly-private-key",    "value"],
  ["poly-api-key",        "value"],
  ["poly-api-secret",     "value"],
  ["poly-passphrase",     "value"],
  ["max-bet",             "value"],
  ["min-edge",            "value"],
  ["max-daily",           "value"],
  ["markets-count",       "value"],
  ["take-profit-pct",     "value"],
  ["scalp-tp-pct",        "value"],
  ["trail-arm-pct",       "value"],
  ["trail-lock-pct",      "value"],
  ["stop-grace-sec",      "value"],
  ["min-close-sec",       "value"],
  ["min-market-volume",   "value"],
  ["min-gap-pct",         "value"],
  ["min-entry-odds",      "value"],
  ["max-entry-odds",      "value"],
  ["dry-run-toggle",      "checked"],
  ["btc-max-bet",         "value"],
  ["btc-min-edge",        "value"],
  ["btc-mode-toggle",     "checked"],
  ["eth-max-bet",         "value"],
  ["eth-min-edge",        "value"],
  ["eth-mode-toggle",     "checked"],
  ["sol-max-bet",         "value"],
  ["sol-min-edge",        "value"],
  ["sol-mode-toggle",     "checked"],
  ["xrp-max-bet",         "value"],
  ["xrp-min-edge",        "value"],
  ["xrp-mode-toggle",     "checked"],
  ["trend-sweep-toggle",  "checked"],
  ["trend-sweep-price",   "value"],
  ["trend-sweep-size",    "value"],
  ["ai-maker-toggle",     "checked"],
  ["emergency-fill-exit-toggle", "checked"],
  ["selective-mode-toggle", "checked"],
  ["btc-maker-price",     "value"],
  ["eth-maker-price",     "value"],
  ["sol-maker-price",     "value"],
  ["xrp-maker-price",     "value"],
  ["momentum-filter-toggle",      "checked"],
  ["momentum-filter-threshold",   "value"],
  ["conviction-exit-toggle",      "checked"],
  ["conviction-exit-threshold",   "value"],
  ["stop-cooldown-toggle",        "checked"],
];

function saveSettings() {
  const data = {};
  for (const [id, prop] of PERSIST_FIELDS) {
    const el = $(`#${id}`);
    if (el) data[id] = el[prop];
  }
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(data)); } catch {}
}

function loadSettings() {
  let data;
  try { data = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch {}
  if (!data) return;
  for (const [id, prop] of PERSIST_FIELDS) {
    const el = $(`#${id}`);
    if (el && data[id] !== undefined) el[prop] = data[id];
  }
  // Sync toggle labels after restoring checkboxes
  syncToggleLabel("dry-run-toggle",     "dry-run-label",      ["ON","amber"], ["OFF — LIVE","red"]);
  syncToggleLabel("btc-mode-toggle",    "btc-mode-label",     ["ON","green"], ["OFF","dim"]);
  syncToggleLabel("eth-mode-toggle",    "eth-mode-label",     ["ON","green"], ["OFF","dim"]);
  syncToggleLabel("sol-mode-toggle",    "sol-mode-label",     ["ON","green"], ["OFF","dim"]);
  syncToggleLabel("trend-sweep-toggle", "trend-sweep-label",  ["ON","green"], ["OFF","dim"]);
  syncToggleLabel("ai-maker-toggle",    "ai-maker-label",     ["ON","green"], ["OFF","dim"]);
  syncToggleLabel("emergency-fill-exit-toggle", "emergency-fill-exit-label", ["ON","amber"], ["OFF","dim"]);
  syncToggleLabel("selective-mode-toggle", "selective-mode-label", ["ON","green"], ["OFF","dim"]);
  syncToggleLabel("momentum-filter-toggle",  "momentum-filter-label",  ["ON","green"], ["OFF","dim"]);
  syncToggleLabel("conviction-exit-toggle",  "conviction-exit-label",  ["ON","amber"], ["OFF","dim"]);
  syncToggleLabel("stop-cooldown-toggle",    "stop-cooldown-label",    ["ON","amber"], ["OFF","dim"]);
}

function syncToggleLabel(toggleId, labelId, onState, offState) {
  const el = $(`#${toggleId}`);
  const lbl = $(`#${labelId}`);
  if (!el || !lbl) return;
  const [text, cls] = el.checked ? onState : offState;
  lbl.textContent = text;
  lbl.className = `toggle-status ${cls}`;
}

// ── Setup screen ─────────────────────────────────────────────────

function initSetup() {
  loadSettings();

  $("#dry-run-toggle").addEventListener("change", () =>
    syncToggleLabel("dry-run-toggle", "dry-run-label", ["ON","amber"], ["OFF — LIVE","red"]));
  $("#btc-mode-toggle")?.addEventListener("change", () =>
    syncToggleLabel("btc-mode-toggle", "btc-mode-label", ["ON","green"], ["OFF","dim"]));
  $("#eth-mode-toggle")?.addEventListener("change", () =>
    syncToggleLabel("eth-mode-toggle", "eth-mode-label", ["ON","green"], ["OFF","dim"]));
  $("#sol-mode-toggle")?.addEventListener("change", () =>
    syncToggleLabel("sol-mode-toggle", "sol-mode-label", ["ON","green"], ["OFF","dim"]));
  $("#trend-sweep-toggle")?.addEventListener("change", () =>
    syncToggleLabel("trend-sweep-toggle", "trend-sweep-label", ["ON","green"], ["OFF","dim"]));
  $("#ai-maker-toggle")?.addEventListener("change", () =>
    syncToggleLabel("ai-maker-toggle", "ai-maker-label", ["ON","green"], ["OFF","dim"]));
  $("#emergency-fill-exit-toggle")?.addEventListener("change", () =>
    syncToggleLabel("emergency-fill-exit-toggle", "emergency-fill-exit-label", ["ON","amber"], ["OFF","dim"]));
  $("#selective-mode-toggle")?.addEventListener("change", () =>
    syncToggleLabel("selective-mode-toggle", "selective-mode-label", ["ON","green"], ["OFF","dim"]));
  $("#momentum-filter-toggle")?.addEventListener("change", () =>
    syncToggleLabel("momentum-filter-toggle", "momentum-filter-label", ["ON","green"], ["OFF","dim"]));
  $("#conviction-exit-toggle")?.addEventListener("change", () =>
    syncToggleLabel("conviction-exit-toggle", "conviction-exit-label", ["ON","amber"], ["OFF","dim"]));
  $("#stop-cooldown-toggle")?.addEventListener("change", () =>
    syncToggleLabel("stop-cooldown-toggle", "stop-cooldown-label", ["ON","amber"], ["OFF","dim"]));

  $("#btn-launch").addEventListener("click", () => {
    $("#setup-error").textContent = "";
    saveSettings();

    state.config = {
      anthropicKey:  $("#anthropic-key").value.trim(),
      model:         $("#claude-model")?.value ?? "claude-haiku-4-5-20251001",
      polyPrivateKey: $("#poly-private-key").value.trim(),
      polyApiKey:    $("#poly-api-key").value.trim(),
      polyApiSecret: $("#poly-api-secret").value.trim(),
      polyPassphrase: $("#poly-passphrase").value.trim(),
      maxBet:        parseFloat($("#max-bet").value) || 10,
      minEdge:       parseFloat($("#min-edge").value) || 0.05,
      maxDaily:      parseFloat($("#max-daily").value) || 100,
      dryRun:        $("#dry-run-toggle").checked,
      takeProfitPct:    parseFloat($("#take-profit-pct")?.value) || 50,
      stopLossPct:      parseFloat($("#stop-loss-pct")?.value)   || 25,
      trailArmPct:      parseFloat($("#trail-arm-pct")?.value)   || 15,
      trailLockPct:     parseFloat($("#trail-lock-pct")?.value)  || 40,
      stopGraceSec:     parseFloat($("#stop-grace-sec")?.value)  ?? 10,
      minMarketVolume:  parseFloat($("#min-market-volume")?.value) || 1000,
      minGapPct:        parseFloat($("#min-gap-pct")?.value ?? ""),   // 0 = disabled
      minEntryOdds:     parseFloat($("#min-entry-odds")?.value)    || 10,
      maxEntryOdds:     parseFloat($("#max-entry-odds")?.value)    || 87,
      btcMode:       $("#btc-mode-toggle")?.checked ?? false,
      btcMaxBet:     parseFloat($("#btc-max-bet")?.value) || 5,
      btcMinEdge:    parseFloat($("#btc-min-edge")?.value) || 0.12,
      ethMode:       $("#eth-mode-toggle")?.checked ?? false,
      ethMaxBet:     parseFloat($("#eth-max-bet")?.value) || 5,
      ethMinEdge:    parseFloat($("#eth-min-edge")?.value) || 0.06,
      solMode:       $("#sol-mode-toggle")?.checked ?? false,
      solMaxBet:     parseFloat($("#sol-max-bet")?.value) || 5,
      solMinEdge:    parseFloat($("#sol-min-edge")?.value) || 0.06,
      xrpMode:       $("#xrp-mode-toggle")?.checked ?? false,
      xrpMaxBet:     parseFloat($("#xrp-max-bet")?.value) || 5,
      xrpMinEdge:    parseFloat($("#xrp-min-edge")?.value) || 0.04,
      startupCooldown: parseInt($("#startup-cooldown")?.value) || 90,
      convictionExit:  $("#conviction-exit-toggle")?.checked ?? false,
      convictionExitThreshold: parseFloat($("#conviction-exit-threshold")?.value) || 20,
      stopCooldown:    $("#stop-cooldown-toggle")?.checked ?? false,
      trendSweep:      $("#trend-sweep-toggle")?.checked ?? false,
      trendSweepPrice: parseFloat($("#trend-sweep-price")?.value) || 50,  // cents
      trendSweepSize:  parseFloat($("#trend-sweep-size")?.value)  || 2,   // USDC
      aiMaker:       $("#ai-maker-toggle")?.checked ?? false,
      emergencyFillExit: $("#emergency-fill-exit-toggle")?.checked ?? false,
      selectiveMode:     $("#selective-mode-toggle")?.checked ?? false,
      momentumFilter:          $("#momentum-filter-toggle")?.checked ?? false,
      momentumFilterThreshold: parseFloat($("#momentum-filter-threshold")?.value) || 7,
      btcMakerPrice: parseFloat($("#btc-maker-price")?.value) || 50,
      ethMakerPrice: parseFloat($("#eth-maker-price")?.value) || 50,
      solMakerPrice: parseFloat($("#sol-maker-price")?.value) || 50,
      xrpMakerPrice: parseFloat($("#xrp-maker-price")?.value) || 50,
    };

    initDashboard();
    showScreen("dashboard-screen");
  });
}

// ── Momentum filter ──────────────────────────────────────────────
// Returns { ok: false, delta, elapsedSecs } when the token we're about to buy
// has dropped more than 7pp in the last oddsHistory window — indicating the
// market is actively pricing the outcome down. ok: true means clear to enter.
function checkEntryMomentum(asset, conditionId, signal) {
  const history = state[asset].oddsHistory.get(conditionId) || [];
  if (history.length < 2) return { ok: true };
  const newest = history[0];
  const oldest = history[history.length - 1];
  const elapsedSecs = Math.max((newest.ts - oldest.ts) / 1000, 1);
  // upDelta > 0 = UP token rising; < 0 = UP token falling
  const upDelta = newest.up - oldest.up;
  // entryTokenDelta: the direction we'd be buying — positive is good, negative is a dump
  const entryTokenDelta = signal === "BUY_UP" ? upDelta : -upDelta;
  const threshold = -((state.config?.momentumFilterThreshold ?? 7) / 100);
  if (entryTokenDelta < threshold) {
    return { ok: false, delta: entryTokenDelta, elapsedSecs };
  }
  return { ok: true, delta: entryTokenDelta };
}

// ── Dashboard ────────────────────────────────────────────────────

// Fetches open positions from the Polymarket data API and creates trade cards
// for any active positions the bot didn't place itself this session.
async function syncExistingPositions() {
  const c = state.config;
  if (!c.polyPrivateKey) return;

  let address;
  try {
    const wallet = new ethers.Wallet(c.polyPrivateKey);
    address = wallet.address;
  } catch { return; }

  let positions;
  try {
    const resp = await fetch(`/positions?address=${encodeURIComponent(address)}`);
    if (!resp.ok) return;
    positions = await resp.json();
  } catch { return; }

  if (!Array.isArray(positions) || !positions.length) return;

  let recovered = 0;
  for (const pos of positions) {
    const tokenId = pos.asset || pos.asset_id || pos.token_id;
    const size    = parseFloat(pos.size ?? pos.currentSize ?? "0");
    if (!tokenId || size < 0.01) continue;

    // Skip if this token is already tracked in the current session
    if (state.trades.some(t => t.tokenId === tokenId)) continue;

    // Identify asset from market title
    const title = (pos.title || pos.market || "").toLowerCase();
    let asset;
    if      (title.includes("bitcoin") || title.includes("btc")) asset = "btc";
    else if (title.includes("ethereum") || title.includes("eth")) asset = "eth";
    else if (title.includes("solana")  || title.includes("sol")) asset = "sol";
    else if (title.includes("xrp")) asset = "xrp";
    else continue;

    // Fetch live market details so we have endDate, question, conditionId
    let raw;
    try {
      const mResp = await fetch(
        `/api/gamma/markets?clob_token_ids=${encodeURIComponent(JSON.stringify([tokenId]))}`
      );
      if (!mResp.ok) continue;
      const mArr = await mResp.json();
      if (!Array.isArray(mArr) || !mArr.length) continue;
      raw = mArr[0];
    } catch { continue; }

    const endDate = raw.endDate;
    if (!endDate || new Date(endDate) <= new Date()) continue; // already resolved

    const outcome   = (pos.outcome || "").toLowerCase();
    const signal    = outcome === "up" ? "BUY_UP" : "BUY_DOWN";
    const avgPrice  = parseFloat(pos.avgPrice ?? pos.averagePrice ?? "0") || 0;
    const amount    = avgPrice * size;
    const secsLeft  = Math.max(0, Math.round((new Date(endDate) - Date.now()) / 1000));

    // Resolve conditionId and Up/Down token IDs from the raw market object
    let tokenIds = [];
    try { tokenIds = JSON.parse(raw.clobTokenIds || "[]"); } catch {}
    let outcomes = [];
    try { outcomes = JSON.parse(raw.outcomes || "[]"); } catch {}
    const upIdx   = outcomes.findIndex(o => o.toLowerCase() === "up");
    const downIdx = outcomes.findIndex(o => o.toLowerCase() === "down");
    const upTokenId   = tokenIds[upIdx]   || "";
    const downTokenId = tokenIds[downIdx] || "";
    const resolvedTokenId = signal === "BUY_UP" ? (upTokenId || tokenId) : (downTokenId || tokenId);

    const trade = {
      id:            Date.now() + (state.stats?.trades ?? 0) + recovered,
      time:          new Date().toUTCString().slice(-12, -4),
      question:      raw.question || pos.title || pos.market || "",
      conditionId:   raw.conditionId || raw.id || pos.conditionId || pos.condition_id || "",
      tokenId:       resolvedTokenId,
      signal,
      entryPrice:    avgPrice,
      amount,
      shares:        size,
      currentPrice:  avgPrice,
      peakPrice:     avgPrice,
      troughPrice:   avgPrice,
      confidence:    "LIVE",
      unrealizedPnl: 0,
      mode:          "LIVE",
      type:          asset,
      endDate,
      confirmed:     true,
      spot:          null,
      priceToBeat:   null,
      gap:           null,
      edge:          null,
      reasoning:     "recovered from wallet",
      momentum:      null,
      volatility:    null,
      volSpikeRatio: null,
      signalAgainstGap: false,
      priceHistory:  [],
      totalSecs:     secsLeft,
      entryTime:     Date.now(),
      entryVolume:   raw.volume ?? null,
      marketUrl:     raw.slug ? `https://polymarket.com/event/${raw.slug}` : "",
      exitPrice:     null,
      secsAtClose:   null,
    };

    state.trades.push(trade);
    if (state.stats) state.stats.trades++;
    priceStream.subscribe(resolvedTokenId);
    addCryptoCard(trade);
    startCryptoCountdown();
    recovered++;

    logEntry("amber",
      `↩ RECOVERED — ${signal} ${asset.toUpperCase()} @ ${(avgPrice * 100).toFixed(1)}¢ ` +
      `× ${size.toFixed(2)} shares — ${(trade.question).slice(0, 55)}`
    );
  }

  if (recovered > 0) {
    setStat("positions", String(state.trades.length));
    updatePnlStat();
  }
}

function initDashboard() {
  const c = state.config;

  const activeAssets = ["BTC","ETH","SOL"]
    .filter(a => c[`${a.toLowerCase()}Mode`])
    .map(a => `${a} $${c[`${a.toLowerCase()}MaxBet`]}/trade`)
    .join(" | ");
  $("#header-config").textContent = activeAssets || "BTC / ETH / SOL MODE";

  const modeEl = $("#header-mode");
  modeEl.textContent = c.dryRun ? "◎ DRY RUN" : "⚡ LIVE";
  modeEl.className = "header-mode " + (c.dryRun ? "dry" : "live");

  setStat("budget", `$${c.maxDaily.toFixed(2)}`);

  $("#btn-stop").addEventListener("click", stopBot);
  $("#btn-settings").addEventListener("click", () => {
    stopBot();
    showScreen("setup-screen");
  });
  for (const asset of ["btc", "eth", "sol", "xrp"]) {
    $(`#btn-${asset}`)?.addEventListener("click", () => {
      if (state[asset].timer) stopCryptoMode(asset);
      else startCryptoMode(asset);
    });
  }

  chainlinkStream.connect();
  startClock();
  logEntry("cyan", "POLYMARKET AI TRADING SYSTEM — ONLINE");
  logEntry("dim", "  ◈ Subdivisions: BTC · ETH · SOL  |  Clockwork Angels protocol active");
  logEntry("info",
    `Mode: ${c.dryRun ? "DRY RUN" : "⚡ LIVE"}  |  BTC/ETH/SOL 5-min & 15-min  |  Budget $${c.maxDaily}`
  );
  if (!c.dryRun) {
    console.log("[LIVE] Bot starting in LIVE mode", {
      maxDaily: c.maxDaily,
      btcMode: c.btcMode, btcMaxBet: c.btcMaxBet,
      ethMode: c.ethMode, ethMaxBet: c.ethMaxBet,
      solMode: c.solMode, solMaxBet: c.solMaxBet,
      apiKeyPresent: !!c.polyApiKey,
      apiSecretPresent: !!c.polyApiSecret,
      passphrasePresent: !!c.polyPassphrase,
      privateKeyPresent: !!c.polyPrivateKey,
    });

    // Check that the trade server (server.py) is reachable before any orders fire.
    fetch("/health", { method: "GET" })
      .then(r => r.ok ? r.json() : Promise.reject(r.status))
      .then(() => {
        logEntry("info", "  ✓ Trade server online — live orders ready");
        console.log("[LIVE] Trade server health check passed");
      })
      .catch(() => {
        const msg = "⚠ TRADE SERVER OFFLINE — live orders will fail! " +
                    "SSH in and run: cd /var/www/html/polymarket && " +
                    "nohup /var/www/html/polymarket/venv/bin/python3 server.py &";
        logEntry("warn", msg);
        console.error("[LIVE] Trade server health check FAILED — server.py is not running");
        // Show a persistent alert so it's impossible to miss
        setTimeout(() => alert(
          "⚠️ TRADE SERVER OFFLINE\n\n" +
          "Live orders will silently fail.\n\n" +
          "SSH into your server and run:\n\n" +
          "cd /var/www/html/polymarket\n" +
          "nohup /var/www/html/polymarket/venv/bin/python3 server.py &"
        ), 500);
      });

    // Recover any open positions placed outside this session (e.g. manual Polymarket trades).
    syncExistingPositions();
  }

  for (const asset of ["btc", "eth", "sol", "xrp"]) {
    if (c[`${asset}Mode`]) {
      logEntry("info", `${asset.toUpperCase()} mode: auto-starting…`);
      startCryptoMode(asset);
    }
  }
  if (!c.btcMode && !c.ethMode && !c.solMode && !c.xrpMode) {
    logEntry("info", "Press [⚡ BTC / ETH / SOL / XRP MODE] to start scanning for markets.");
  }
}

// ── Stop ─────────────────────────────────────────────────────────

function stopBot() {
  if (state.abortCtrl) state.abortCtrl.abort();
  for (const asset of ["btc", "eth", "sol", "xrp"]) {
    // Cancel any pending sweep bids so they don't fill after the bot is "stopped"
    for (const conditionId of [...state[asset].pendingLimitOrders.keys()]) {
      cancelTrendSweepOrder(asset, conditionId, "bot stopped");
    }
    stopCryptoMode(asset);
  }
  stopPendingLimitPoll();
  chainlinkStream.disconnect();
  setStat("status", "STOPPED", "amber");
  logEntry("warning", "Bot stopped.");
  setRunning(false);
  releaseWakeLock();
}

// ── UI helpers ───────────────────────────────────────────────────

function setRunning(active) {
  state.running = active;
  const stopBtn = $("#btn-stop");
  if (stopBtn) stopBtn.disabled = !active;
}

function setStat(key, value, color) {
  const el = $(`#stat-${key}`);
  if (!el) return;
  el.textContent = value;
  if (color) el.className = `stat-val ${color}`;
}

function logEntry(type, msg) {
  const log = $("#log-content");
  const time = new Date().toLocaleTimeString('da-DK', {
    timeZone: 'Europe/Copenhagen', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  });
  const div = document.createElement("div");
  div.className = `log-entry ${type}`;
  div.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${msg}</span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function showProgress(visible) {
  $("#progress-wrap")?.classList.toggle("hidden", !visible);
}

// ── Helpers ───────────────────────────────────────────────────────

function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60)  return `${s}s`;
  const m = Math.floor(s / 60), rs = s % 60;
  if (m < 60)  return `${m}m ${rs}s`;
  const h = Math.floor(m / 60), rm = m % 60;
  return `${h}h ${rm}m`;
}

// ── Crypto Position Cards ─────────────────────────────────────────

function addCryptoCard(trade) {
  const emptyEl = $("#btc-empty");
  if (emptyEl) emptyEl.style.display = "none";

  const cards   = $("#btc-cards");
  const div     = document.createElement("div");
  div.id        = `card-${trade.id}`;
  div.className = "btc-card";

  const cfg       = (typeof CRYPTO_CONFIG !== "undefined" && CRYPTO_CONFIG[trade.type]) || { ticker: trade.type.toUpperCase() };
  const ticker    = cfg.ticker;
  const isUp      = trade.signal === "BUY_UP";
  const sigLabel  = isUp ? `▲ ${ticker} UP` : `▼ ${ticker} DOWN`;
  const sigClass  = isUp ? "sig-up" : "sig-down";
  const modeClass = trade.mode === "SIM" ? "amber" : "red";
  const confClass = `conf-${trade.confidence.toLowerCase()}`;
  const secsLeft  = Math.max(0, Math.round((new Date(trade.endDate) - Date.now()) / 1000));
  const pct       = Math.min(100, Math.max(0, (secsLeft / trade.totalSecs) * 100));
  const gap        = trade.gap ?? 0;
  const gapSign    = gap >= 0 ? "+" : "";
  const gapClass   = gap >= 0 ? "green" : "red";
  const edgePct    = trade.edge != null ? `${trade.edge >= 0 ? "+" : ""}${(trade.edge * 100).toFixed(1)}%` : null;
  const spot       = trade.spot ?? 0;
  const priceFmt   = spot >= 1000 ? spot.toFixed(0) : spot.toFixed(2);
  const targetFmt  = (trade.priceToBeat ?? 0) >= 1000 ? (trade.priceToBeat ?? 0).toFixed(0) : (trade.priceToBeat ?? 0).toFixed(2);
  const gapFmt     = spot >= 1000 ? Math.abs(gap).toFixed(0) : Math.abs(gap).toFixed(2);
  const assetClass = `asset-${trade.type}`;
  // Derived display values for analysis fields
  const gapPct     = trade.priceToBeat ? (gap / trade.priceToBeat * 100) : 0;
  const gapPctStr  = `${gapSign}${gapPct.toFixed(2)}%`;
  const momVal     = trade.momentum;
  const momStr     = momVal != null
    ? `${momVal >= 0 ? "+" : ""}${spot >= 1000 ? momVal.toFixed(0) : momVal.toFixed(2)}/m`
    : "—";
  const momClass   = momVal == null ? "dim" : momVal >= 0 ? "green" : "red";

  div.innerHTML = `
    <div class="btc-card-scan"></div>
    <div class="btc-card-head">
      <span class="btc-card-q">${escHtml(trade.question)}</span>
      <div class="btc-card-badges">
        <span class="btc-badge ${assetClass}">${ticker}</span>
        <span class="btc-badge ${modeClass}">${trade.mode}</span>
        <span class="btc-card-cd ${secsLeft < 60 ? "urgent" : ""}" id="cd-${trade.id}">[${secsLeft}s]</span>
      </div>
    </div>
    <div class="btc-timer-bar">
      <div class="btc-timer-track"></div>
      <div class="btc-timer-fill ${secsLeft < 60 ? "urgent" : ""}" id="cdbar-${trade.id}" style="width:${pct}%"></div>
    </div>
    <div class="slip-bar-wrap" id="slipwrap-${trade.id}" style="display:none">
      <div class="slip-bar-fill" id="slipbar-${trade.id}" style="width:100%"></div>
    </div>
    <div class="btc-card-body">
      <div class="btc-card-signal ${sigClass}">${sigLabel}</div>
      <div class="btc-card-stats">
        <div class="btc-kv">
          <span class="btc-k">ENTRY</span>
          <span class="btc-v">${(trade.entryPrice * 100).toFixed(1)}%</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k" id="clabel-${trade.id}">CURRENT</span>
          <span class="btc-v" id="tp-${trade.id}">${(trade.currentPrice * 100).toFixed(1)}%</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">CROWD MOVE</span>
          <span class="btc-v dim" id="crowd-${trade.id}">+0.0pp</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">PEAK</span>
          <span class="btc-v dim" id="peak-${trade.id}">${(trade.peakPrice * 100).toFixed(1)}%</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">LOW</span>
          <span class="btc-v dim" id="trough-${trade.id}">${(trade.troughPrice * 100).toFixed(1)}%</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">STOP DEPTH</span>
          <span class="btc-v dim" id="stopdepth-${trade.id}">—</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">TP TARGET</span>
          <span class="btc-v" style="${trade.aiMakerFill && trade.entryPrice <= 0.40 ? 'color:var(--amber)' : 'opacity:0.5'}">${trade.aiMakerFill && trade.entryPrice <= 0.40 ? `${parseFloat($("#scalp-tp-pct")?.value) || state.config?.scalpTpPct || 3}% (SCALP)` : `${Math.round((parseFloat($("#take-profit-pct")?.value) || state.config?.takeProfitPct || 50))}%`}</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">UNREAL. PnL</span>
          <span class="btc-v dim" id="pnl-${trade.id}">+$0.00</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">SIZE</span>
          <span class="btc-v">$${trade.amount.toFixed(2)}</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">CONFIDENCE</span>
          <span class="btc-v ${confClass}">${trade.confidence}</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">DURATION</span>
          <span class="btc-v dim" id="dur-${trade.id}">0s</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">TIME LEFT</span>
          <span class="btc-v dim" id="sl-${trade.id}">${secsLeft > 0 ? (Math.floor(secsLeft/60) > 0 ? `${Math.floor(secsLeft/60)}m ${String(secsLeft%60).padStart(2,'0')}s` : `${secsLeft}s`) : "—"}</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">GAP %</span>
          <span class="btc-v ${gapClass}">${gapPctStr}</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">MOMENTUM</span>
          <span class="btc-v ${momClass}">${momStr}</span>
        </div>
        ${trade.entryVolume != null ? `
        <div class="btc-kv">
          <span class="btc-k">VOL AT ENTRY</span>
          <span class="btc-v dim">$${trade.entryVolume >= 1000 ? (trade.entryVolume / 1000).toFixed(1) + "k" : trade.entryVolume.toFixed(0)}</span>
        </div>` : ""}
      </div>
    </div>
    <div class="card-chart">
      <svg id="chart-${trade.id}" class="sparkline" viewBox="0 0 300 46" preserveAspectRatio="none">
        <defs>
          <linearGradient id="sg-${trade.id}" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--green)" stop-opacity="0.18"/>
            <stop offset="100%" stop-color="var(--green)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        <line class="spark-entry-line" id="el-${trade.id}" x1="0" y1="23" x2="300" y2="23"/>
        <path class="spark-area" id="sa-${trade.id}" d=""/>
        <path class="spark-line" id="sl-${trade.id}" d=""/>
        <circle class="spark-dot" id="sd-${trade.id}" cx="0" cy="0" r="3"/>
      </svg>
    </div>
    ${trade.reasoning ? `
    <div class="card-reasoning expanded">
      <div class="card-reasoning-head">
        <span class="card-reasoning-label">◈ AI REASONING</span>
        ${edgePct ? `<span class="card-reasoning-edge">EDGE ${edgePct}</span>` : ""}
        <button class="card-reasoning-toggle" onclick="this.closest('.card-reasoning').classList.toggle('expanded')" title="Toggle reasoning">▾</button>
      </div>
      <div class="card-reasoning-body">${escHtml(trade.reasoning)}</div>
    </div>` : ""}
    <div class="btc-card-foot">
      <span>${ticker} $${priceFmt}&nbsp; vs &nbsp;target $${targetFmt}
      &nbsp;|&nbsp; Gap: <span class="${gapClass}">${gapSign}$${gapFmt}</span></span>
      <div style="display:flex;gap:10px;align-items:center">
        ${trade.mode.startsWith("LIVE") ? `<button class="manual-sell-btn" data-id="${trade.id}" title="Sell now at market price">⬛ SELL NOW</button>` : ""}
        <a href="${trade.marketUrl}" target="_blank" rel="noopener" class="btc-market-link">↗ POLYMARKET</a>
      </div>
    </div>
  `;

  cards.insertBefore(div, cards.firstChild);

  // Wire up manual sell button
  const sellBtn = div.querySelector(".manual-sell-btn");
  if (sellBtn) {
    sellBtn.addEventListener("click", () => {
      if (!confirm(`Sell ${trade.type?.toUpperCase()} position now at market price?\n\nCurrent: ${(trade.currentPrice * 100).toFixed(1)}%  |  Unrealized: $${(trade.unrealizedPnl ?? 0).toFixed(2)}`)) return;
      sellBtn.disabled = true;
      sellBtn.textContent = "SELLING…";
      closePosition(trade, "MANUAL");
    });
  }
}

const addBtcCard = addCryptoCard;

function updateSparkline(t) {
  const W = 300, H = 46, PAD = 4;
  const hist = t.priceHistory;
  if (hist.length < 1) return;

  const min   = Math.min(...hist, t.entryPrice);
  const max   = Math.max(...hist, t.entryPrice);
  const range = max - min || 0.001;
  const toY   = v => PAD + (1 - (v - min) / range) * (H - PAD * 2);
  const toX   = i => hist.length < 2 ? W : (i / (hist.length - 1)) * W;

  const entryY = toY(t.entryPrice);
  const isUp   = t.currentPrice >= t.entryPrice;
  const colour = isUp ? "var(--green)" : "var(--red)";

  // entry dashed line
  const el = $(`#el-${t.id}`);
  if (el) { el.setAttribute("y1", entryY); el.setAttribute("y2", entryY); }

  // gradient colour
  const grad = document.getElementById(`sg-${t.id}`);
  if (grad) {
    grad.querySelectorAll("stop").forEach(s => s.setAttribute("stop-color", colour));
  }

  if (hist.length >= 2) {
    const pts = hist.map((v, i) => `${toX(i).toFixed(1)},${toY(v).toFixed(1)}`).join(" ");
    const lastX = toX(hist.length - 1).toFixed(1);
    const lastY = toY(hist[hist.length - 1]).toFixed(1);

    const sl = $(`#sl-${t.id}`);
    if (sl) { sl.setAttribute("d", `M ${pts.replace(/ /g, " L ")}`); sl.style.stroke = colour; }

    const sa = $(`#sa-${t.id}`);
    if (sa) { sa.setAttribute("d", `M 0,${H} L ${pts.replace(/ /g, " L ")} L ${lastX},${H} Z`); sa.setAttribute("fill", `url(#sg-${t.id})`); }

    const sd = $(`#sd-${t.id}`);
    if (sd) { sd.setAttribute("cx", lastX); sd.setAttribute("cy", lastY); sd.style.fill = colour; sd.style.filter = `drop-shadow(0 0 3px ${colour})`; }
  }
}

function refreshBtcCards() {
  for (const t of state.trades) {
    const tpEl   = $(`#tp-${t.id}`);
    const peakEl = $(`#peak-${t.id}`);
    const pnlEl  = $(`#pnl-${t.id}`);
    if (tpEl)   tpEl.textContent = (t.currentPrice * 100).toFixed(1) + "%";
    if (peakEl) {
      peakEl.textContent = (t.peakPrice * 100).toFixed(1) + "%";
      peakEl.className = t.peakPrice > t.entryPrice + 0.005 ? "btc-v green" : "btc-v dim";
    }
    const troughEl = $(`#trough-${t.id}`);
    if (troughEl) {
      troughEl.textContent = (t.troughPrice * 100).toFixed(1) + "%";
      troughEl.className = t.troughPrice < t.entryPrice - 0.005 ? "btc-v red" : "btc-v dim";
    }
    const crowdEl = $(`#crowd-${t.id}`);
    if (crowdEl) {
      const crowdMove = (t.currentPrice - t.entryPrice) * 100;
      const sign = crowdMove >= 0 ? "+" : "";
      crowdEl.textContent = `${sign}${crowdMove.toFixed(1)}pp`;
      crowdEl.className = crowdMove > 1 ? "btc-v green" : crowdMove < -1 ? "btc-v red" : "btc-v dim";
    }
    const stopDepthEl = $(`#stopdepth-${t.id}`);
    if (stopDepthEl && t.entryPrice > 0) {
      const slPct = (parseFloat($("#stop-loss-pct")?.value) || state.config?.stopLossPct || 25) / 100;
      const stopPrice = t.entryPrice * (1 - slPct);
      const depthPp = (t.troughPrice - stopPrice) * 100;
      const sign = depthPp >= 0 ? "+" : "";
      stopDepthEl.textContent = `${sign}${depthPp.toFixed(1)}pp from stop`;
      stopDepthEl.className = depthPp < 5 ? "btc-v red" : depthPp < 15 ? "btc-v amber" : "btc-v dim";
    }
    if (pnlEl) {
      const isPos = t.unrealizedPnl >= 0;
      pnlEl.textContent = (isPos ? "+" : "") + "$" + t.unrealizedPnl.toFixed(2);
      pnlEl.className   = `btc-v ${isPos ? "green" : "red"}`;
    }
    const durEl = $(`#dur-${t.id}`);
    if (durEl) durEl.textContent = fmtDuration(Date.now() - t.entryTime);
    updateSparkline(t);
  }
}

// ── Real-time price stream via Polymarket WebSocket ──────────────

const POLY_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const priceStream = (() => {
  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;
  const subscribed = new Set();

  function onMessage(evt) {
    if (evt.data === "PONG") return;
    let msgs;
    try { msgs = JSON.parse(evt.data); } catch { return; }
    if (!Array.isArray(msgs)) msgs = [msgs];
    for (const msg of msgs) {
      if (msg.event_type === "best_bid_ask" || msg.type === "best_bid_ask") {
        const tokenId = msg.asset_id;
        const bid = parseFloat(msg.best_bid ?? msg.bid ?? 0);
        // Polymarket order books momentarily show best_bid ≈ 0 when no bids are queued.
        // A bid of <5¢ on a ~50-80% odds token is clearly a stale/empty-book artefact —
        // using it would spike unrealizedPnl to near -$amount and trigger a phantom stop.
        if (!tokenId || bid < 0.05) continue;
        let changed = false;
        for (const t of state.trades) {
          if (t.tokenId !== tokenId) continue;
          t.currentPrice  = bid;
          t.unrealizedPnl = t.shares * bid - t.amount;
          if (bid > t.peakPrice) t.peakPrice = bid;
          if (bid < t.troughPrice) t.troughPrice = bid;
          t.priceHistory.push(bid);
          if (t.priceHistory.length > 120) t.priceHistory.shift();
          changed = true;
        }
        if (changed) {
          // Read live from DOM so changes take effect instantly without restart
          const stopLossPct   = (parseFloat($("#stop-loss-pct")?.value)   || state.config?.stopLossPct   || 25) / 100;
          const takeProfitPct = (parseFloat($("#take-profit-pct")?.value) || state.config?.takeProfitPct || 50) / 100;
          const trailArmPct   = (parseFloat($("#trail-arm-pct")?.value)   || state.config?.trailArmPct   || 15) / 100;
          const trailLockPct  = (parseFloat($("#trail-lock-pct")?.value)  || state.config?.trailLockPct  || 40) / 100;
          const stopGraceMs = (parseFloat($("#stop-grace-sec")?.value) ?? state.config?.stopGraceSec ?? 10) * 1_000;
          // Conviction exit runs FIRST — catches straight-down losses before the full stop fires.
          if (state.config?.convictionExit) {
            const threshold = (state.config?.convictionExitThreshold ?? 20) / 100;
            const toConvictionExit = state.trades.filter(t => {
              if (t.tokenId !== tokenId) return false;
              if (Date.now() - t.entryTime < 10_000) return false;
              const crowdMove = t.currentPrice - t.entryPrice;
              const peakMoved = t.peakPrice > t.entryPrice + 0.02;
              return crowdMove <= -threshold && !peakMoved;
            });
            for (const t of toConvictionExit) closePosition(t, "CONVICTION EXIT");
          }

          const toStopLoss = state.trades.filter(t => {
            if (t.tokenId !== tokenId) return false;
            if (t.totalSecs < 45) return false;
            // AI Maker fills need 90s grace — they may have gotten price improvement
            // (filled at 19¢ on a 50¢ bid) and the entry price might still be updating.
            const grace = t.aiMakerFill ? Math.max(stopGraceMs, 20_000) : stopGraceMs;
            if (Date.now() - t.entryTime < grace) return false;
            // HIGH confidence + high entry odds = near-certain binary outcome.
            // e.g., entering DOWN at 83% — a 25% stop fires at 65%, but position resolves 99%.
            // Price oscillates on correct-direction trades; only exit on true collapse (<35%).
            if (t.confidence === "HIGH" && t.entryPrice > 0.70) {
              return t.unrealizedPnl <= -t.amount * 0.65;
            }
            // Gap-flip trades (signalAgainstGap=true) bet that price currently on the wrong side
            // of the target will cross before resolution. The prediction market token naturally
            // drops while the price approaches from the wrong direction — a 25% flat stop fires
            // at the token low even when the trade direction is ultimately correct.
            // Use a wider 60% base stop for gap-flip entries to survive the pre-crossing dip.
            // Exception: low-odds gap-flip entries (<40%) are momentum-only bets with no real gap
            // cushion — capping at 35% limits the max loss instead of allowing a 60-70% drawdown.
            // High-entry trades (>65¢) are near-certain binary bets — a 30% flat stop fires at 49¢
            // but the token can gap 40pp in a single tick before recovering to 97¢. Widen to 65%
            // so the stop only triggers on a true collapse (~24.5¢ on a 70¢ entry).
            const highEntryWide = (!t.signalAgainstGap && t.entryPrice > 0.65) ? Math.max(stopLossPct, 0.65) : null;
            const effectiveStop = t.signalAgainstGap
              ? (t.entryPrice <= 0.40 ? Math.max(stopLossPct, 0.35) : Math.max(stopLossPct, 0.60))
              : (highEntryWide ?? stopLossPct);
            return t.unrealizedPnl <= -t.amount * effectiveStop;
          });
          for (const t of toStopLoss) closePosition(t, "STOP LOSS");
          const toTakeProfit = state.trades.filter(t => {
            if (t.tokenId !== tokenId) return false;
            // Low-fill trades (GTC maker filled below 40¢ via price improvement) got in cheap
            // precisely because the crowd disagrees — take a quick 3% gain and exit rather than
            // waiting for the normal 50% TP that may never arrive.
            const scalpTpPct   = (parseFloat($("#scalp-tp-pct")?.value) || state.config?.scalpTpPct || 3) / 100;
            const effectiveTp = (t.aiMakerFill && t.entryPrice <= 0.40) ? scalpTpPct : takeProfitPct;
            return t.unrealizedPnl >= t.amount * effectiveTp;
          });
          for (const t of toTakeProfit) {
            const reason = (t.aiMakerFill && t.entryPrice <= 0.40) ? "SCALP EXIT" : "TAKE PROFIT";
            closePosition(t, reason);
          }
          const toTrailStop = state.trades.filter(t => {
            if (t.tokenId !== tokenId) return false;
            if (!trailArmPct) return false;
            const peakGain = t.peakPrice * t.shares - t.amount;
            return peakGain >= t.amount * trailArmPct && t.unrealizedPnl < peakGain * trailLockPct;
          });
          for (const t of toTrailStop) closePosition(t, "TRAIL STOP");
          refreshBtcCards();
          updatePnlStat();
        }
        // Shadow tracking: closed positions still monitoring for final direction resolution
        for (const s of (state.shadowTrades || [])) {
          if (s.tokenId !== tokenId || s.resolved) continue;
          if (bid < s.minPriceAfterClose) s.minPriceAfterClose = bid;
          if (bid > s.maxPriceAfterClose) s.maxPriceAfterClose = bid;
          s.lastKnownPrice = bid;
          // Resolution: token converges to ~0 (wrong direction) or ~1 (correct direction)
          if (bid >= 0.97 || bid <= 0.03) {
            s.resolved = true;
            s.finalResolutionPrice = bid;
            s.directionCorrect = bid >= 0.97;
            updateResolutionBadge(s);
            cleanupShadowTrade(s);
          }
        }
      }
    }
  }

  function sendSub(tokenIds, operation = null) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg = { assets_ids: tokenIds, type: "market", custom_feature_enabled: true };
    if (operation) msg.operation = operation;
    ws.send(JSON.stringify(msg));
  }

  function connect() {
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    ws = new WebSocket(POLY_WS_URL);
    ws.onopen = () => {
      logEntry("info", "  ◈ Price stream connected (WebSocket)");
      if (subscribed.size) sendSub([...subscribed]);
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10_000);
    };
    ws.onmessage = onMessage;
    ws.onclose = () => {
      clearInterval(pingTimer);
      pingTimer = null;
      if (subscribed.size > 0) reconnectTimer = setTimeout(connect, 3_000);
    };
    ws.onerror = () => ws.close();
  }

  function disconnect() {
    clearInterval(pingTimer);
    clearTimeout(reconnectTimer);
    pingTimer = null; reconnectTimer = null;
    subscribed.clear();
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  return {
    subscribe(tokenId) {
      if (subscribed.has(tokenId)) return;
      subscribed.add(tokenId);
      if (!ws || ws.readyState > WebSocket.OPEN) connect();
      else sendSub([tokenId], "subscribe");
    },
    unsubscribe(tokenId) {
      subscribed.delete(tokenId);
      if (ws && ws.readyState === WebSocket.OPEN)
        ws.send(JSON.stringify({ assets_ids: [tokenId], operation: "unsubscribe" }));
      if (subscribed.size === 0) disconnect();
    },
    disconnect,
  };
})();

// ── Chainlink RTDS — live prices matching Polymarket's resolution source ──────
// wss://ws-live-data.polymarket.com streams Chainlink oracle prices in real-time.
// We use these as `spot` in gap calculations so both sides of the gap use the same
// price source as Polymarket's resolution (eliminates Binance/Chainlink delta).
const CHAINLINK_WS_URL = "wss://ws-live-data.polymarket.com";

const chainlinkStream = (() => {
  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;

  function onMessage(evt) {
    let msg;
    try { msg = JSON.parse(evt.data); } catch { return; }
    if (msg.topic === "crypto_prices_chainlink" && msg.payload?.value != null) {
      const sym = msg.payload.symbol;
      const val = parseFloat(msg.payload.value);
      if (!isNaN(val)) {
        const now = Date.now();
        if      (sym === "btc/usd") { state.chainlinkPrices.btc = val; state.chainlinkPricesAt.btc = now; }
        else if (sym === "eth/usd") { state.chainlinkPrices.eth = val; state.chainlinkPricesAt.eth = now; }
        else if (sym === "sol/usd") { state.chainlinkPrices.sol = val; state.chainlinkPricesAt.sol = now; }
        else if (sym === "xrp/usd") { state.chainlinkPrices.xrp = val; state.chainlinkPricesAt.xrp = now; }
      }
    }
  }

  function sendSubs() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({
      action: "subscribe",
      subscriptions: [
        { topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"btc/usd"}' },
        { topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"eth/usd"}' },
        { topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"sol/usd"}' },
        { topic: "crypto_prices_chainlink", type: "*", filters: '{"symbol":"xrp/usd"}' },
      ],
    }));
  }

  function connect() {
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    ws = new WebSocket(CHAINLINK_WS_URL);
    ws.onopen = () => {
      sendSubs();
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 5_000);
    };
    ws.onmessage = onMessage;
    ws.onclose = () => {
      clearInterval(pingTimer); pingTimer = null;
      reconnectTimer = setTimeout(connect, 3_000);
    };
    ws.onerror = () => ws.close();
  }

  function disconnect() {
    clearInterval(pingTimer); clearTimeout(reconnectTimer);
    pingTimer = null; reconnectTimer = null;
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  return { connect, disconnect };
})();

// ── Fill price parsing ───────────────────────────────────────────

// Extract actual fill price from a Polymarket CLOB FOK order response.
// For BUY: makingAmount = USDC spent, takingAmount = tokens received → price = making/taking
// For SELL: makingAmount = tokens sold, takingAmount = USDC received → price = taking/making
function parseFillPrice(result, side) {
  const making = parseFloat(result.makingAmount);
  const taking = parseFloat(result.takingAmount);
  if (making > 0 && taking > 0) {
    return side === "SELL" ? taking / making : making / taking;
  }
  if (result.price != null) return parseFloat(result.price);
  return null;
}

// ── Position management ──────────────────────────────────────────

function closePosition(trade, reason) {
  // Don't exit a live position before the BUY has confirmed on-chain —
  // tokens don't exist yet so the SELL will fail with balance: 0.
  if (trade.mode.startsWith("LIVE") && !trade.confirmed) {
    console.warn(`[LIVE] closePosition blocked — BUY not yet confirmed (reason: ${reason})`);
    return;
  }
  const idx = state.trades.indexOf(trade);
  if (idx === -1) return;
  state.trades.splice(idx, 1);

  // Consecutive stop tracking for crash-phase cooldown
  if (reason === "STOP LOSS") {
    state.consecutiveStops = (state.consecutiveStops ?? 0) + 1;
    if ((state.config?.stopCooldown) && state.consecutiveStops >= 2) {
      state.stopCooldownActive = true;
      logEntry("warn", `  ⚠ Stop cooldown armed — ${state.consecutiveStops} consecutive stops, skipping next window`);
    }
  } else {
    state.consecutiveStops = 0;
  }

  // Freeze the PEAK DOM element to the true final peak — refreshBtcCards won't touch
  // this trade anymore (it's removed from state.trades), so we write it once here so
  // the card display and the PEAK PnL calculation in the resolution section always agree.
  const peakFreezeEl = $(`#peak-${trade.id}`);
  if (peakFreezeEl) {
    peakFreezeEl.textContent = (trade.peakPrice * 100).toFixed(1) + "%";
    peakFreezeEl.className = trade.peakPrice > trade.entryPrice + 0.005 ? "btc-v green" : "btc-v dim";
  }

  // LIVE MODE: post a GTC SELL limit order to exit the position.
  // GTC is used instead of FOK because FOK requires all shares to fill at a single
  // price level — unreliable in thin prediction market books. A GTC SELL just below
  // the current bid immediately crosses existing bids and rests for any remainder.
  if (trade.mode.startsWith("LIVE") && trade.tokenId && (trade.shares ?? 0) > 0) {
    const c = state.config;
    console.log(`[LIVE] Placing GTC SELL`, {
      reason,
      asset:         trade.type,
      token_id:      trade.tokenId,
      shares:        trade.shares?.toFixed(4),
      entryPrice:    (trade.entryPrice * 100).toFixed(1) + "%",
      currentPrice:  (trade.currentPrice * 100).toFixed(1) + "%",
      unrealizedPnl: trade.unrealizedPnl?.toFixed(2),
      secsLeft:      Math.max(0, Math.round((new Date(trade.endDate) - Date.now()) / 1000)),
      market:        trade.question?.slice(0, 60),
    });
    const attemptGtcSell = (priceFloor, attempt) => {
      const label = attempt === 0 ? "" : ` (retry #${attempt})`;
      const payload = {
        token_id:       trade.tokenId,
        side:           "SELL",
        price:          Math.max(0.03, Math.round(priceFloor * 100) / 100),
        size:           trade.shares,
        private_key:    c.polyPrivateKey,
        api_key:        c.polyApiKey,
        api_secret:     c.polyApiSecret,
        api_passphrase: c.polyPassphrase,
      };
      fetch("/limit", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(payload),
      })
        .then(r => r.json())
        .then(result => {
          if (result.error) {
            console.error(`[LIVE] SELL FAILED${label}`, result);
            logEntry("warn", `  [LIVE] SELL failed${label}: ${result.error}`);
            if (attempt < 2) {
              const delay = (attempt + 1) * 2000;
              const lowerFloor = priceFloor - 0.15;
              logEntry("warn", `  [LIVE] SELL retry in ${delay / 1000}s @ ${(lowerFloor * 100).toFixed(0)}¢…`);
              setTimeout(() => attemptGtcSell(lowerFloor, attempt + 1), delay);
            } else {
              logEntry("warn", `  [LIVE] SELL gave up — position may still be open on Polymarket`);
            }
          } else {
            const orderId   = result.orderID ?? result.orderId ?? result.id ?? "";
            const fillPrice = parseFillPrice(result, "SELL");
            console.log(`[LIVE] GTC SELL confirmed${label}`, result,
                        fillPrice ? `fill: ${(fillPrice*100).toFixed(1)}¢` : "");
            logEntry("info", `  [LIVE] SELL confirmed${label}: ${String(orderId).slice(0, 16)}…` +
                             (fillPrice ? ` @ ${(fillPrice*100).toFixed(1)}¢` : ""));

            // Reconcile realized PnL from actual SELL fill price.
            // The snapshot at close time uses bid (stale/thin), but GTC SELL
            // response carries exact takingAmount/makingAmount.
            if (fillPrice && fillPrice > 0.01 && trade.shares > 0) {
              const prevRealized   = trade.realizedPnl;
              const actualRealized = trade.shares * fillPrice - trade.amount;
              const delta = actualRealized - prevRealized;
              if (Math.abs(delta) > 0.01) {
                state.realizedPnl = (state.realizedPnl || 0) + delta;
                trade.realizedPnl = actualRealized;
                const wasWin = prevRealized  > 0;
                const nowWin = actualRealized > 0;
                if (wasWin && !nowWin)  { state.wins--;   state.losses++; }
                else if (!wasWin && nowWin) { state.losses--; state.wins++; }
                const cardEl = $(`#card-${trade.id}`);
                if (cardEl) {
                  const pnlEl = cardEl.querySelector(".btc-closed-pnl");
                  if (pnlEl) {
                    const sign = actualRealized >= 0 ? "+" : "";
                    pnlEl.textContent = `${sign}$${actualRealized.toFixed(2)} REALIZED`;
                    pnlEl.className = `btc-closed-pnl ${actualRealized >= 0 ? "green" : "red"}`;
                  }
                  if (wasWin !== nowWin) {
                    const stripEl = cardEl.querySelector(".btc-closed-strip");
                    const labelEl = cardEl.querySelector(".btc-closed-label");
                    if (stripEl) stripEl.className = `btc-closed-strip ${nowWin ? "win" : "loss"}`;
                    if (labelEl) {
                      const txt = labelEl.textContent.replace(/^(▲ WIN|▼ LOSS) — /, "");
                      labelEl.textContent = `${nowWin ? "▲ WIN" : "▼ LOSS"} — ${txt}`;
                    }
                  }
                }
                updatePnlStat();
                logEntry("info", `  [LIVE] PnL reconciled: $${actualRealized.toFixed(2)} ` +
                                 `(was $${prevRealized.toFixed(2)})`);
              }
            }
          }
        })
        .catch(err => {
          console.error(`[LIVE] SELL fetch error${label}`, err);
          logEntry("warn", `  [LIVE] SELL error${label}: ${err.message}`);
        });
    };
    // Post GTC SELL 15¢ below current bid — ensures crossing even if the market
    // dips during transit. In CLOB mechanics our taker SELL fills at the maker's
    // bid price (price improvement), so a 15¢ buffer just guarantees fill — we
    // still get the actual bid price.
    attemptGtcSell(trade.currentPrice - 0.15, 0);
  }

  // Post-close direction tracking: keep subscription alive until market resolves
  const msToEnd = new Date(trade.endDate) - Date.now();
  const willShadow = msToEnd > 5_000 && reason !== "RESOLVED";

  trade.exitTime   = Date.now();
  trade.duration   = trade.exitTime - trade.entryTime;
  trade.exitPrice  = trade.currentPrice;
  trade.secsAtClose = Math.max(0, Math.round((new Date(trade.endDate) - Date.now()) / 1000));

  const realized = trade.unrealizedPnl;
  trade.realizedPnl = realized;  // stored so SELL fill reconciliation can update it
  state.realizedPnl = (state.realizedPnl || 0) + realized;
  if (realized > 0) state.wins++; else if (realized < 0) state.losses++;
  state.tradeHistory.push({ ts: Date.now(), pnl: realized, asset: trade.type, reason });

  if (willShadow) {
    state.shadowTrades = state.shadowTrades || [];
    const shadow = {
      tradeId: trade.id,
      tokenId: trade.tokenId,
      minPriceAfterClose: trade.currentPrice,
      maxPriceAfterClose: trade.currentPrice,
      exitPrice:          trade.currentPrice,
      shares:             trade.shares ?? 0,
      isWin:              realized > 0,
      lastKnownPrice: trade.currentPrice,
      finalResolutionPrice: null,
      resolved: false,
      directionCorrect: null,
      cleanupTimer: null,
    };
    shadow.cleanupTimer = setTimeout(() => {
      if (!shadow.resolved) {
        shadow.resolved = true;
        shadow.finalResolutionPrice = shadow.lastKnownPrice;
        shadow.directionCorrect = shadow.lastKnownPrice >= 0.5;
        updateResolutionBadge(shadow);
      }
      cleanupShadowTrade(shadow);
    }, msToEnd + 30_000);
    state.shadowTrades.push(shadow);
  }
  const stillNeeded = state.trades.some(t => t.tokenId === trade.tokenId) || willShadow;
  if (!stillNeeded) priceStream.unsubscribe(trade.tokenId);

  const card = $(`#card-${trade.id}`);
  if (card) {
    const isWin = realized > 0;
    const sign  = realized >= 0 ? "+" : "";

    // Insert a permanent result strip at top of card
    const strip = document.createElement("div");
    strip.className = `btc-closed-strip ${isWin ? "win" : "loss"}`;
    strip.innerHTML = `
      <span class="btc-closed-label">${isWin ? "▲ WIN" : "▼ LOSS"} — ${reason}</span>
      <span class="btc-closed-pnl ${isWin ? "green" : "red"}">${sign}$${realized.toFixed(2)} REALIZED</span>
      <span class="btc-closed-dur dim">${fmtDuration(trade.duration)}</span>
    `;
    card.insertBefore(strip, card.firstChild);

    // Flip CURRENT label → EXIT so the frozen value is clearly the exit price
    const clabel = $(`#clabel-${trade.id}`);
    if (clabel) clabel.textContent = "EXIT";

    // Freeze countdown display
    const cd = $(`#cd-${trade.id}`);
    if (cd) { cd.textContent = "[CLOSED]"; cd.className = "btc-card-cd resolved"; }

    // Freeze duration display
    const durEl = $(`#dur-${trade.id}`);
    if (durEl) { durEl.textContent = fmtDuration(trade.duration); durEl.className = "btc-v dim"; }

    // Clear unrealized PnL — position is settled
    const pnlEl = $(`#pnl-${trade.id}`);
    if (pnlEl) { pnlEl.textContent = "+$0.00"; pnlEl.className = "btc-v dim"; }

    // Mark card as closed + move to bottom of container (below active positions)
    card.classList.add(isWin ? "closed-win" : "closed-loss");
    const container = card.parentNode;
    if (container) container.appendChild(card);

    // Resolution tracking section
    const resDiv = document.createElement("div");
    resDiv.className = "resolution-tracking";

    // Stop-depth: how far price fell from entry before the stop fired
    const isStopReason = /stop|cascade|slip/i.test(reason);
    const stopDepthPct = isStopReason
      ? ((trade.entryPrice - trade.exitPrice) / trade.entryPrice * 100).toFixed(1)
      : null;
    // Peak scenario: PnL if trade had been exited at the in-trade price peak
    const peakPnl     = (trade.peakPrice - trade.entryPrice) * (trade.shares ?? 0);
    const peakSign    = peakPnl >= 0 ? "+" : "";
    const peakClass   = peakPnl >= 0 ? "green" : "red";

    if (willShadow) {
      resDiv.innerHTML = `
        <span id="resolution-badge-${trade.id}" class="resolution-badge pending">⏳ TRACKING DIRECTION</span>
        <div class="resolution-data">
          ${stopDepthPct !== null ? `<span class="res-item">STOP DEPTH: <span class="btc-v red">${stopDepthPct}% from entry</span></span>` : ""}
          <span class="res-item">PEAK PnL: <span class="btc-v ${peakClass}">${peakSign}$${peakPnl.toFixed(2)} at ${(trade.peakPrice * 100).toFixed(1)}¢</span></span>
          <span class="res-item">MIN AFTER CLOSE: <span id="res-min-${trade.id}" class="btc-v">$${trade.currentPrice.toFixed(3)}</span></span>
          <span class="res-item">MAX AFTER CLOSE: <span id="res-max-${trade.id}" class="btc-v">$${trade.currentPrice.toFixed(3)}</span></span>
          <span class="res-item">RESOLUTION: <span id="res-final-${trade.id}" class="btc-v dim">—</span></span>
          <span class="res-item" id="res-delta-wrap-${trade.id}" style="display:none"><span id="res-delta-label-${trade.id}">LEFT / SAVED</span>: <span id="res-delta-${trade.id}" class="btc-v dim">—</span></span>
        </div>
      `;
    } else {
      const correct = trade.currentPrice >= 0.5;
      resDiv.innerHTML = `
        <span class="resolution-badge ${correct ? "correct" : "wrong"}">${correct ? "✓ CORRECT DIR" : "✗ WRONG DIR"}</span>
        <div class="resolution-data">
          <span class="res-item">FINAL: <span class="btc-v">$${trade.currentPrice.toFixed(3)}</span></span>
        </div>
      `;
    }
    card.appendChild(resDiv);
  }

  // Only show empty state if no active trades AND no closed cards in DOM
  if (state.trades.length === 0) {
    const hasClosed = document.querySelectorAll("#btc-cards .closed-win, #btc-cards .closed-loss").length > 0;
    const empty = $("#btc-empty");
    if (empty) empty.style.display = hasClosed ? "none" : "";
  }

  const sign = realized >= 0 ? "+" : "";
  logEntry("info",
    `  ✓ [${trade.mode}] CLOSE ${reason} — ${trade.question.slice(0, 60)} ` +
    `| Realized: <span class="${realized >= 0 ? "green" : "red"}">${sign}$${realized.toFixed(2)}</span>`
  );

  // BTC stop loss triggers cross-asset cascade + directional veto
  if (reason === "STOP LOSS" && trade.type === "btc") {
    const correlated = state.trades.filter(t => t.signal === trade.signal);
    const vetoMins = 2;
    state.directionVeto = { signal: trade.signal, expiresAt: Date.now() + vetoMins * 60_000 };
    if (correlated.length) {
      logEntry("info", `  ⚡ BTC cascade — closing ${correlated.length} correlated ${trade.signal} position(s)`);
      for (const t of correlated) closePosition(t, "CASCADE STOP LOSS");
    }
    logEntry("info", `  🚫 ${trade.signal} veto active for ${vetoMins}min (BTC correlation)`);
  }

  // Market-stress cool-down: track stop-loss events across all assets.
  // If ≥3 stops fire within a 20-minute rolling window, pause new entries for 10 minutes.
  // This catches market-dislocation events where prediction prices crash independently of spot
  // (e.g. the 6:20–7:00 PM cluster that cost -$88.75 in a single session).
  if (reason === "STOP LOSS" || reason === "CASCADE STOP LOSS") {
    const now = Date.now();
    const windowMs = 20 * 60_000;
    state.recentStops = (state.recentStops ?? []).filter(t => now - t < windowMs);
    state.recentStops.push(now);
    if (state.recentStops.length >= 3 && now > (state.stressHoldUntil ?? 0)) {
      const holdMins = 10;
      state.stressHoldUntil = now + holdMins * 60_000;
      logEntry("amber",
        `  ⚠️ Market-stress cool-down — ${state.recentStops.length} stops in ${windowMs / 60_000}min. ` +
        `Pausing new entries for ${holdMins}min.`
      );
    }
  }

  setStat("positions", String(state.trades.length));
  updatePnlStat();
}

function updateResolutionBadge(shadow) {
  const badge = $(`#resolution-badge-${shadow.tradeId}`);
  if (!badge) return;
  const correct = shadow.directionCorrect;
  badge.className = `resolution-badge ${correct ? "correct" : "wrong"}`;
  badge.textContent = correct ? "✓ CORRECT DIR" : "✗ WRONG DIR";

  const minEl = $(`#res-min-${shadow.tradeId}`);
  if (minEl) minEl.textContent = `$${shadow.minPriceAfterClose.toFixed(3)}`;

  const maxEl = $(`#res-max-${shadow.tradeId}`);
  if (maxEl) maxEl.textContent = `$${shadow.maxPriceAfterClose.toFixed(3)}`;

  const finalEl = $(`#res-final-${shadow.tradeId}`);
  if (finalEl) {
    finalEl.textContent = `$${shadow.finalResolutionPrice.toFixed(3)}`;
    finalEl.className = "btc-v";
  }

  // Contextual exit-quality label: four distinct scenarios
  const wrapEl   = $(`#res-delta-wrap-${shadow.tradeId}`);
  const deltaEl  = $(`#res-delta-${shadow.tradeId}`);
  const labelEl  = $(`#res-delta-label-${shadow.tradeId}`);
  if (wrapEl && deltaEl && shadow.shares > 0) {
    const delta = (shadow.finalResolutionPrice - shadow.exitPrice) * shadow.shares;
    if (shadow.isWin && shadow.directionCorrect) {
      // WIN + correct dir: exited early, missed upside
      if (labelEl) labelEl.textContent = "LEFT ON TABLE";
      deltaEl.textContent = delta > 0.005 ? `+$${delta.toFixed(2)}` : `$0.00`;
      deltaEl.className = delta > 0.05 ? "btc-v amber" : "btc-v dim";
    } else if (shadow.isWin && !shadow.directionCorrect) {
      // WIN + wrong dir: lucky TP exit before market crashed — delta is negative (exit > resolution)
      if (labelEl) labelEl.textContent = "TP DODGE";
      deltaEl.textContent = `$${Math.abs(delta).toFixed(2)} saved`;
      deltaEl.className = "btc-v green";
    } else if (!shadow.isWin && shadow.directionCorrect) {
      // LOSS + correct dir: stop fired before price recovered; delta is positive (cost of stop)
      if (labelEl) labelEl.textContent = "STOP COST";
      deltaEl.textContent = `+$${Math.abs(delta).toFixed(2)}`;
      deltaEl.className = delta > 0.05 ? "btc-v red" : "btc-v dim";
    } else {
      // LOSS + wrong dir: stop correctly limited damage; delta is negative (savings)
      if (labelEl) labelEl.textContent = "STOP SAVED";
      deltaEl.textContent = `$${Math.abs(delta).toFixed(2)} avoided`;
      deltaEl.className = "btc-v green";
    }
    wrapEl.style.display = "";
  }
}

function cleanupShadowTrade(shadow) {
  clearTimeout(shadow.cleanupTimer);
  state.shadowTrades = (state.shadowTrades || []).filter(s => s !== shadow);
  const stillNeeded = state.trades.some(t => t.tokenId === shadow.tokenId) ||
                      (state.shadowTrades || []).some(s => s.tokenId === shadow.tokenId);
  if (!stillNeeded) priceStream.unsubscribe(shadow.tokenId);
}

// ── Profitability chart ──────────────────────────────────────────
// Renders hourly PnL bars (Europe/Copenhagen time) + cumulative line.
// Called after every position close.
function updateProfitChart() {
  const svg = document.getElementById('profit-chart-svg');
  const totalLabel = document.getElementById('chart-total-label');
  if (!svg) return;

  const history = state.tradeHistory;
  if (!history.length) return;

  // Bucket each trade into its Copenhagen hour
  const hourlyPnl = {};
  for (const t of history) {
    const h = parseInt(new Date(t.ts).toLocaleString('en-US', {
      timeZone: 'Europe/Copenhagen', hour: 'numeric', hour12: false
    }));
    hourlyPnl[h] = (hourlyPnl[h] || 0) + t.pnl;
  }

  const hours = Object.keys(hourlyPnl).map(Number).sort((a, b) => a - b);
  // Fill every hour from first to last so gaps show as empty
  const allHours = [];
  for (let h = hours[0]; h <= hours[hours.length - 1]; h++) allHours.push(h);
  const pnls = allHours.map(h => hourlyPnl[h] || 0);

  const W = svg.clientWidth || 700;
  const H = 88;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);

  const padL = 38, padR = 6, padT = 8, padB = 16;
  const cW = W - padL - padR;
  const cH = H - padT - padB;
  const midY = padT + cH / 2;
  const maxAbs = Math.max(1, ...pnls.map(Math.abs));
  const yScale = (cH / 2 - 2) / maxAbs;
  const slotW = cW / allHours.length;
  const barW = Math.max(4, Math.floor(slotW * 0.65));

  let out = '';

  // Baseline & y-axis
  out += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + cH}" stroke="#252525" stroke-width="1"/>`;
  out += `<line x1="${padL}" y1="${midY}" x2="${padL + cW}" y2="${midY}" stroke="#2d2d2d" stroke-width="1" stroke-dasharray="4,4"/>`;
  out += `<text x="${padL - 3}" y="${padT + 5}" text-anchor="end" font-size="7" fill="#444">+$${maxAbs.toFixed(0)}</text>`;
  out += `<text x="${padL - 3}" y="${padT + cH + 4}" text-anchor="end" font-size="7" fill="#444">-$${maxAbs.toFixed(0)}</text>`;
  out += `<text x="${padL - 3}" y="${midY + 3}" text-anchor="end" font-size="7" fill="#444">$0</text>`;

  // Bars
  allHours.forEach((h, i) => {
    const pnl = pnls[i];
    const cx = padL + i * slotW + slotW / 2;
    const bx = cx - barW / 2;
    const bh = Math.max(1, Math.abs(pnl) * yScale);
    const by = pnl >= 0 ? midY - bh : midY;
    const color = pnl > 0 ? '#39ff14' : pnl < 0 ? '#ff4444' : '#333';
    out += `<rect x="${bx.toFixed(1)}" y="${by.toFixed(1)}" width="${barW}" height="${bh.toFixed(1)}" fill="${color}" opacity="0.78"/>`;
    // PnL label inside bar (only if tall enough)
    if (bh > 12) {
      const sign = pnl > 0 ? '+' : '';
      const ty = pnl >= 0 ? by + bh / 2 + 3 : by + bh / 2 + 3;
      out += `<text x="${cx.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="middle" font-size="6.5" fill="#000" opacity="0.7">${sign}$${Math.abs(pnl).toFixed(0)}</text>`;
    }
    // Hour label
    out += `<text x="${cx.toFixed(1)}" y="${H - 2}" text-anchor="middle" font-size="7" fill="#555">${h < 10 ? '0' + h : h}:00</text>`;
  });

  // Cumulative line
  let cum = 0;
  const pts = [];
  allHours.forEach((h, i) => {
    cum += pnls[i];
    const x = padL + i * slotW + slotW / 2;
    const y = Math.max(padT + 2, Math.min(padT + cH - 2, midY - cum * yScale * 0.9));
    pts.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  });
  if (pts.length > 1) {
    out += `<polyline points="${pts.join(' ')}" fill="none" stroke="#ffffff" stroke-width="1.5" opacity="0.45"/>`;
  }
  if (pts.length >= 1) {
    const [lx, ly] = pts[pts.length - 1].split(',');
    out += `<circle cx="${lx}" cy="${ly}" r="2.5" fill="#ffffff" opacity="0.6"/>`;
  }

  svg.innerHTML = out;

  // Update total label
  if (totalLabel) {
    const total = pnls.reduce((a, b) => a + b, 0);
    const sign = total >= 0 ? '+' : '';
    totalLabel.textContent = `${sign}$${total.toFixed(2)} total`;
    totalLabel.className = `chart-total-label ${total >= 0 ? 'green' : 'red'}`;
  }
}

function updatePnlStat() {
  const unrealized = state.trades.reduce((s, t) => s + t.unrealizedPnl, 0);
  const pnl = unrealized + (state.realizedPnl || 0);
  state.sessionPnl = pnl;
  const pnlEl = $("#stat-pnl");
  if (pnlEl) {
    pnlEl.textContent = (pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(2);
    pnlEl.className   = `stat-val ${pnl > 0 ? "green" : pnl < 0 ? "red" : "dim"}`;
  }
  setStat("positions", String(state.trades.length));

  // Win rate
  const totalClosed = state.wins + state.losses;
  const winRate = totalClosed > 0 ? Math.round((state.wins / totalClosed) * 100) : null;
  const winRateEl = $("#stat-winrate");
  if (winRateEl) {
    winRateEl.textContent = winRate !== null ? `${state.wins}W/${state.losses}L (${winRate}%)` : "—";
    winRateEl.className   = `stat-val ${winRate === null ? "dim" : winRate >= 50 ? "green" : "red"}`;
  }

  // Profit per hour (realized only, since open positions aren't locked in)
  const hoursElapsed = (Date.now() - state.sessionStart) / 3_600_000;
  const pph = hoursElapsed > 0 ? (state.realizedPnl || 0) / hoursElapsed : 0;
  const pphEl = $("#stat-pph");
  if (pphEl) {
    pphEl.textContent = (pph >= 0 ? "+" : "") + "$" + pph.toFixed(2) + "/hr";
    pphEl.className   = `stat-val ${pph > 0 ? "green" : pph < 0 ? "red" : "dim"}`;
  }
  updateProfitChart();
}

// ── Crypto mode (BTC / ETH / SOL) ────────────────────────────────

const ASSET_COLORS = { btc: "amber", eth: "eth", sol: "sol", xrp: "xrp" };

// ── Market WebSocket — instant new_market detection ──────────────

const WS_MARKET_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
// Match the same keywords as CRYPTO_CONFIG so only "up or down" markets trigger a cycle.
// Broad terms like /\bbitcoin\b/ also match "bitcoin above X" markets which are a
// completely different type and flood the signal log with spurious cycle triggers.
const WS_KEYWORDS = {
  btc: [/\bbitcoin up or down\b/, /\bbtc up or down\b/],
  eth: [/\bethereum up or down\b/, /\beth up or down\b/],
  sol: [/\bsolana up or down\b/, /\bsol up or down\b/],
  xrp: [/\bxrp up or down\b/, /\bripple up or down\b/],
};

let _marketWs = null;
let _marketWsPingTimer = null;
let _marketWsReconnectTimer = null;
let _marketWsReconnectDelay = 2000;

function startMarketWS() {
  if (_marketWs && _marketWs.readyState < 2) return; // already open or connecting
  clearTimeout(_marketWsReconnectTimer);

  try { _marketWs = new WebSocket(WS_MARKET_URL); }
  catch (e) {
    logEntry("warning", `Market WS: could not open — ${e.message}`);
    _scheduleWsReconnect();
    return;
  }

  _marketWs.onopen = () => {
    _marketWsReconnectDelay = 2000; // reset backoff on success
    logEntry("cyan", "Market WS connected — instant new-market alerts active");
    _marketWs.send(JSON.stringify({ assets_ids: [], type: "market", custom_feature_enabled: true }));
    _marketWsPingTimer = setInterval(() => {
      if (_marketWs.readyState === WebSocket.OPEN) _marketWs.send("PING");
    }, 10_000);
  };

  _marketWs.onmessage = (evt) => {
    if (evt.data === "PONG") return;
    let msgs;
    try { msgs = JSON.parse(evt.data); if (!Array.isArray(msgs)) msgs = [msgs]; }
    catch { return; }
    for (const msg of msgs) {
      if (msg.event_type === "new_market") _handleNewMarketEvent(msg);
    }
  };

  _marketWs.onclose = () => {
    clearInterval(_marketWsPingTimer);
    _marketWsPingTimer = null;
    logEntry("warning", "Market WS closed — reconnecting…");
    _scheduleWsReconnect();
  };

  _marketWs.onerror = () => { /* onclose fires after onerror */ };
}

function stopMarketWS() {
  clearInterval(_marketWsPingTimer);
  clearTimeout(_marketWsReconnectTimer);
  _marketWsPingTimer = null;
  _marketWsReconnectTimer = null;
  if (_marketWs) {
    _marketWs.onclose = null; // prevent reconnect loop
    _marketWs.close();
    _marketWs = null;
  }
}

function _scheduleWsReconnect() {
  if (!["btc", "eth", "sol", "xrp"].some(a => state[a].timer)) return; // no asset running
  _marketWsReconnectTimer = setTimeout(() => {
    _marketWsReconnectDelay = Math.min(_marketWsReconnectDelay * 2, 30_000);
    startMarketWS();
  }, _marketWsReconnectDelay);
}

function _handleNewMarketEvent(msg) {
  const question = (msg.market?.question || msg.question || "").toLowerCase();
  if (!question) return;

  // Polymarket batch-creates next-day and next-week slots in advance, sending
  // new_market WS events for markets whose date is tomorrow or later. Ignore them.
  // Parse the date from the question title (e.g. "may 21") and compare to today in ET.
  const dateM = question.match(/\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\s+(\d{1,2})/i);
  if (dateM) {
    const MON = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };
    const mMon = MON[dateM[1].slice(0,3).toLowerCase()] ?? -1;
    const mDay = parseInt(dateM[2], 10);
    const etNow = new Date(Date.now() - 4 * 3600_000); // ET = UTC-4
    if (mMon !== etNow.getUTCMonth() || mDay !== etNow.getUTCDate()) {
      console.log(`[WS] new_market ignored — future date (${dateM[0].trim()}): ${question.slice(0,60)}`);
      return;
    }
  }

  for (const [asset, kws] of Object.entries(WS_KEYWORDS)) {
    if (!state[asset].timer) continue;
    if (!kws.some(kw => kw.test(question))) continue;
    logEntry("cyan", `⚡ WS new_market → <span class="amber">${question.slice(0, 60)}</span> — running ${asset.toUpperCase()} cycle`);
    // Small delay so Gamma API has time to index the new market
    setTimeout(() => runCryptoCycle(asset), 800);
  }
}

// ── Startup cooldown overlay ──────────────────────────────────────

function _startCooldownOverlay(totalSecs) {
  const overlay  = $("#cooldown-overlay");
  const numEl    = $("#cooldown-num");
  const secsEl   = $("#cooldown-secs");
  const arc      = $("#cooldown-arc");
  if (!overlay) return;

  const circumference = 213.6; // 2π × r=34
  const update = () => {
    const elapsed  = (Date.now() - state.bootTime) / 1000;
    const left     = Math.max(0, totalSecs - elapsed);
    const leftInt  = Math.ceil(left);
    if (numEl)  numEl.textContent  = leftInt;
    if (secsEl) secsEl.textContent = leftInt;
    if (arc)    arc.style.strokeDashoffset = String(circumference * (elapsed / totalSecs));
    if (left <= 0) {
      clearInterval(timer);
      overlay.style.animation = "cooldown-fade-out 0.4s ease forwards";
      setTimeout(() => { overlay.style.display = "none"; overlay.style.animation = ""; }, 400);
    }
  };

  overlay.style.display = "flex";
  update();
  const timer = setInterval(update, 250);
}

// ─────────────────────────────────────────────────────────────────

function startCryptoMode(asset) {
  if (state[asset].timer) return;
  // Prune only expired markets — keep active ones so restarts don't re-buy them
  const now = Date.now();
  for (const [cid, data] of state[asset].analyzed)
    if ((data?.endDateMs ?? data) < now) state[asset].analyzed.delete(cid);

  const cfg = CRYPTO_CONFIG[asset];
  const btn = $(`#btn-${asset}`);
  if (btn) { btn.textContent = `■ ${cfg.ticker} STOP`; btn.classList.add("active"); }
  setStat(`${asset}-status`, "ACTIVE", ASSET_COLORS[asset]);
  setRunning(true);
  requestWakeLock();

  // Record boot time once (first asset to start sets the clock for all)
  if (!state.bootTime) {
    const coolSecs = state.config?.startupCooldown ?? 90;
    state.bootTime = Date.now();
    logEntry("amber", `⏱ Startup cooldown: observing for ${coolSecs}s before trading`);
    _startCooldownOverlay(coolSecs);
  }

  logEntry("cyan", `⚡ ${cfg.ticker} MODE ON — WS instant detection + 30s safety poll`);

  startMarketWS();
  runCryptoCycle(asset);
  state[asset].timer = setInterval(() => runCryptoCycle(asset), 30_000);

  // Start polling pending GTC limit orders (trend sweep and/or AI maker)
  if (state.config?.trendSweep || state.config?.aiMaker) startPendingLimitPoll();
}

function stopCryptoMode(asset) {
  if (!state[asset]?.timer) return;
  clearInterval(state[asset].timer);
  state[asset].timer = null;
  if (state[asset].accelTimer) { clearTimeout(state[asset].accelTimer); state[asset].accelTimer = null; }

  const cfg = CRYPTO_CONFIG[asset];
  const btn = $(`#btn-${asset}`);
  if (btn) { btn.textContent = `⚡ ${cfg.ticker} MODE`; btn.classList.remove("active"); }
  setStat(`${asset}-status`, "OFF", "dim");
  if (!["btc", "eth", "sol", "xrp"].some(a => state[a].timer)) {
    setRunning(false);
    stopMarketWS();
  }
  logEntry("warning", `${cfg.ticker} mode stopped.`);
}

// Keep backward-compat names
const startBtcMode = () => startCryptoMode("btc");
const stopBtcMode  = () => stopCryptoMode("btc");

function getWindowDurationMins(question) {
  const m = question.match(/(\d+):(\d+)\s*(AM|PM)-(\d+):(\d+)\s*(AM|PM)/i);
  if (!m) return null;
  let [, sh, sm, sp, eh, em, ep] = m;
  sh = parseInt(sh); sm = parseInt(sm); eh = parseInt(eh); em = parseInt(em);
  if (sp.toUpperCase() === "PM" && sh !== 12) sh += 12;
  if (sp.toUpperCase() === "AM" && sh === 12) sh = 0;
  if (ep.toUpperCase() === "PM" && eh !== 12) eh += 12;
  if (ep.toUpperCase() === "AM" && eh === 12) eh = 0;
  const start = sh * 60 + sm, end = eh * 60 + em;
  return (end < start ? end + 1440 : end) - start;
}

async function runCryptoCycle(asset) {
  if (state[asset].running) return;  // prevent concurrent cycles
  state[asset].running = true;
  try {
    await _runCryptoCycleInner(asset);
  } finally {
    state[asset].running = false;
  }
}

async function _runCryptoCycleInner(asset) {
  const c   = state.config;
  const cfg = CRYPTO_CONFIG[asset];
  setStat(`${asset}-status`, "SCANNING…", "cyan");

  let markets, debug;
  try {
    ({ markets, debug } = await fetchCryptoMarkets(asset, { maxMinutes: 20, minVolume: c.minMarketVolume }));
  } catch (err) {
    logEntry("error", `${cfg.ticker}: market fetch failed — ${err.message}`);
    setStat(`${asset}-status`, "ERROR", "red");
    return;
  }

  // Expire gapPending entries whose market has already resolved
  { const nowMs = Date.now(); for (const [id, d] of state[asset].gapPending) { if ((d.endDateMs ?? 0) < nowMs) state[asset].gapPending.delete(id); } }

  const freshCount = markets.filter(m => !state[asset].analyzed.has(m.conditionId)).length;

  // Include gapWatch re-exams; gapPending markets are naturally fresh (not yet in analyzed)
  const fresh = markets.filter(m => !state[asset].analyzed.has(m.conditionId) || state[asset].gapWatch.has(m.conditionId));
  if (!fresh.length) {
    setStat(`${asset}-status`, "WATCHING", "dim");
    return;
  }

  let spot, candles, orderBook, fundingRate;
  try {
    [spot, candles, orderBook, fundingRate] = await Promise.all([
      fetchCryptoSpot(cfg.symbol),
      fetchCryptoCandles(cfg.symbol, 6),
      fetchCryptoOrderBook(cfg.symbol).catch(() => null),
      fetchCryptoFundingRate(cfg.symbol).catch(() => null),
    ]);
  } catch (err) {
    logEntry("error", `${cfg.ticker}: Binance data failed — ${err.message}`);
    setStat(`${asset}-status`, "ERROR", "red");
    return;
  }

  // Binance is always used as spot for the direction signal. Chainlink oracle has a
  // 0.5% deviation threshold — for BTC that's ~$400, so the oracle can sit $47+ stale
  // while Binance tracks the actual move in real time. Even a "fresh" Chainlink value
  // (arrived 10s ago) can already be misleading. Chainlink is used only for
  // priceToBeat (window-open baseline) since that's what Polymarket resolves against.
  // The 0.05% autoGap noise floor absorbs the Binance↔Chainlink inter-source delta.

  const pd = spot >= 1000 ? 0 : spot >= 10 ? 2 : 3;

  // BTC macro state: store BTC candle direction + momentum so ETH/SOL cycles can
  // suppress trades that fight BTC's dominant trend.
  if (asset === "btc") {
    const refC   = candles.slice(1, 4);
    const btcMom = refC.length ? refC.reduce((s, c) => s + (c.close - c.open), 0) / refC.length : 0;
    const last5  = candles.slice(0, 5);
    state.btcMacro = {
      bullCount: last5.filter(c => c.close > c.open).length,
      bearCount: last5.filter(c => c.close < c.open).length,
      momentum:  btcMom,
      updatedAt: Date.now(),
    };
  }

  for (const market of fresh) {
    // Track re-examination states.
    const isGapWatched  = state[asset].gapWatch.has(market.conditionId);
    const isGapPending  = state[asset].gapPending.has(market.conditionId);

    // Snapshot Chainlink price on very first detection and store in gapPending.
    // The market stays in gapPending (and therefore stays fresh) until the gap
    // clears the noise floor, at which point it is promoted to analyzed and AI
    // analysis runs.  This way a market with gap=0 at detection is observed on
    // every subsequent 30s cycle until a real gap develops — rather than being
    // analyzed once at $0 and discarded as SKIP/LOW forever.
    if (!isGapWatched && !isGapPending) {
      state[asset].gapPending.set(market.conditionId, {
        endDateMs:            new Date(market.endDate).getTime(),
        chainlinkPriceToBeat: null,           // Captured on first cycle inside window — see pre-window gate
        firstSeenAt:          Date.now(),
        firstSeenVolume:      market.volume ?? 0,
        preWindow:            true,
      });
    }

    // Derive window duration from title e.g. "March 26, 4:55PM-5:10PM ET" → 15 min → 900s.
    // Fallback to 300s (5 min) if parsing fails.
    const windowMs = (() => {
      const m = market.question.match(/(\d+:\d+)(AM|PM)-(\d+:\d+)(AM|PM)/i);
      if (!m) return 300_000;
      const toMin = (hhmm, ampm) => {
        let [h, mm] = hhmm.split(":").map(Number);
        if (ampm.toUpperCase() === "PM" && h !== 12) h += 12;
        if (ampm.toUpperCase() === "AM" && h === 12) h = 0;
        return h * 60 + mm;
      };
      const diff = (toMin(m[3], m[4]) - toMin(m[1], m[2]) + 1440) % 1440;
      return diff * 60_000;
    })();

    const timeRemaining = Math.round((new Date(market.endDate) - Date.now()) / 1000);
    const windowSecs    = windowMs / 1000;

    // Pre-window gate — Polymarket lists markets 10–20 minutes before their window opens.
    // Entering pre-window is wrong for two reasons:
    //   1. priceToBeat captured before the window = wrong reference price
    //   2. You hold through unrelated price movement before the window even starts
    // On the first cycle INSIDE the window, refresh chainlinkPriceToBeat from live Chainlink.
    {
      const snap = state[asset].gapPending.get(market.conditionId);
      if (snap?.preWindow && timeRemaining <= windowSecs) {
        let clPrice = state.chainlinkPrices[asset] ?? null;
        if (!clPrice) {
          // Chainlink hasn't ticked for this asset yet — fetch historical price at window start
          try {
            clPrice = await fetchCryptoOpenAtTime(cfg.symbol, new Date(market.endDate).getTime() - windowMs);
          } catch { /* fall through — will use last candle open below */ }
        }
        snap.chainlinkPriceToBeat = clPrice ?? null;
        snap.preWindow            = false;
        snap.firstSeenAt          = Date.now();        // Reset so oracle gate runs from window open
        snap.firstSeenVolume      = market.volume ?? 0;
        const displayPrice = snap.chainlinkPriceToBeat ?? 0;
        const src = (clPrice && !state.chainlinkPrices[asset]) ? " (historical)" : "";
        logEntry("dim", `  → window opened — priceToBeat refreshed $${displayPrice >= 1000 ? displayPrice.toFixed(0) : displayPrice.toFixed(2)}${src}`);

        // Trend-Sweep: post a GTC maker bid at 50¢ on the trend-direction token
        // BEFORE the AI cycle runs. This gets us into the book early so we fill
        // at fair value when MMs reprice their asks (instead of fighting them
        // for the last shares at 90¢).
        if (state.config?.trendSweep) {
          const sweepSignal = detectClearTrend(candles);
          if (sweepSignal) {
            placeTrendSweepBid(asset, market, sweepSignal, spot);
          }
        }
      }
      if (timeRemaining > windowSecs) {
        // pre-window polling — no log (too noisy)
        continue;
      }
    }

    // Prefer the Chainlink price snapshotted on first cycle inside the window.
    // Fallback: Binance kline at window start (small delta vs Chainlink, but directionally correct).
    const storedData = state[asset].analyzed.get(market.conditionId)
                    ?? state[asset].gapPending.get(market.conditionId);
    let priceToBeat = storedData?.chainlinkPriceToBeat ?? null;
    if (!priceToBeat) {
      try {
        priceToBeat = await fetchCryptoOpenAtTime(cfg.symbol, new Date(market.endDate).getTime() - windowMs);
      } catch { /* fall through */ }
    }
    if (!priceToBeat) priceToBeat = candles[candles.length - 1]?.open ?? spot;

    const gap = spot - priceToBeat;

    // Skip near-zero gaps — use 0.05% floor to absorb Binance↔Chainlink inter-source delta.
    // If minGapPct is explicitly set (including 0 = fully disabled), that overrides auto value.
    // Use !isNaN so that 0 means "user explicitly disabled" (not "not configured").
    // With > 0 check, typing 0 fell through to autoGap — filter never truly turned off.
    const configGap = !isNaN(c.minGapPct) ? c.minGapPct / 100 : null;
    const autoGap   = 0.0005;
    const minGapFrac = configGap ?? autoGap;
    if (minGapFrac > 0 && Math.abs(gap) < spot * minGapFrac) {
      const minGap = spot * minGapFrac;
      if (timeRemaining < 90) {
        // Too close to resolution — give up watching, mark analyzed so we stop re-checking
        const snap = state[asset].gapPending.get(market.conditionId);
        if (snap) { state[asset].analyzed.set(market.conditionId, snap); state[asset].gapPending.delete(market.conditionId); }
        logEntry("dim", `  → gap never grew (${gap >= 0 ? "+" : ""}$${gap.toFixed(pd)}) — ${timeRemaining}s left, giving up`);
      } else {
        const pendSnap = state[asset].gapPending.get(market.conditionId);
        if (!isGapPending) {
          // First detection — record timestamp and schedule an early re-check at 15s, then
          // a second early re-check at 35s so fast-developing gaps are caught quickly.
          pendSnap.firstSeenAt = Date.now();
          pendSnap.checkCount  = 0;
          if (!state[asset].pendingCheckTimer) {
            state[asset].pendingCheckTimer = setTimeout(() => {
              state[asset].pendingCheckTimer = null;
              runCryptoCycle(asset);
              // Schedule a second early check 20s after the first
              setTimeout(() => runCryptoCycle(asset), 20_000);
            }, 15_000);
          }
          logEntry("dim", `  → gap ${gap >= 0 ? "+" : ""}$${gap.toFixed(pd)} < ±$${minGap.toFixed(pd)} (first check) — observing, early re-checks at ~15s and ~35s`);
        } else {
          pendSnap.checkCount = (pendSnap.checkCount ?? 0) + 1;
          const elapsed = Math.round((Date.now() - (pendSnap.firstSeenAt ?? Date.now())) / 1000);
          logEntry("dim", `  → gap ${gap >= 0 ? "+" : ""}$${gap.toFixed(pd)} < ±$${minGap.toFixed(pd)} (re-check #${pendSnap.checkCount} at ${elapsed}s) — still watching, next check ~30s`);
        }
      }
      continue;
    }

    // Oracle observation gate — when a market is brand-new AND the gap is tiny (<0.2%),
    // the Chainlink price-to-beat may not have been published yet (typical 1-2 min lag on
    // new windows).  Deferring the AI call until volume picks up ($200+ delta) OR the market
    // is ≥90s old avoids premature momentum entries on ghost data AND saves AI tokens.
    {
      const freshSnap   = state[asset].gapPending.get(market.conditionId);
      const gapFrac     = priceToBeat > 0 ? Math.abs(gap) / priceToBeat : 1;
      const volumeDelta = market.volume - (freshSnap?.firstSeenVolume ?? market.volume);
      const marketAge   = Date.now() - (freshSnap?.firstSeenAt ?? 0);
      if (gapFrac < 0.002 && volumeDelta < 200 && marketAge < 90_000) {
        const ageS = Math.round(marketAge / 1000);
        // oracle gate deferral — no log (too noisy)
        continue; // stay in gapPending; retried next cycle
      }
    }

    // Gap has cleared the noise floor — promote from gapPending to analyzed
    // Use live map lookup (not stale isGapPending) to catch markets just added this iteration
    if (state[asset].gapPending.has(market.conditionId)) {
      const snap = state[asset].gapPending.get(market.conditionId);
      state[asset].analyzed.set(market.conditionId, snap);
      state[asset].gapPending.delete(market.conditionId);
      if (isGapPending) logEntry("dim", `  → gap confirmed ${gap >= 0 ? "+" : ""}$${gap.toFixed(pd)} — running analysis`);
    }

    // Hard block: too close to resolution — book gets thin, stop-loss can't protect.
    // Threshold is configurable (default 60s). Mark analyzed so we don't retry this market.
    const minCloseSec = parseFloat($("#min-close-sec")?.value) || state.config?.minCloseSec || 60;
    if (timeRemaining < minCloseSec) {
      const snap = state[asset].gapPending.get(market.conditionId) ?? state[asset].analyzed.get(market.conditionId);
      if (snap) state[asset].analyzed.set(market.conditionId, snap);
      state[asset].gapPending.delete(market.conditionId);
      logEntry("dim", `  → <${timeRemaining}s left — too close to resolution, skipping`);
      continue;
    }

    // Non-5-min window early-entry gate: too much time for BTC to flip mid-window.
    // Only enter when ≤4 minutes remain (gap is settled by then).
    const windowMins = getWindowDurationMins(market.question);
    if (windowMins !== null && windowMins > 5 && timeRemaining > 4 * 60) {
      logEntry("dim", `  → ${windowMins}-min window, ${Math.ceil(timeRemaining / 60)}m left — waiting until ≤4m`);
      continue;
    }

    // Precompute maxMovement for post-analysis crossing check.
    // Floor: 0.1% of spot/min avoids underestimating movement during calm 1-min candles.
    const recentRange = candles.slice(-3).reduce((mx, c) => Math.max(mx, c.high - c.low), 0);
    const maxMovement = Math.max(recentRange, spot * 0.001) * Math.max(timeRemaining / 60, 0.25) * 3;

    logEntry("info",
      `${cfg.ticker}: <span class="cyan">${market.question.slice(0, 55)}</span>  ` +
      `[${timeRemaining}s left]  ${cfg.ticker} $${spot.toFixed(pd)} vs target $${priceToBeat.toFixed(pd)}  ` +
      `<span class="${gap >= 0 ? "green" : "red"}">${gap >= 0 ? "+" : ""}$${gap.toFixed(pd)}</span>`
    );

    // Track Polymarket token price history (last 3 observations) for trend signal.
    // Newest entry is prepended; older entries shift back. Keyed by conditionId.
    const oddsHist = state[asset].oddsHistory;
    const prevOdds = oddsHist.get(market.conditionId) || [];
    const updatedOdds = [{ up: market.upPrice, ts: Date.now() }, ...prevOdds].slice(0, 3);
    oddsHist.set(market.conditionId, updatedOdds);

    let polyOrderBook = null;
    if (market.upTokenId) {
      try {
        const pr = await fetch(`/price?token_id=${encodeURIComponent(market.upTokenId)}`);
        if (pr.ok) polyOrderBook = await pr.json();
      } catch {}
    }

    let analysis;
    try {
      analysis = await analyzeCryptoMarket(
        market, { spot, candles, priceToBeat, orderBook, fundingRate, oddsHistory: updatedOdds, momentumFilterThreshold: c.momentumFilterThreshold ?? 7, polyOrderBook }, c.anthropicKey, { model: c.model }, asset
      );
    } catch (err) {
      logEntry("error", `  ${cfg.ticker} analysis failed: ${err.message}`);
      continue;
    }

    const sigColor = analysis.signal === "BUY_UP" ? "green"
                   : analysis.signal === "BUY_DOWN" ? "red" : "dim";
    logEntry("info",
      `  → <span class="${sigColor}">${analysis.signal}</span>  ` +
      `Conf: ${analysis.confidence}  ` +
      `Edge: ${(analysis.edge >= 0 ? "+" : "")}${(analysis.edge * 100).toFixed(1)}%  ` +
      (analysis.momentumTrade ? `<span class="amber">⚡MOM</span>  ` : "") +
      `| ${analysis.reasoning}`
    );

    const sigEl = $(`#stat-${asset}-signals`);
    if (sigEl) sigEl.textContent = String(parseInt(sigEl.textContent || "0") + 1);

    const minEdge     = c[`${asset}MinEdge`] ?? 0.06;
    const minOdds     = (c.minEntryOdds ?? 32) / 100;   // raised from 10% — blocks low-odds entries where stop loss produces outsized losses
    const maxOdds     = (c.maxEntryOdds ?? 87) / 100;
    const entryOdds   = analysis.signal === "BUY_UP" ? market.upPrice : market.downPrice;
    // HIGH conf + edge exception: allow entry up to 85% when AI has ≥10% edge.
    // Capped at 85% — above that, max gain <15¢/$ and slippage eats most of it.
    const highConfHighOdds = analysis.confidence === "HIGH" && analysis.absEdge >= 0.10 && entryOdds <= 0.85;
    // Near-res exception: <120s + HIGH confidence = outcome is near-certain regardless of odds.
    // Capped at 85% — 90%+ entries have terrible R/R and slippage turns them into losses.
    const nearResHighConf  = timeRemaining < 120 && analysis.confidence === "HIGH" && entryOdds <= 0.85;
    // Low-odds exception: HIGH conf + ≥15% edge can enter down to 43% — strong directional signal
    // with clear mispricing justifies bypassing the crowd-sentiment floor.
    const highConfLowOdds  = analysis.confidence === "HIGH" && (analysis.absEdge ?? 0) >= 0.15 && entryOdds >= 0.43;
    const oddsOk      = analysis.signal === "SKIP" || ((entryOdds >= minOdds || highConfLowOdds) && (entryOdds <= maxOdds || highConfHighOdds || nearResHighConf));

    // Gap-crossing guard: only applies when signal bets AGAINST the current gap direction.
    // (BUY_UP when price is below target, or BUY_DOWN when price is above target)
    const signalAgainstGap = analysis.signal === "BUY_UP" && gap < 0 ||
                             analysis.signal === "BUY_DOWN" && gap > 0;
    const crossable = !signalAgainstGap || Math.abs(gap) <= maxMovement;

    // Directional veto: BTC stop loss has indicated a correlated market regime
    const veto = state.directionVeto;
    if (veto && Date.now() < veto.expiresAt && analysis.signal === veto.signal) {
      const secsLeft = Math.ceil((veto.expiresAt - Date.now()) / 1000);
      logEntry("info", `  ↳ <span class="amber">no trade</span> — ${veto.signal} vetoed ${secsLeft}s (BTC correlation)`);
      continue;
    }

    // Market-stress cool-down: multiple stops in a short window indicate prediction-market
    // dislocation — prices can crash independently of spot. Pause new entries until cool-down expires.
    if (Date.now() < (state.stressHoldUntil ?? 0)) {
      const secsLeft = Math.ceil((state.stressHoldUntil - Date.now()) / 1000);
      logEntry("info", `  ↳ <span class="amber">no trade</span> — market-stress hold ${secsLeft}s remaining`);
      continue;
    }

    // Momentum filter (A/B toggle): skip entry when the token we'd buy dropped >7pp since
    // the previous analysis cycle — the market is actively pricing the outcome away from us.
    // Uses oddsHistory which is updated each cycle (~30s apart), so the window is ~30-60s.
    if (c.momentumFilter && analysis.signal !== "SKIP") {
      const mCheck = checkEntryMomentum(asset, market.conditionId, analysis.signal);
      if (!mCheck.ok) {
        logEntry("info",
          `  ↳ <span class="amber">no trade</span> — momentum filter: token dumped ` +
          `${(mCheck.delta * 100).toFixed(1)}pp in ${mCheck.elapsedSecs.toFixed(0)}s — ` +
          `waiting for stabilization [A/B]`
        );
        continue;
      }
    }

    // Long-window low-conviction guard: near-50% odds with lots of time remaining means
    // the market is uncertain — require minimum conviction odds before entering.
    // BTC is stricter: requires ≥55% odds with >900s remaining (volatility is harder to
    // predict over long windows and BTC gaps rarely flip in 5-min windows).
    // Exception: HIGH confidence + strong edge (≥14%) — when the AI has both high confidence
    // AND large edge on a long-window signal, the momentum/drift case is real even at 50-54%.
    const longWindowHighConf = analysis.confidence === "HIGH" && analysis.absEdge >= 0.14;
    const longWindowLowConv = ((asset === "btc"
      ? (timeRemaining > 900 && entryOdds < 0.55)
      : (timeRemaining > 800 && entryOdds < 0.52)) &&
      !longWindowHighConf);

    // BTC mid-window minimum odds guard: 50-54.9% BTC entries with >250s remaining are
    // consistently net-negative (-$19.31 at 250s, -$26.24 at 300s in session data).
    // The crowd pricing below 55% indicates the market doesn't believe the gap will hold —
    // and BTC's volatility gives reversion plenty of time to materialise.
    // Exception: HIGH confidence + strong edge (≥12%) — the AI has detected something the
    // Polymarket UI-lagging crowd hasn't priced yet; these are worth taking.
    const btcMidWindowLowOdds = asset === "btc" &&
                                 timeRemaining > 250 &&
                                 entryOdds >= 0.50 &&
                                 entryOdds < 0.52 &&
                                 !(analysis.confidence === "HIGH" && analysis.absEdge >= 0.10);

    // Short-window MEDIUM guard: <120s left is high-volatility endgame territory.
    // A single price candle can flip everything — only HIGH confidence is worth the risk.
    // 120-200s MEDIUM signals with adequate market odds have sufficient time buffer.
    const shortWindowMedium = timeRemaining < minCloseSec && analysis.confidence !== "HIGH";

    // SOL mid-window MEDIUM guard: SOL has higher intra-candle volatility than ETH/BTC.
    // Session data shows MEDIUM-confidence SOL entries with >400s remaining stop out in 1-3 min
    // even when the gap+trend thesis is correct — require ≥60% entry odds for these entries
    // to ensure the crowd signal is strong enough to offset SOL's whipsaw risk.
    const solMediumLongWindow = asset === "sol" &&
                                analysis.confidence === "MEDIUM" &&
                                timeRemaining > 600 &&
                                entryOdds < 0.57;

    // BTC near-coin-flip block: entries in the 46–54% odds range are essentially coin-flips for BTC.
    // At these odds the AI's expressed HIGH confidence is unreliable — BTC is driven by macro and
    // momentum factors that 5-min candles can't fully resolve, making 50% real uncertainty.
    // Session evidence: BTC BUY_DOWN at 49.5–51% with HIGH conf resolved $0.06 (UP won) repeatedly.
    // The current btcMidWindowLowOdds guard allows HIGH conf + ≥10% edge — but at 50% odds, a 10%
    // edge claim simply means the AI says 60% vs 50% market, which is within its error range.
    // Require ≥18% edge for coin-flip zone entries — only enter if the AI sees a genuinely strong
    // directional signal (e.g. huge gap + strong momentum + volume spike all aligned).
    const btcCoinFlipBlocked = asset === "btc" &&
                               entryOdds >= 0.46 &&
                               entryOdds <= 0.54 &&
                               !(analysis.confidence === "HIGH" && (analysis.absEdge ?? 0) >= 0.13);

    // BTC gap-flip filter: MEDIUM confidence gap-flip bets on BTC are net-negative in two cases:
    // (1) gap > 800pts — rarely flip in the window; (2) entry odds < 55% with any gap size —
    // market pricing below 55% signals strong crowd skepticism about the flip materialising,
    // and BTC's momentum-driven volatility makes stop-outs in 250-900s windows routine.
    // Session data: BTC BUY_DOWN -$19.50 at 47.5%/702s/gap≈$0 — gap=0 made signalAgainstGap
    // true (tiny float > 0), bypassing pumpSkeptic; nothing caught it in the 250-900s dead zone.
    const btcMediumGapBlocked = asset === "btc" &&
                                 analysis.confidence === "MEDIUM" &&
                                 signalAgainstGap &&
                                 (Math.abs(analysis.gap) > 800 || entryOdds < 0.55);

    // SOL/ETH mid-window gap-flip momentum guard: gap-flip trades (betting against the current
    // price direction) need momentum strong enough to actually close the gap before expiry.
    // With >300s remaining the prediction-market price has time to swing against us and hit
    // the stop-loss even when momentum is real but too weak.  Require |momentum| ≥ 50% of the
    // constant rate needed to close the gap in the remaining window.  Trades with ≤300s left
    // are exempt — near-resolution arbs where stop-loss exposure is bounded in time.
    const momNeededToFlip = timeRemaining > 0
      ? Math.abs(analysis.gap ?? 0) / (timeRemaining / 60)
      : Infinity;
    const gapFlipMidWindowBlocked = signalAgainstGap &&
                                     asset !== "btc" &&
                                     analysis.confidence === "MEDIUM" &&
                                     timeRemaining > 300 &&
                                     Math.abs(analysis.momentum ?? 0) < momNeededToFlip * 0.5;

    // Near-resolution gap-flip with opposing momentum: with <90s left the price must reverse
    // direction AND cross the gap before expiry. If momentum is actively running the WRONG way
    // (e.g. BUY_DOWN but price moving up at +1/min), there is no time to reverse and flip.
    // Applies at any confidence level — the AI can see bearish candles but momentum rules endgame.
    const nearResGapFlipMomOpposed = signalAgainstGap &&
                                     timeRemaining < minCloseSec &&
                                     ((analysis.signal === "BUY_DOWN" && (analysis.momentum ?? 0) > 0.5) ||
                                      (analysis.signal === "BUY_UP"  && (analysis.momentum ?? 0) < -0.5));

    // Near-res gap-flip low-odds filter: gap-flip trades with <300s remaining and entry odds
    // below 72% are strongly net-negative — the gap needs to physically cross target in under
    // 5 minutes, and the 58–72% range has failed consistently across multiple sessions:
    //   ETH BUY_UP at 68%/169s  → wrong dir $0.030 (-$30.33)
    //   SOL BUY_UP at 58.5%/171s → correct dir but stopped, resolved $0.970 (-$21.46)
    //   ETH BUY_UP at 63.5%/81s  → wrong dir $0.030 (-$21)
    //   Earlier: ETH losses at 48.5%/212s, 54.5%/148s, 55%/268s, 56.5%/94s all at $0.03-$0.08
    // Market pricing in the 58–72% range reflects genuine uncertainty about whether the gap
    // flips in time — when the crowd is that undecided on a gap-flip, we shouldn't bet on it.
    // Threshold raised: 56% → 58% → 72% as each boundary case surfaced in session data.
    // Entries at ≥72% odds are still allowed (crowd has high conviction the gap will cross).
    // Exception: HIGH confidence + ≥15% edge = AI has strong conviction the gap will flip
    // in time. The historical failures were MEDIUM/LOW confidence entries. A HIGH conf signal
    // at +18% edge with 250-300s is a genuinely different situation — allow it down to 50%.
    const nearResGapFlipHighConf = analysis.confidence === "HIGH" && analysis.absEdge >= 0.15;
    const nearResGapFlipLowOdds = signalAgainstGap &&
                                   timeRemaining < 300 &&
                                   entryOdds < 0.62 &&
                                   !nearResGapFlipHighConf;

    // BTC short-window exception: the pump-skeptic crowd-reversion logic breaks down when
    // BTC has a large gap, ≤500s remaining, HIGH confidence and strong edge (≥12%).
    // In these endgame windows the gap physically can't close in time — override pump-skeptic.
    // Require ≥50% entry odds: sub-50% entries on BTC are net-negative (-$26.68/session)
    // because the crowd reversion signal is stronger than the gap-persistence assumption.
    const btcShortWindowException = asset === "btc" &&
                                     timeRemaining < 500 &&
                                     analysis.confidence === "HIGH" &&
                                     analysis.absEdge >= 0.12 &&
                                     !signalAgainstGap &&
                                     entryOdds >= 0.50;

    // Pump-skeptic guard: when price has already moved in our signal direction (not a gap-flip)
    // but the market still prices the outcome below 50%, the crowd is pricing in a mean-reversion.
    // BTC +2156 at 47.5% UP and ETH +107 at 46% UP are typical pump-and-dump setups where
    // the AI overestimates edge ("gap is huge → safe") but the spike reverses before resolution.
    // Exception: HIGH conf + ≥14% edge. When AI has strong conviction AND a large edge at a
    // near-zero gap (e.g., gap=0 but drift=-178pts), the momentum case is real. The crowd
    // pricing DOWN at 49.5% doesn't negate a well-evidenced AI signal with strong drift.
    const pumpSkepticHighConf = analysis.confidence === "HIGH" && analysis.absEdge >= 0.14;
    const pumpSkeptic = !signalAgainstGap &&
                         analysis.signal !== "SKIP" &&
                         entryOdds < 0.50 &&
                         !btcShortWindowException &&
                         !pumpSkepticHighConf;

    // Fractional gap vs price-to-beat — used by nearResSmallGap, midWindowSmallGap, solLargeGapUp,
    // and the stall guard below.  Must be declared here (before first use) to avoid a temporal
    // dead zone ReferenceError that was silently killing cycles after the signal log.
    const stallGapPct = (analysis.priceToBeat ?? 0) > 0
      ? Math.abs((analysis.gap ?? 0) / analysis.priceToBeat)
      : 0;

    // Near-res low-odds guard: at <200s remaining the prediction market price is volatile
    // and a stop-loss fires easily on normal fluctuations even when the underlying gap is intact.
    // Require ≥50% entry odds — below 50% the crowd expects the opposite outcome.
    // Exception: HIGH conf + ≥15% edge can enter at 40-49.9% — same rationale as BTC mid-window
    // exception (UI lag, thin liquidity, market underpricing a near-certain gap outcome).
    const nearResLowOdds = timeRemaining < 200 && entryOdds < 0.50 &&
                           !(analysis.confidence === "HIGH" && analysis.absEdge >= 0.15);

    // Near-res small-gap guard: when <200s remaining and the gap is near-zero (<0.05% of price),
    // the outcome is essentially coin-flip regardless of trend/momentum signal.  The effective
    // stop loss (32% at 90-200s) on a full-size position means one wrong coin-flip wipes
    // multiple wins.  Session data: three <0.05% gap entries at 149-183s lost -$46, -$51, -$50.
    // A $1 gap on ETH ($2000) is exactly 0.05% — that's the minimum "meaningful" gap threshold.
    const nearResSmallGap = timeRemaining < 200 && stallGapPct < 0.0005;

    // Mid-window small-gap guard: a tiny actual gap (< 0.10% of price) at 200-900s remaining
    // is a drift/momentum projection bet, not a gap bet — regardless of confidence level.
    // In a flat market the projected "effective gap" evaporates the moment momentum pauses.
    // HIGH confidence on a $0 gap is the AI overweighting momentum; it is still a coin-flip.
    // Session data: ETH gap=$0 at 275s HIGH conf → -$71.17; ETH Trades 1/3/5 at 270-400s all WRONG DIR.
    // BTC gap=$0 at 631s HIGH conf +18% edge → entered early before direction confirmed, -$5.68 unrealized.
    // Upper bound extended from 600s → 900s to close the 600-900s dead zone where longWindowLowConv
    // hasn't kicked in yet but midWindowSmallGap had already stopped watching.
    // Use gapWatch for one observation cycle: if gap grows to threshold on re-check, allow entry.
    // Thresholds relaxed: HIGH 0.05%→0.03%, MEDIUM/LOW 0.10%→0.07% — prior values filtered too aggressively.
    const midGapThreshold = analysis.confidence === "HIGH" ? 0.0003 : 0.0007;
    const midWindowSmallGap = timeRemaining >= 200 && timeRemaining < 900 &&
                              stallGapPct < midGapThreshold;

    // SOL large-gap BUY_UP guard: when SOL has just pumped >2% above target on a volume spike,
    // the position is priced for perfection — the spike reverses and the UP token crashes.
    // Session data: 5 BUY_UP losses totalling ~$56 during pump phases; 0 recoveries.
    // Requires a volume spike (>1.8×) to distinguish fresh pumps from sustained trends:
    // a sustained trend at 3%+ above target with normal volume is a legitimate BUY_UP opportunity,
    // but a sudden spike with elevated volume is fragile and likely to mean-revert.
    const solLargeGapUp = asset === "sol" &&
                          analysis.signal === "BUY_UP" &&
                          !signalAgainstGap &&
                          stallGapPct > 0.020 &&
                          (analysis.volSpikeRatio ?? 0) > 1.8;

    // Per-asset concurrent position limit: max 1 open position per asset at a time.
    // Multiple simultaneous SOL or ETH positions in the same direction hit stop-loss
    // together when the asset reverses, causing outsized correlated losses and triggering
    // the market-stress cooldown (which then blocks subsequent valid entries too).
    const assetPositionOpen = state.trades.some(t => t.type === asset);

    // BTC macro filter: when BTC shows a strong directional signal (≥4/5 candles aligned
    // + momentum ≥ 20/min in that direction), altcoin trades that fight that trend have a
    // high stop-loss failure rate (BTC leads alts).  Block BUY_UP on ETH/SOL when BTC is
    // strongly bearish, and BUY_DOWN when BTC is strongly bullish.
    // State expires after 5 minutes so stale BTC data doesn't block valid alt entries.
    // Threshold raised from 3/5 → 4/5: 3/5 is only 60% bullish/bearish (coin-flip level)
    // and was blocking too many HIGH confidence alt trades. 4/5 = 80% = genuine trend.
    const btcMacro      = state.btcMacro;
    const btcMacroFresh = btcMacro && (Date.now() - btcMacro.updatedAt) < 300_000;
    const btcMacroVeto  = asset !== "btc" && btcMacroFresh && (
      (analysis.signal === "BUY_UP"   && btcMacro.bearCount >= 4 && btcMacro.momentum <= -20) ||
      (analysis.signal === "BUY_DOWN" && btcMacro.bullCount >= 4 && btcMacro.momentum >= 20)
    );

    // Stall guard: a large gap with near-zero momentum is "floating" — no force is sustaining
    // it above/below target, so gravity takes over and it reverts. Uses the same momentum
    // threshold as the signal generator (spot × 0.00007). Does not apply to gap-flip trades
    // or near-resolution windows (<120s) where time compression makes momentum less relevant.
    const momThresholdStall = spot * 0.00007;
    const stalled = !signalAgainstGap &&
                     analysis.signal !== "SKIP" &&
                     stallGapPct > 0.030 &&
                     Math.abs(analysis.momentum ?? Infinity) < momThresholdStall &&
                     timeRemaining > 120;

    // Momentum trade bypass: current gap is tiny (<0.10%) but expected drift is large (>0.15%
    // of price), so the AI is trading the TOKEN PRICE MOVE, not the final resolution outcome.
    // Auto-detected from analysis data — more reliable than depending on the AI to flag it.
    // Only bypasses midWindowSmallGap; all other risk filters still apply.
    // Require HIGH confidence so low-quality momentum signals don't slip through.
    const expectedDriftPts  = (analysis.momentum ?? 0) * ((analysis.timeRemaining ?? 0) / 60);
    const effectiveGapPct   = (analysis.priceToBeat ?? 0) > 0
      ? Math.abs((analysis.gap ?? 0) + expectedDriftPts) / analysis.priceToBeat
      : 0;
    const autoMomentumTrade = analysis.signal !== "SKIP" &&
                              analysis.confidence === "HIGH" &&
                              stallGapPct > 0.0002 &&   // require real gap floor (>0.02%) — zero-gap pure-momentum plays fail
                              stallGapPct < 0.001 &&    // current gap < 0.10%
                              effectiveGapPct > 0.0015 && // effective gap > 0.15% of price
                              (analysis.signal === "BUY_UP" ? market.upPrice : market.downPrice) < 0.68;
    const momentumTradeBypass = (analysis.momentumTrade === true || autoMomentumTrade) &&
                                analysis.confidence === "HIGH" &&
                                analysis.signal !== "SKIP";

    // Stop cooldown circuit breaker: skip one window after 2 consecutive stops
    if (c.stopCooldown && state.stopCooldownActive) {
      state.stopCooldownActive = false;
      logEntry("amber", `  ⚠ Stop cooldown active — skipping window after consecutive stops`);
      continue;
    }

    const qualifies = c.aiMaker
      ? (
          analysis.signal !== "SKIP" &&
          !assetPositionOpen &&
          state.stats.spent < c.maxDaily
        )
      : (
          analysis.signal !== "SKIP" &&
          oddsOk &&
          crossable &&
          !longWindowLowConv &&
          !btcMidWindowLowOdds &&
          !btcCoinFlipBlocked &&
          !shortWindowMedium &&
          !solMediumLongWindow &&
          !btcMediumGapBlocked &&
          !gapFlipMidWindowBlocked &&
          !nearResGapFlipMomOpposed &&
          !nearResGapFlipLowOdds &&
          !btcMacroVeto &&
          !pumpSkeptic &&
          !stalled &&
          !nearResLowOdds &&
          !nearResSmallGap &&
          (!midWindowSmallGap || momentumTradeBypass) &&
          !solLargeGapUp &&
          !assetPositionOpen &&
          (analysis.confidence === "HIGH" || analysis.absEdge >= minEdge) &&
          state.stats.spent < c.maxDaily
        );

    if (autoMomentumTrade && !analysis.momentumTrade) {
      logEntry("dim", `  ↳ <span class="amber">⚡MOM auto</span> — gap ${(stallGapPct * 100).toFixed(3)}% but effective gap ${(effectiveGapPct * 100).toFixed(3)}% (drift ${expectedDriftPts >= 0 ? "+" : ""}${expectedDriftPts.toFixed(2)}) — momentum trade bypass active`);
    }

    if (qualifies) {
      // Fresh-window gate: CLOB book is thin/empty for the first ~30s after a window opens.
      // Entering immediately sends a FOK into an empty book and causes catastrophic fills.
      // AI Maker mode posts a resting GTC bid, so book depth doesn't matter — skip the wait.
      const windowAge = storedData?.firstSeenAt ? Date.now() - storedData.firstSeenAt : Infinity;
      if (!c.aiMaker && windowAge < 30_000) {
        logEntry("dim", `  ↳ <span class="amber">fresh window</span> — ${Math.round(windowAge/1000)}s since open, holding 30s for book depth (next cycle will trade)`);
      } else {
        state[asset].gapWatch.delete(market.conditionId);
        placeCryptoTrade(asset, analysis, { spot, priceToBeat });
      }
    } else if (analysis.signal !== "SKIP") {
      const reasons = [];
      try {
      // Re-examined market whose gap grew but was blocked by a different filter — clean up watch.
      if (isGapWatched && !nearResSmallGap) state[asset].gapWatch.delete(market.conditionId);
      if (c.aiMaker) {
        // GTC maker: only position limit and budget block trades — all market-order filters are irrelevant.
        if (assetPositionOpen) reasons.push(`${asset.toUpperCase()} position already open — max 1 per asset (correlated stop risk)`);
        if (state.stats.spent >= c.maxDaily) reasons.push("daily budget exhausted");
        if (reasons.length === 0)
          reasons.push(`qualifies=false [assetPositionOpen=${assetPositionOpen} spent=${state.stats.spent} maxDaily=${c.maxDaily}]`);
      } else {
      if (!oddsOk) {
        if (entryOdds > maxOdds)
          reasons.push(`entry odds ${(entryOdds * 100).toFixed(1)}% > max ${(maxOdds * 100).toFixed(0)}% (bad risk/reward)`);
        else
          reasons.push(`entry odds ${(entryOdds * 100).toFixed(1)}% < min ${(minOdds * 100).toFixed(0)}%`);
      }
      if (!crossable) reasons.push(`gap $${Math.abs(gap).toFixed(pd)} too large to cross in ${timeRemaining}s (max ≈${maxMovement.toFixed(pd)})`);
      if (longWindowLowConv) reasons.push(`long window (${timeRemaining}s) needs ≥${asset === "btc" ? "60" : "55"}% conviction odds — got ${(entryOdds * 100).toFixed(1)}%`);
      if (btcMidWindowLowOdds) reasons.push(`BTC mid-window low odds — ${(entryOdds * 100).toFixed(1)}% entry with ${timeRemaining}s left needs ≥55% or HIGH conf + ≥12% edge (crowd reversion signal)`);
      if (btcCoinFlipBlocked) reasons.push(`BTC coin-flip zone — ${(entryOdds * 100).toFixed(1)}% is near 50/50; need HIGH conf + ≥18% edge to enter (AI overconfidence risk at these odds, session evidence)`);

      if (shortWindowMedium) reasons.push(`short window (${timeRemaining}s) requires HIGH confidence — endgame volatility too high for MEDIUM (<120s)`);
      if (solMediumLongWindow) reasons.push(`SOL mid-window MEDIUM — ${(entryOdds * 100).toFixed(1)}% entry with ${timeRemaining}s left needs ≥60% (SOL whipsaw risk too high for MEDIUM conviction)`);
      if (btcMediumGapBlocked) {
        if (Math.abs(analysis.gap) > 800)
          reasons.push(`BTC gap-flip blocked — MEDIUM confidence with gap $${Math.abs(analysis.gap).toFixed(0)} > $800 rarely flips in time`);
        else
          reasons.push(`BTC gap-flip blocked — MEDIUM confidence gap-flip at ${(entryOdds * 100).toFixed(1)}% (<55%) with ${timeRemaining}s left — crowd skepticism too strong`);
      }
      if (gapFlipMidWindowBlocked) reasons.push(`gap-flip momentum too weak — need ${momNeededToFlip.toFixed(3)}/m to close gap, got ${Math.abs(analysis.momentum ?? 0).toFixed(3)}/m (need ≥50%)`);
      if (nearResGapFlipMomOpposed) reasons.push(`near-res gap-flip blocked — momentum ${(analysis.momentum ?? 0).toFixed(2)}/m opposes ${analysis.signal} flip with only ${timeRemaining}s left`);
      if (nearResGapFlipLowOdds) reasons.push(`near-res gap-flip low-odds — ${(entryOdds * 100).toFixed(1)}% entry (<72%) with only ${timeRemaining}s left — market uncertainty too high for gap-flip in limited time`);
      if (btcMacroVeto) {
        const mDir = btcMacro.bearCount >= 3 ? "bearish" : "bullish";
        const mCnt = btcMacro.bearCount >= 3 ? btcMacro.bearCount : btcMacro.bullCount;
        reasons.push(`BTC macro veto — BTC ${mDir} (${mCnt}/5 candles, ${btcMacro.momentum.toFixed(1)}/min) opposes ${analysis.signal}`);
      }
      if (pumpSkeptic) reasons.push(`pump-skeptic — price already ${analysis.signal === "BUY_UP" ? "above" : "below"} target but market prices it at ${(entryOdds * 100).toFixed(1)}% (<50%) — crowd expects reversion`);
      if (stalled) reasons.push(`stall guard — gap ${(stallGapPct * 100).toFixed(1)}% but momentum ≈0 (${(analysis.momentum ?? 0).toFixed(2)}/m < threshold ${momThresholdStall.toFixed(2)}/m) — no driving force`);
      if (nearResLowOdds) reasons.push(`near-res low-odds — ${timeRemaining}s left but market only at ${(entryOdds * 100).toFixed(1)}% (need ≥50% for near-res entries ≤200s)`);
      if (nearResSmallGap) {
        if (isGapWatched) {
          // Second look: gap still hasn't grown — give up.
          state[asset].gapWatch.delete(market.conditionId);
          reasons.push(`near-res small gap — ${timeRemaining}s left, gap ${(stallGapPct * 100).toFixed(3)}% still <0.05% after observation — skipping`);
        } else {
          // First time: gap is tiny but signal is present — observe one more cycle (~30s).
          state[asset].gapWatch.set(market.conditionId, { signal: analysis.signal, startedAt: Date.now() });
          reasons.push(`near-res small gap — ${timeRemaining}s left, gap ${(stallGapPct * 100).toFixed(3)}% (<0.05%) — watching for gap expansion next cycle`);
        }
      }
      if (midWindowSmallGap && !momentumTradeBypass) {
        if (isGapWatched) {
          state[asset].gapWatch.delete(market.conditionId);
          reasons.push(`mid-window small gap — ${timeRemaining}s left, gap ${(stallGapPct * 100).toFixed(3)}% still <0.10% after observation — skipping`);
        } else {
          state[asset].gapWatch.set(market.conditionId, { signal: analysis.signal, startedAt: Date.now() });
          reasons.push(`mid-window small gap — ${timeRemaining}s left, gap ${(stallGapPct * 100).toFixed(3)}% (<0.10%) — watching for gap expansion next cycle`);
        }
      } else if (midWindowSmallGap && momentumTradeBypass) {
        reasons.push(`mid-window small gap bypassed — momentum trade: AI predicts token will hit take-profit from momentum alone (gap=${(stallGapPct * 100).toFixed(3)}% but HIGH conf momentum signal)`);
      }
      if (solLargeGapUp) reasons.push(`SOL large-gap BUY_UP — SOL ${(stallGapPct * 100).toFixed(1)}% above target with vol spike ${(analysis.volSpikeRatio ?? 0).toFixed(2)}× — fresh pump reversal risk`);
      if (assetPositionOpen) reasons.push(`${asset.toUpperCase()} position already open — max 1 per asset (correlated stop risk)`);
      if (analysis.confidence === "LOW") reasons.push("confidence LOW");
      else if (analysis.confidence === "MEDIUM" && analysis.absEdge < minEdge)
        reasons.push(`edge ${(analysis.absEdge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(0)}% required for MEDIUM`);
      if (analysis.absEdge < minEdge)
        reasons.push(`edge ${(analysis.absEdge * 100).toFixed(1)}% < minEdge ${(minEdge * 100).toFixed(1)}%`);
      if (state.stats.spent >= c.maxDaily)
        reasons.push("daily budget exhausted");
      if (reasons.length === 0)
        reasons.push(`all filters ok but qualifies=false [oddsOk=${oddsOk} nearResSmallGap=${nearResSmallGap} midWindowSmallGap=${midWindowSmallGap} momentumBypass=${momentumTradeBypass} absEdge=${(analysis.absEdge??'?')} minEdge=${minEdge}]`);
      }
      logEntry("info", `  ↳ <span class="amber">no trade</span> — ${reasons.join(", ")}`);
      } catch (err) {
        logEntry("dim", `  ↳ <span class="amber">no trade</span> — [reason build error: ${err.message}]`);
      }
    }
  }

  // Oracle-latency acceleration: Chainlink heartbeats every ~20-27s on-chain.
  // When a market is <300s from resolution and still watching for a gap to develop
  // (in gapPending) or waiting for a small gap to grow (in gapWatch), re-check in
  // 10s rather than waiting the full 30s — this maximises the chance of catching
  // the oracle update window before Polymarket odds reprice.
  const nowMs2 = Date.now();
  const hasUrgentGap = markets.some(m => {
    const tr = (new Date(m.endDate) - nowMs2) / 1000;
    return tr > 0 && tr < 300 &&
      (state[asset].gapPending.has(m.conditionId) || state[asset].gapWatch.has(m.conditionId));
  });
  if (hasUrgentGap && !state[asset].accelTimer) {
    state[asset].accelTimer = setTimeout(() => {
      state[asset].accelTimer = null;
      runCryptoCycle(asset);
    }, 10_000);
    // accelerated re-check — no log (too noisy)
  } else if (!hasUrgentGap && state[asset].accelTimer) {
    clearTimeout(state[asset].accelTimer);
    state[asset].accelTimer = null;
  }

  setStat(`${asset}-status`, "WATCHING", "dim");
}

const runBtcCycle = () => runCryptoCycle("btc");

async function placeCryptoTrade(asset, analysis, { spot, priceToBeat }) {
  const c      = state.config;
  const cfg    = CRYPTO_CONFIG[asset];

  // Startup cooldown: skip trading until the observation window has passed
  if (state.bootTime) {
    const coolMs  = (c.startupCooldown ?? 90) * 1000;
    const elapsed = Date.now() - state.bootTime;
    if (elapsed < coolMs) {
      const secsLeft = Math.ceil((coolMs - elapsed) / 1000);
      logEntry("amber", `  ↳ <span class="amber">cooldown</span> — observing ${secsLeft}s before first trade`);
      return;
    }
  }
  const market = analysis.market;
  const isUp   = analysis.signal === "BUY_UP";

  const entryPrice = isUp ? market.upPrice   : market.downPrice;
  const tokenId    = isUp ? market.upTokenId : market.downTokenId;

  // Scale bet size by time remaining — more time = more uncertainty = smaller bet.
  // Near-res markets are illiquid: large FOK orders fail and exit slippage is severe.
  // Use smaller sizes in the final 150s to match available book depth (~$3-5).
  const secsForSizing = Math.max(1, Math.round((new Date(market.endDate) - Date.now()) / 1000));
  const timeFraction  = secsForSizing <= 150 ? 0.50   // thin book near expiry — keep small
                      : secsForSizing <= 300 ? 0.60   // 5-min windows and late 15-min entries: reduce exposure
                      : secsForSizing <= 400 ? 1.0
                      : secsForSizing <= 800 ? 0.65
                      : 0.40;
  // Scale down size for high-odds entries (reversal costly when you paid premium) AND
  // low-odds entries (gap-flip — market disagrees, token crashes hard when wrong).
  // High end: 1.0× at 65% → 0.40× at 87%. Low end: 1.0× at 35% → 0.40× at 10%.
  const oddsFraction = entryPrice > 0.65 ? Math.max(0.40, 1 - (entryPrice - 0.65) / 0.367)
                     : entryPrice < 0.35 ? Math.max(0.40, 1 - (0.35 - entryPrice) / 0.250)
                     : 1.0;
  // MEDIUM confidence gets half size — near-50% entries with uncertain direction shouldn't
  // get max exposure (e.g. the -$27.45 ETH loss at 51% MEDIUM with full $50 stake).
  const confidenceFraction = analysis.confidence === "HIGH" ? 1.0 : 0.5;
  const maxBet = c[`${asset}MaxBet`] ?? c.btcMaxBet ?? 5;
  // AI Maker mode: post the full UI bet size as a resting GTC bid.  None of the FAK
  // sizing scalers apply — there's no slippage on a maker fill, and the bid only fills
  // if the market crashes to our price (so a bigger bet here is bigger gain on fill).
  const rawAmount = c.aiMaker
    ? Math.min(maxBet, c.maxDaily - state.stats.spent)
    : Math.min(maxBet * timeFraction * oddsFraction * confidenceFraction, c.maxDaily - state.stats.spent);
  // Near-resolution size cap: prediction markets become illiquid in the final 120s and a stop
  // can fire on a single bad tick even with a large underlying gap intact.  Cap exposure at $25
  // to bound catastrophic stop losses that outweigh the edge (e.g. SOL -$33.53 at 156s).
  // AI Maker bids are exempt — the bid auto-cancels at <60s pre-resolution anyway.
  const nearResCap = c.aiMaker ? Infinity
                   : secsForSizing <= 150 ? 5
                   : secsForSizing <= 300 ? 15
                   : Infinity;
  // Gap-flip size cap: gap-flip trades bet against the current price direction — the token crashes
  // hard to ~$0.03 when wrong, with no partial recovery.  Cap at $50 to limit worst-case losses
  // while still allowing meaningful upside on the higher-frequency correct-direction wins.
  // Session data: -$85.57 and -$85.32 on full-size gap-flip entries; winning gap-flips avg ~$40.
  // AI Maker bids are exempt — the maker bid only fills at our chosen price.
  const signalAgainstGapSizing = (analysis.signal === "BUY_UP"   && (analysis.gap ?? 0) < 0) ||
                                  (analysis.signal === "BUY_DOWN" && (analysis.gap ?? 0) > 0);
  const gapFlipCap = c.aiMaker ? Infinity : (signalAgainstGapSizing ? 50 : Infinity);
  let amount = Math.min(rawAmount, nearResCap, gapFlipCap);
  // Sub-$1 rescue: HIGH-conf qualified signals were silently lost to $0.75-0.95 sizes;
  // bump to the $1 minimum so we actually take the position (budget permitting).
  if (amount >= 0.50 && amount < 1.00 && analysis.confidence === "HIGH" && (c.maxDaily - state.stats.spent) >= 1.00) {
    logEntry("dim", `  ↳ <span class="amber">size bump</span> — computed $${amount.toFixed(2)} → $1.00 (HIGH conf, Polymarket minimum)`);
    amount = 1.00;
  }
  if (amount < 1.00) {
    logEntry("dim", `  ↳ <span class="dim">skipped</span> — computed size $${amount.toFixed(2)} < $1.00 Polymarket minimum (maxBet=${maxBet} time=${timeFraction.toFixed(2)} odds=${oddsFraction.toFixed(2)} conf=${confidenceFraction})`);
    return;
  }

  // ─── AI Maker Mode: post GTC limit bid instead of FAK ─────────────────
  if (c.aiMaker) {
    const priceCt = Math.max(20, Math.min(80, c[`${asset}MakerPrice`] ?? 50));

    // Selective Mode: skip the two patterns most strongly correlated with losses.
    // (1) Expensive bid + long window + weak edge → asymmetric loss (≥18¢ down, ≤10¢ up)
    // (2) Signal against current gap + long window + weak edge → relies on reversal
    if (c.selectiveMode) {
      const absEdge = analysis.absEdge ?? Math.abs(analysis.edge ?? 0);
      const gap = analysis.gap ?? 0;
      const signalAgainstGap = (analysis.signal === "BUY_UP"   && gap < 0) ||
                                (analysis.signal === "BUY_DOWN" && gap > 0);
      const longWindow = secsForSizing > 300;

      if (priceCt >= 65 && longWindow && absEdge < 0.12) {
        logEntry("dim",
          `  ↳ <span class="dim">selective skip</span> — bid ${priceCt}¢ on ${Math.floor(secsForSizing/60)}m window, ` +
          `edge ${(absEdge*100).toFixed(1)}% < 12% required`
        );
        return;
      }
      if (signalAgainstGap && longWindow && absEdge < 0.10) {
        logEntry("dim",
          `  ↳ <span class="dim">selective skip</span> — gap-flip on ${Math.floor(secsForSizing/60)}m window, ` +
          `edge ${(absEdge*100).toFixed(1)}% < 10% required`
        );
        return;
      }
    }

    await placeAiMakerBid(asset, analysis, {
      market, tokenId, amount, price: priceCt / 100, spot, priceToBeat,
    });
    return;
  }

  const tag      = c.dryRun ? "[SIM]" : "[LIVE]";
  const sigClass = isUp ? "green" : "red";
  const pd       = spot >= 1000 ? 0 : spot >= 10 ? 2 : 3;

  logEntry("trade",
    `${tag} ${cfg.ticker} <span class="${sigClass}">${analysis.signal}</span>  ` +
    `$${amount.toFixed(2)}  —  ${market.question.slice(0, 50)}`
  );
  logEntry("info",
    `  Entry: ${(entryPrice * 100).toFixed(1)}%  ` +
    `${cfg.ticker} $${spot.toFixed(pd)} vs target $${priceToBeat.toFixed(pd)}  ` +
    `Gap: ${analysis.gap >= 0 ? "+" : ""}$${analysis.gap.toFixed(pd)}`
  );

  const secsLeft  = Math.max(1, Math.round((new Date(market.endDate) - Date.now()) / 1000));
  const searchQ   = cfg.keywords[0].replace(/ /g, "+");
  const marketUrl = market.slug
    ? `https://polymarket.com/event/${market.slug}`
    : `https://polymarket.com/markets?q=${searchQ}`;

  const trade = {
    id:            Date.now() + state.stats.trades,
    time:          new Date().toUTCString().slice(-12, -4),
    question:      market.question,
    conditionId:   market.conditionId,
    tokenId,
    signal:        analysis.signal,
    entryPrice,
    amount,
    shares:        amount / entryPrice,
    currentPrice:  entryPrice,
    peakPrice:     entryPrice,
    troughPrice:   entryPrice,
    confidence:    analysis.confidence,
    unrealizedPnl: 0,
    mode:          c.dryRun ? "SIM" : "LIVE",
    type:          asset,
    endDate:       market.endDate,
    confirmed:     c.dryRun,  // live trades stay false until BUY confirms on-chain
    spot,
    priceToBeat,
    gap:             analysis.gap,
    edge:            analysis.edge,
    reasoning:       analysis.reasoning ?? "",
    momentum:        analysis.momentum ?? null,      // pts/min at entry (for spike detection)
    volatility:      analysis.volatility ?? null,    // ±pts/candle range at entry
    volSpikeRatio:   analysis.volSpikeRatio ?? null, // last candle vol / avg (>2 = spike)
    signalAgainstGap: (analysis.signal === "BUY_UP"   && (analysis.gap ?? 0) < 0) ||
                      (analysis.signal === "BUY_DOWN" && (analysis.gap ?? 0) > 0), // gap-flip?
    priceHistory:    [],
    totalSecs:       secsLeft,
    entryTime:       Date.now(),
    entryVolume:     market.volume ?? null,
    marketUrl,
    exitPrice:       null,   // set on close
    secsAtClose:     null,   // set on close
  };

  state.trades.push(trade);
  priceStream.subscribe(tokenId);

  if (c.dryRun) {
    // Dry run: card appears immediately (no real order to wait for)
    addCryptoCard(trade);
    startCryptoCountdown();
  } else {
    // Pre-order CLOB depth check.
    // Brief pause first — Gamma API prices lag by 30-60s; waiting 2s lets any market move
    // show up in the live CLOB before we commit.  After the pause we do two checks:
    // 1) Gate 1 (price drift): if best_ask moved >8pp from our expected entry in EITHER
    //    direction, the market has repriced since AI analyzed — skip and let the next 30s
    //    cycle re-evaluate with fresh data.
    //    Both directions matter:
    //      • much MORE expensive → thin book / momentum gone
    //      • much CHEAPER → market crashed against our direction (e.g. UP token repriced
    //        from 44¢ → 31¢ means crowd thinks DOWN is winning now)
    // 2) Gate 2 (depth sweep): walk the ask ladder to estimate avg fill for our USDC amount.
    //    Skip if: book too thin to absorb our order, OR |avg fill − expected| > 10pp.
    //    This catches thick-book sweeps like 52¢ entry sweeping to 24¢ fill.
    await new Promise(r => setTimeout(r, 2000));   // 2s pause — let stale data expire
    try {
      const priceResp = await fetch(`/price?token_id=${encodeURIComponent(tokenId)}`);
      const priceData = await priceResp.json();
      if (!priceData.error) {
        const liveAsk  = priceData.best_ask;
        const drift    = Math.abs(liveAsk - entryPrice);

        // Gate 1: top-of-book price drift (tightened 15pp → 8pp, absolute value)
        if (drift > 0.08) {
          const dir = liveAsk < entryPrice ? "market crashed ↓" : "market moved ↑";
          logEntry("warn", `  ↳ <span class="red">CLOB price check: live ask ${(liveAsk*100).toFixed(1)}% vs expected ${(entryPrice*100).toFixed(1)}% — ${(drift*100).toFixed(1)}pp drift (${dir}) — skipping, next cycle will re-evaluate</span>`);
          const idx = state.trades.indexOf(trade);
          if (idx !== -1) state.trades.splice(idx, 1);
          priceStream.unsubscribe(tokenId);
          state.stats.trades = Math.max(0, state.stats.trades - 1);
          state.stats.spent  = Math.max(0, state.stats.spent - amount);
          setStat("trades",    String(state.stats.trades));
          setStat("spent",     `$${state.stats.spent.toFixed(2)}`);
          setStat("budget",    `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);
          return;
        }

        // Gate 2: depth / slippage simulation
        // Walk ask levels (sorted lowest price first) to estimate weighted average fill.
        // Each ask level has {price, size} where size is in shares (1 share ≈ 1 USDC / price).
        // Only count levels the FOK order can actually reach — the server caps price at
        // entry + 5% (max 92%).  Counting higher levels overstates fillable depth and causes
        // FOK failures that the simulation wrongly predicted would succeed.
        const priceCapFOK  = Math.min(entryPrice + 0.05, 0.92);  // mirrors server max_slippage
        const askLevels = priceData.asks || [];
        if (askLevels.length > 0) {
          let usdcRemaining  = amount;
          let usdcFilled     = 0;
          let sharesAcquired = 0;

          for (const level of askLevels) {
            if (usdcRemaining <= 0) break;
            if (level.price > priceCapFOK) break;  // FOK won't fill above the price cap — stop
            const px          = level.price;
            const sharesAvail = level.size;
            const usdcNeeded  = sharesAvail * px;
            const usdcTake    = Math.min(usdcRemaining, usdcNeeded);
            const sharesTaken = usdcTake / px;
            usdcFilled     += usdcTake;
            sharesAcquired += sharesTaken;
            usdcRemaining  -= usdcTake;
          }

          if (usdcRemaining > 0.01) {
            const fillable = amount - usdcRemaining;
            const fillPct  = (fillable / amount * 100).toFixed(0);
            if (fillable >= 1.00) {
              // Book can partially fill within the price cap — trim order to what's available.
              // Better to place a smaller confirmed fill than miss the trade entirely.
              const trimmed = Math.floor(fillable * 100) / 100;  // round down to nearest cent
              logEntry("dim", `  ↳ <span class="amber">depth trim</span> — book fillable $${trimmed.toFixed(2)} of $${amount.toFixed(2)} (${fillPct}% at ≤${(priceCapFOK*100).toFixed(0)}¢), sizing down`);
              amount       = trimmed;
              trade.amount = trimmed;
              trade.shares = trimmed / entryPrice;
              // state.stats.spent picks up the trimmed amount at the sync update below — no early update needed
            } else {
              logEntry("warn", `  ↳ <span class="red">CLOB depth check: book too thin — only $${fillable.toFixed(2)} fillable at ≤${(priceCapFOK*100).toFixed(0)}¢ (${fillPct}% of $${amount.toFixed(2)}), skipping</span>`);
              const idx = state.trades.indexOf(trade);
              if (idx !== -1) state.trades.splice(idx, 1);
              priceStream.unsubscribe(tokenId);
              state.stats.trades = Math.max(0, state.stats.trades - 1);
              state.stats.spent  = Math.max(0, state.stats.spent - amount);
              setStat("trades",    String(state.stats.trades));
              setStat("spent",     `$${state.stats.spent.toFixed(2)}`);
              setStat("budget",    `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);
              return;
            }
          }

          const avgFill   = usdcFilled / sharesAcquired;
          const slippage  = avgFill - entryPrice;           // signed: + = more expensive, - = market crashed
          const absSlip   = Math.abs(slippage);

          if (absSlip > 0.10) {
            const reason = slippage > 0 ? "thin book sweep" : "market repriced against direction";
            logEntry("warn", `  ↳ <span class="red">CLOB depth check: est. avg fill ${(avgFill*100).toFixed(1)}% vs entry ${(entryPrice*100).toFixed(1)}% — ${(slippage*100).toFixed(1)}pp (${reason}), skipping</span>`);
            const idx = state.trades.indexOf(trade);
            if (idx !== -1) state.trades.splice(idx, 1);
            priceStream.unsubscribe(tokenId);
            state.stats.trades = Math.max(0, state.stats.trades - 1);
            state.stats.spent  = Math.max(0, state.stats.spent - amount);
            setStat("trades",    String(state.stats.trades));
            setStat("spent",     `$${state.stats.spent.toFixed(2)}`);
            setStat("budget",    `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);
            return;
          }

          logEntry("dim", `  → CLOB depth check: live ask ${(liveAsk*100).toFixed(1)}% · est. fill ${(avgFill*100).toFixed(1)}% for $${amount.toFixed(2)} (${(slippage >= 0 ? "+" : "")}${(slippage*100).toFixed(1)}pp) — ok`);
        } else {
          // No ask levels — book is empty (typical in the first ~30s after a window opens).
          // Firing FOK into an empty book sweeps stale limit orders at catastrophic prices
          // (e.g. 47% → 5%, 50% → 10%).  Abort and let the next cycle retry once depth exists.
          logEntry("warn", `  ↳ <span class="amber">empty book</span> — no CLOB ask levels, skipping (book hasn't established yet — next cycle will retry)`);
          const idx = state.trades.indexOf(trade);
          if (idx !== -1) state.trades.splice(idx, 1);
          priceStream.unsubscribe(tokenId);
          state.stats.trades = Math.max(0, state.stats.trades - 1);
          state.stats.spent  = Math.max(0, state.stats.spent - amount);
          setStat("trades",    String(state.stats.trades));
          setStat("spent",     `$${state.stats.spent.toFixed(2)}`);
          setStat("budget",    `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);
          return;
        }
      }
    } catch (_) { /* non-fatal — proceed with order */ }

    const orderPayload = {
      token_id:       tokenId,
      side:           "BUY",
      amount_usdc:    amount,
      entry_price:    entryPrice,   // used server-side to cap slippage
      private_key:    c.polyPrivateKey,
      api_key:        c.polyApiKey,
      api_secret:     c.polyApiSecret,
      api_passphrase: c.polyPassphrase,
    };
    console.log(`[LIVE] Placing BUY order`, {
      token_id: tokenId,
      asset,
      amount_usdc: amount,
      entryOdds: (entryPrice * 100).toFixed(1) + "%",
      signal: analysis.signal,
      market: market.question.slice(0, 60),
    });
    fetch("/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderPayload),
    })
      .then(r => r.json())
      .then(result => {
        if (result.error) {
          // Order failed — remove from state, no card shown
          const idx = state.trades.indexOf(trade);
          if (idx !== -1) state.trades.splice(idx, 1);
          priceStream.unsubscribe(tokenId);
          // Undo the stats that were charged synchronously
          state.stats.trades = Math.max(0, state.stats.trades - 1);
          state.stats.spent  = Math.max(0, state.stats.spent - amount);
          setStat("trades",    String(state.stats.trades));
          setStat("spent",     `$${state.stats.spent.toFixed(2)}`);
          setStat("budget",    `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);
          setStat("positions", String(state.trades.length));
          console.error(`[LIVE] Order FAILED — no card created`, result);
          logEntry("warn", `  [LIVE] Order failed: ${result.error}`);
        } else {
          // Order confirmed — now show the card
          trade.confirmed = true;
          console.log(`[LIVE] Order CONFIRMED`, result);
          logEntry("info", `  [LIVE] Order confirmed: ${result.orderID ?? result.status ?? JSON.stringify(result)}`);

          // Update with actual fill price before card renders
          const fillPrice = parseFillPrice(result, "BUY");
          if (fillPrice && fillPrice > 0 && fillPrice < 1) {
            const prev = trade.entryPrice;
            trade.entryPrice   = fillPrice;
            trade.currentPrice = fillPrice;
            trade.peakPrice    = fillPrice;
            trade.shares       = trade.amount / fillPrice;
            console.log(`[LIVE] Entry price updated from fill: ${(prev*100).toFixed(1)}% → ${(fillPrice*100).toFixed(1)}%`, {
              shares: trade.shares.toFixed(4),
              amount: trade.amount.toFixed(2),
            });
            logEntry("info", `  [LIVE] Fill price: ${(fillPrice*100).toFixed(1)}% (was ${(prev*100).toFixed(1)}%)`);
          } else {
            console.warn(`[LIVE] Could not parse fill price from response`, result);
          }

          addCryptoCard(trade);
          startCryptoCountdown();

          // Post-fill slippage guard: exit immediately if fill is outside acceptable odds.
          // Only exit on truly catastrophic fills — don't penalize favorable slippage.
          // Catastrophic floor: book collapsed (e.g. 47.5% → 5%).
          // Hard ceiling: margin too thin at >78%.  At 78%+ the risk/reward collapses:
          //   78% fill → 22pp upside vs 73pp downside = 3.3:1 against.
          //   Our analysis cap is 80% so any fill ≥78% means slippage pushed us into bad territory.
          const fill = parseFillPrice(result, "BUY");
          if (fill) {
            const catastrophic = fill < 0.25;
            const tooHigh      = fill > 0.78;
            if (catastrophic || tooHigh) {
              const reason = catastrophic
                ? `fill ${(fill*100).toFixed(1)}% — book collapse (< 25%)`
                : `fill ${(fill*100).toFixed(1)}% > 78% — slippage pushed entry above risk/reward threshold`;
              logEntry("warn", `  ↳ <span class="red">${reason} — slippage exit</span>`);
              closePosition(trade, "BAD FILL");
            }
          }
        }
      })
      .catch(err => {
        // Network error — remove from state, no card
        const idx = state.trades.indexOf(trade);
        if (idx !== -1) state.trades.splice(idx, 1);
        priceStream.unsubscribe(tokenId);
        // Undo the stats that were charged synchronously
        state.stats.trades = Math.max(0, state.stats.trades - 1);
        state.stats.spent  = Math.max(0, state.stats.spent - amount);
        setStat("trades",    String(state.stats.trades));
        setStat("spent",     `$${state.stats.spent.toFixed(2)}`);
        setStat("budget",    `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);
        setStat("positions", String(state.trades.length));
        console.error(`[LIVE] Order fetch error — no card created`, err);
        logEntry("warn", `  [LIVE] Order error: ${err.message}`);
      });
  }

  state.stats.trades++;
  state.stats.spent += amount;
  setStat("trades", String(state.stats.trades));
  setStat("spent",  `$${state.stats.spent.toFixed(2)}`);
  setStat("budget", `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);

  const tradesEl = $(`#stat-${asset}-trades`);
  if (tradesEl) tradesEl.textContent = String(parseInt(tradesEl.textContent || "0") + 1);
}

const placeBtcTrade = (analysis, data) => placeCryptoTrade("btc", analysis, data);

// ── Trend-Sweep mode (GTC maker bids) ────────────────────────────
//
// Posts a GTC limit BUY at ~50¢ on the trend-direction token the moment a new
// window opens, BEFORE any AI analysis runs. The order sits in the book as a
// maker; when market makers reprice their asks (because BTC has clearly moved
// above/below target), our bid is already at the front of the queue and fills
// at fair value. Cancelled if the trend reverses, the window is about to
// resolve, or the asset mode is stopped.

function detectClearTrend(candles) {
  // Returns "BUY_UP" if last 3 candles are bullish with positive momentum,
  // "BUY_DOWN" if bearish with negative momentum, null otherwise.
  if (!candles || candles.length < 3) return null;
  const last3 = candles.slice(-3);
  const allBull = last3.every(c => c.close > c.open);
  const allBear = last3.every(c => c.close < c.open);
  if (!allBull && !allBear) return null;
  const totalMove = last3[2].close - last3[0].open;
  const pctMove   = Math.abs(totalMove) / last3[0].open;
  if (pctMove < 0.0010) return null;  // need ≥0.10% move across 3 candles
  return allBull ? "BUY_UP" : "BUY_DOWN";
}

async function placeTrendSweepBid(asset, market, signal, spot) {
  const c = state.config;
  if (!c.trendSweep) return;
  if (state[asset].sweptWindows.has(market.conditionId)) return;
  if (state[asset].pendingLimitOrders.has(market.conditionId)) return;
  if (state.trades.some(t => t.conditionId === market.conditionId)) return;
  if (state.stats.spent >= c.maxDaily) return;

  const isUp     = signal === "BUY_UP";
  const tokenId  = isUp ? market.upTokenId : market.downTokenId;
  const priceCt  = Math.max(40, Math.min(60, c.trendSweepPrice ?? 50));
  const price    = priceCt / 100;
  const sizeUsd  = Math.min(c.trendSweepSize ?? 2, c.maxDaily - state.stats.spent);
  const shares   = sizeUsd / price;

  if (sizeUsd < 1.00 || shares < 1.00) return;

  state[asset].sweptWindows.add(market.conditionId);
  const cfg = CRYPTO_CONFIG[asset];
  logEntry("amber",
    `  ◈ <span class="amber">SWEEP</span> ${cfg.ticker} ${signal} — posting GTC $${sizeUsd.toFixed(2)} @ ${priceCt}¢ ` +
    `(${cfg.ticker} $${spot.toFixed(spot >= 1000 ? 0 : 2)} trend-clear)`
  );

  if (c.dryRun) {
    // In dry run, simulate an immediate fill at our bid price so the strategy
    // can be observed end-to-end (stop-loss + take-profit on the resulting
    // position). Real GTC bids only fill when an MM crosses our price.
    const pending = {
      orderId:    `dry-${Date.now()}`,
      market, signal, tokenId, price, shares, sizeUsd,
      placedAt:   Date.now(),
      endDateMs:  new Date(market.endDate).getTime(),
      dryRun:     true,
    };
    convertFilledSweepToTrade(asset, pending, price);
    return;
  }

  try {
    const resp = await fetch("/limit", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_id:       tokenId,
        side:           "BUY",
        price,
        size:           shares,
        private_key:    c.polyPrivateKey,
        api_key:        c.polyApiKey,
        api_secret:     c.polyApiSecret,
        api_passphrase: c.polyPassphrase,
      }),
    });
    const result = await resp.json();
    if (result.error) {
      logEntry("warn", `  ◈ SWEEP failed — ${result.error}`);
      state[asset].sweptWindows.delete(market.conditionId);
      return;
    }
    const orderId = result.orderID ?? result.orderId ?? result.id;
    if (!orderId) {
      logEntry("warn", `  ◈ SWEEP no orderID returned — ${JSON.stringify(result).slice(0, 100)}`);
      state[asset].sweptWindows.delete(market.conditionId);
      return;
    }
    state[asset].pendingLimitOrders.set(market.conditionId, {
      orderId, market, signal, tokenId, price, shares, sizeUsd,
      placedAt:   Date.now(),
      endDateMs:  new Date(market.endDate).getTime(),
      dryRun:     false,
    });
    logEntry("info", `  ◈ SWEEP placed: order ${String(orderId).slice(0, 12)}…`);
  } catch (err) {
    logEntry("warn", `  ◈ SWEEP error: ${err.message}`);
    state[asset].sweptWindows.delete(market.conditionId);
  }
}

async function placeAiMakerBid(asset, analysis, { market, tokenId, amount, price, spot, priceToBeat }) {
  const c   = state.config;
  const cfg = CRYPTO_CONFIG[asset];

  if (state[asset].sweptWindows.has(market.conditionId)) return;
  if (state[asset].pendingLimitOrders.has(market.conditionId)) return;
  if (state.trades.some(t => t.conditionId === market.conditionId)) return;
  if (state.stats.spent >= c.maxDaily) return;

  // Polymarket minimum: 5 shares per order. Bump amount to satisfy minimum.
  const MIN_SHARES = 5;
  const rawShares = amount / price;
  const shares    = Math.max(rawShares, MIN_SHARES);
  amount          = shares * price;   // may be higher than original maxBet — ok for maker bids
  const priceCt = Math.round(price * 100);
  const tag     = c.dryRun ? "[SIM-MKR]" : "[LIVE-MKR]";
  const sigClass = analysis.signal === "BUY_UP" ? "green" : "red";
  const mktPricePct = ((analysis.signal === "BUY_UP" ? market.upPrice : market.downPrice) * 100).toFixed(1);

  logEntry("trade",
    `${tag} ${cfg.ticker} <span class="${sigClass}">${analysis.signal}</span>` +
    `  $${amount.toFixed(2)} — ${market.question.slice(0, 50)}`
  );
  logEntry("amber",
    `  ◈ <span class="amber">AI MAKER</span> posting GTC @ ${priceCt}¢ (market ${mktPricePct}¢)` +
    ` — waiting for fill, no fill = no loss`
  );

  state[asset].sweptWindows.add(market.conditionId);

  if (c.dryRun) {
    const pending = {
      orderId:    `dry-${Date.now()}`,
      market, signal: analysis.signal, tokenId, price, shares, sizeUsd: amount,
      placedAt:   Date.now(),
      endDateMs:  new Date(market.endDate).getTime(),
      dryRun:     true,
      aiMaker:    true,
      analysis, spot, priceToBeat,
    };
    convertFilledSweepToTrade(asset, pending, price);
    return;
  }

  try {
    const resp = await fetch("/limit", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_id:       tokenId,
        side:           "BUY",
        price,
        size:           shares,
        private_key:    c.polyPrivateKey,
        api_key:        c.polyApiKey,
        api_secret:     c.polyApiSecret,
        api_passphrase: c.polyPassphrase,
      }),
    });
    const rawText = await resp.text();
    let result;
    try {
      result = JSON.parse(rawText);
    } catch (parseErr) {
      logEntry("warn", `  ◈ AI MAKER non-JSON response (HTTP ${resp.status}): ${rawText.slice(0, 200)}`);
      state[asset].sweptWindows.delete(market.conditionId);
      return;
    }
    if (result.error) {
      logEntry("warn", `  ◈ AI MAKER failed (HTTP ${resp.status}) — ${result.error}`);
      state[asset].sweptWindows.delete(market.conditionId);
      return;
    }
    const orderId = result.orderID ?? result.orderId ?? result.id;
    if (!orderId) {
      logEntry("warn", `  ◈ AI MAKER no orderID — ${JSON.stringify(result).slice(0, 200)}`);
      state[asset].sweptWindows.delete(market.conditionId);
      return;
    }

    // If our bid was way above the market (e.g. 60¢ bid vs 15¢ ask), the GTC
    // order crosses immediately and the response carries makingAmount/takingAmount.
    // Use those to record the actual price-improved fill and skip the poll.
    const immediateFill = parseFillPrice(result, "BUY");
    const isMatched     = String(result.status || "").toLowerCase() === "matched";
    if (isMatched && immediateFill && immediateFill > 0.01 && immediateFill < 1) {
      const filledShares = parseFloat(result.takingAmount ?? shares);
      const filledUsdc   = filledShares * immediateFill;
      if (Math.abs(immediateFill - price) > 0.001) {
        logEntry("amber",
          `  ◈ AI MAKER filled at ${(immediateFill*100).toFixed(1)}¢ ` +
          `(bid was ${(price*100).toFixed(1)}¢ — price improvement)`
        );
      }
      const filledPending = {
        orderId, market, signal: analysis.signal, tokenId,
        price:   immediateFill,
        shares:  filledShares,
        sizeUsd: filledUsdc,
        placedAt:   Date.now(),
        endDateMs:  new Date(market.endDate).getTime(),
        dryRun:     false,
        aiMaker:    true,
        aiMakerFill: true,
        analysis, spot, priceToBeat,
      };
      logEntry("info", `  ◈ AI MAKER placed: order ${String(orderId).slice(0, 12)}…`);
      convertFilledSweepToTrade(asset, filledPending, immediateFill);
      return;
    }

    state[asset].pendingLimitOrders.set(market.conditionId, {
      orderId, market, signal: analysis.signal, tokenId, price, shares, sizeUsd: amount,
      placedAt:   Date.now(),
      endDateMs:  new Date(market.endDate).getTime(),
      dryRun:     false,
      aiMaker:    true,
      analysis, spot, priceToBeat,
    });
    logEntry("info", `  ◈ AI MAKER placed: order ${String(orderId).slice(0, 12)}…`);
  } catch (err) {
    logEntry("warn", `  ◈ AI MAKER error: ${err.message}`);
    state[asset].sweptWindows.delete(market.conditionId);
  }
}

async function cancelTrendSweepOrder(asset, conditionId, reason) {
  const pending = state[asset].pendingLimitOrders.get(conditionId);
  if (!pending) return;
  state[asset].pendingLimitOrders.delete(conditionId);

  const c = state.config;
  const tag = pending.aiMaker ? "AI MAKER" : "SWEEP";
  if (pending.dryRun) {
    logEntry("dim", `  ◈ ${tag} cancelled (sim) — ${reason}`);
    return;
  }
  try {
    await fetch("/cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        order_id:       pending.orderId,
        private_key:    c.polyPrivateKey,
        api_key:        c.polyApiKey,
        api_secret:     c.polyApiSecret,
        api_passphrase: c.polyPassphrase,
      }),
    });
    logEntry("dim", `  ◈ ${tag} cancelled — ${reason}`);
  } catch (err) {
    logEntry("warn", `  ◈ ${tag} cancel failed (${err.message}) — ${reason}`);
  }
}

function convertFilledSweepToTrade(asset, pending, fillPrice) {
  const c       = state.config;
  const cfg     = CRYPTO_CONFIG[asset];
  const market  = pending.market;
  const isUp    = pending.signal === "BUY_UP";
  const secsLeft = Math.max(1, Math.round((pending.endDateMs - Date.now()) / 1000));

  const trade = {
    id:            Date.now() + state.stats.trades,
    time:          new Date().toUTCString().slice(-12, -4),
    question:      market.question,
    conditionId:   market.conditionId,
    tokenId:       pending.tokenId,
    signal:        pending.signal,
    entryPrice:    fillPrice,
    amount:        pending.sizeUsd,
    shares:        pending.shares,
    currentPrice:  fillPrice,
    peakPrice:     fillPrice,
    troughPrice:   fillPrice,
    confidence:    pending.aiMaker ? (pending.analysis?.confidence ?? "MEDIUM") : "SWEEP",
    unrealizedPnl: 0,
    mode:          c.dryRun ? (pending.aiMaker ? "SIM-MKR" : "SIM-SWP") : (pending.aiMaker ? "LIVE-MKR" : "LIVE-SWP"),
    type:          asset,
    endDate:       market.endDate,
    confirmed:     true,
    aiMakerFill:   pending.aiMakerFill ?? false,
    spot:          pending.spot ?? null,
    priceToBeat:   pending.priceToBeat ?? null,
    gap:           pending.analysis?.gap ?? null,
    edge:          pending.analysis?.edge ?? null,
    reasoning:     pending.aiMaker
                     ? (pending.analysis?.reasoning ?? `AI maker bid filled at ${(fillPrice*100).toFixed(1)}¢`)
                     : `Trend-sweep maker bid filled at ${(fillPrice*100).toFixed(1)}¢`,
    momentum:      pending.analysis?.momentum ?? null,
    volatility:    pending.analysis?.volatility ?? null,
    volSpikeRatio: pending.analysis?.volSpikeRatio ?? null,
    signalAgainstGap: pending.aiMaker
                     ? ((pending.signal === "BUY_UP"   && (pending.analysis?.gap ?? 0) < 0) ||
                        (pending.signal === "BUY_DOWN" && (pending.analysis?.gap ?? 0) > 0))
                     : false,
    priceHistory:  [],
    totalSecs:     secsLeft,
    entryTime:     Date.now(),
    entryVolume:   market.volume ?? null,
    marketUrl:     market.slug ? `https://polymarket.com/event/${market.slug}` : "",
    exitPrice:     null,
    secsAtClose:   null,
    earlyWindow:   true,
  };

  state.trades.push(trade);
  state.stats.trades++;
  state.stats.spent += pending.sizeUsd;
  setStat("trades", String(state.stats.trades));
  setStat("spent",  `$${state.stats.spent.toFixed(2)}`);
  setStat("budget", `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);
  const tradesEl = $(`#stat-${asset}-trades`);
  if (tradesEl) tradesEl.textContent = String(parseInt(tradesEl.textContent || "0") + 1);

  priceStream.subscribe(pending.tokenId);
  addCryptoCard(trade);
  startCryptoCountdown();

  const fillLabel = pending.aiMaker ? "AI FILL" : "SWEEP FILL";
  logEntry("trade",
    `  ◈ <span class="green">${fillLabel}</span> ${cfg.ticker} ${pending.signal} ` +
    `$${pending.sizeUsd.toFixed(2)} @ ${(fillPrice*100).toFixed(1)}¢ — ${market.question.slice(0, 50)}`
  );
}

let pendingLimitPollTimer = null;

function startPendingLimitPoll() {
  if (pendingLimitPollTimer) return;
  pendingLimitPollTimer = setInterval(pollPendingLimitOrders, 8_000);
}

function stopPendingLimitPoll() {
  if (!pendingLimitPollTimer) return;
  clearInterval(pendingLimitPollTimer);
  pendingLimitPollTimer = null;
}

async function pollPendingLimitOrders() {
  const c = state.config;
  for (const asset of ["btc", "eth", "sol", "xrp"]) {
    for (const [conditionId, pending] of [...state[asset].pendingLimitOrders]) {
      const secsToEnd = Math.round((pending.endDateMs - Date.now()) / 1000);

      // Dry-run orders fill immediately at placement time (see placeTrendSweepBid),
      // so they should never be in pendingLimitOrders. Skip defensively.
      if (pending.dryRun) {
        state[asset].pendingLimitOrders.delete(conditionId);
        continue;
      }

      // Always check order status FIRST — an order may have already filled even if we're
      // about to cancel for time/macro reasons.  Cancelling without checking loses fills.
      let sizeMatched = 0, orderState = "", status = null;
      try {
        const resp = await fetch("/order_status", {
          method:  "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            order_id:       pending.orderId,
            token_id:       pending.tokenId,
            placed_at_sec:  Math.floor(pending.placedAt / 1000),
            private_key:    c.polyPrivateKey,
            api_key:        c.polyApiKey,
            api_secret:     c.polyApiSecret,
            api_passphrase: c.polyPassphrase,
          }),
        });
        status     = await resp.json();
        sizeMatched = parseFloat(status.size_matched ?? status.sizeMatched ?? 0);
        orderState  = String(status.status ?? status.state ?? "").toUpperCase();
      } catch {
        // Network blip — still apply time/macro cancels below; skip fill logic
      }

      if (status && (sizeMatched > 0 || orderState === "MATCHED" || orderState === "FILLED")) {
          console.log(`[AI MAKER fill] full status response:`, JSON.stringify(status, null, 2));
          const filledShares = sizeMatched > 0 ? sizeMatched : pending.shares;

          // Server queries /trades to compute the size-weighted avg fill price.
          // This is the authoritative source — the order's `price` field is just the bid.
          let actualFillPrice = null;
          const serverComputed = parseFloat(status.computed_fill_price ?? NaN);
          if (serverComputed > 0 && serverComputed < 1) actualFillPrice = serverComputed;

          // Fallback paths if the server couldn't query /trades for some reason:
          if (!actualFillPrice) {
            const tradelist = status.associatedTrades ?? status.associated_trades ?? status.trades ?? [];
            if (tradelist.length > 0) {
              let wUsdc = 0, wShares = 0;
              for (const tr of tradelist) {
                const tp = parseFloat(tr.price ?? 0);
                const ts = parseFloat(tr.size ?? tr.matchedSize ?? 0);
                if (tp > 0 && ts > 0) { wUsdc += tp * ts; wShares += ts; }
              }
              if (wShares > 0) actualFillPrice = wUsdc / wShares;
            }
          }
          if (!actualFillPrice) {
            const f = parseFloat(
              status.price_matched ?? status.priceMatched ??
              status.price_avg    ?? status.priceAvg     ??
              status.avg_price    ?? status.averagePrice ?? NaN
            );
            if (f > 0 && f < 1) actualFillPrice = f;
          }
          actualFillPrice = actualFillPrice ?? pending.price;
          console.log(`[AI MAKER fill] bid=${(pending.price*100).toFixed(1)}¢ → fill=${(actualFillPrice*100).toFixed(1)}¢ (serverFP=${serverComputed})`);

          if (Math.abs(actualFillPrice - pending.price) > 0.001) {
            const pTag = pending.aiMaker ? "AI MAKER" : "SWEEP";
            logEntry("amber",
              `  ◈ ${pTag} filled at ${(actualFillPrice*100).toFixed(1)}¢ ` +
              `(bid was ${(pending.price*100).toFixed(1)}¢ — price improvement)`
            );
          }
          const filledUsdc    = filledShares * actualFillPrice;
          const filledPending = { ...pending, shares: filledShares, sizeUsd: filledUsdc, price: actualFillPrice,
                                  aiMakerFill: true };
          state[asset].pendingLimitOrders.delete(conditionId);
          convertFilledSweepToTrade(asset, filledPending, actualFillPrice);

          // Emergency fill-slip exit: a fill ≥15% below our bid means the orderbook
          // walked through us — entering into a hostile move. Bail before the −25%
          // stop bleeds further. Wait 5s to let the orderbook settle, then check
          // if the bid has recovered above the fill price; if not, close.
          const slipFraction = pending.price > 0 ? (pending.price - actualFillPrice) / pending.price : 0;
          if (state.config?.emergencyFillExit && slipFraction >= 0.15) {
            logEntry("red",
              `  ◈ FILL SLIP ${(slipFraction*100).toFixed(1)}% — arming emergency exit ` +
              `(bid ${(pending.price*100).toFixed(1)}¢ → fill ${(actualFillPrice*100).toFixed(1)}¢)`
            );
            const tokenIdForCheck = pending.tokenId;
            const fillPriceForCheck = actualFillPrice;

            // Show the slip countdown bar on the card
            const trNow = [...state.trades].reverse()
              .find(x => x.tokenId === tokenIdForCheck && x.aiMakerFill && !x.exitPrice);
            if (trNow) {
              const wrap = $(`#slipwrap-${trNow.id}`);
              const fill = $(`#slipbar-${trNow.id}`);
              if (wrap && fill) {
                wrap.style.display = "block";
                // Trigger transition: start at 100%, drain to 0 over 5s
                requestAnimationFrame(() => {
                  fill.style.transition = "width 5s linear";
                  fill.style.width = "0%";
                });
              }
            }

            setTimeout(() => {
              const tr = [...state.trades].reverse()
                .find(x => x.tokenId === tokenIdForCheck && x.aiMakerFill && !x.exitPrice);
              const wrap = tr ? $(`#slipwrap-${tr.id}`) : null;
              const fill = tr ? $(`#slipbar-${tr.id}`) : null;

              if (!tr) return;
              if (tr.currentPrice <= fillPriceForCheck * 0.98) {
                // Flash red, then close
                if (fill) { fill.style.transition = "none"; fill.style.width = "100%"; fill.classList.add("slip-exit"); }
                setTimeout(() => { if (wrap) wrap.style.display = "none"; }, 600);
                closePosition(tr, "FILL SLIP EXIT");
              } else {
                // Flash green, then hide
                if (fill) { fill.style.transition = "none"; fill.style.width = "100%"; fill.classList.add("slip-ok"); }
                setTimeout(() => { if (wrap) wrap.style.display = "none"; }, 800);
                logEntry("green",
                  `  ◈ FILL SLIP EXIT skipped — price recovered to ${(tr.currentPrice*100).toFixed(1)}¢`
                );
              }
            }, 5_000);
          }
      } else if (orderState === "CANCELED" || orderState === "CANCELLED" || orderState === "EXPIRED") {
        state[asset].pendingLimitOrders.delete(conditionId);
        const pTag = pending.aiMaker ? "AI MAKER" : "SWEEP";
        logEntry("dim", `  ◈ ${pTag} order ${orderState.toLowerCase()} (CLOB-side)`);
      } else {
        // Order is still live — now apply cancellation policies.

        // Cancel if market price collapsed below minEntryOdds while order was pending.
        // Protects against GTC fills at 2¢ when the crowd has already priced in the opposite outcome.
        try {
          const priceResp = await fetch(`/price?token_id=${encodeURIComponent(pending.tokenId)}`);
          if (priceResp.ok) {
            const { best_ask: liveAsk } = await priceResp.json();
            const minOddsThreshold = (parseFloat($("#min-entry-odds")?.value) || state.config?.minEntryOdds || 32) / 100;
            if (liveAsk > 0 && liveAsk < minOddsThreshold) {
              cancelTrendSweepOrder(asset, conditionId, `token collapsed to ${(liveAsk*100).toFixed(1)}¢ — below min odds ${(minOddsThreshold*100).toFixed(0)}¢`);
              continue;
            }
          }
        } catch {}

        // Cancel near resolution: fill leaves too little time to manage the position.
        // IMPORTANT: the CLOB order-status API can lag 30-50s after an actual fill, so
        // we cannot trust "not filled" from the status poll alone.  After sending the
        // cancel we wait 12s and cross-check the wallet positions API, which reflects
        // on-chain state faster than the CLOB order-book API.
        const minCloseSecGtc = parseFloat($("#min-close-sec")?.value) || state.config?.minCloseSec || 60;
        if (secsToEnd < minCloseSecGtc) {
          state[asset].pendingLimitOrders.delete(conditionId);
          const pTag = pending.aiMaker ? "AI MAKER" : "SWEEP";

          if (!pending.dryRun) {
            try {
              await fetch("/cancel", {
                method:  "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  order_id:       pending.orderId,
                  private_key:    c.polyPrivateKey,
                  api_key:        c.polyApiKey,
                  api_secret:     c.polyApiSecret,
                  api_passphrase: c.polyPassphrase,
                }),
              });
            } catch {}

            // Wait for on-chain state to settle, then verify via wallet positions —
            // more reliable than CLOB order-status which can lag 30-50s on fast fills.
            await new Promise(r => setTimeout(r, 12_000));
            try {
              const wallet   = new ethers.Wallet(c.polyPrivateKey);
              const posResp  = await fetch(`/positions?address=${encodeURIComponent(wallet.address)}`);
              const positions = posResp.ok ? await posResp.json() : [];
              const match = Array.isArray(positions)
                ? positions.find(p =>
                    (p.asset || p.asset_id || p.token_id) === pending.tokenId &&
                    parseFloat(p.size ?? p.currentSize ?? "0") > 0.01
                  )
                : null;
              if (match) {
                const avgPrice  = parseFloat(match.avgPrice ?? match.averagePrice ?? "0") || pending.price;
                const fillShares = parseFloat(match.size ?? "0") || pending.shares;
                const filledPendingCR = {
                  ...pending, shares: fillShares,
                  sizeUsd: fillShares * avgPrice, price: avgPrice, aiMakerFill: true,
                };
                logEntry("amber",
                  `  ◈ ${pTag} cancel-race recovered — filled at ${(avgPrice*100).toFixed(1)}¢ ` +
                  `(CLOB lag masked the fill during poll window)`
                );
                convertFilledSweepToTrade(asset, filledPendingCR, avgPrice);
                continue;
              }
            } catch {}
            // Positions check came up empty — warn so the user can manually verify on Polymarket.
            logEntry("warn", `  ◈ ${pTag} cancel-race: no fill detected — check Polymarket manually, may need redeem_all.py`);
          }

          logEntry("dim", `  ◈ ${pTag} cancelled — ${secsToEnd}s before resolution`);
          continue;
        }

        // Cancel if signal flipped: BTC trend reversed, no longer want this direction.
        const macro = state.btcMacro;
        if (macro && (Date.now() - macro.updatedAt) < 180_000) {
          const macroFlip =
            (pending.signal === "BUY_UP"   && macro.bearCount >= 4 && macro.momentum <= -20) ||
            (pending.signal === "BUY_DOWN" && macro.bullCount >= 4 && macro.momentum >=  20);
          if (macroFlip) {
            cancelTrendSweepOrder(asset, conditionId, `BTC macro reversed against ${pending.signal}`);
          }
        }
      }
    }
  }
}

// ── Countdown timer ───────────────────────────────────────────────

let cryptoCountdownTimer = null;

function startCryptoCountdown() {
  if (cryptoCountdownTimer) return;
  cryptoCountdownTimer = setInterval(() => {
    const cryptoTrades = state.trades.filter(t => ["btc","eth","sol","xrp"].includes(t.type));
    if (!cryptoTrades.length) {
      clearInterval(cryptoCountdownTimer);
      cryptoCountdownTimer = null;
      return;
    }
    // Periodic stop-loss safety net: catches positions where the price stream
    // stopped updating (token frozen at near-zero), so onMessage never fires.
    const stopLossPct  = (parseFloat($("#stop-loss-pct")?.value)  || state.config?.stopLossPct  || 25) / 100;
    const trailArmPct  = (parseFloat($("#trail-arm-pct")?.value)  || state.config?.trailArmPct  || 15) / 100;
    const trailLockPct = (parseFloat($("#trail-lock-pct")?.value) || state.config?.trailLockPct || 40) / 100;
    const stopGraceMs  = (parseFloat($("#stop-grace-sec")?.value) ?? state.config?.stopGraceSec ?? 10) * 1_000;
    for (const t of [...cryptoTrades]) {
      if (t.totalSecs < 45) continue;
      const grace = t.aiMakerFill ? Math.max(stopGraceMs, 20_000) : stopGraceMs;
      if (Date.now() - t.entryTime < grace) continue;
      // Gap-flip trades use a wider 60% base stop — token oscillates before price crosses target.
      const effectiveStop = t.signalAgainstGap ? Math.max(stopLossPct, 0.60) : stopLossPct;
      if (t.unrealizedPnl <= -t.amount * effectiveStop) { closePosition(t, "STOP LOSS"); refreshBtcCards(); updatePnlStat(); continue; }
      // Trailing stop safety net (same logic as WS handler, covers frozen price streams)
      if (trailArmPct > 0) {
        const peakGain = t.peakPrice * t.shares - t.amount;
        if (peakGain >= t.amount * trailArmPct && t.unrealizedPnl < peakGain * trailLockPct) {
          closePosition(t, "TRAIL STOP"); refreshBtcCards(); updatePnlStat();
        }
      }
    }
    for (const t of cryptoTrades) {
      const cdEl  = $(`#cd-${t.id}`);
      const barEl = $(`#cdbar-${t.id}`);
      if (!cdEl) continue;
      const secs   = Math.round((new Date(t.endDate) - Date.now()) / 1000);
      const urgent = secs < 60;
      const slEl = $(`#sl-${t.id}`);
      if (secs <= 0) {
        cdEl.textContent = "[RESOLVED]";
        cdEl.className   = "btc-card-cd resolved";
        if (barEl) { barEl.style.width = "0%"; barEl.className = "btc-timer-fill urgent"; }
        if (slEl)  { slEl.textContent = "—"; }
        // Auto-close expired positions at current market price
        closePosition(t, "RESOLVED");
      } else {
        cdEl.textContent = `[${secs}s]`;
        cdEl.className   = `btc-card-cd ${urgent ? "urgent" : ""}`;
        if (barEl) {
          const pct = Math.min(100, Math.max(0, (secs / t.totalSecs) * 100));
          barEl.style.width = pct + "%";
          barEl.className   = `btc-timer-fill ${urgent ? "urgent" : ""}`;
        }
        if (slEl) {
          const mm = Math.floor(secs / 60);
          const ss = String(secs % 60).padStart(2, "0");
          slEl.textContent = mm > 0 ? `${mm}m ${ss}s` : `${secs}s`;
          slEl.className   = `btc-v ${urgent ? "red" : "dim"}`;
        }
      }
    }
  }, 1_000);
}

const startBtcCountdown = startCryptoCountdown;

// ── Util ─────────────────────────────────────────────────────────

function escHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function formatNum(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(0) + "K";
  return String(Math.round(n));
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Generate Polymarket API Keys ─────────────────────────────────

async function generatePolyApiKey() {
  const privateKey = $("#poly-private-key").value.trim();
  const btn        = $("#btn-gen-keys");
  const status     = $("#gen-keys-status");

  if (!privateKey) {
    status.className  = "gen-keys-status error";
    status.textContent = "⚠  Enter your wallet private key first.";
    return;
  }

  btn.disabled = true;
  status.className  = "gen-keys-status loading";
  status.textContent = "⟳  Connecting to Polymarket CLOB API…";

  try {
    const wallet    = new ethers.Wallet(privateKey);
    const address   = wallet.address;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce     = 0;

    const domain = { name: "ClobAuthDomain", version: "1", chainId: 137 };
    const types  = {
      ClobAuth: [
        { name: "address",   type: "address" },
        { name: "timestamp", type: "string"  },
        { name: "nonce",     type: "uint256" },
        { name: "message",   type: "string"  },
      ],
    };
    const value = {
      address, timestamp, nonce,
      message: "This message attests that I control the given wallet",
    };

    status.textContent = "⟳  Signing authentication message…";
    const sig = await wallet.signTypedData(domain, types, value);

    status.textContent = "⟳  Requesting API keys from Polymarket…";
    const resp = await fetch("https://clob.polymarket.com/auth/api-key", {
      method: "POST",
      headers: {
        "POLY_ADDRESS":   address,
        "POLY_SIGNATURE": sig,
        "POLY_TIMESTAMP": timestamp,
        "POLY_NONCE":     String(nonce),
        "Content-Type":  "application/json",
      },
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`CLOB API ${resp.status}: ${text.slice(0, 120)}`);
    }

    const data = await resp.json();
    if (!data.apiKey || !data.secret || !data.passphrase)
      throw new Error("Unexpected response: " + JSON.stringify(data).slice(0, 120));

    $("#poly-api-key").value    = data.apiKey;
    $("#poly-api-secret").value = data.secret;
    $("#poly-passphrase").value = data.passphrase;

    status.className  = "gen-keys-status success";
    status.textContent = `✓  API keys generated for ${address.slice(0, 6)}…${address.slice(-4)}`;
  } catch (err) {
    status.className  = "gen-keys-status error";
    status.textContent = `✗  ${err.message}`;
  } finally {
    btn.disabled = false;
  }
}

// ── Wake Lock ────────────────────────────────────────────────────

let wakeLock = null;

async function requestWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch (err) {
    // Wake lock unavailable — silent, non-critical
  }
}

async function releaseWakeLock() {
  if (wakeLock) {
    await wakeLock.release();
    wakeLock = null;
  }
}

// Re-acquire wake lock when tab becomes visible again (browser auto-releases on hide)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.running) {
    requestWakeLock();
  }
});

// ── Unload guard ─────────────────────────────────────────────────

window.addEventListener('beforeunload', (e) => {
  if (!state.running) return;
  e.preventDefault();
  // Modern browsers show their own generic message; setting returnValue triggers the dialog
  e.returnValue = 'The bot is still running — positions may be open. Leave anyway?';
});

// ── Boot ─────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initSetup();
});
