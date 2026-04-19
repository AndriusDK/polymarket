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
  btc: { timer: null, analyzed: new Map(), gapWatch: new Map(), gapPending: new Map(), pendingCheckTimer: null, accelTimer: null, running: false, oddsHistory: new Map(), volTrack: new Map() },  // conditionId → endDateMs
  eth: { timer: null, analyzed: new Map(), gapWatch: new Map(), gapPending: new Map(), pendingCheckTimer: null, accelTimer: null, running: false, oddsHistory: new Map(), volTrack: new Map() },
  sol: { timer: null, analyzed: new Map(), gapWatch: new Map(), gapPending: new Map(), pendingCheckTimer: null, accelTimer: null, running: false, oddsHistory: new Map(), volTrack: new Map() },
  xrp: { timer: null, analyzed: new Map(), gapWatch: new Map(), gapPending: new Map(), pendingCheckTimer: null, accelTimer: null, running: false, oddsHistory: new Map(), volTrack: new Map() },
  tradeHistory: [],    // { ts, pnl, asset, reason } — every closed position, used by profit chart
  recentStops: [],     // timestamps of recent stop-loss events (any asset) for stress detection
  stressHoldUntil: 0, // epoch ms: new entries blocked until this time (market-stress cool-down)
  chainlinkPrices: { btc: null, eth: null, sol: null, xrp: null }, // live Chainlink prices from RTDS
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
      xrpMode:       $("#xrp-mode-toggle")?.checked ?? false,
      xrpMaxBet:     parseFloat($("#xrp-max-bet")?.value) || 5,
      xrpMinEdge:    parseFloat($("#xrp-min-edge")?.value) || 0.04,
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
  for (const asset of ["btc", "eth", "sol", "xrp"]) stopCryptoMode(asset);
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
        ${trade.mode === "LIVE" ? `<button class="manual-sell-btn" data-id="${trade.id}" title="Sell now at market price">⬛ SELL NOW</button>` : ""}
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
            // Gap-flip trades get a 75s minimum grace regardless of window size — the token
            // oscillates steeply downward before price crosses the target, and the 15-20s grace
            // for 90-200s windows fires the catastrophic stop on a correct-direction dip.
            const baseGrace = t.totalSecs < 90
              ? 25_000                                                    // near-res: always 25s
              : t.totalSecs < 200
              ? Math.min(20_000, Math.max(15_000, t.totalSecs * 100))    // short window: 15-20s
              : t.totalSecs < 500
              ? 90_000                                                    // mid-window (200-500s): 90s — correct-direction 5-min trades resolve late, tight 60s was stopping winners
              : (t.confidence === "HIGH" && t.entryPrice > 0.55)
              ? 180_000                                                   // long window + HIGH conf + strong entry (>55%): 180s — correct-direction trades oscillate before resolving
              : 120_000;                                                  // long window (500s+): 120s — 15-min markets need time to settle
            const grace = t.signalAgainstGap ? Math.max(baseGrace, 75_000) : baseGrace;
            if (Date.now() - t.entryTime < grace) {
              // Catastrophic loss override: bypass grace if loss exceeds threshold.
              // Gap-flip trades raise this to 85% — the token dumps to 13-17 cents during
              // the pre-crossing oscillation (observed MIN AFTER 0.130-0.150), which triggers
              // the old 70% threshold on correct-direction trades. 85% only fires at ~8-9 cents,
              // safely below the observed oscillation trough, protecting against true collapse.
              const catThreshold = t.signalAgainstGap ? 0.85 : 0.50;
              const catastrophic = t.unrealizedPnl <= -t.amount * catThreshold;
              if (!catastrophic) return false;
            }
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
            const baseStop = t.signalAgainstGap
              ? (t.entryPrice < 0.40 ? Math.max(stopLossPct, 0.35) : Math.max(stopLossPct, 0.60))
              : stopLossPct;
            const effectiveStop = t.totalSecs < 90  ? Math.max(baseStop, 0.40)  // near-res
                                : t.totalSecs < 200 ? Math.max(baseStop, 0.32)  // short window
                                : baseStop;
            return t.unrealizedPnl <= -t.amount * effectiveStop;
          });
          for (const t of toStopLoss) closePosition(t, "STOP LOSS");
          const toTakeProfit = state.trades.filter(t => {
            if (t.tokenId !== tokenId) return false;
            if (t.unrealizedPnl >= t.amount * takeProfitPct) return true;
            // Trailing stop: arms at 15% gain, lock-in % scales with absolute peak gain
            // Small gains: loose trail (40%) — let it run; large gains: tight trail (65%) — protect profit
            const peakGain = t.peakPrice * t.shares - t.amount;
            const lockIn = peakGain >= 12 ? 0.65 : peakGain >= 6 ? 0.55 : 0.40;
            if (peakGain >= t.amount * 0.15 && t.unrealizedPnl < peakGain * lockIn) return true;
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
        if      (sym === "btc/usd") state.chainlinkPrices.btc = val;
        else if (sym === "eth/usd") state.chainlinkPrices.eth = val;
        else if (sym === "sol/usd") state.chainlinkPrices.sol = val;
        else if (sym === "xrp/usd") state.chainlinkPrices.xrp = val;
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
  if (trade.mode === "LIVE" && !trade.confirmed) {
    console.warn(`[LIVE] closePosition blocked — BUY not yet confirmed (reason: ${reason})`);
    return;
  }
  const idx = state.trades.indexOf(trade);
  if (idx === -1) return;
  state.trades.splice(idx, 1);

  // LIVE MODE: place a SELL order on-chain to exit the position.
  if (trade.mode === "LIVE" && trade.tokenId && (trade.shares ?? 0) > 0) {
    const c = state.config;
    const sellPayload = {
      token_id:       trade.tokenId,
      side:           "SELL",
      amount_usdc:    trade.shares,  // for SELL, amount = shares (tokens), not USDC
      entry_price:    trade.currentPrice,  // sell limit: don't accept more than 8% below current
      private_key:    c.polyPrivateKey,
      api_key:        c.polyApiKey,
      api_secret:     c.polyApiSecret,
      api_passphrase: c.polyPassphrase,
    };
    console.log(`[LIVE] Placing SELL order`, {
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
    // SELL retry: server does FOK retries internally; if ALL server retries fail,
    // retry from the frontend after a short delay, dropping price limit on 2nd+ attempt.
    const attemptSell = (payload, attempt) => {
      const label = attempt === 0 ? "" : ` (retry #${attempt})`;
      fetch("/trade", {
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
              logEntry("warn", `  [LIVE] SELL retry in ${delay / 1000}s (no price limit)…`);
              setTimeout(() => {
                // Drop price limit on retry — must exit at any price
                const retryPayload = { ...payload, entry_price: undefined };
                attemptSell(retryPayload, attempt + 1);
              }, delay);
            } else {
              logEntry("warn", `  [LIVE] SELL gave up after ${attempt + 1} attempts — position may still be open`);
            }
          } else {
            const fillPrice = parseFillPrice(result, "SELL");
            console.log(`[LIVE] SELL CONFIRMED${label}`, result, fillPrice ? `fill: ${(fillPrice*100).toFixed(1)}%` : "");
            logEntry("info", `  [LIVE] SELL confirmed${label}: ${result.orderID ?? result.status ?? JSON.stringify(result)}`);
            // Reconcile realized PnL from actual fill price — the snapshot at stop-trigger
            // time can be based on a stale/thin bid (e.g. bid=1¢ → shows -$4.92 when
            // actual fill was 58¢ → real loss -$0.66). Update card and session totals.
            if (fillPrice && fillPrice > 0.05 && trade.shares > 0) {
              const prevRealized  = trade.realizedPnl;
              const actualRealized = trade.shares * fillPrice - trade.amount;
              const delta = actualRealized - prevRealized;
              if (Math.abs(delta) > 0.01) {
                state.realizedPnl = (state.realizedPnl || 0) + delta;
                trade.realizedPnl = actualRealized;

                // Fix win/loss counts if the sign flipped
                const wasWin  = prevRealized  > 0;
                const nowWin  = actualRealized > 0;
                if (wasWin && !nowWin) { state.wins--; state.losses++; }
                else if (!wasWin && nowWin) { state.losses--; state.wins++; }

                const cardEl = $(`#card-${trade.id}`);
                if (cardEl) {
                  // Update PnL amount + color
                  const pnlEl = cardEl.querySelector(".btc-closed-pnl");
                  if (pnlEl) {
                    const sign = actualRealized >= 0 ? "+" : "";
                    pnlEl.textContent = `${sign}$${actualRealized.toFixed(2)} REALIZED`;
                    pnlEl.className = `btc-closed-pnl ${actualRealized >= 0 ? "green" : "red"}`;
                  }
                  // Update WIN/LOSS strip label + color if sign changed
                  if (wasWin !== nowWin) {
                    const stripEl = cardEl.querySelector(".btc-closed-strip");
                    const labelEl = cardEl.querySelector(".btc-closed-label");
                    if (stripEl) stripEl.className = `btc-closed-strip ${nowWin ? "win" : "loss"}`;
                    if (labelEl) {
                      const reason = labelEl.textContent.replace(/^(▲ WIN|▼ LOSS) — /, "");
                      labelEl.textContent = `${nowWin ? "▲ WIN" : "▼ LOSS"} — ${reason}`;
                    }
                  }
                }
                updatePnlStat();
                logEntry("info", `  [LIVE] PnL reconciled from fill: $${actualRealized.toFixed(2)} (was $${prevRealized.toFixed(2)})`);
              }
            }
          }
        })
        .catch(err => {
          console.error(`[LIVE] SELL fetch error${label}`, err);
          logEntry("warn", `  [LIVE] SELL error${label}: ${err.message}`);
        });
    };
    attemptSell(sellPayload, 0);
  }

  // Post-close direction tracking: keep subscription alive until market resolves
  const msToEnd = new Date(trade.endDate) - Date.now();
  const willShadow = msToEnd > 5_000 && reason !== "RESOLVED";
  if (willShadow) {
    state.shadowTrades = state.shadowTrades || [];
    const shadow = {
      tradeId: trade.id,
      tokenId: trade.tokenId,
      minPriceAfterClose: trade.currentPrice,
      maxPriceAfterClose: trade.currentPrice,
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
  trade.realizedPnl = realized;  // stored so SELL fill reconciliation can update it
  state.realizedPnl = (state.realizedPnl || 0) + realized;
  if (realized > 0) state.wins++; else if (realized < 0) state.losses++;
  state.tradeHistory.push({ ts: Date.now(), pnl: realized, asset: trade.type, reason });

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
          <span class="res-item">MAX AFTER CLOSE: <span id="res-max-${trade.id}" class="btc-v">$${trade.currentPrice.toFixed(3)}</span></span>
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
  const maxEl = $(`#res-max-${shadow.tradeId}`);
  if (maxEl) maxEl.textContent = `$${shadow.maxPriceAfterClose.toFixed(3)}`;
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
// Word-boundary regexes for WS matching — prevents "eth" matching "wetherholt" etc.
const WS_KEYWORDS = {
  btc: [/\bbitcoin\b/, /\bbtc\b/],
  eth: [/\bethereum\b/, /\beth\b/],
  sol: [/\bsolana\b/, /\bsol\b/],
  xrp: [/\bxrp\b/, /\bripple\b/],
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

  logEntry("cyan", `⚡ ${cfg.ticker} MODE ON — WS instant detection + 15s safety poll`);

  startMarketWS();
  runCryptoCycle(asset);
  state[asset].timer = setInterval(() => runCryptoCycle(asset), 15_000);
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

    // Skip non-standard markets: hourly ("1PM ET"), daily, or threshold ("above 70,000") markets
    // lack an explicit HH:MM-HH:MM time range.  Their near-expiry tokens can be at 1-4% which
    // falsely passes the flash entry ≤52% check, causing catastrophic fills on worthless tokens.
    if (!/\d+:\d+[AP]M-\d+:\d+[AP]M/i.test(market.question)) continue;

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
        snap.firstSeenAt          = new Date(market.endDate).getTime() - windowMs;  // actual window-open wall-clock time, not bot-start time
        snap.firstSeenVolume      = market.volume ?? 0;
        const displayPrice = snap.chainlinkPriceToBeat ?? 0;
        const src = (clPrice && !state.chainlinkPrices[asset]) ? " (historical)" : "";
        logEntry("dim", `  → window opened — priceToBeat refreshed $${displayPrice >= 1000 ? displayPrice.toFixed(0) : displayPrice.toFixed(2)}${src}`);
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

    // === Pre-gap momentum entry ===
    // Fires when the window just opened (<15s) and gap hasn't developed yet. Rationale:
    // both tokens are ~50/50 and the book is symmetric, so fills are cheap. If pre-window
    // momentum is strongly directional (high |mom|, 4+ aligned candles, strong book),
    // enter in that direction at parity before the market "votes" via gap movement.
    // Tighter gate than flash: pure momentum with no gap confirmation carries reversal risk,
    // so all 3 path-quality signals must hold.
    {
      const pgSnap    = state[asset].gapPending.get(market.conditionId)
                     ?? state[asset].analyzed.get(market.conditionId);
      const windowAge = pgSnap?.firstSeenAt ? Date.now() - pgSnap.firstSeenAt : Infinity;
      const gapFrac   = priceToBeat > 0 ? Math.abs(gap) / priceToBeat : 1;

      if (
        !pgSnap?.flashEntered &&
        !pgSnap?.preGapEntered &&
        windowAge < 15_000 &&
        timeRemaining > 180 &&
        gapFrac < 0.0004   // below flash's gap threshold — pure momentum entry
      ) {
        const pgMomRaw     = candles.slice(0, 3).reduce((s, c) => s + (c.close - c.open), 0) / 3;
        const pgSignal     = pgMomRaw > 0 ? "BUY_UP" : "BUY_DOWN";
        const pgOdds       = pgSignal === "BUY_UP" ? market.upPrice : market.downPrice;
        const pgMomThr     = asset === "btc" ? 25 : asset === "eth" ? 2 : 0.08;
        const pgMomOk      = Math.abs(pgMomRaw) >= pgMomThr;
        const pgAlignedCnt = candles.slice(0, 5).filter(c =>
          pgSignal === "BUY_UP" ? c.close > c.open : c.close < c.open
        ).length;
        let pgBookRatio = 1, pgBookWall = false;
        if (orderBook) {
          const bids = (orderBook.bids ?? []).slice(0, 10);
          const asks = (orderBook.asks ?? []).slice(0, 10);
          const bidQ = bids.reduce((s, b) => s + b.qty, 0);
          const askQ = asks.reduce((s, a) => s + a.qty, 0);
          pgBookRatio = pgSignal === "BUY_UP"
            ? bidQ / Math.max(askQ, 0.001)
            : askQ / Math.max(bidQ, 0.001);
          const pgSide = pgSignal === "BUY_UP" ? bids : asks;
          const pgAvg  = pgSide.reduce((s, b) => s + b.qty, 0) / Math.max(pgSide.length, 1);
          pgBookWall   = pgSide.some(b => b.qty > pgAvg * 3);
        }
        const pgStrongBook = pgBookRatio >= 2 || pgBookWall;
        const assetOpen    = state.trades.some(t => t.type === asset);
        const veto         = state.directionVeto;
        const vetoed       = veto && Date.now() < veto.expiresAt && pgSignal === veto.signal;
        const stressed     = Date.now() < (state.stressHoldUntil ?? 0);

        if (
          pgMomOk &&
          pgAlignedCnt >= 4 &&
          pgStrongBook &&
          pgOdds >= 0.47 && pgOdds <= 0.53 &&
          !assetOpen &&
          !vetoed &&
          !stressed &&
          state.stats.spent < c.maxDaily
        ) {
          if (pgSnap) pgSnap.preGapEntered = true;
          logEntry("dim",
            `  ↳ <span class="amber">⚡ pre-gap</span> — ` +
            `book at ${(pgOdds*100).toFixed(0)}% (no gap yet), ` +
            `mom ${pgMomRaw >= 0 ? "+" : ""}${pgMomRaw.toFixed(asset === "btc" ? 0 : 2)}/m, ` +
            `${pgAlignedCnt}/5 candles, book ${pgBookRatio.toFixed(1)}×`
          );
          placeCryptoTrade(asset, {
            signal:        pgSignal,
            confidence:    "HIGH",
            edge:          0.10,
            absEdge:       0.10,
            reasoning:     `Pre-gap momentum entry — ${pgAlignedCnt}/5 candles aligned, momentum ${pgMomRaw.toFixed(2)}/m, book ${pgBookRatio.toFixed(1)}× before gap formation`,
            gap,
            priceToBeat,
            momentum:      pgMomRaw,
            timeRemaining,
            momentumTrade: false,
            market,
          }, { spot, priceToBeat });
          continue;
        }
      }
    }

    // Skip near-zero gaps — noise floor depends on price source.
    // When Chainlink supplies both spot and priceToBeat the delta is ~0, so 0.01% is enough.
    // Fall back to 0.05% when either value came from Binance (0.07-0.10% inter-source noise).
    // If minGapPct is explicitly set (including 0 = fully disabled), that overrides auto value.
    const usingChainlink = state.chainlinkPrices[asset] != null &&
                           storedData?.chainlinkPriceToBeat != null;
    // Use !isNaN so that 0 means "user explicitly disabled" (not "not configured").
    // With > 0 check, typing 0 fell through to autoGap — filter never truly turned off.
    const configGap = !isNaN(c.minGapPct) ? c.minGapPct / 100 : null;
    const autoGap   = usingChainlink ? 0.0001 : 0.0005;
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

    // === Flash-entry gate ===
    // At window open (<45s), Polymarket tokens start near 50/50 before the crowd processes
    // the gap.  Entering at ~50% gives deeper book, better fills, and better risk/reward
    // vs entering at 55-65%+ after price discovery.
    // Bypasses: 30s wait, oracle gate, AI analysis.
    // Respects: stress hold, direction veto, position limit, budget.
    {
      const fSnap     = state[asset].gapPending.get(market.conditionId)
                     ?? state[asset].analyzed.get(market.conditionId);
      const windowAge = fSnap?.firstSeenAt ? Date.now() - fSnap.firstSeenAt : Infinity;

      if (!fSnap?.flashEntered && windowAge < 45_000 && timeRemaining > 150) {
        const flashSignal = gap > 0 ? "BUY_UP" : "BUY_DOWN";
        const flashGapPct = priceToBeat > 0 ? Math.abs(gap) / priceToBeat : 0;
        const flashOdds   = flashSignal === "BUY_UP" ? market.upPrice : market.downPrice;
        const assetOpen   = state.trades.some(t => t.type === asset);
        const veto        = state.directionVeto;
        const vetoed      = veto && Date.now() < veto.expiresAt && flashSignal === veto.signal;
        const stressed    = Date.now() < (state.stressHoldUntil ?? 0);

        if (
          flashGapPct >= 0.0004 &&    // gap ≥ 0.04% — meaningful directional signal
          flashOdds >= 0.35 &&         // token not near-expired worthless (1-4% = loser, not undiscovered)
          flashOdds <= 0.55 &&         // token still pre-discovery — accept up to 55% (matches postDiscovery cap)
          !assetOpen &&                // no existing position for this asset
          !vetoed &&                   // no correlated-loss directional veto
          !stressed &&                 // no market-stress cool-down
          state.stats.spent < c.maxDaily
        ) {
          // Flash quality gate: tiny gaps (<0.08%) need ≥2/3 confirmations to avoid coin-flip entries.
          // Large gaps (≥0.08%) carry enough directional signal on their own.
          const flashAlignedCnt = candles.slice(0, 5).filter(c =>
            flashSignal === "BUY_UP" ? c.close > c.open : c.close < c.open
          ).length;
          const flashMomRaw = candles.slice(0, 3).reduce((s, c) => s + (c.close - c.open), 0) / 3;
          const flashMomThr = asset === "btc" ? 20 : asset === "eth" ? 1.5 : 0.05;
          const flashMomOk  = flashSignal === "BUY_UP" ? flashMomRaw >= flashMomThr : flashMomRaw <= -flashMomThr;
          let flashBookRatio = 1, flashBookWall = false;
          if (orderBook) {
            const bids = (orderBook.bids ?? []).slice(0, 10);
            const asks = (orderBook.asks ?? []).slice(0, 10);
            const bidQ = bids.reduce((s, b) => s + b.qty, 0);
            const askQ = asks.reduce((s, a) => s + a.qty, 0);
            flashBookRatio = flashSignal === "BUY_UP"
              ? bidQ / Math.max(askQ, 0.001)
              : askQ / Math.max(bidQ, 0.001);
            const fSide = flashSignal === "BUY_UP" ? bids : asks;
            const fAvg  = fSide.reduce((s, b) => s + b.qty, 0) / Math.max(fSide.length, 1);
            flashBookWall = fSide.some(b => b.qty > fAvg * 3);
          }
          const flashStrongBook = flashBookRatio >= 3 || flashBookWall;
          const flashConfirmCnt = [flashMomOk, flashAlignedCnt >= 4, flashStrongBook].filter(Boolean).length;
          const flashWeakEdge   = flashGapPct < 0.0008 && flashConfirmCnt < 2;

          if (flashWeakEdge) {
            if (!fSnap.flashBlockLogged) {
              fSnap.flashBlockLogged = true;
              logEntry("dim",
                `  ↳ <span class="amber">flash</span> blocked — weak edge: gap ${(flashGapPct*100).toFixed(2)}%, ` +
                `${flashConfirmCnt}/3 signals (mom${flashMomOk ? "✓" : "✗"} candles ${flashAlignedCnt}/5 book${flashStrongBook ? "✓" : "✗"}) — waiting for AI`
              );
            }
            // fall through to oracle gate / AI analysis this cycle
          } else {
            fSnap.flashEntered = true;   // prevent double-fire on subsequent cycles
            logEntry("dim",
              `  ↳ <span class="amber">⚡ flash</span> — ` +
              `book at ${(flashOdds*100).toFixed(0)}% (pre-discovery), ` +
              `gap ${gap >= 0 ? "+" : ""}$${gap.toFixed(pd)} (${(flashGapPct*100).toFixed(2)}%)`
            );
            placeCryptoTrade(asset, {
              signal:        flashSignal,
              confidence:    "HIGH",
              edge:          0.10,
              absEdge:       0.10,
              reasoning:     `Window-open flash entry — gap ${gap >= 0 ? "+" : ""}$${gap.toFixed(pd)} (${(flashGapPct*100).toFixed(2)}%) captured before market price discovery`,
              gap,
              priceToBeat,
              momentum:      0,
              timeRemaining,
              momentumTrade: false,
              market,
            }, { spot, priceToBeat });
            continue;  // skip oracle gate + AI analysis this cycle
          }
        }
      }
    }

    // Oracle observation gate — when a market is brand-new AND the gap is tiny (<0.2%),
    // the Chainlink price-to-beat may not have been published yet (typical 1-2 min lag on
    // new windows).  Deferring the AI call until volume picks up ($200+ delta) OR the market
    // is old enough avoids premature momentum entries on ghost data AND saves AI tokens.
    // For meaningful gaps (≥0.04%) we only wait 30s so AI can assess while market is still
    // pre-discovery (~50-55%); tiny gaps (<0.04%) still wait the full 90s.
    {
      const freshSnap   = state[asset].gapPending.get(market.conditionId);
      const gapFrac     = priceToBeat > 0 ? Math.abs(gap) / priceToBeat : 1;
      const volumeDelta = market.volume - (freshSnap?.firstSeenVolume ?? market.volume);
      const marketAge   = Date.now() - (freshSnap?.firstSeenAt ?? 0);
      const ageThreshold = gapFrac >= 0.0004 ? 30_000 : 90_000;
      if (gapFrac < 0.002 && volumeDelta < 200 && marketAge < ageThreshold) {
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

    // Hard block: < 90s remaining — book is empty, FOK always fails, stop-loss can't
    // protect.  At 60–90s the DOWN/UP token with losing probability has essentially no
    // liquidity so a market BUY fills at catastrophically low prices (e.g. 72.5% → 7.9%).
    // Raised from 60s after BTC at 64s and ETH at 63s both filled at 4.6%/26% (vs 59.5%/58.5%).
    // Mark analyzed so we don't retry this market again.
    if (timeRemaining < 90) {
      const snap = state[asset].gapPending.get(market.conditionId) ?? state[asset].analyzed.get(market.conditionId);
      if (snap) state[asset].analyzed.set(market.conditionId, snap);
      state[asset].gapPending.delete(market.conditionId);
      logEntry("dim", `  → <${timeRemaining}s left — too close to resolution, skipping`);
      continue;
    }

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

    let analysis;
    try {
      analysis = await analyzeCryptoMarket(
        market, { spot, candles, priceToBeat, orderBook, fundingRate, oddsHistory: updatedOdds }, c.anthropicKey, { model: c.model }, asset
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
    const shortWindowMedium = timeRemaining < 90 && analysis.confidence !== "HIGH";

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
    // Late-window exception: timeRemaining < 400s bounds stop-loss exposure to ≤6.5min, so
    // the coin-flip failure mode has less time to materialise. Relax edge floor 0.13 → 0.10.
    const btcCoinFlipEdgeFloor = timeRemaining < 400 ? 0.10 : 0.13;
    const btcCoinFlipBlocked = asset === "btc" &&
                               entryOdds >= 0.46 &&
                               entryOdds <= 0.54 &&
                               !(analysis.confidence === "HIGH" && (analysis.absEdge ?? 0) >= btcCoinFlipEdgeFloor);

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
                                     timeRemaining < 90 &&
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
    // Thresholds relaxed: HIGH 0.05%→0.03%→0.02%, MEDIUM/LOW 0.10%→0.07% — session log showed
    // HIGH conf signals at 0.023-0.029% gaps being blocked; momentumTradeBypass floor (0.02%)
    // still protects pure zero-gap plays.
    const midGapThreshold = analysis.confidence === "HIGH" ? 0.0002 : 0.0007;
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
    const _autoMomIsUp     = analysis.signal === "BUY_UP";
    const _autoMomPrice    = _autoMomIsUp ? (market?.upPrice ?? 0.5) : (market?.downPrice ?? 0.5);
    const autoMomentumTrade = analysis.signal !== "SKIP" &&
                              analysis.confidence === "HIGH" &&
                              stallGapPct > 0.0002 &&   // require real gap floor (>0.02%) — zero-gap pure-momentum plays fail
                              stallGapPct < 0.001 &&    // current gap < 0.10%
                              effectiveGapPct > 0.0015 && // effective gap > 0.15% of price
                              _autoMomPrice < 0.68;     // above 68%: only 32pp to gain vs 63pp+ to lose — bad risk/reward for thin-gap bets
    const momentumTradeBypass = (analysis.momentumTrade === true || autoMomentumTrade) &&
                                analysis.confidence === "HIGH" &&
                                analysis.signal !== "SKIP";

    // === Path quality signals — used by long-window flip filter (change 2) and path quality veto (change 3).
    // Computed independently from raw Binance data to verify the AI's signal has immediate backing.
    const _pqIsUp        = analysis.signal === "BUY_UP";
    const pqCandleAligned = candles.slice(0, 5).filter(c => _pqIsUp ? c.close > c.open : c.close < c.open).length;
    const pqMomThr        = asset === "btc" ? 18 : asset === "eth" ? 1.5 : 0.05;
    const pqStrongMom     = Math.abs(analysis.momentum ?? 0) >= pqMomThr;
    const pqStrongCandles = pqCandleAligned >= 4;
    let pqBookRatio = 1, pqBookWall = false;
    if (orderBook) {
      const bids = (orderBook.bids ?? []).slice(0, 10);
      const asks = (orderBook.asks ?? []).slice(0, 10);
      const bidQ = bids.reduce((s, b) => s + b.qty, 0);
      const askQ = asks.reduce((s, a) => s + a.qty, 0);
      pqBookRatio = _pqIsUp ? bidQ / Math.max(askQ, 0.001) : askQ / Math.max(bidQ, 0.001);
      const pqSide = _pqIsUp ? bids : asks;
      const pqAvg  = pqSide.reduce((s, b) => s + b.qty, 0) / Math.max(pqSide.length, 1);
      pqBookWall   = pqSide.some(b => b.qty > pqAvg * 3);
    }
    const pqStrongBook = pqBookRatio >= 3 || pqBookWall;
    const pqConfirmCnt = [pqStrongMom, pqStrongCandles, pqStrongBook].filter(Boolean).length;

    // Long-window gap-flip filter: if price is on the wrong side of target and ≥600s remain,
    // the trade must clear ALL four gates — otherwise it is a "drift story" with no near-term path.
    // Exemption: pure momentum repricing (momentumTradeBypass) where the token price move is the
    // thesis, not final resolution.
    const lwfDriftMult = asset === "btc" ? 1.8 : 2.0;
    const lwfDriftOk   = Math.abs(analysis.gap ?? 0) < 1 ||                    // near-zero gap — drift condition trivially satisfied
                         Math.abs(expectedDriftPts) >= Math.abs(analysis.gap ?? 0) * lwfDriftMult;
    const weakLongWindowGapFlip = signalAgainstGap &&
      timeRemaining >= 600 &&
      !(lwfDriftOk && pqStrongMom && pqCandleAligned >= 4 && pqStrongBook) &&
      !momentumTradeBypass;

    // Path quality veto: a gap-flip trade (betting against current price direction) needs at least
    // 2/3 immediate signals — if fewer, the thesis depends on hope or eventual drift, not real edge.
    // Non-flip (gap-aligned) trades are exempt: their near-term path is already in the right direction.
    const weakPathQualityFlip = signalAgainstGap && pqConfirmCnt < 2 && analysis.confidence !== "HIGH";

    // Early-discovery cap: above 57% the book has already moved and fills get bad.
    // Flash entry handles ≤52%; AI entry covers the 47-57% pre-discovery window.
    const postDiscovery = entryOdds > 0.57;

    const qualifies =
      analysis.signal !== "SKIP" &&
      oddsOk &&
      crossable &&
      !postDiscovery &&
      !longWindowLowConv &&
      !btcMidWindowLowOdds &&
      (!btcCoinFlipBlocked || momentumTradeBypass) &&
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
      !weakLongWindowGapFlip &&
      !weakPathQualityFlip &&
      (analysis.confidence === "HIGH" || analysis.absEdge >= minEdge) &&
      state.stats.spent < c.maxDaily;

    if (autoMomentumTrade && !analysis.momentumTrade) {
      logEntry("dim", `  ↳ <span class="amber">⚡MOM auto</span> — gap ${(stallGapPct * 100).toFixed(3)}% but effective gap ${(effectiveGapPct * 100).toFixed(3)}% (drift ${expectedDriftPts >= 0 ? "+" : ""}${expectedDriftPts.toFixed(2)}) — momentum trade bypass active`);
    }

    if (qualifies) {
      // Fresh-window gate: at 50/50 (pre-discovery) the book has symmetric depth so 10s is
      // enough to see real makers.  Old 30s wait pushed entry past discovery into volatile range.
      const windowAge = storedData?.firstSeenAt ? Date.now() - storedData.firstSeenAt : Infinity;
      if (windowAge < 10_000) {
        logEntry("dim", `  ↳ <span class="amber">fresh window</span> — ${Math.round(windowAge/1000)}s since open, holding 10s for book depth (next cycle will trade)`);
      } else {
        state[asset].gapWatch.delete(market.conditionId);
        placeCryptoTrade(asset, analysis, { spot, priceToBeat });
      }
    } else if (analysis.signal !== "SKIP") {
      const reasons = [];
      try {
      // Re-examined market whose gap grew but was blocked by a different filter — clean up watch.
      if (isGapWatched && !nearResSmallGap) state[asset].gapWatch.delete(market.conditionId);
      if (postDiscovery) reasons.push(`post-discovery — ${(entryOdds * 100).toFixed(1)}% > 57%, book already thin — wait for next window`);
      if (!oddsOk) {
        if (entryOdds > maxOdds)
          reasons.push(`entry odds ${(entryOdds * 100).toFixed(1)}% > max ${(maxOdds * 100).toFixed(0)}% (bad risk/reward)`);
        else
          reasons.push(`entry odds ${(entryOdds * 100).toFixed(1)}% < min ${(minOdds * 100).toFixed(0)}%`);
      }
      if (!crossable) reasons.push(`gap $${Math.abs(gap).toFixed(pd)} too large to cross in ${timeRemaining}s (max ≈${maxMovement.toFixed(pd)})`);
      if (longWindowLowConv) reasons.push(`long window (${timeRemaining}s) needs ≥${asset === "btc" ? "60" : "55"}% conviction odds — got ${(entryOdds * 100).toFixed(1)}%`);
      if (btcMidWindowLowOdds) reasons.push(`BTC mid-window low odds — ${(entryOdds * 100).toFixed(1)}% entry with ${timeRemaining}s left needs ≥55% or HIGH conf + ≥12% edge (crowd reversion signal)`);
      if (btcCoinFlipBlocked) reasons.push(`BTC coin-flip zone — ${(entryOdds * 100).toFixed(1)}% is near 50/50; need HIGH conf + ≥${(btcCoinFlipEdgeFloor*100).toFixed(0)}% edge to enter (AI overconfidence risk at these odds, session evidence)`);

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
      if (weakLongWindowGapFlip) {
        const why = [];
        if (!lwfDriftOk) why.push(`drift ${expectedDriftPts.toFixed(0)}pts < ${lwfDriftMult}× gap ${Math.abs(analysis.gap ?? 0).toFixed(0)}pts`);
        if (!pqStrongMom) why.push(`momentum ${Math.abs(analysis.momentum ?? 0).toFixed(2)}/m < ${pqMomThr}`);
        if (pqCandleAligned < 4) why.push(`${pqCandleAligned}/5 candles aligned`);
        if (!pqStrongBook) why.push(`book ${pqBookRatio.toFixed(2)}× (need 3×)`);
        reasons.push(`long-window flip blocked — ${timeRemaining}s, needs all 4: ${why.join(", ")} — no clean near-term path`);
      }
      if (weakPathQualityFlip) {
        const pqWhy = [];
        if (!pqStrongMom) pqWhy.push(`momentum ${Math.abs(analysis.momentum ?? 0).toFixed(2)}/m`);
        if (!pqStrongCandles) pqWhy.push(`${pqCandleAligned}/5 candles`);
        if (!pqStrongBook) pqWhy.push(`book ${pqBookRatio.toFixed(2)}×`);
        reasons.push(`gap flip needs stronger path — ${pqConfirmCnt}/3 signals (${pqWhy.join(", ")}) — need ≥2 for early TP`);
      }
      if (analysis.confidence === "LOW") reasons.push("confidence LOW");
      else if (analysis.confidence === "MEDIUM" && analysis.absEdge < minEdge)
        reasons.push(`edge ${(analysis.absEdge * 100).toFixed(1)}% < ${(minEdge * 100).toFixed(0)}% required for MEDIUM`);
      if (analysis.absEdge < minEdge)
        reasons.push(`edge ${(analysis.absEdge * 100).toFixed(1)}% < minEdge ${(minEdge * 100).toFixed(1)}%`);
      if (state.stats.spent >= c.maxDaily)
        reasons.push("daily budget exhausted");
      if (reasons.length === 0)
        reasons.push(`all filters ok but qualifies=false [oddsOk=${oddsOk} nearResSmallGap=${nearResSmallGap} midWindowSmallGap=${midWindowSmallGap} momentumBypass=${momentumTradeBypass} absEdge=${(analysis.absEdge??'?')} minEdge=${minEdge}]`);
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
  const rawAmount = Math.min(maxBet * timeFraction * oddsFraction * confidenceFraction, c.maxDaily - state.stats.spent);
  // Near-resolution size cap: prediction markets become illiquid in the final 120s and a stop
  // can fire on a single bad tick even with a large underlying gap intact.  Cap exposure at $25
  // to bound catastrophic stop losses that outweigh the edge (e.g. SOL -$33.53 at 156s).
  const nearResCap = secsForSizing <= 150 ? 5 : secsForSizing <= 300 ? 15 : Infinity;
  // Gap-flip size cap: gap-flip trades bet against the current price direction — the token crashes
  // hard to ~$0.03 when wrong, with no partial recovery.  Cap at $50 to limit worst-case losses
  // while still allowing meaningful upside on the higher-frequency correct-direction wins.
  // Session data: -$85.57 and -$85.32 on full-size gap-flip entries; winning gap-flips avg ~$40.
  const signalAgainstGapSizing = (analysis.signal === "BUY_UP"   && (analysis.gap ?? 0) < 0) ||
                                  (analysis.signal === "BUY_DOWN" && (analysis.gap ?? 0) > 0);
  const gapFlipCap = signalAgainstGapSizing ? 50 : Infinity;
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
    const handleBuyResult = (result, isRetry) => {
      if (result.error) {
        if (!isRetry) {
          // Aggressive retry: wider price cap + half size. Getting a small fill at a
          // worse price beats losing the signal entirely. At coin-flip odds the ask
          // book above entry+5pp is often too thin for full size.
          const retryCap    = Math.min(entryPrice + 0.06, 0.92);
          const retryAmount = amount / 2;
          const amountDiff  = amount - retryAmount;
          logEntry("dim", `  ↳ FOK miss — retrying $${retryAmount.toFixed(2)} at ${(retryCap * 100).toFixed(0)}¢ cap in 2s…`);

          // Stats were charged for full `amount` synchronously — refund the half
          // we're not risking on retry. If retry succeeds, trade.amount reflects
          // the reduced size. If it fails, the final rollback uses trade.amount.
          state.stats.spent = Math.max(0, state.stats.spent - amountDiff);
          setStat("spent",  `$${state.stats.spent.toFixed(2)}`);
          setStat("budget", `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);
          trade.amount = retryAmount;
          trade.shares = retryAmount / entryPrice;

          setTimeout(() => {
            const retryPayload = { ...orderPayload, entry_price: retryCap, amount_usdc: retryAmount };
            fetch("/trade", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(retryPayload),
            })
              .then(r => r.json())
              .then(r2 => handleBuyResult(r2, true))
              .catch(err => {
                // Retry network error — clean up with reduced trade.amount
                const idx = state.trades.indexOf(trade);
                if (idx !== -1) state.trades.splice(idx, 1);
                priceStream.unsubscribe(tokenId);
                state.stats.trades = Math.max(0, state.stats.trades - 1);
                state.stats.spent  = Math.max(0, state.stats.spent - trade.amount);
                setStat("trades",    String(state.stats.trades));
                setStat("spent",     `$${state.stats.spent.toFixed(2)}`);
                setStat("budget",    `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);
                setStat("positions", String(state.trades.length));
                logEntry("warn", `  [LIVE] BUY retry error: ${err.message}`);
              });
          }, 2000);
          return;
        }
        // Order failed (retry also failed) — remove from state, no card shown.
        // Rollback uses trade.amount which was reduced before the retry fired.
        const idx = state.trades.indexOf(trade);
        if (idx !== -1) state.trades.splice(idx, 1);
        priceStream.unsubscribe(tokenId);
        state.stats.trades = Math.max(0, state.stats.trades - 1);
        state.stats.spent  = Math.max(0, state.stats.spent - trade.amount);
        setStat("trades",    String(state.stats.trades));
        setStat("spent",     `$${state.stats.spent.toFixed(2)}`);
        setStat("budget",    `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);
        setStat("positions", String(state.trades.length));
        console.error(`[LIVE] Order FAILED after retry — no card created`, result);
        logEntry("warn", `  [LIVE] Order failed after retry: ${result.error}`);
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
          // Directional drift: BUY_UP filling >8pp below requested entry (or BUY_DOWN filling
          // >8pp above) means the market repriced against our signal during the 2s check→fill
          // delay. Session data: ETH BUY_UP at 56.5% filled at 43.7% → stop loss −$3.47; BTC
          // BUY_UP at 55.5% filled at 70% → stop loss −$0.88. Both would have exited at wash.
          const fill = parseFillPrice(result, "BUY");
          if (fill) {
            const catastrophic = fill < 0.25;
            const tooHigh      = fill > 0.78;
            const isUpSig      = trade.signal === "BUY_UP";
            const driftAgainst = isUpSig ? (entryPrice - fill) : (fill - entryPrice);
            const badDrift     = driftAgainst > 0.08;
            if (catastrophic || tooHigh || badDrift) {
              const reason = catastrophic
                ? `fill ${(fill*100).toFixed(1)}% — book collapse (< 25%)`
                : tooHigh
                  ? `fill ${(fill*100).toFixed(1)}% > 78% — slippage pushed entry above risk/reward threshold`
                  : `fill ${(fill*100).toFixed(1)}% vs requested ${(entryPrice*100).toFixed(1)}% — market repriced ${(driftAgainst*100).toFixed(1)}pp against ${trade.signal} during check→fill delay`;
              logEntry("warn", `  ↳ <span class="red">${reason} — slippage exit</span>`);
              closePosition(trade, "BAD FILL");
            }
          }
      }
    };
    fetch("/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(orderPayload),
    })
      .then(r => r.json())
      .then(result => handleBuyResult(result, false))
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
    const stopLossPct = (parseFloat($("#stop-loss-pct")?.value) || state.config?.stopLossPct || 25) / 100;
    for (const t of [...cryptoTrades]) {
      if (t.totalSecs < 45) continue;
      // Grace must match the main WS handler so the safety net doesn't fire prematurely.
      // The old formula (totalSecs * 40ms for <200s) gave only 3-8s grace, causing stops
      // to fire in 5-7s on short-window trades that later resolved correctly.
      // Gap-flip trades get 75s minimum grace — matches WS handler logic.
      const baseGrace = t.totalSecs < 90
        ? 25_000
        : t.totalSecs < 200
        ? Math.min(20_000, Math.max(15_000, t.totalSecs * 100))
        : t.totalSecs < 500
        ? 60_000
        : Math.min(60_000, Math.max(45_000, t.totalSecs * 60));
      const grace = t.signalAgainstGap ? Math.max(baseGrace, 75_000) : baseGrace;
      if (Date.now() - t.entryTime < grace) continue;
      // Same widened thresholds as the WS handler for thin-book noise protection.
      // Gap-flip trades use a wider 60% base stop — token oscillates before price crosses target.
      const baseStop = t.signalAgainstGap ? Math.max(stopLossPct, 0.60) : stopLossPct;
      const effectiveStop = t.totalSecs < 90  ? Math.max(baseStop, 0.40)
                          : t.totalSecs < 200 ? Math.max(baseStop, 0.32)
                          : baseStop;
      if (t.unrealizedPnl <= -t.amount * effectiveStop) { closePosition(t, "STOP LOSS"); refreshBtcCards(); updatePnlStat(); }
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
