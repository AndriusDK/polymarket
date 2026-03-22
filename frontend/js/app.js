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
  btc: { timer: null, analyzed: new Map(), running: false },  // conditionId → endDateMs
  eth: { timer: null, analyzed: new Map(), running: false },
  sol: { timer: null, analyzed: new Map(), running: false },
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
    if (el) el.textContent = new Date().toUTCString().slice(-12, -4) + " UTC";
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
  ["min-market-volume",   "value"],
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
  syncToggleLabel("dry-run-toggle",  "dry-run-label",  ["ON","amber"], ["OFF — LIVE","red"]);
  syncToggleLabel("btc-mode-toggle", "btc-mode-label",  ["ON","green"], ["OFF","dim"]);
  syncToggleLabel("eth-mode-toggle", "eth-mode-label",  ["ON","green"], ["OFF","dim"]);
  syncToggleLabel("sol-mode-toggle", "sol-mode-label",  ["ON","green"], ["OFF","dim"]);
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
      minMarketVolume:  parseFloat($("#min-market-volume")?.value) || 1000,
      minEntryOdds:     parseFloat($("#min-entry-odds")?.value)    || 15,
      maxEntryOdds:     parseFloat($("#max-entry-odds")?.value)    || 87,
      btcMode:       $("#btc-mode-toggle")?.checked ?? false,
      btcMaxBet:     parseFloat($("#btc-max-bet")?.value) || 5,
      btcMinEdge:    parseFloat($("#btc-min-edge")?.value) || 0.06,
      ethMode:       $("#eth-mode-toggle")?.checked ?? false,
      ethMaxBet:     parseFloat($("#eth-max-bet")?.value) || 5,
      ethMinEdge:    parseFloat($("#eth-min-edge")?.value) || 0.06,
      solMode:       $("#sol-mode-toggle")?.checked ?? false,
      solMaxBet:     parseFloat($("#sol-max-bet")?.value) || 5,
      solMinEdge:    parseFloat($("#sol-min-edge")?.value) || 0.06,
    };

    initDashboard();
    showScreen("dashboard-screen");
  });
}

// ── Dashboard ────────────────────────────────────────────────────

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
  for (const asset of ["btc", "eth", "sol"]) {
    $(`#btn-${asset}`)?.addEventListener("click", () => {
      if (state[asset].timer) stopCryptoMode(asset);
      else startCryptoMode(asset);
    });
  }

  startClock();
  logEntry("cyan", "POLYMARKET AI TRADING SYSTEM — ONLINE");
  logEntry("info",
    `Mode: ${c.dryRun ? "DRY RUN" : "⚡ LIVE"}  |  BTC/ETH/SOL 5-min & 15-min  |  Budget $${c.maxDaily}`
  );

  for (const asset of ["btc", "eth", "sol"]) {
    if (c[`${asset}Mode`]) {
      logEntry("info", `${asset.toUpperCase()} mode: auto-starting…`);
      startCryptoMode(asset);
    }
  }
  if (!c.btcMode && !c.ethMode && !c.solMode) {
    logEntry("info", "Press [⚡ BTC / ETH / SOL MODE] to start scanning for markets.");
  }
}

// ── Stop ─────────────────────────────────────────────────────────

function stopBot() {
  if (state.abortCtrl) state.abortCtrl.abort();
  for (const asset of ["btc", "eth", "sol"]) stopCryptoMode(asset);
  setStat("status", "STOPPED", "amber");
  logEntry("warning", "Bot stopped.");
  setRunning(false);
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
  const time = new Date().toUTCString().slice(-12, -4);
  const div = document.createElement("div");
  div.className = `log-entry ${type}`;
  div.innerHTML = `<span class="log-time">${time}</span><span class="log-msg">${msg}</span>`;
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

function showProgress(visible) {
  $("#progress-wrap")?.classList.toggle("hidden", !visible);
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
  const gap       = trade.gap ?? 0;
  const gapSign   = gap >= 0 ? "+" : "";
  const gapClass  = gap >= 0 ? "green" : "red";
  const spot      = trade.spot ?? 0;
  const priceFmt  = spot >= 1000 ? spot.toFixed(0) : spot.toFixed(2);
  const targetFmt = (trade.priceToBeat ?? 0) >= 1000 ? (trade.priceToBeat ?? 0).toFixed(0) : (trade.priceToBeat ?? 0).toFixed(2);
  const gapFmt    = spot >= 1000 ? Math.abs(gap).toFixed(0) : Math.abs(gap).toFixed(2);
  const assetClass = `asset-${trade.type}`;

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
    <div class="btc-card-body">
      <div class="btc-card-signal ${sigClass}">${sigLabel}</div>
      <div class="btc-card-stats">
        <div class="btc-kv">
          <span class="btc-k">ENTRY</span>
          <span class="btc-v">${(trade.entryPrice * 100).toFixed(1)}%</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">CURRENT</span>
          <span class="btc-v" id="tp-${trade.id}">${(trade.currentPrice * 100).toFixed(1)}%</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">PEAK</span>
          <span class="btc-v dim" id="peak-${trade.id}">${(trade.peakPrice * 100).toFixed(1)}%</span>
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
      </div>
    </div>
    <div class="btc-card-foot">
      <span>${ticker} $${priceFmt}&nbsp; vs &nbsp;target $${targetFmt}
      &nbsp;|&nbsp; Gap: <span class="${gapClass}">${gapSign}$${gapFmt}</span></span>
      <a href="${trade.marketUrl}" target="_blank" rel="noopener" class="btc-market-link">↗ POLYMARKET</a>
    </div>
  `;

  cards.insertBefore(div, cards.firstChild);
}

const addBtcCard = addCryptoCard;

function refreshBtcCards() {
  for (const t of state.trades) {
    const tpEl   = $(`#tp-${t.id}`);
    const peakEl = $(`#peak-${t.id}`);
    const pnlEl  = $(`#pnl-${t.id}`);
    if (tpEl)   tpEl.textContent = (t.currentPrice * 100).toFixed(1) + "%";
    if (peakEl) {
      peakEl.textContent = (t.peakPrice * 100).toFixed(1) + "%";
      // Color peak green if it meaningfully exceeded entry, dim if flat
      peakEl.className = t.peakPrice > t.entryPrice + 0.005 ? "btc-v green" : "btc-v dim";
    }
    if (pnlEl) {
      const isPos = t.unrealizedPnl >= 0;
      pnlEl.textContent = (isPos ? "+" : "") + "$" + t.unrealizedPnl.toFixed(2);
      pnlEl.className   = `btc-v ${isPos ? "green" : "red"}`;
    }
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
        if (!tokenId || !bid) continue;
        let changed = false;
        for (const t of state.trades) {
          if (t.tokenId !== tokenId) continue;
          t.currentPrice  = bid;
          t.unrealizedPnl = t.shares * bid - t.amount;
          if (bid > t.peakPrice) t.peakPrice = bid;
          changed = true;
        }
        if (changed) {
          const stopLossPct   = (state.config?.stopLossPct   ?? 50) / 100;
          const takeProfitPct = (state.config?.takeProfitPct ?? 50) / 100;
          const toStopLoss = state.trades.filter(t => {
            if (t.tokenId !== tokenId) return false;
            // Never stop-loss truly last-second entries — position resolves in seconds
            if (t.totalSecs < 45) return false;
            // Grace period: scale to entry window so short-duration trades don't
            // sit blind for half their remaining time (min 10s, max 30s)
            const grace = Math.min(30_000, Math.max(10_000, t.totalSecs * 120));
            if (Date.now() - t.entryTime < grace) return false;
            // For high-priced tokens (>0.70 entry), stop-loss in dollar terms only:
            // don't trigger on normal spread noise — require a real directional move
            const stopThreshold = t.entryPrice > 0.70
              ? -t.amount * 0.35          // 35% loss cap for high-confidence entries
              : -t.amount * stopLossPct;  // 50% for mid/low priced tokens
            return t.unrealizedPnl <= stopThreshold;
          });
          for (const t of toStopLoss) closePosition(t, "STOP LOSS");
          const toTakeProfit = state.trades.filter(t => {
            if (t.tokenId !== tokenId) return false;
            // Hard TP: fires when gain exceeds takeProfitPct of amount invested
            // e.g. $20 trade, 50% pct → fires when unrealizedPnl >= $10
            if (t.unrealizedPnl >= t.amount * takeProfitPct) return true;
            // Trailing stop: protect gains once peak gain is meaningful (>15% of amount)
            // Close if current PnL has fallen below 40% of peak PnL — locks in 40% of best gains
            const peakGain = t.peakPrice * t.shares - t.amount;
            if (peakGain >= t.amount * 0.15 && t.unrealizedPnl < peakGain * 0.40) return true;
            return false;
          });
          for (const t of toTakeProfit) closePosition(t, "TAKE PROFIT");
          refreshBtcCards();
          updatePnlStat();
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

// ── Position management ──────────────────────────────────────────

function closePosition(trade, reason) {
  const idx = state.trades.indexOf(trade);
  if (idx === -1) return;
  state.trades.splice(idx, 1);

  const stillNeeded = state.trades.some(t => t.tokenId === trade.tokenId);
  if (!stillNeeded) priceStream.unsubscribe(trade.tokenId);

  const realized = trade.unrealizedPnl;
  state.realizedPnl = (state.realizedPnl || 0) + realized;

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
    `;
    card.insertBefore(strip, card.firstChild);

    // Freeze countdown display
    const cd = $(`#cd-${trade.id}`);
    if (cd) { cd.textContent = "[CLOSED]"; cd.className = "btc-card-cd resolved"; }

    // Clear unrealized PnL — position is settled
    const pnlEl = $(`#pnl-${trade.id}`);
    if (pnlEl) { pnlEl.textContent = "+$0.00"; pnlEl.className = "btc-v dim"; }

    // Mark card as closed + move to bottom of container (below active positions)
    card.classList.add(isWin ? "closed-win" : "closed-loss");
    const container = card.parentNode;
    if (container) container.appendChild(card);
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

  setStat("positions", String(state.trades.length));
  updatePnlStat();
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
}

// ── Crypto mode (BTC / ETH / SOL) ────────────────────────────────

const ASSET_COLORS = { btc: "amber", eth: "eth", sol: "sol" };

function startCryptoMode(asset) {
  if (state[asset].timer) return;
  // Prune only expired markets — keep active ones so restarts don't re-buy them
  const now = Date.now();
  for (const [cid, endMs] of state[asset].analyzed)
    if (endMs < now) state[asset].analyzed.delete(cid);

  const cfg = CRYPTO_CONFIG[asset];
  const btn = $(`#btn-${asset}`);
  if (btn) { btn.textContent = `■ ${cfg.ticker} STOP`; btn.classList.add("active"); }
  setStat(`${asset}-status`, "ACTIVE", ASSET_COLORS[asset]);
  setRunning(true);
  logEntry("cyan", `⚡ ${cfg.ticker} MODE ON — scanning every 10s for 5-min & 15-min markets`);

  runCryptoCycle(asset);
  state[asset].timer = setInterval(() => runCryptoCycle(asset), 10_000);
}

function stopCryptoMode(asset) {
  if (!state[asset]?.timer) return;
  clearInterval(state[asset].timer);
  state[asset].timer = null;

  const cfg = CRYPTO_CONFIG[asset];
  const btn = $(`#btn-${asset}`);
  if (btn) { btn.textContent = `⚡ ${cfg.ticker} MODE`; btn.classList.remove("active"); }
  setStat(`${asset}-status`, "OFF", "dim");
  if (!["btc","eth","sol"].some(a => state[a].timer)) setRunning(false);
  logEntry("warning", `${cfg.ticker} mode stopped.`);
}

// Keep backward-compat names
const startBtcMode = () => startCryptoMode("btc");
const stopBtcMode  = () => stopCryptoMode("btc");

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

  const freshCount = markets.filter(m => !state[asset].analyzed.has(m.conditionId)).length;

  const fresh = markets.filter(m => !state[asset].analyzed.has(m.conditionId));
  if (!fresh.length) {
    setStat(`${asset}-status`, "WATCHING", "dim");
    return;
  }

  let spot, candles;
  try {
    [spot, candles] = await Promise.all([
      fetchCryptoSpot(cfg.symbol),
      fetchCryptoCandles(cfg.symbol, 6),
    ]);
  } catch (err) {
    logEntry("error", `${cfg.ticker}: Binance data failed — ${err.message}`);
    setStat(`${asset}-status`, "ERROR", "red");
    return;
  }

  const pd = spot >= 1000 ? 0 : spot >= 10 ? 2 : 3;

  for (const market of fresh) {
    state[asset].analyzed.set(market.conditionId, new Date(market.endDate).getTime());

    let priceToBeat = null;
    if (market.startDate) {
      try {
        priceToBeat = await fetchCryptoOpenAtTime(cfg.symbol, new Date(market.startDate).getTime());
      } catch { /* fall through */ }
    }
    if (!priceToBeat) priceToBeat = candles[candles.length - 1]?.open ?? spot;

    const timeRemaining = Math.round((new Date(market.endDate) - Date.now()) / 1000);
    const gap = spot - priceToBeat;

    // Precompute maxMovement for post-analysis crossing check.
    const recentRange = candles.slice(-3).reduce((mx, c) => Math.max(mx, c.high - c.low), 0);
    const maxMovement = Math.max(recentRange, 1) * Math.max(timeRemaining / 60, 0.25) * 3;

    logEntry("info",
      `${cfg.ticker}: <span class="cyan">${market.question.slice(0, 55)}</span>  ` +
      `[${timeRemaining}s left]  ${cfg.ticker} $${spot.toFixed(pd)} vs target $${priceToBeat.toFixed(pd)}  ` +
      `<span class="${gap >= 0 ? "green" : "red"}">${gap >= 0 ? "+" : ""}$${gap.toFixed(pd)}</span>`
    );

    let analysis;
    try {
      analysis = await analyzeCryptoMarket(
        market, { spot, candles, priceToBeat }, c.anthropicKey, { model: c.model }, asset
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
      `| ${analysis.reasoning}`
    );

    const sigEl = $(`#stat-${asset}-signals`);
    if (sigEl) sigEl.textContent = String(parseInt(sigEl.textContent || "0") + 1);

    const minEdge     = c[`${asset}MinEdge`] ?? 0.06;
    const minOdds     = (c.minEntryOdds ?? 15) / 100;
    const maxOdds     = (c.maxEntryOdds ?? 87) / 100;
    const entryOdds   = analysis.signal === "BUY_UP" ? market.upPrice : market.downPrice;
    const oddsOk      = analysis.signal === "SKIP" || (entryOdds >= minOdds && entryOdds <= maxOdds);

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

    const qualifies =
      analysis.signal !== "SKIP" &&
      oddsOk &&
      crossable &&
      (analysis.confidence === "HIGH" ||
       (analysis.confidence === "MEDIUM" && analysis.absEdge >= 0.10)) &&
      analysis.absEdge >= minEdge &&
      state.stats.spent < c.maxDaily;

    if (qualifies) {
      placeCryptoTrade(asset, analysis, { spot, priceToBeat });
    } else if (analysis.signal !== "SKIP") {
      const reasons = [];
      if (!oddsOk) {
        if (entryOdds > maxOdds)
          reasons.push(`entry odds ${(entryOdds * 100).toFixed(1)}% > max ${(maxOdds * 100).toFixed(0)}% (bad risk/reward)`);
        else
          reasons.push(`entry odds ${(entryOdds * 100).toFixed(1)}% < min ${(minOdds * 100).toFixed(0)}%`);
      }
      if (!crossable) reasons.push(`gap $${Math.abs(gap).toFixed(pd)} too large to cross in ${timeRemaining}s (max ≈${maxMovement.toFixed(pd)})`);
      if (analysis.confidence === "LOW") reasons.push("confidence LOW");
      else if (analysis.confidence === "MEDIUM" && analysis.absEdge < 0.10)
        reasons.push(`edge ${(analysis.absEdge * 100).toFixed(1)}% < 10% required for MEDIUM`);
      if (analysis.absEdge < minEdge)
        reasons.push(`edge ${(analysis.absEdge * 100).toFixed(1)}% < minEdge ${(minEdge * 100).toFixed(1)}%`);
      if (state.stats.spent >= c.maxDaily)
        reasons.push("daily budget exhausted");
      logEntry("info", `  ↳ <span class="amber">no trade</span> — ${reasons.join(", ")}`);
    }
  }

  setStat(`${asset}-status`, "WATCHING", "dim");
}

const runBtcCycle = () => runCryptoCycle("btc");

function placeCryptoTrade(asset, analysis, { spot, priceToBeat }) {
  const c      = state.config;
  const cfg    = CRYPTO_CONFIG[asset];
  const market = analysis.market;
  const isUp   = analysis.signal === "BUY_UP";

  const entryPrice = isUp ? market.upPrice   : market.downPrice;
  const tokenId    = isUp ? market.upTokenId : market.downTokenId;

  // Scale bet size by time remaining — more time = more uncertainty = smaller bet
  const secsForSizing = Math.max(1, Math.round((new Date(market.endDate) - Date.now()) / 1000));
  const timeFraction  = secsForSizing > 800 ? 0.40
                      : secsForSizing > 400 ? 0.65
                      : 1.0;
  const maxBet = c[`${asset}MaxBet`] ?? c.btcMaxBet ?? 5;
  const amount = Math.min(maxBet * timeFraction, c.maxDaily - state.stats.spent);
  if (amount < 0.50) return;

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
    confidence:    analysis.confidence,
    unrealizedPnl: 0,
    mode:          c.dryRun ? "SIM" : "LIVE",
    type:          asset,
    endDate:       market.endDate,
    spot,
    priceToBeat,
    gap:           analysis.gap,
    totalSecs:     secsLeft,
    entryTime:     Date.now(),
    marketUrl,
  };

  state.trades.push(trade);
  addCryptoCard(trade);
  priceStream.subscribe(tokenId);
  startCryptoCountdown();

  state.stats.trades++;
  state.stats.spent += amount;
  setStat("trades", String(state.stats.trades));
  setStat("spent",  `$${state.stats.spent.toFixed(2)}`);
  setStat("budget", `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);

  const tradesEl = $(`#stat-${asset}-trades`);
  if (tradesEl) tradesEl.textContent = String(parseInt(tradesEl.textContent || "0") + 1);
}

const placeBtcTrade = (analysis, data) => placeCryptoTrade("btc", analysis, data);

// ── Countdown timer ───────────────────────────────────────────────

let cryptoCountdownTimer = null;

function startCryptoCountdown() {
  if (cryptoCountdownTimer) return;
  cryptoCountdownTimer = setInterval(() => {
    const cryptoTrades = state.trades.filter(t => ["btc","eth","sol"].includes(t.type));
    if (!cryptoTrades.length) {
      clearInterval(cryptoCountdownTimer);
      cryptoCountdownTimer = null;
      return;
    }
    // Periodic stop-loss safety net: catches positions where the price stream
    // stopped updating (token frozen at near-zero), so onMessage never fires.
    const stopLossPct = (state.config?.stopLossPct ?? 50) / 100;
    for (const t of [...cryptoTrades]) {
      if (t.totalSecs < 45) continue;
      // Scale grace period to entry window: short-duration entries get shorter grace
      const grace = Math.min(30_000, t.totalSecs * 120);
      if (Date.now() - t.entryTime < grace) continue;
      const stopThreshold = t.entryPrice > 0.70
        ? -t.amount * 0.35
        : -t.amount * stopLossPct;
      if (t.unrealizedPnl <= stopThreshold) { closePosition(t, "STOP LOSS"); refreshBtcCards(); updatePnlStat(); }
    }
    for (const t of cryptoTrades) {
      const cdEl  = $(`#cd-${t.id}`);
      const barEl = $(`#cdbar-${t.id}`);
      if (!cdEl) continue;
      const secs   = Math.round((new Date(t.endDate) - Date.now()) / 1000);
      const urgent = secs < 60;
      if (secs <= 0) {
        cdEl.textContent = "[RESOLVED]";
        cdEl.className   = "btc-card-cd resolved";
        if (barEl) { barEl.style.width = "0%"; barEl.className = "btc-timer-fill urgent"; }
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

// ── Boot ─────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initSetup();
});
