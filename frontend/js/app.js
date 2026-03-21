/* ═══════════════════════════════════════════════════════════════════
   App Controller — BTC 5-min trading
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
  btc: {
    timer:    null,    // setInterval handle for 30s scan
    analyzed: new Set(),
  },
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

// ── Setup screen ─────────────────────────────────────────────────

function initSetup() {
  $("#dry-run-toggle").addEventListener("change", (e) => {
    const label = $("#dry-run-label");
    if (e.target.checked) {
      label.textContent = "ON";
      label.className = "toggle-status amber";
    } else {
      label.textContent = "OFF — LIVE";
      label.className = "toggle-status red";
    }
  });

  $("#btn-launch").addEventListener("click", () => {
    $("#setup-error").textContent = "";

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
      takeProfitPct: parseFloat($("#take-profit-pct")?.value) || 50,
      btcMode:       $("#btc-mode-toggle")?.checked ?? false,
      btcMaxBet:     parseFloat($("#btc-max-bet")?.value) || 5,
      btcMinEdge:    parseFloat($("#btc-min-edge")?.value) || 0.06,
    };

    initDashboard();
    showScreen("dashboard-screen");
  });
}

// ── Dashboard ────────────────────────────────────────────────────

function initDashboard() {
  const c = state.config;

  $("#header-config").textContent = `BTC MODE  |  MAX $${c.btcMaxBet}/trade`;

  const modeEl = $("#header-mode");
  modeEl.textContent = c.dryRun ? "◎ DRY RUN" : "⚡ LIVE";
  modeEl.className = "header-mode " + (c.dryRun ? "dry" : "live");

  setStat("budget", `$${c.maxDaily.toFixed(2)}`);

  $("#btn-stop").addEventListener("click", stopBot);
  $("#btn-settings").addEventListener("click", () => {
    stopBot();
    showScreen("setup-screen");
  });
  $("#btn-btc")?.addEventListener("click", () => {
    if (state.btc.timer) stopBtcMode();
    else startBtcMode();
  });

  startClock();
  logEntry("cyan", "POLYMARKET AI TRADING SYSTEM — ONLINE");
  logEntry("info",
    `Mode: ${c.dryRun ? "DRY RUN" : "⚡ LIVE"}  |  BTC 5-min  |  ` +
    `Max $${c.btcMaxBet}/trade  |  Budget $${c.maxDaily}`
  );

  if (c.btcMode) {
    logEntry("info", "BTC 5-min mode: auto-starting…");
    startBtcMode();
  } else {
    logEntry("info", "Press [⚡ BTC MODE] to start scanning for Bitcoin 5-min markets.");
  }
}

// ── Stop ─────────────────────────────────────────────────────────

function stopBot() {
  if (state.abortCtrl) state.abortCtrl.abort();
  stopBtcMode();
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

// ── BTC Position Cards ────────────────────────────────────────────

function addBtcCard(trade) {
  const emptyEl = $("#btc-empty");
  if (emptyEl) emptyEl.style.display = "none";

  const cards   = $("#btc-cards");
  const div     = document.createElement("div");
  div.id        = `card-${trade.id}`;
  div.className = "btc-card";

  const isUp      = trade.signal === "BUY_UP";
  const sigLabel  = isUp ? "▲ BTC UP" : "▼ BTC DOWN";
  const sigClass  = isUp ? "sig-up" : "sig-down";
  const modeClass = trade.mode === "SIM" ? "amber" : "red";
  const confClass = `conf-${trade.confidence.toLowerCase()}`;
  const secsLeft  = Math.max(0, Math.round((new Date(trade.endDate) - Date.now()) / 1000));
  const pct       = Math.min(100, Math.max(0, (secsLeft / trade.totalSecs) * 100));
  const gap       = trade.gap ?? 0;
  const gapSign   = gap >= 0 ? "+" : "";
  const gapClass  = gap >= 0 ? "green" : "red";

  div.innerHTML = `
    <div class="btc-card-head">
      <span class="btc-card-q">${escHtml(trade.question)}</span>
      <div class="btc-card-badges">
        <span class="btc-badge ${modeClass}">${trade.mode}</span>
        <span class="btc-card-cd ${secsLeft < 60 ? "urgent" : ""}" id="cd-${trade.id}">[${secsLeft}s]</span>
      </div>
    </div>
    <div class="btc-timer-bar">
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
      BTC $${(trade.spot ?? 0).toFixed(0)}&nbsp; vs &nbsp;target $${(trade.priceToBeat ?? 0).toFixed(0)}
      &nbsp;|&nbsp; Gap: <span class="${gapClass}">${gapSign}$${Math.abs(gap).toFixed(0)}</span>
    </div>
  `;

  cards.insertBefore(div, cards.firstChild);
}

function refreshBtcCards() {
  for (const t of state.trades) {
    const tpEl  = $(`#tp-${t.id}`);
    const pnlEl = $(`#pnl-${t.id}`);
    if (tpEl)  tpEl.textContent = (t.currentPrice * 100).toFixed(1) + "%";
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
          changed = true;
        }
        if (changed) {
          const toClose = state.trades.filter(
            t => t.tokenId === tokenId &&
                 t.unrealizedPnl >= t.amount * ((state.config?.takeProfitPct ?? 50) / 100)
          );
          for (const t of toClose) closePosition(t, "TAKE PROFIT");
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
  if (card) card.remove();

  if (state.trades.length === 0) {
    const empty = $("#btc-empty");
    if (empty) empty.style.display = "";
  }

  const sign = realized >= 0 ? "+" : "";
  logEntry("info",
    `  ✓ [${trade.mode}] CLOSE ${reason} — ${trade.question.slice(0, 60)} ` +
    `| Realized: <span class="${realized >= 0 ? "green" : "red"}">${sign}$${realized.toFixed(2)}</span>`
  );

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

// ── BTC 5-min mode ───────────────────────────────────────────────

function startBtcMode() {
  if (state.btc.timer) return;
  state.btc.analyzed.clear();

  const btn = $("#btn-btc");
  if (btn) { btn.textContent = "■ BTC STOP"; btn.classList.add("active"); }
  setStat("btc-status", "ACTIVE", "amber");
  setRunning(true);
  logEntry("cyan", "⚡ BTC MODE ON — scanning every 30s for high-volume 5-min markets");

  runBtcCycle();
  state.btc.timer = setInterval(runBtcCycle, 30_000);
}

function stopBtcMode() {
  if (!state.btc.timer) return;
  clearInterval(state.btc.timer);
  state.btc.timer = null;

  const btn = $("#btn-btc");
  if (btn) { btn.textContent = "⚡ BTC MODE"; btn.classList.remove("active"); }
  setStat("btc-status", "OFF", "dim");
  setRunning(false);
  logEntry("warning", "BTC mode stopped.");
}

async function runBtcCycle() {
  const c = state.config;
  setStat("btc-status", "SCANNING…", "cyan");

  let markets, debug;
  try {
    ({ markets, debug } = await fetchBtcMarkets({ maxMinutes: 10 }));
  } catch (err) {
    logEntry("error", `BTC: market fetch failed — ${err.message}`);
    setStat("btc-status", "ERROR", "red");
    return;
  }

  logEntry("info",
    `BTC scan: ${debug.total} total markets → ${debug.btc} BTC → ` +
    `${debug.inWindow} in window → ${debug.parsed} valid ` +
    `(${markets.filter(m => !state.btc.analyzed.has(m.conditionId)).length} fresh)`
  );

  const fresh = markets.filter(m => !state.btc.analyzed.has(m.conditionId));
  if (!fresh.length) {
    setStat("btc-status", "WATCHING", "dim");
    return;
  }

  let spot, candles;
  try {
    [spot, candles] = await Promise.all([fetchBtcSpot(), fetchBtcCandles(6)]);
  } catch (err) {
    logEntry("error", `BTC: Binance data failed — ${err.message}`);
    setStat("btc-status", "ERROR", "red");
    return;
  }

  for (const market of fresh) {
    state.btc.analyzed.add(market.conditionId);

    let priceToBeat = null;
    if (market.startDate) {
      try {
        priceToBeat = await fetchBtcOpenAtTime(new Date(market.startDate).getTime());
      } catch { /* fall through */ }
    }
    if (!priceToBeat) priceToBeat = candles[candles.length - 1]?.open ?? spot;

    const timeRemaining = Math.round((new Date(market.endDate) - Date.now()) / 1000);
    const gap = spot - priceToBeat;

    logEntry("info",
      `BTC: <span class="cyan">${market.question.slice(0, 55)}</span>  ` +
      `[${timeRemaining}s left]  BTC $${spot.toFixed(0)} vs target $${priceToBeat.toFixed(0)}  ` +
      `<span class="${gap >= 0 ? "green" : "red"}">${gap >= 0 ? "+" : ""}$${gap.toFixed(0)}</span>`
    );

    let analysis;
    try {
      analysis = await analyzeBtcMarket(
        market, { spot, candles, priceToBeat }, c.anthropicKey, { model: c.model }
      );
    } catch (err) {
      logEntry("error", `  BTC analysis failed: ${err.message}`);
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

    const sigEl = $("#stat-btc-signals");
    if (sigEl) sigEl.textContent = String(parseInt(sigEl.textContent || "0") + 1);

    const qualifies =
      analysis.signal !== "SKIP" &&
      (analysis.confidence === "HIGH" ||
       (analysis.confidence === "MEDIUM" && analysis.absEdge >= 0.10)) &&
      analysis.absEdge >= c.btcMinEdge &&
      state.stats.spent < c.maxDaily;

    if (qualifies) placeBtcTrade(analysis, { spot, priceToBeat });
  }

  setStat("btc-status", "WATCHING", "dim");
}

function placeBtcTrade(analysis, { spot, priceToBeat }) {
  const c      = state.config;
  const market = analysis.market;
  const isUp   = analysis.signal === "BUY_UP";

  const entryPrice = isUp ? market.upPrice   : market.downPrice;
  const tokenId    = isUp ? market.upTokenId : market.downTokenId;
  const amount     = Math.min(c.btcMaxBet, c.maxDaily - state.stats.spent);
  if (amount < 1) return;

  const tag      = c.dryRun ? "[SIM]" : "[LIVE]";
  const sigClass = isUp ? "green" : "red";

  logEntry("trade",
    `${tag} BTC <span class="${sigClass}">${analysis.signal}</span>  ` +
    `$${amount.toFixed(2)}  —  ${market.question.slice(0, 50)}`
  );
  logEntry("info",
    `  Entry: ${(entryPrice * 100).toFixed(1)}%  ` +
    `BTC $${spot.toFixed(0)} vs target $${priceToBeat.toFixed(0)}  ` +
    `Gap: ${analysis.gap >= 0 ? "+" : ""}$${analysis.gap.toFixed(2)}`
  );

  const secsLeft = Math.max(1, Math.round((new Date(market.endDate) - Date.now()) / 1000));

  const trade = {
    id:           Date.now() + state.stats.trades,
    time:         new Date().toUTCString().slice(-12, -4),
    question:     market.question,
    conditionId:  market.conditionId,
    tokenId,
    signal:       analysis.signal,
    entryPrice,
    amount,
    shares:       amount / entryPrice,
    currentPrice: entryPrice,
    confidence:   analysis.confidence,
    unrealizedPnl: 0,
    mode:         c.dryRun ? "SIM" : "LIVE",
    type:         "btc",
    endDate:      market.endDate,
    spot,
    priceToBeat,
    gap:          analysis.gap,
    totalSecs:    secsLeft,
  };

  state.trades.push(trade);
  addBtcCard(trade);
  priceStream.subscribe(tokenId);
  startBtcCountdown();

  state.stats.trades++;
  state.stats.spent += amount;
  setStat("trades",     String(state.stats.trades));
  setStat("spent",      `$${state.stats.spent.toFixed(2)}`);
  setStat("budget",     `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);

  const btcTradesEl = $("#stat-btc-trades");
  if (btcTradesEl) btcTradesEl.textContent =
    String(parseInt(btcTradesEl.textContent || "0") + 1);
}

// ── Countdown timer ───────────────────────────────────────────────

let btcCountdownTimer = null;

function startBtcCountdown() {
  if (btcCountdownTimer) return;
  btcCountdownTimer = setInterval(() => {
    const btcTrades = state.trades.filter(t => t.type === "btc");
    if (!btcTrades.length) {
      clearInterval(btcCountdownTimer);
      btcCountdownTimer = null;
      return;
    }
    for (const t of btcTrades) {
      const cdEl  = $(`#cd-${t.id}`);
      const barEl = $(`#cdbar-${t.id}`);
      if (!cdEl) continue;
      const secs   = Math.round((new Date(t.endDate) - Date.now()) / 1000);
      const urgent = secs < 60;
      if (secs <= 0) {
        cdEl.textContent = "[RESOLVED]";
        cdEl.className   = "btc-card-cd resolved";
        if (barEl) { barEl.style.width = "0%"; barEl.className = "btc-timer-fill urgent"; }
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
