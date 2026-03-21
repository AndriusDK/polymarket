/* ═══════════════════════════════════════════════════════════════════
   App Controller — wires setup, dashboard, bot cycle
   ═══════════════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────────

const state = {
  config: null,        // { anthropicKey, polyKey, ... }
  running: false,
  autoLoop: false,
  abortCtrl: null,
  stats: {
    fetched: 0, analyzed: 0, opps: 0, trades: 0,
    spent: 0, cycle: 0,
  },
  trades: [],          // open positions for session PnL
  sessionPnl: 0,
  realizedPnl: 0,
  btc: {
    timer:    null,    // setInterval handle for 30s BTC scan
    analyzed: new Set(), // conditionIds already sent to Claude this session
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
    const now = new Date();
    const el = $("#header-clock");
    if (el) el.textContent = now.toUTCString().slice(-12, -4) + " UTC";
  };
  tick();
  setInterval(tick, 1000);
}

// ── Setup screen ─────────────────────────────────────────────────

function initSetup() {
  // Dry run toggle label
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

  // Launch button
  $("#btn-launch").addEventListener("click", () => {
    const key = $("#anthropic-key").value.trim();
    // key is optional — heuristic mode runs without it
    $("#setup-error").textContent = "";

    state.config = {
      anthropicKey:    key,
      model:           ($("#claude-model") ? $("#claude-model").value : "claude-haiku-4-5-20251001"),
      polyPrivateKey:  $("#poly-private-key").value.trim(),
      polyApiKey:      $("#poly-api-key").value.trim(),
      polyApiSecret:   $("#poly-api-secret").value.trim(),
      polyPassphrase:  $("#poly-passphrase").value.trim(),
      maxBet:          parseFloat($("#max-bet").value) || 10,
      minEdge:         parseFloat($("#min-edge").value) || 0.05,
      maxDaily:        parseFloat($("#max-daily").value) || 100,
      marketsToScan:   parseInt($("#markets-count").value) || 20,
      dryRun:          $("#dry-run-toggle").checked,
      takeProfitPct:   parseFloat($("#take-profit-pct")?.value) || 50,
      // BTC 5-min mode
      btcMode:         $("#btc-mode-toggle")?.checked ?? false,
      btcMaxBet:       parseFloat($("#btc-max-bet")?.value) || 5,
      btcMinEdge:      parseFloat($("#btc-min-edge")?.value) || 0.06,
    };

    initDashboard();
    showScreen("dashboard-screen");
  });
}

// ── Dashboard ────────────────────────────────────────────────────

function initDashboard() {
  const c = state.config;

  // Header config summary
  $("#header-config").textContent =
    `EDGE ≥ ${(c.minEdge * 100).toFixed(0)}%  |  MAX $${c.maxBet}/trade`;

  const modeEl = $("#header-mode");
  if (c.dryRun) {
    modeEl.textContent = "◎ DRY RUN";
    modeEl.className = "header-mode dry";
  } else {
    modeEl.textContent = "⚡ LIVE";
    modeEl.className = "header-mode live";
  }

  // Budget
  setStat("budget", `$${c.maxDaily.toFixed(2)}`);

  // Toolbar
  $("#btn-run").addEventListener("click", () => {
    if (state.running) return;
    runCycle();
  });
  $("#btn-auto").addEventListener("click", () => {
    if (state.running) return;
    startAutoLoop();
  });
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
  logEntry("cyan", `POLYMARKET AI TRADING SYSTEM — ONLINE`);
  logEntry("info", `Mode: ${c.dryRun ? "DRY RUN" : "⚡ LIVE"}  |  Edge ≥ ${(c.minEdge*100).toFixed(0)}%  |  Max $${c.maxBet}/trade  |  Budget $${c.maxDaily}`);
  if (c.btcMode) {
    logEntry("info", `BTC 5-min mode: auto-starting…`);
    startBtcMode();
  } else {
    logEntry("info", `Press [RUN CYCLE] to scan, [AUTO 5min] to loop, or [⚡ BTC] for real-time BTC markets.`);
  }
}

// ── Bot cycle ────────────────────────────────────────────────────

async function runCycle() {
  const c = state.config;
  state.running = true;
  state.abortCtrl = new AbortController();
  setRunning(true);

  state.stats.cycle++;
  setStat("cycle", `#${state.stats.cycle}`);
  setStat("status", "SCANNING…", "cyan");

  logEntry("cyan", `══ CYCLE ${state.stats.cycle} ══`);
  logEntry("info", "Fetching active markets from Polymarket…");

  // 1. Fetch markets
  let markets;
  try {
    markets = await fetchMarkets({
      limit: c.marketsToScan,
      minVolume: 10000,
      minLiquidity: 1000,
    });
  } catch (err) {
    logEntry("error", `Failed to fetch markets: ${err.message}`);
    setStat("status", "ERROR", "red");
    setRunning(false);
    return;
  }

  state.stats.fetched = markets.length;
  setStat("fetched", String(markets.length));
  logEntry("info", `Found ${markets.length} active markets`);

  if (markets.length === 0) {
    logEntry("warning", "No markets returned. Check connectivity.");
    setStat("status", "IDLE", "dim");
    setRunning(false);
    return;
  }

  // 2. Analyze with Claude
  setStat("status", "ANALYZING…", "cyan");
  showProgress(true);

  clearTable();
  const analyses = [];

  for (let i = 0; i < markets.length; i++) {
    if (state.abortCtrl.signal.aborted) break;

    const market = markets[i];
    setProgress(i, markets.length, market.question);

    // Add placeholder row
    addTableRowPlaceholder(market, i);

    logEntry("info", `[${i+1}/${markets.length}] ${market.question.slice(0, 75)}…`);

    let analysis;
    try {
      analysis = await analyzeMarket(market, c.anthropicKey, {
        model: c.model,
        signal: state.abortCtrl.signal,
      });
    } catch (err) {
      logEntry("error", `  ✗ ${err.message}`);
      updateTableRow(i, null);
      continue;
    }

    analyses.push(analysis);
    state.stats.analyzed = analyses.length;
    setStat("analyzed", String(analyses.length));

    if (analysis.heuristic) {
      logEntry("warn", `  ⚠ Heuristic (no API): Market=${(market.yesPrice*100).toFixed(1)}% — no edge signal`);
    } else {
      const edgeClass = analysis.edge > 0 ? "green" : "red";
      logEntry("info",
        `  Claude: ${(analysis.yesProbability*100).toFixed(1)}%  ` +
        `Market: ${(market.yesPrice*100).toFixed(1)}%  ` +
        `Edge: <span class="${edgeClass}">${(analysis.edge > 0 ? "+" : "")}${(analysis.edge*100).toFixed(1)}%</span>  ` +
        `Conf: ${analysis.confidence}`
      );
    }

    updateTableRow(i, analysis);
  }

  showProgress(false);

  // Update PnL for existing positions using fresh prices
  updatePositionPrices(markets);

  // 3. Find opportunities
  const opportunities = analyses
    .filter(a =>
      !a.insufficientKnowledge &&
      a.signal !== null &&
      a.absEdge >= c.minEdge &&
      (a.confidence === "MEDIUM" || a.confidence === "HIGH")
    )
    .sort((a, b) => b.absEdge - a.absEdge);

  state.stats.opps = opportunities.length;
  setStat("opps", String(opportunities.length));

  if (opportunities.length === 0) {
    logEntry("warning", "No opportunities above edge threshold.");
    setStat("status", "IDLE", "dim");
    setRunning(false);
    return;
  }

  logEntry("cyan", `${opportunities.length} opportunity(ies) found!`);

  // 4. Simulate / execute trades
  setStat("status", "TRADING…", "magenta");
  let dailySpent = state.stats.spent;

  for (const a of opportunities) {
    if (state.abortCtrl.signal.aborted) break;
    if (dailySpent >= c.maxDaily) {
      logEntry("warning", "Daily budget exhausted.");
      break;
    }

    const amount = sizeBet(a, c.maxBet, c.maxDaily - dailySpent);
    if (amount < 1) continue;

    const tag = c.dryRun ? "[SIM]" : "[LIVE]";
    const sigClass = a.signal === "BUY_YES" ? "green" : "red";

    logEntry("trade",
      `${tag} <span class="${sigClass}">${a.signal}</span>  ` +
      `$${amount.toFixed(2)}  —  ${a.market.question.slice(0, 60)}`
    );
    logEntry("info",
      `  Edge: ${(a.edge > 0 ? "+" : "")}${(a.edge*100).toFixed(1)}%  ` +
      `Conf: ${a.confidence}`
    );
    logEntry("info", `  ${a.reasoning}`);

    // Record position for PnL tracking
    const entryPrice = a.signal === "BUY_YES" ? a.market.yesPrice : (1 - a.market.yesPrice);
    // tokenId is the specific token we're holding (for WS subscription)
    const tokenId = a.signal === "BUY_YES" ? a.market.yesTokenId : a.market.noTokenId;
    const trade = {
      id: Date.now() + state.stats.trades,
      time: new Date().toUTCString().slice(-12, -4),
      question: a.market.question,
      conditionId: a.market.conditionId,
      tokenId,
      signal: a.signal,
      entryPrice: entryPrice,
      amount: amount,
      shares: amount / entryPrice,
      currentPrice: entryPrice,
      edge: a.edge,
      confidence: a.confidence,
      unrealizedPnl: 0,
      mode: c.dryRun ? "SIM" : "LIVE",
    };
    state.trades.push(trade);
    addTradeRow(trade);
    priceStream.subscribe(tokenId); // subscribe to real-time WS feed

    dailySpent += amount;
    state.stats.trades++;
    state.stats.spent = dailySpent;
    setStat("trades", String(state.stats.trades));
    setStat("spent", `$${state.stats.spent.toFixed(2)}`);
    setStat("budget", `$${(c.maxDaily - dailySpent).toFixed(2)}`);
  }

  setStat("status", "IDLE", "dim");
  logEntry("cyan",
    `══ CYCLE COMPLETE — ${state.stats.trades} trade(s)  $${state.stats.spent.toFixed(2)} spent ══`
  );
  setRunning(false);
}

// ── Auto loop ────────────────────────────────────────────────────

async function startAutoLoop() {
  state.autoLoop = true;
  $("#btn-auto").classList.add("active");
  logEntry("cyan", "Auto-loop started — cycle every 5 minutes.");

  while (state.autoLoop) {
    await runCycle();
    if (!state.autoLoop) break;

    logEntry("info", "Sleeping 5 min until next cycle…");
    setStat("status", "WAITING…", "dim");

    // Sleep 300s, check abort every second
    for (let i = 0; i < 300; i++) {
      if (!state.autoLoop) break;
      await sleep(1000);
    }
  }

  $("#btn-auto").classList.remove("active");
  logEntry("warning", "Auto-loop stopped.");
}

function stopBot() {
  state.autoLoop = false;
  if (state.abortCtrl) state.abortCtrl.abort();
  stopBtcMode();
  setStat("status", "STOPPING…", "amber");
  logEntry("warning", "Stop requested.");
  setRunning(false);
}

// ── UI helpers ───────────────────────────────────────────────────

function setRunning(active) {
  state.running = active;
  $("#btn-run").disabled = active;
  $("#btn-auto").disabled = active && !state.autoLoop;
  $("#btn-stop").disabled = !active;
}

function setStat(key, value, color) {
  const el = $(`#stat-${key}`);
  if (!el) return;
  el.textContent = value;
  if (color) {
    el.className = `stat-val ${color}`;
  }
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
  $("#progress-wrap").classList.toggle("hidden", !visible);
}

function setProgress(current, total, label) {
  const pct = ((current + 1) / total * 100).toFixed(0);
  $("#progress-fill").style.width = pct + "%";
  $("#progress-text").textContent = `Analyzing ${current + 1}/${total}`;
}

// ── Table ────────────────────────────────────────────────────────

function clearTable() {
  $("#markets-tbody").innerHTML = "";
}

function addTableRowPlaceholder(market, idx) {
  const tr = document.createElement("tr");
  tr.id = `row-${idx}`;
  tr.innerHTML = `
    <td class="col-q">${escHtml(market.question.slice(0, 55))}${market.question.length > 55 ? '…' : ''}</td>
    <td>$${formatNum(market.volume)}</td>
    <td>${(market.yesPrice * 100).toFixed(1)}%</td>
    <td class="analyzing">…</td>
    <td class="analyzing">…</td>
    <td class="analyzing">…</td>
    <td class="analyzing">—</td>
  `;
  tr.style.cursor = "pointer";
  tr.addEventListener("click", () => toggleRowDetail(idx));
  $("#markets-tbody").appendChild(tr);
}

function updateTableRow(idx, analysis) {
  const tr = $(`#row-${idx}`);
  if (!tr) return;

  const cells = tr.querySelectorAll("td");
  if (!analysis) {
    cells[3].textContent = "ERR";
    cells[3].className = "red";
    cells[4].textContent = "—";
    cells[5].textContent = "—";
    cells[6].textContent = "—";
    cells[6].className = "signal-pass";
    return;
  }

  // Claude probability
  cells[3].textContent = (analysis.yesProbability * 100).toFixed(1) + "%";
  cells[3].className = "cyan";

  // Edge
  const edgeStr = (analysis.edge > 0 ? "+" : "") + (analysis.edge * 100).toFixed(1) + "%";
  cells[4].textContent = edgeStr;
  cells[4].className = analysis.edge > 0 ? "edge-pos" : "edge-neg";

  // Confidence
  cells[5].textContent = analysis.confidence;
  cells[5].className = `conf-${analysis.confidence.toLowerCase()}`;

  // Signal
  const sig = analysis.signal || "PASS";
  cells[6].textContent = sig;
  cells[6].className = sig === "BUY_YES" ? "signal-buy-yes"
                      : sig === "BUY_NO"  ? "signal-buy-no"
                      : "signal-pass";

  // Store reasoning for detail toggle
  tr.dataset.reasoning = analysis.reasoning || "";
  tr.dataset.edge = edgeStr;
  tr.dataset.conf = analysis.confidence;
  tr.dataset.claudeProb = (analysis.yesProbability * 100).toFixed(1) + "%";
}

function toggleRowDetail(idx) {
  const detailId = `detail-${idx}`;
  const existing = $(`#${detailId}`);
  if (existing) {
    existing.remove();
    return;
  }

  const tr = $(`#row-${idx}`);
  if (!tr || !tr.dataset.reasoning) return;

  const detailTr = document.createElement("tr");
  detailTr.id = detailId;
  const td = document.createElement("td");
  td.colSpan = 7;
  td.className = "row-detail";
  td.innerHTML = `
    <span class="reasoning-label">CLAUDE REASONING:</span> ${escHtml(tr.dataset.reasoning)}<br>
    <span class="reasoning-label">PROBABILITY:</span> ${tr.dataset.claudeProb}
    &nbsp;|&nbsp; <span class="reasoning-label">EDGE:</span> ${tr.dataset.edge}
    &nbsp;|&nbsp; <span class="reasoning-label">CONFIDENCE:</span> ${tr.dataset.conf}
  `;
  detailTr.appendChild(td);
  tr.after(detailTr);
}

// ── Tab switching ────────────────────────────────────────────────

function switchTab(tab) {
  const isLog = tab === "log";
  $("#log-content").classList.toggle("hidden", !isLog);
  $("#trades-content").classList.toggle("hidden", isLog);
  $("#tab-log").classList.toggle("active", isLog);
  $("#tab-trades").classList.toggle("active", !isLog);
}

// ── Trades table ─────────────────────────────────────────────────

function addTradeRow(trade) {
  // Remove "no trades" placeholder if present
  const empty = $("#trades-empty-row");
  if (empty) empty.remove();

  const tbody = $("#trades-tbody");
  const tr = document.createElement("tr");
  tr.id = `trade-${trade.id}`;
  tr.className = "trade-row";

  const modeClass = trade.mode === "SIM" ? "amber" : "live-mode";
  const sigClass  = trade.signal === "BUY_YES" ? "signal-buy-yes" : "signal-buy-no";
  const confClass = `conf-${trade.confidence.toLowerCase()}`;
  const pnlStr    = "+$0.00";

  tr.innerHTML = `
    <td class="${modeClass}">${trade.mode}</td>
    <td class="col-q-trade" title="${escHtml(trade.question)}">${escHtml(trade.question.slice(0, 45))}${trade.question.length > 45 ? "…" : ""}</td>
    <td class="${sigClass}">${trade.signal}</td>
    <td>$${trade.amount.toFixed(2)}</td>
    <td>${(trade.entryPrice * 100).toFixed(1)}%</td>
    <td id="tp-${trade.id}">${(trade.currentPrice * 100).toFixed(1)}%</td>
    <td id="pnl-${trade.id}" class="dim">${pnlStr}</td>
    <td class="${confClass}">${trade.confidence}</td>
  `;

  // Newest on top
  tbody.insertBefore(tr, tbody.firstChild);
}

function updatePositionPrices(markets) {
  if (state.trades.length === 0) return;

  const marketMap = {};
  for (const m of markets) {
    marketMap[m.conditionId] = m;
  }

  const tpMultiplier = parseFloat(state.config?.takeProfitPct ?? 50) / 100;
  const toClose = [];

  let totalPnl = 0;
  for (const t of state.trades) {
    const m = marketMap[t.conditionId];
    if (m) {
      t.currentPrice = t.signal === "BUY_YES" ? m.yesPrice : (1 - m.yesPrice);
      t.unrealizedPnl = t.shares * t.currentPrice - t.amount;
    }
    // Take-profit check
    if (t.unrealizedPnl >= t.amount * tpMultiplier) {
      toClose.push(t);
    } else {
      totalPnl += t.unrealizedPnl;
    }
  }

  // Close take-profit positions
  for (const t of toClose) {
    closePosition(t, "TAKE PROFIT");
  }

  state.sessionPnl = totalPnl + state.realizedPnl;
  refreshTradesTable();
  updatePnlStat();
}

function closePosition(trade, reason) {
  const idx = state.trades.indexOf(trade);
  if (idx === -1) return;
  state.trades.splice(idx, 1);

  // Unsubscribe from WS if no other position uses this token
  const stillNeeded = state.trades.some(t => t.tokenId === trade.tokenId);
  if (!stillNeeded) priceStream.unsubscribe(trade.tokenId);

  const realized = trade.unrealizedPnl;
  state.realizedPnl = (state.realizedPnl || 0) + realized;

  // Remove row from table
  const row = $(`#trade-${trade.id}`);
  if (row) row.remove();

  const sign = realized >= 0 ? "+" : "";
  logEntry("info",
    `  ✓ [${trade.mode}] CLOSE ${reason} — ${trade.question.slice(0, 60)}` +
    ` | Realized: <span class="${realized >= 0 ? "green" : "red"}">${sign}$${realized.toFixed(2)}</span>`
  );

  setStat("positions", String(state.trades.length));
  updatePnlStat();
}

// ── Live price ticker (30s refresh for open positions) ────────────

// ── Real-time price stream via Polymarket WebSocket ──────────────

const POLY_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

const priceStream = (() => {
  let ws = null;
  let pingTimer = null;
  let reconnectTimer = null;
  const subscribed = new Set(); // tokenIds currently subscribed

  function onMessage(evt) {
    // Server sends PONG or JSON array
    if (evt.data === "PONG") return;
    let msgs;
    try { msgs = JSON.parse(evt.data); } catch { return; }
    if (!Array.isArray(msgs)) msgs = [msgs];
    for (const msg of msgs) {
      if (msg.event_type === "best_bid_ask" || msg.type === "best_bid_ask") {
        const tokenId = msg.asset_id;
        const bid = parseFloat(msg.best_bid ?? msg.bid ?? 0);
        if (!tokenId || !bid) continue;
        // Update all trades holding this token
        let changed = false;
        for (const t of state.trades) {
          if (t.tokenId !== tokenId) continue;
          t.currentPrice = bid;
          t.unrealizedPnl = t.shares * bid - t.amount;
          changed = true;
        }
        if (changed) {
          // Take-profit check
          const toClose = state.trades.filter(
            t => t.tokenId === tokenId && t.unrealizedPnl >= t.amount * ((state.config?.takeProfitPct ?? 50) / 100)
          );
          for (const t of toClose) closePosition(t, "TAKE PROFIT");
          refreshTradesTable();
          updatePnlStat();
        }
      }
    }
  }

  function sendSub(tokenIds, operation = null) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const msg = {
      assets_ids: tokenIds,
      type: "market",
      custom_feature_enabled: true,
    };
    if (operation) msg.operation = operation;
    ws.send(JSON.stringify(msg));
  }

  function connect() {
    if (ws && ws.readyState <= WebSocket.OPEN) return;
    ws = new WebSocket(POLY_WS_URL);

    ws.onopen = () => {
      logEntry("info", "  ◈ Price stream connected (WebSocket)");
      // Re-subscribe to all tracked tokens
      if (subscribed.size) sendSub([...subscribed]);
      // Ping every 10s
      pingTimer = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) ws.send("PING");
      }, 10_000);
    };

    ws.onmessage = onMessage;

    ws.onclose = () => {
      clearInterval(pingTimer);
      pingTimer = null;
      if (subscribed.size > 0) {
        // Reconnect after 3s if we still have positions
        reconnectTimer = setTimeout(connect, 3_000);
      }
    };

    ws.onerror = () => ws.close();
  }

  function disconnect() {
    clearInterval(pingTimer);
    clearTimeout(reconnectTimer);
    pingTimer = null;
    reconnectTimer = null;
    subscribed.clear();
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  return {
    subscribe(tokenId) {
      if (subscribed.has(tokenId)) return;
      subscribed.add(tokenId);
      if (!ws || ws.readyState > WebSocket.OPEN) {
        connect(); // will subscribe all on open
      } else {
        sendSub([tokenId], "subscribe");
      }
    },
    unsubscribe(tokenId) {
      subscribed.delete(tokenId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ assets_ids: [tokenId], operation: "unsubscribe" }));
      }
      if (subscribed.size === 0) disconnect();
    },
    disconnect,
  };
})();

function refreshTradesTable() {
  for (const t of state.trades) {
    const tpEl  = $(`#tp-${t.id}`);
    const pnlEl = $(`#pnl-${t.id}`);
    if (tpEl)  tpEl.textContent  = (t.currentPrice * 100).toFixed(1) + "%";
    if (pnlEl) {
      const isPos = t.unrealizedPnl >= 0;
      pnlEl.textContent = (isPos ? "+" : "") + "$" + t.unrealizedPnl.toFixed(2);
      pnlEl.className   = isPos ? "green" : "red";
    }
  }
  const tsEl = $("#positions-updated");
  if (tsEl) {
    const t = new Date();
    tsEl.textContent = `live · ${t.getUTCHours().toString().padStart(2,"0")}:${t.getUTCMinutes().toString().padStart(2,"0")}:${t.getUTCSeconds().toString().padStart(2,"0")} UTC`;
  }
}

function updatePnlStat() {
  const unrealized = state.trades.reduce((s, t) => s + t.unrealizedPnl, 0);
  const realized   = state.realizedPnl || 0;
  const pnl        = unrealized + realized;
  state.sessionPnl = pnl;
  const pnlEl = $("#stat-pnl");
  if (pnlEl) {
    pnlEl.textContent = (pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(2);
    pnlEl.className = `stat-val ${pnl > 0 ? "green" : pnl < 0 ? "red" : "dim"}`;
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
  logEntry("cyan", "⚡ BTC MODE ON — scanning every 30s for high-volume 5-min markets");

  runBtcCycle(); // run immediately
  state.btc.timer = setInterval(runBtcCycle, 30_000);
}

function stopBtcMode() {
  if (!state.btc.timer) return;
  clearInterval(state.btc.timer);
  state.btc.timer = null;

  const btn = $("#btn-btc");
  if (btn) { btn.textContent = "⚡ BTC MODE"; btn.classList.remove("active"); }
  setStat("btc-status", "OFF", "dim");
  logEntry("warning", "BTC mode stopped.");
}

async function runBtcCycle() {
  const c = state.config;
  setStat("btc-status", "SCANNING…", "cyan");

  // 1. Find active BTC 5-min markets resolving in 0–10 min
  let markets, debug;
  try {
    ({ markets, debug } = await fetchBtcMarkets({ minVolume: 1000, minMinutes: 0, maxMinutes: 10 }));
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

  // Only process markets we haven't analyzed yet
  const fresh = markets.filter(m => !state.btc.analyzed.has(m.conditionId));
  if (!fresh.length) {
    setStat("btc-status", "WATCHING", "dim");
    return;
  }

  // 2. Fetch BTC market data once (shared across all markets this cycle)
  let spot, candles;
  try {
    [spot, candles] = await Promise.all([fetchBtcSpot(), fetchBtcCandles(6)]);
  } catch (err) {
    logEntry("error", `BTC: Binance data failed — ${err.message}`);
    setStat("btc-status", "ERROR", "red");
    return;
  }

  // 3. Analyze each fresh market
  for (const market of fresh) {
    // Mark analyzed immediately to avoid re-queuing in the next 30s tick
    state.btc.analyzed.add(market.conditionId);

    // Get price to beat = BTC open at market start
    let priceToBeat = null;
    if (market.startDate) {
      try {
        priceToBeat = await fetchBtcOpenAtTime(new Date(market.startDate).getTime());
      } catch { /* fall through */ }
    }
    // Fallback: oldest candle's open
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
        market,
        { spot, candles, priceToBeat },
        c.anthropicKey,
        { model: c.model }
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

    // Increment BTC signals stat
    const sigEl = $("#stat-btc-signals");
    if (sigEl) sigEl.textContent = String(parseInt(sigEl.textContent || "0") + 1);

    // Place trade if qualifies
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

  const entryPrice = isUp ? market.upPrice : market.downPrice;
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

  const trade = {
    id:          Date.now() + state.stats.trades,
    time:        new Date().toUTCString().slice(-12, -4),
    question:    market.question,
    conditionId: market.conditionId,
    tokenId,
    signal:      analysis.signal,
    entryPrice,
    amount,
    shares:      amount / entryPrice,
    currentPrice: entryPrice,
    confidence:  analysis.confidence,
    unrealizedPnl: 0,
    mode:        c.dryRun ? "SIM" : "LIVE",
    type:        "btc",
    endDate:     market.endDate,
  };

  state.trades.push(trade);
  addBtcTradeRow(trade);
  priceStream.subscribe(tokenId);
  startBtcCountdown();

  state.stats.trades++;
  state.stats.spent += amount;
  setStat("trades", String(state.stats.trades));
  setStat("spent",  `$${state.stats.spent.toFixed(2)}`);
  setStat("budget", `$${(c.maxDaily - state.stats.spent).toFixed(2)}`);

  const btcTradesEl = $("#stat-btc-trades");
  if (btcTradesEl) btcTradesEl.textContent = String(parseInt(btcTradesEl.textContent || "0") + 1);
}

function addBtcTradeRow(trade) {
  const empty = $("#trades-empty-row");
  if (empty) empty.remove();

  const tbody  = $("#trades-tbody");
  const tr     = document.createElement("tr");
  tr.id        = `trade-${trade.id}`;
  tr.className = "trade-row btc-trade-row";

  const modeClass = trade.mode === "SIM" ? "amber" : "live-mode";
  const sigClass  = trade.signal === "BUY_UP" ? "signal-buy-yes" : "signal-buy-no";
  const sigLabel  = trade.signal === "BUY_UP" ? "BTC UP" : "BTC DOWN";
  const secsLeft  = Math.max(0, Math.round((new Date(trade.endDate) - Date.now()) / 1000));

  tr.innerHTML = `
    <td class="${modeClass}">${trade.mode}</td>
    <td class="col-q-trade" title="${escHtml(trade.question)}">
      ⚡ ${escHtml(trade.question.slice(0, 36))}…
      <span class="btc-countdown" id="cd-${trade.id}">[${secsLeft}s]</span>
    </td>
    <td class="${sigClass}">${sigLabel}</td>
    <td>$${trade.amount.toFixed(2)}</td>
    <td>${(trade.entryPrice * 100).toFixed(1)}%</td>
    <td id="tp-${trade.id}">${(trade.currentPrice * 100).toFixed(1)}%</td>
    <td id="pnl-${trade.id}" class="dim">+$0.00</td>
    <td class="conf-${trade.confidence.toLowerCase()}">${trade.confidence}</td>
  `;

  tbody.insertBefore(tr, tbody.firstChild);
}

// Countdown timer for BTC trades (updates every second)
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
      const el = $(`#cd-${t.id}`);
      if (!el) continue;
      const secs = Math.round((new Date(t.endDate) - Date.now()) / 1000);
      if (secs <= 0) {
        el.textContent = "[RESOLVED]";
        el.style.color = "#00ffe7";
      } else {
        el.textContent = `[${secs}s]`;
        el.style.color = secs < 30 ? "#ff4444" : "#ffb347";
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
  if (n >= 1_000) return (n / 1_000).toFixed(0) + "K";
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
    status.className = "gen-keys-status error";
    status.textContent = "⚠  Enter your wallet private key first.";
    return;
  }

  btn.disabled = true;
  status.className = "gen-keys-status loading";
  status.textContent = "⟳  Connecting to Polymarket CLOB API…";

  try {
    const wallet    = new ethers.Wallet(privateKey);
    const address   = wallet.address;
    const timestamp = String(Math.floor(Date.now() / 1000));
    const nonce     = 0;

    // EIP-712 typed data — matches py-clob-client L1 auth
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
      address,
      timestamp,
      nonce,
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
    if (!data.apiKey || !data.secret || !data.passphrase) {
      throw new Error("Unexpected response: " + JSON.stringify(data).slice(0, 120));
    }

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
