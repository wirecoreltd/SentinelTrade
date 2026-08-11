// app/lib/journal.js
// Journal de trades + statistiques de performance. Stocké en localStorage,
// même logique que watchlist.js — aucun backend.

const JOURNAL_KEY = "st_trade_journal";

export function getTrades() {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(JOURNAL_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveTrades(trades) {
  localStorage.setItem(JOURNAL_KEY, JSON.stringify(trades));
}

export function addTrade(trade) {
  const trades = getTrades();
  const withId = {
    id: typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
    ...trade,
  };
  const updated = [...trades, withId];
  saveTrades(updated);
  return updated;
}

export function deleteTrade(id) {
  const updated = getTrades().filter((t) => t.id !== id);
  saveTrades(updated);
  return updated;
}

// --- Calculs par trade -------------------------------------------------

// Un trade clôturé a : entry, stop, exit, direction ("haussier"/"baissier"),
// quantity (optionnel — 1 par défaut, on raisonne alors surtout en R).
function tradePnL(t) {
  const sign = t.direction === "haussier" ? 1 : -1;
  const qty = t.quantity || 1;
  return sign * (t.exit - t.entry) * qty;
}

function tradeR(t) {
  const risk = Math.abs(t.entry - t.stop);
  if (!risk) return 0;
  const sign = t.direction === "haussier" ? 1 : -1;
  return (sign * (t.exit - t.entry)) / risk;
}

// --- Statistiques globales -----------------------------------------------

export function computeStats(trades) {
  const closed = trades.filter((t) => t.exit != null && t.exit !== "");
  if (closed.length === 0) return { count: 0 };

  const results = closed.map((t) => ({ ...t, pnl: tradePnL(t), r: tradeR(t) }));
  const wins = results.filter((t) => t.pnl > 0);
  const losses = results.filter((t) => t.pnl <= 0);

  const winRate = wins.length / results.length;
  const lossRate = losses.length / results.length;

  const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? Math.abs(losses.reduce((a, t) => a + t.pnl, 0) / losses.length) : 0;
  const avgWinR = wins.length ? wins.reduce((a, t) => a + t.r, 0) / wins.length : 0;
  const avgLossR = losses.length ? Math.abs(losses.reduce((a, t) => a + t.r, 0) / losses.length) : 0;

  const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((a, t) => a + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  const expectancy = winRate * avgWin - lossRate * avgLoss;
  const expectancyR = winRate * avgWinR - lossRate * avgLossR;

  // Courbe d'equity (cumulée, en devise) triée par date -> drawdown.
  const sorted = [...results].sort((a, b) => new Date(a.date) - new Date(b.date));
  let equity = 0, peak = 0, maxDrawdown = 0;
  const equityCurve = [];
  for (const t of sorted) {
    equity += t.pnl;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak - equity);
    equityCurve.push(equity);
  }
  const netProfit = equity;
  const maxDrawdownPct = peak > 0 ? (maxDrawdown / peak) * 100 : 0;
  const recoveryFactor = maxDrawdown > 0 ? netProfit / maxDrawdown : netProfit > 0 ? Infinity : 0;

  // Sharpe / Sortino sur les résultats en R (comparable entre actifs,
  // contrairement au PnL brut qui dépend de la taille de position).
  const returnsR = sorted.map((t) => t.r);
  const meanR = returnsR.reduce((a, r) => a + r, 0) / returnsR.length;
  const variance = returnsR.reduce((a, r) => a + (r - meanR) ** 2, 0) / returnsR.length;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? meanR / stdDev : null;

  const downside = returnsR.filter((r) => r < 0);
  const downsideVariance = downside.length ? downside.reduce((a, r) => a + r ** 2, 0) / downside.length : 0;
  const downsideDev = Math.sqrt(downsideVariance);
  const sortino = downsideDev > 0 ? meanR / downsideDev : null;

  // Calmar : rendement net en R / pire drawdown en R.
  let equityR = 0, peakR = 0, maxDrawdownR = 0;
  for (const r of returnsR) {
    equityR += r;
    peakR = Math.max(peakR, equityR);
    maxDrawdownR = Math.max(maxDrawdownR, peakR - equityR);
  }
  const calmar = maxDrawdownR > 0 ? equityR / maxDrawdownR : equityR > 0 ? Infinity : 0;

  return {
    count: results.length,
    winRate: winRate * 100,
    lossRate: lossRate * 100,
    avgWin,
    avgLoss,
    avgWinR,
    avgLossR,
    profitFactor,
    expectancy,
    expectancyR,
    netProfit,
    maxDrawdown,
    maxDrawdownPct,
    recoveryFactor,
    sharpe,
    sortino,
    calmar,
    equityCurve,
  };
}

// --- Monte Carlo -----------------------------------------------------------
// Rééchantillonne au hasard (avec remise) les résultats R déjà obtenus,
// `simulations` fois, pour estimer la robustesse du système de trading —
// ce n'est PAS une prédiction du marché, c'est une analyse de la
// distribution des issues possibles à partir de l'edge déjà mesuré.
export function monteCarloSimulation(trades, simulations = 1000, targetR = 20, drawdownLimitR = 10) {
  const closed = trades.filter((t) => t.exit != null && t.exit !== "");
  if (closed.length < 10) return { error: "insufficient_data", minTrades: 10, count: closed.length };

  const returnsR = closed.map((t) => tradeR(t));
  const n = returnsR.length;

  let reachedTarget = 0;
  let breachedDrawdown = 0;
  let worstDrawdown = 0;

  for (let s = 0; s < simulations; s++) {
    let equity = 0, peak = 0, maxDD = 0, hitTarget = false;
    for (let i = 0; i < n; i++) {
      const r = returnsR[Math.floor(Math.random() * n)];
      equity += r;
      peak = Math.max(peak, equity);
      maxDD = Math.max(maxDD, peak - equity);
      if (equity >= targetR) hitTarget = true;
    }
    if (hitTarget) reachedTarget++;
    if (maxDD >= drawdownLimitR) breachedDrawdown++;
    worstDrawdown = Math.max(worstDrawdown, maxDD);
  }

  return {
    simulations,
    probReachTarget: (reachedTarget / simulations) * 100,
    probBreachDrawdown: (breachedDrawdown / simulations) * 100,
    worstDrawdownR: worstDrawdown,
    targetR,
    drawdownLimitR,
  };
}
