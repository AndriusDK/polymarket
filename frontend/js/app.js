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
    if (!key) {
      $("#setup-error").textContent = "⚠  Anthropic API key is required.";
      return;
    }
    $("#setup-error").textContent = "";

    state.config = {
      anthropicKey:    key,
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

    const edgeClass = analysis.edge > 0 ? "green" : "red";
    logEntry("info",
      `  Claude: ${(analysis.yesProbability*100).toFixed(1)}%  ` +
      `Market: ${(market.yesPrice*100).toFixed(1)}%  ` +
      `Edge: <span class="${edgeClass}">${(analysis.edge > 0 ? "+" : "")}${(analysis.edge*100).toFixed(1)}%</span>  ` +
      `Conf: ${analysis.confidence}`
    );

    updateTableRow(i, analysis);
  }

  showProgress(false);

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

    const tag = c.dryRun ? "[DRY]" : "[LIVE]";
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

// ── Boot ─────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  initSetup();
});
