/* ═══════════════════════════════════════════════════════════════════
   App Controller — wires setup, dashboard, bot cycle
   ═══════════════════════════════════════════════════════════════════ */

// ── State ────────────────────────────────────────────────────────

const state = {
  config: null,        // { anthropicKey, polyKey, ... }
  running: false,
  autoLoop: false,
  abortCtrl: null,
  priceTicker: null,   // setInterval handle for live PnL refresh
  stats: {
    fetched: 0, analyzed: 0, opps: 0, trades: 0,
    spent: 0, cycle: 0,
  },
  trades: [],          // open positions for session PnL
  sessionPnl: 0,
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

  startClock();
  logEntry("cyan", `POLYMARKET AI TRADING SYSTEM — ONLINE`);
  logEntry("info", `Mode: ${c.dryRun ? "DRY RUN" : "⚡ LIVE"}  |  Edge ≥ ${(c.minEdge*100).toFixed(0)}%  |  Max $${c.maxBet}/trade  |  Budget $${c.maxDaily}`);
  logEntry("info", `Press [RUN CYCLE] to scan or [AUTO 5min] to loop.`);
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
    const trade = {
      id: Date.now() + state.stats.trades,
      time: new Date().toUTCString().slice(-12, -4),
      question: a.market.question,
      conditionId: a.market.conditionId,
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
    startPriceTicker(); // begin live PnL refresh if not already running

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

  let totalPnl = 0;
  for (const t of state.trades) {
    const m = marketMap[t.conditionId];
    if (m) {
      t.currentPrice = t.signal === "BUY_YES" ? m.yesPrice : (1 - m.yesPrice);
      t.unrealizedPnl = t.shares * t.currentPrice - t.amount;
    }
    totalPnl += t.unrealizedPnl;
  }

  state.sessionPnl = totalPnl;
  refreshTradesTable();
  updatePnlStat();
}

// ── Live price ticker (30s refresh for open positions) ────────────

function startPriceTicker() {
  if (state.priceTicker) return; // already running
  state.priceTicker = setInterval(async () => {
    if (state.trades.length === 0) return;
    try {
      const ids = [...new Set(state.trades.map(t => t.conditionId))];
      const markets = await fetchMarketPrices(ids);
      if (markets.length) updatePositionPrices(markets);
    } catch {
      // silent — ticker will retry next interval
    }
  }, 30_000);
}

function stopPriceTicker() {
  if (state.priceTicker) {
    clearInterval(state.priceTicker);
    state.priceTicker = null;
  }
}

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
  // Show last refresh time
  const tsEl = $("#positions-updated");
  if (tsEl) {
    const t = new Date();
    tsEl.textContent = `prices updated ${t.getUTCHours().toString().padStart(2,"0")}:${t.getUTCMinutes().toString().padStart(2,"0")}:${t.getUTCSeconds().toString().padStart(2,"0")} UTC`;
  }
}

function updatePnlStat() {
  const pnl = state.sessionPnl;
  const pnlEl = $("#stat-pnl");
  if (pnlEl) {
    pnlEl.textContent = (pnl >= 0 ? "+" : "") + "$" + pnl.toFixed(2);
    pnlEl.className = `stat-val ${pnl > 0 ? "green" : pnl < 0 ? "red" : "dim"}`;
  }
  setStat("positions", String(state.trades.length));
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
