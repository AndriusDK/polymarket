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
  btc: { timer: null, analyzed: new Map(), running: false },  // conditionId → endDateMs
  eth: { timer: null, analyzed: new Map(), running: false },
  sol: { timer: null, analyzed: new Map(), running: false },
  recentStops: [],     // timestamps of recent stop-loss events (any asset) for stress detection
  stressHoldUntil: 0, // epoch ms: new entries blocked until this time (market-stress cool-down)
  chainlinkPrices: { btc: null, eth: null, sol: null }, // live Chainlink prices from RTDS
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
      stopLossPct:      parseFloat($("#stop-loss-pct")?.value)   || 25,
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
      startupCooldown: parseInt($("#startup-cooldown")?.value) || 90,
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

  chainlinkStream.connect();
  startClock();
  logEntry("cyan", "POLYMARKET AI TRADING SYSTEM — ONLINE");
  logEntry("dim", "  ◈ Subdivisions: BTC · ETH · SOL  |  Clockwork Angels protocol active");
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
  chainlinkStream.disconnect();
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
        <div class="btc-kv">
          <span class="btc-k">DURATION</span>
          <span class="btc-v dim" id="dur-${trade.id}">0s</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">SECS LEFT</span>
          <span class="btc-v dim">${trade.totalSecs}s</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">GAP %</span>
          <span class="btc-v ${gapClass}">${gapPctStr}</span>
        </div>
        <div class="btc-kv">
          <span class="btc-k">MOMENTUM</span>
          <span class="btc-v ${momClass}">${momStr}</span>
        </div>
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
      <a href="${trade.marketUrl}" target="_blank" rel="noopener" class="btc-market-link">↗ POLYMARKET</a>
    </div>
  `;

  cards.insertBefore(div, cards.firstChild);
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
      // Color peak green if it meaningfully exceeded entry, dim if flat
      peakEl.className = t.peakPrice > t.entryPrice + 0.005 ? "btc-v green" : "btc-v dim";
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
        if (!tokenId || !bid) continue;
        let changed = false;
        for (const t of state.trades) {
          if (t.tokenId !== tokenId) continue;
          t.currentPrice  = bid;
          t.unrealizedPnl = t.shares * bid - t.amount;
          if (bid > t.peakPrice) t.peakPrice = bid;
          t.priceHistory.push(bid);
          if (t.priceHistory.length > 120) t.priceHistory.shift();
          changed = true;
        }
        if (changed) {
          // Read live from DOM so changes take effect instantly without restart
          const stopLossPct   = (parseFloat($("#stop-loss-pct")?.value)   || state.config?.stopLossPct   || 25) / 100;
          const takeProfitPct = (parseFloat($("#take-profit-pct")?.value) || state.config?.takeProfitPct || 50) / 100;
          const toStopLoss = state.trades.filter(t => {
            if (t.tokenId !== tokenId) return false;
            // Never stop-loss truly last-second entries — position resolves in seconds
            if (t.totalSecs < 45) return false;
            // Grace period: short windows get a longer minimum grace now — a 147s trade with
            // only 5.88s grace was getting nuked in 5 seconds before the position could breathe.
            // Near-resolution arbs (< 90s) always get 25s since they're entered with high
            // confidence and a single candle tick can temporarily move the price.
            const grace = t.totalSecs < 90
              ? 25_000                                                    // near-res: always 25s
              : t.totalSecs < 200
              ? Math.min(20_000, Math.max(15_000, t.totalSecs * 100))    // short window: 15-20s
              : t.totalSecs < 500
              ? 60_000                                                    // mid-window (200-500s): 60s flat — let position breathe before first stop check
              : Math.min(60_000, Math.max(45_000, t.totalSecs * 60));    // long window (500s+): 45-60s
            if (Date.now() - t.entryTime < grace) {
              // Catastrophic loss override: bypass grace if loss exceeds 2× the normal stop.
              // A 50%+ loss in seconds is a genuine collapse, not tick noise — letting it compound
              // while waiting for grace to expire makes the final loss far worse.
              const catastrophic = t.unrealizedPnl <= -t.amount * 0.50;
              if (!catastrophic) return false;
            }
            // Near-res and short-window markets have thin order books — a single aggressive
            // order can move the token ±30% momentarily even with the gap intact.
            // Widen the effective stop for these entries to avoid exiting a correct trade.
            const effectiveStop = t.totalSecs < 90  ? Math.max(stopLossPct, 0.40)  // near-res
                                : t.totalSecs < 200 ? Math.max(stopLossPct, 0.32)  // short window
                                : stopLossPct;
            return t.unrealizedPnl <= -t.amount * effectiveStop;
          });
          for (const t of toStopLoss) closePosition(t, "STOP LOSS");
          const toTakeProfit = state.trades.filter(t => {
            if (t.tokenId !== tokenId) return false;
            if (t.unrealizedPnl >= t.amount * takeProfitPct) return true;
            // Trailing stop: arms at 15% gain, locks in 40% of peak
            // Higher arm threshold prevents quick spikes from arming the trail prematurely
            // 40% lock-in gives ~7pp breathing room vs 55% which was only 4pp — less harsh exits
            const peakGain = t.peakPrice * t.shares - t.amount;
            if (peakGain >= t.amount * 0.15 && t.unrealizedPnl < peakGain * 0.40) return true;
            return false;
          });
          for (const t of toTakeProfit) closePosition(t, "TAKE PROFIT");
          refreshBtcCards();
          updatePnlStat();
        }
        // Shadow tracking: closed positions still monitoring for final direction resolution
        for (const s of (state.shadowTrades || [])) {
          if (s.tokenId !== tokenId || s.resolved) continue;
          if (bid < s.minPriceAfterClose) s.minPriceAfterClose = bid;
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
        if      (sym === "btc/usd") state.chainlinkPrices.btc = val;
        else if (sym === "eth/usd") state.chainlinkPrices.eth = val;
        else if (sym === "sol/usd") state.chainlinkPrices.sol = val;
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

// ── Position management ──────────────────────────────────────────

function closePosition(trade, reason) {
  const idx = state.trades.indexOf(trade);
  if (idx === -1) return;
  state.trades.splice(idx, 1);

  // Post-close direction tracking: keep subscription alive until market resolves
  const msToEnd = new Date(trade.endDate) - Date.now();
  const willShadow = msToEnd > 5_000 && reason !== "RESOLVED";
  if (willShadow) {
    state.shadowTrades = state.shadowTrades || [];
    const shadow = {
      tradeId: trade.id,
      tokenId: trade.tokenId,
      minPriceAfterClose: trade.currentPrice,
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

  trade.exitTime   = Date.now();
  trade.duration   = trade.exitTime - trade.entryTime;
  trade.exitPrice  = trade.currentPrice;
  trade.secsAtClose = Math.max(0, Math.round((new Date(trade.endDate) - Date.now()) / 1000));

  const realized = trade.unrealizedPnl;
  state.realizedPnl = (state.realizedPnl || 0) + realized;
  if (realized > 0) state.wins++; else if (realized < 0) state.losses++;

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
    if (willShadow) {
      resDiv.innerHTML = `
        <span id="resolution-badge-${trade.id}" class="resolution-badge pending">⏳ TRACKING DIRECTION</span>
        <div class="resolution-data">
          <span class="res-item">MIN AFTER CLOSE: <span id="res-min-${trade.id}" class="btc-v">$${trade.currentPrice.toFixed(3)}</span></span>
          <span class="res-item">RESOLUTION: <span id="res-final-${trade.id}" class="btc-v dim">—</span></span>
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
  const finalEl = $(`#res-final-${shadow.tradeId}`);
  if (finalEl) {
    finalEl.textContent = `$${shadow.finalResolutionPrice.toFixed(3)}`;
    finalEl.className = "btc-v";
  }
}

function cleanupShadowTrade(shadow) {
  clearTimeout(shadow.cleanupTimer);
  state.shadowTrades = (state.shadowTrades || []).filter(s => s !== shadow);
  const stillNeeded = state.trades.some(t => t.tokenId === shadow.tokenId) ||
                      (state.shadowTrades || []).some(s => s.tokenId === shadow.tokenId);
  if (!stillNeeded) priceStream.unsubscribe(shadow.tokenId);
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
}

// ── Crypto mode (BTC / ETH / SOL) ────────────────────────────────

const ASSET_COLORS = { btc: "amber", eth: "eth", sol: "sol" };

// ── Market WebSocket — instant new_market detection ──────────────

const WS_MARKET_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";
// Word-boundary regexes for WS matching — prevents "eth" matching "wetherholt" etc.
const WS_KEYWORDS = {
  btc: [/\bbitcoin\b/, /\bbtc\b/],
  eth: [/\bethereum\b/, /\beth\b/],
  sol: [/\bsolana\b/, /\bsol\b/],
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
  if (!["btc", "eth", "sol"].some(a => state[a].timer)) return; // no asset running
  _marketWsReconnectTimer = setTimeout(() => {
    _marketWsReconnectDelay = Math.min(_marketWsReconnectDelay * 2, 30_000);
    startMarketWS();
  }, _marketWsReconnectDelay);
}

function _handleNewMarketEvent(msg) {
  const question = (msg.market?.question || msg.question || "").toLowerCase();
  if (!question) return;

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
}

function stopCryptoMode(asset) {
  if (!state[asset]?.timer) return;
  clearInterval(state[asset].timer);
  state[asset].timer = null;

  const cfg = CRYPTO_CONFIG[asset];
  const btn = $(`#btn-${asset}`);
  if (btn) { btn.textContent = `⚡ ${cfg.ticker} MODE`; btn.classList.remove("active"); }
  setStat(`${asset}-status`, "OFF", "dim");
  if (!["btc", "eth", "sol"].some(a => state[a].timer)) {
    setRunning(false);
    stopMarketWS();
  }
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

  // Prefer Chainlink live price as spot — same source as Polymarket resolution.
  // Candles stay Binance (trend/momentum analysis only, source doesn't matter there).
  const clSpot = state.chainlinkPrices[asset];
  if (clSpot) spot = clSpot;

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
    // Snapshot Chainlink price at detection time — this is our price-to-beat.
    // Detection happens within ~1-5s of window open (via WS new_market event),
    // so this closely matches Polymarket's actual Chainlink reference price.
    state[asset].analyzed.set(market.conditionId, {
      endDateMs:            new Date(market.endDate).getTime(),
      chainlinkPriceToBeat: state.chainlinkPrices[asset] ?? null,
    });

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

    // Prefer the Chainlink price snapshotted when we first detected this market window.
    // That snapshot happens within ~1-5s of window open (WS new_market event), so it's
    // the closest approximation to Polymarket's actual Chainlink reference price.
    // Fallback: Binance kline at window start (small delta vs Chainlink, but directionally correct).
    const storedData = state[asset].analyzed.get(market.conditionId);
    let priceToBeat = storedData?.chainlinkPriceToBeat ?? null;
    if (!priceToBeat) {
      try {
        priceToBeat = await fetchCryptoOpenAtTime(cfg.symbol, new Date(market.endDate).getTime() - windowMs);
      } catch { /* fall through */ }
    }
    if (!priceToBeat) priceToBeat = candles[candles.length - 1]?.open ?? spot;

    const timeRemaining = Math.round((new Date(market.endDate) - Date.now()) / 1000);
    const gap = spot - priceToBeat;

    // Skip near-zero gaps — noise floor depends on price source.
    // When Chainlink supplies both spot and priceToBeat the delta is ~0, so 0.01% is enough.
    // Fall back to 0.05% when either value came from Binance (0.07-0.10% inter-source noise).
    // If minGapPct is set in config (> 0), that overrides the auto value. Set to 0 to disable.
    const usingChainlink = state.chainlinkPrices[asset] != null &&
                           storedData?.chainlinkPriceToBeat != null;
    const configGap = c.minGapPct > 0 ? c.minGapPct / 100 : null;
    const autoGap   = usingChainlink ? 0.0001 : 0.0005;
    const minGapFrac = configGap ?? autoGap;
    if (minGapFrac > 0 && Math.abs(gap) < spot * minGapFrac) {
      const minGap = spot * minGapFrac;
      logEntry("dim", `  → SKIP gap too small (${gap >= 0 ? "+" : ""}$${gap.toFixed(pd)} < ±$${minGap.toFixed(pd)} threshold) — ${configGap ? `config ${c.minGapPct}%` : usingChainlink ? "price noise" : "Binance/Chainlink delta"}`);
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

    let analysis;
    try {
      analysis = await analyzeCryptoMarket(
        market, { spot, candles, priceToBeat, orderBook, fundingRate }, c.anthropicKey, { model: c.model }, asset
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
    const minOdds     = (c.minEntryOdds ?? 10) / 100;
    const maxOdds     = (c.maxEntryOdds ?? 87) / 100;
    const entryOdds   = analysis.signal === "BUY_UP" ? market.upPrice : market.downPrice;
    // HIGH conf + edge exception: allow entry up to 92% when AI has ≥10% edge.
    // Market has priced the direction but the AI has confirmed a clear gap — worth entering.
    const highConfHighOdds = analysis.confidence === "HIGH" && analysis.absEdge >= 0.10 && entryOdds <= 0.92;
    // Near-res exception: <120s + HIGH confidence = outcome is near-certain regardless of odds.
    // maxEntryOdds cap is designed for uncertain mid-window entries, not endgame lock-ins.
    const nearResHighConf  = timeRemaining < 120 && analysis.confidence === "HIGH" && entryOdds <= 0.95;
    const oddsOk      = analysis.signal === "SKIP" || (entryOdds >= minOdds && (entryOdds <= maxOdds || highConfHighOdds || nearResHighConf));

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

    // Long-window low-conviction guard: near-50% odds with lots of time remaining means
    // the market is uncertain — require minimum conviction odds before entering.
    // BTC is stricter: requires ≥58% odds with >900s remaining (volatility is harder to
    // predict over long windows and BTC gaps rarely flip in 5-min windows).
    const longWindowLowConv = asset === "btc"
      ? (timeRemaining > 900 && entryOdds < 0.58)
      : (timeRemaining > 800 && entryOdds < 0.55);

    // BTC mid-window minimum odds guard: 50-54.9% BTC entries with >250s remaining are
    // consistently net-negative (-$19.31 at 250s, -$26.24 at 300s in session data).
    // The crowd pricing below 55% indicates the market doesn't believe the gap will hold —
    // and BTC's volatility gives reversion plenty of time to materialise.
    // Exception: HIGH confidence + strong edge (≥12%) — the AI has detected something the
    // Polymarket UI-lagging crowd hasn't priced yet; these are worth taking.
    const btcMidWindowLowOdds = asset === "btc" &&
                                 timeRemaining > 250 &&
                                 entryOdds >= 0.50 &&
                                 entryOdds < 0.55 &&
                                 !(analysis.confidence === "HIGH" && analysis.absEdge >= 0.12);

    // Short-window MEDIUM guard: <120s left is high-volatility endgame territory.
    // A single price candle can flip everything — only HIGH confidence is worth the risk.
    // 120-200s MEDIUM signals with adequate market odds have sufficient time buffer.
    const shortWindowMedium = timeRemaining < 120 && analysis.confidence !== "HIGH";

    // SOL mid-window MEDIUM guard: SOL has higher intra-candle volatility than ETH/BTC.
    // Session data shows MEDIUM-confidence SOL entries with >400s remaining stop out in 1-3 min
    // even when the gap+trend thesis is correct — require ≥60% entry odds for these entries
    // to ensure the crowd signal is strong enough to offset SOL's whipsaw risk.
    const solMediumLongWindow = asset === "sol" &&
                                analysis.confidence === "MEDIUM" &&
                                timeRemaining > 400 &&
                                entryOdds < 0.60;

    // BTC gap-flip filter: MEDIUM confidence bets against a gap >800pts rarely flip in time.
    // These produce high-frequency small wins but large stop-loss losses — negative EV overall.
    const btcMediumGapBlocked = asset === "btc" &&
                                 analysis.confidence === "MEDIUM" &&
                                 signalAgainstGap &&
                                 Math.abs(analysis.gap) > 800;

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
    const pumpSkeptic = !signalAgainstGap &&
                         analysis.signal !== "SKIP" &&
                         entryOdds < 0.50 &&
                         !btcShortWindowException;

    // Near-res low-odds guard: at <200s remaining the prediction market price is volatile
    // and a stop-loss fires easily on normal fluctuations even when the underlying gap is intact.
    // Require ≥50% entry odds — below 50% the crowd expects the opposite outcome.
    // Exception: HIGH conf + ≥15% edge can enter at 40-49.9% — same rationale as BTC mid-window
    // exception (UI lag, thin liquidity, market underpricing a near-certain gap outcome).
    const nearResLowOdds = timeRemaining < 200 && entryOdds < 0.50 &&
                           !(analysis.confidence === "HIGH" && analysis.absEdge >= 0.15);

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

    // BTC macro filter: when BTC shows a strong directional signal (≥3/5 candles aligned
    // + momentum ≥ 20/min in that direction), altcoin trades that fight that trend have a
    // high stop-loss failure rate (BTC leads alts).  Block BUY_UP on ETH/SOL when BTC is
    // strongly bearish, and BUY_DOWN when BTC is strongly bullish.
    // State expires after 5 minutes so stale BTC data doesn't block valid alt entries.
    const btcMacro      = state.btcMacro;
    const btcMacroFresh = btcMacro && (Date.now() - btcMacro.updatedAt) < 300_000;
    const btcMacroVeto  = asset !== "btc" && btcMacroFresh && (
      (analysis.signal === "BUY_UP"   && btcMacro.bearCount >= 3 && btcMacro.momentum <= -20) ||
      (analysis.signal === "BUY_DOWN" && btcMacro.bullCount >= 3 && btcMacro.momentum >= 20)
    );

    // Stall guard: a large gap with near-zero momentum is "floating" — no force is sustaining
    // it above/below target, so gravity takes over and it reverts. Uses the same momentum
    // threshold as the signal generator (spot × 0.00007). Does not apply to gap-flip trades
    // or near-resolution windows (<120s) where time compression makes momentum less relevant.
    const momThresholdStall = spot * 0.00007;
    const stallGapPct = (analysis.priceToBeat ?? 0) > 0
      ? Math.abs((analysis.gap ?? 0) / analysis.priceToBeat)
      : 0;
    const stalled = !signalAgainstGap &&
                     analysis.signal !== "SKIP" &&
                     stallGapPct > 0.030 &&
                     Math.abs(analysis.momentum ?? Infinity) < momThresholdStall &&
                     timeRemaining > 120;

    const qualifies =
      analysis.signal !== "SKIP" &&
      oddsOk &&
      crossable &&
      !longWindowLowConv &&
      !btcMidWindowLowOdds &&
      !shortWindowMedium &&
      !solMediumLongWindow &&
      !btcMediumGapBlocked &&
      !gapFlipMidWindowBlocked &&
      !btcMacroVeto &&
      !pumpSkeptic &&
      !stalled &&
      !nearResLowOdds &&
      !solLargeGapUp &&
      !assetPositionOpen &&
      (analysis.confidence === "HIGH" ||
       (analysis.confidence === "MEDIUM" && analysis.absEdge >= minEdge)) &&
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
      if (longWindowLowConv) reasons.push(`long window (${timeRemaining}s) needs ≥${asset === "btc" ? "60" : "55"}% conviction odds — got ${(entryOdds * 100).toFixed(1)}%`);
      if (btcMidWindowLowOdds) reasons.push(`BTC mid-window low odds — ${(entryOdds * 100).toFixed(1)}% entry with ${timeRemaining}s left needs ≥55% or HIGH conf + ≥12% edge (crowd reversion signal)`);
      if (shortWindowMedium) reasons.push(`short window (${timeRemaining}s) requires HIGH confidence — endgame volatility too high for MEDIUM (<120s)`);
      if (solMediumLongWindow) reasons.push(`SOL mid-window MEDIUM — ${(entryOdds * 100).toFixed(1)}% entry with ${timeRemaining}s left needs ≥60% (SOL whipsaw risk too high for MEDIUM conviction)`);
      if (btcMediumGapBlocked) reasons.push(`BTC gap-flip blocked — MEDIUM confidence with gap $${Math.abs(analysis.gap).toFixed(0)} > $800 rarely flips in time`);
      if (gapFlipMidWindowBlocked) reasons.push(`gap-flip momentum too weak — need ${momNeededToFlip.toFixed(3)}/m to close gap, got ${Math.abs(analysis.momentum ?? 0).toFixed(3)}/m (need ≥50%)`);
      if (btcMacroVeto) {
        const mDir = btcMacro.bearCount >= 3 ? "bearish" : "bullish";
        const mCnt = btcMacro.bearCount >= 3 ? btcMacro.bearCount : btcMacro.bullCount;
        reasons.push(`BTC macro veto — BTC ${mDir} (${mCnt}/5 candles, ${btcMacro.momentum.toFixed(1)}/min) opposes ${analysis.signal}`);
      }
      if (pumpSkeptic) reasons.push(`pump-skeptic — price already ${analysis.signal === "BUY_UP" ? "above" : "below"} target but market prices it at ${(entryOdds * 100).toFixed(1)}% (<50%) — crowd expects reversion`);
      if (stalled) reasons.push(`stall guard — gap ${(stallGapPct * 100).toFixed(1)}% but momentum ≈0 (${(analysis.momentum ?? 0).toFixed(2)}/m < threshold ${momThresholdStall.toFixed(2)}/m) — no driving force`);
      if (nearResLowOdds) reasons.push(`near-res low-odds — ${timeRemaining}s left but market only at ${(entryOdds * 100).toFixed(1)}% (need ≥50% for near-res entries ≤200s)`);
      if (solLargeGapUp) reasons.push(`SOL large-gap BUY_UP — SOL ${(stallGapPct * 100).toFixed(1)}% above target with vol spike ${(analysis.volSpikeRatio ?? 0).toFixed(2)}× — fresh pump reversal risk`);
      if (assetPositionOpen) reasons.push(`${asset.toUpperCase()} position already open — max 1 per asset (correlated stop risk)`);
      if (analysis.confidence === "LOW") reasons.push("confidence LOW");
      else if (analysis.confidence === "MEDIUM" && analysis.absEdge < minEdge)
        reasons.push(`edge ${(analysis.absEdge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(0)}% required for MEDIUM`);
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
  // Near-resolution arbs (≤90s, HIGH confidence only) get a size premium: the gap is
  // almost impossible to close and the outcome is near-certain — maximise the edge.
  const secsForSizing = Math.max(1, Math.round((new Date(market.endDate) - Date.now()) / 1000));
  const timeFraction  = secsForSizing <= 90  ? 1.35   // near-resolution arb premium
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
  const rawAmount = Math.min(maxBet * timeFraction * oddsFraction * confidenceFraction, c.maxDaily - state.stats.spent);
  // Near-resolution size cap: prediction markets become illiquid in the final 120s and a stop
  // can fire on a single bad tick even with a large underlying gap intact.  Cap exposure at $25
  // to bound catastrophic stop losses that outweigh the edge (e.g. SOL -$33.53 at 156s).
  const nearResCap = secsForSizing <= 120 ? 25 : Infinity;
  const amount = Math.min(rawAmount, nearResCap);
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
    marketUrl,
    exitPrice:       null,   // set on close
    secsAtClose:     null,   // set on close
  };

  state.trades.push(trade);
  addCryptoCard(trade);
  priceStream.subscribe(tokenId);
  startCryptoCountdown();

  if (!c.dryRun) {
    fetch("/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        token_id:       tokenId,
        side:           "BUY",
        amount_usdc:    amount,
        private_key:    c.polyPrivateKey,
        api_key:        c.polyApiKey,
        api_secret:     c.polyApiSecret,
        api_passphrase: c.polyPassphrase,
      }),
    })
      .then(r => r.json())
      .then(result => {
        if (result.error) {
          logEntry("warn", `  [LIVE] Order failed: ${result.error}`);
        } else {
          logEntry("info", `  [LIVE] Order confirmed: ${result.orderID ?? result.status ?? JSON.stringify(result)}`);
        }
      })
      .catch(err => logEntry("warn", `  [LIVE] Order error: ${err.message}`));
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
    const stopLossPct = (parseFloat($("#stop-loss-pct")?.value) || state.config?.stopLossPct || 25) / 100;
    for (const t of [...cryptoTrades]) {
      if (t.totalSecs < 45) continue;
      // Grace must match the main WS handler so the safety net doesn't fire prematurely.
      // The old formula (totalSecs * 40ms for <200s) gave only 3-8s grace, causing stops
      // to fire in 5-7s on short-window trades that later resolved correctly.
      const grace = t.totalSecs < 90
        ? 25_000
        : t.totalSecs < 200
        ? Math.min(20_000, Math.max(15_000, t.totalSecs * 100))
        : t.totalSecs < 500
        ? 60_000
        : Math.min(60_000, Math.max(45_000, t.totalSecs * 60));
      if (Date.now() - t.entryTime < grace) continue;
      // Same widened thresholds as the WS handler for thin-book noise protection
      const effectiveStop = t.totalSecs < 90  ? Math.max(stopLossPct, 0.40)
                          : t.totalSecs < 200 ? Math.max(stopLossPct, 0.32)
                          : stopLossPct;
      if (t.unrealizedPnl <= -t.amount * effectiveStop) { closePosition(t, "STOP LOSS"); refreshBtcCards(); updatePnlStat(); }
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
