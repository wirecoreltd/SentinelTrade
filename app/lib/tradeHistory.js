"use client";

// ============================================================================
// Historique des trades "pris" (marqués manuellement depuis le Calculateur)
// + garde-fous de discipline (surexposition sur un même actif, limite de
// risque cumulé par jour, limite du nombre de trades par jour)
// + suivi de performance réel (P&L calculé à partir d'un prix de sortie
// saisi, pas d'une déclaration "gagné/perdu" manuelle).
//
// Stockage : localStorage, donc propre à cet appareil/navigateur. Pas de
// backend — si tu utilises l'appli sur plusieurs appareils, l'historique
// ne sera pas partagé entre eux.
// ============================================================================

const HISTORY_KEY = "trading-app:trade-history:v1";
const SETTINGS_KEY = "trading-app:risk-settings:v1";

export const DEFAULT_SETTINGS = {
  dailyRiskLimit: 100, // € — perte cumulée max acceptée sur les trades encore ouverts pris aujourd'hui
  maxTradesPerDay: 5, // nombre max de trades pris dans la journée, tous actifs confondus
  maxTradesPerAsset: 2, // nombre max de trades pris sur le même actif + même sens dans la journée
  dailyBudget: 50,
};

function isBrowser() {
  return typeof window !== "undefined";
}

function isFiniteNum(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function safeParse(json, fallback) {
  try {
    const v = JSON.parse(json);
    return v ?? fallback;
  } catch {
    return fallback;
  }
}

export function toLocalDateKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------- Lecture / écriture brute ----------

export function loadHistory() {
  if (!isBrowser()) return [];
  return safeParse(window.localStorage.getItem(HISTORY_KEY), []);
}

function saveHistory(list) {
  if (!isBrowser()) return;
  window.localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
}

export function loadSettings() {
  if (!isBrowser()) return DEFAULT_SETTINGS;
  return { ...DEFAULT_SETTINGS, ...safeParse(window.localStorage.getItem(SETTINGS_KEY), {}) };
}

export function saveSettings(settings) {
  if (!isBrowser()) return;
  window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

// ---------- Ajout / mise à jour d'un trade ----------

// `trade` attendu : { symbol, assetType, direction ("long"|"short"),
// entry, stop, takeProfit, invested, leverage, quantity, positionValue,
// riskAmount, potentialGain, riskPct, verdict }
export function addTrade(trade) {
  const list = loadHistory();
  const now = new Date();
  const entry = {
    id: `${now.getTime()}-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: now.toISOString(),
    dateKey: toLocalDateKey(now),
    status: "ouvert", // "ouvert" | "gagné" | "perdu" | "clôturé"
    closedAt: null,
    exitPrice: null,
    realizedPnL: null,
    realizedPnLPct: null,
    ...trade,
  };
  saveHistory([entry, ...list]);
  return entry;
}

// Clôture un trade. Si `exitPrice` est fourni et que le trade a une
// quantité/entrée valides, le P&L réel est calculé à partir du prix de
// sortie (pas déclaré à la main) : on ne fait plus confiance à un simple
// bouton "Gagné"/"Perdu" pour mesurer la performance.
// `status` reste explicite ("gagné" | "perdu" | "clôturé") pour couvrir le
// cas d'une clôture sans résultat chiffré (ex: annulation, jamais entré).
export function updateTradeStatus(id, status, { exitPrice = null } = {}) {
  const next = loadHistory().map((t) => {
    if (t.id !== id) return t;

    let realizedPnL = t.realizedPnL;
    let realizedPnLPct = t.realizedPnLPct;

    if (exitPrice != null && isFiniteNum(exitPrice) && isFiniteNum(t.entry) && isFiniteNum(t.quantity)) {
      const isLong = t.direction !== "short";
      realizedPnL = isLong
        ? t.quantity * (exitPrice - t.entry)
        : t.quantity * (t.entry - exitPrice);
      realizedPnLPct = isFiniteNum(t.invested) && t.invested > 0 ? (realizedPnL / t.invested) * 100 : null;
    }

    return {
      ...t,
      status,
      closedAt: new Date().toISOString(),
      exitPrice: exitPrice != null ? exitPrice : t.exitPrice ?? null,
      realizedPnL,
      realizedPnLPct,
    };
  });
  saveHistory(next);
  return next;
}

export function deleteTrade(id) {
  const next = loadHistory().filter((t) => t.id !== id);
  saveHistory(next);
  return next;
}

// ---------- Lecture / stats de discipline (existant) ----------

export function getTodayTrades(history, dateKey = toLocalDateKey()) {
  return history.filter((t) => t.dateKey === dateKey);
}

export function getOpenTrades(history) {
  return history.filter((t) => t.status === "ouvert");
}

// Risque total (somme des pertes potentielles si stop touché) des trades
// encore ouverts pris aujourd'hui.
export function todayOpenRisk(history, dateKey = toLocalDateKey()) {
  return getTodayTrades(history, dateKey)
    .filter((t) => t.status === "ouvert")
    .reduce((sum, t) => sum + (t.riskAmount || 0), 0);
}

// Somme des mises (invested) de tous les trades pris aujourd'hui, ouverts
// ou déjà clôturés — le budget du jour se consomme dès la prise du trade,
// pas seulement tant qu'il reste ouvert.
export function todayInvested(history, dateKey = toLocalDateKey()) {
  return getTodayTrades(history, dateKey).reduce((sum, t) => sum + (t.invested || 0), 0);
}

export function todayRemainingBudget(history, settings, dateKey = toLocalDateKey()) {
  const invested = todayInvested(history, dateKey);
  const budget = settings?.dailyBudget ?? DEFAULT_SETTINGS.dailyBudget;
  return Math.max(0, budget - invested);
}

export function exposureByType(history) {
  const map = {};
  getOpenTrades(history).forEach((t) => {
    map[t.assetType] = (map[t.assetType] || 0) + 1;
  });
  return map;
}

// ---------- Stats de performance (nouveau) ----------
//
// Ne prend en compte QUE les trades clôturés avec un P&L réellement calculé
// (realizedPnL non-null), donc jamais un trade "clôturé" sans prix de sortie.
// C'est volontaire : mélanger des clôtures sans résultat chiffré fausserait
// le win-rate.
export function getStats(history) {
  const closed = history.filter(
    (t) => (t.status === "gagné" || t.status === "perdu") && isFiniteNum(t.realizedPnL)
  );

  const wins = closed.filter((t) => t.status === "gagné");
  const losses = closed.filter((t) => t.status === "perdu");

  const winRate = closed.length ? (wins.length / closed.length) * 100 : null;
  const totalPnL = closed.reduce((sum, t) => sum + t.realizedPnL, 0);
  const avgPnLPct = closed.length
    ? closed.reduce((sum, t) => sum + (isFiniteNum(t.realizedPnLPct) ? t.realizedPnLPct : 0), 0) / closed.length
    : null;

  // R:R réellement obtenu sur les trades gagnants, comparé au risque
  // planifié à l'entrée (riskAmount). Permet de voir si tu sors trop tôt
  // par rapport à ton plan initial.
  const realizedRRs = wins
    .filter((t) => isFiniteNum(t.riskAmount) && t.riskAmount > 0 && isFiniteNum(t.realizedPnL))
    .map((t) => t.realizedPnL / t.riskAmount);
  const avgRealizedRR = realizedRRs.length
    ? realizedRRs.reduce((a, b) => a + b, 0) / realizedRRs.length
    : null;

  // Win-rate par verdict du moteur d'analyse au moment de l'entrée —
  // répond à "est-ce que 'haussier' gagne vraiment plus souvent que
  // 'mitigé' avec mon système ?"
  const byVerdict = {};
  ["haussier", "baissier", "mitigé"].forEach((v) => {
    const group = closed.filter((t) => t.verdict === v);
    const groupWins = group.filter((t) => t.status === "gagné");
    byVerdict[v] = {
      total: group.length,
      wins: groupWins.length,
      winRate: group.length ? (groupWins.length / group.length) * 100 : null,
    };
  });

  // Win-rate par actif — pour repérer un marché qui performe mal avec ton
  // système, même si le nombre de trades par actif reste souvent faible.
  const bySymbol = {};
  closed.forEach((t) => {
    const key = t.symbol || "—";
    if (!bySymbol[key]) bySymbol[key] = { total: 0, wins: 0 };
    bySymbol[key].total += 1;
    if (t.status === "gagné") bySymbol[key].wins += 1;
  });
  Object.keys(bySymbol).forEach((key) => {
    const g = bySymbol[key];
    g.winRate = g.total ? (g.wins / g.total) * 100 : null;
  });

  return {
    totalClosed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate,
    totalPnL,
    avgPnLPct,
    avgRealizedRR,
    byVerdict,
    bySymbol,
  };
}

// ---------- Garde-fous (existant, inchangé) ----------
// Renvoie un tableau de messages d'avertissement (vide = rien à signaler)
// pour un trade candidat, sans jamais bloquer : c'est à toi de décider si
// tu confirmes quand même.
export function checkGuidance(candidate, { history, settings } = {}) {
  const h = history ?? loadHistory();
  const s = settings ?? loadSettings();
  const warnings = [];
  const dateKey = toLocalDateKey();
  const today = getTodayTrades(h, dateKey);

  // Surexposition sur le même actif + même sens
  const sameAssetCount = today.filter(
    (t) => t.symbol === candidate.symbol && t.direction === candidate.direction
  ).length;
  if (sameAssetCount >= s.maxTradesPerAsset) {
    warnings.push(
      `Tu as déjà pris ${sameAssetCount} trade(s) ${candidate.direction === "short" ? "short" : "long"} sur ${candidate.symbol} aujourd'hui (limite : ${s.maxTradesPerAsset}).`
    );
  }

  // Nombre total de trades aujourd'hui
  if (today.length >= s.maxTradesPerDay) {
    warnings.push(
      `Tu as déjà pris ${today.length} trade(s) aujourd'hui (limite : ${s.maxTradesPerDay}). Un de plus peut relever de l'overtrading.`
    );
  }

  // Risque cumulé (trades encore ouverts aujourd'hui) + ce nouveau trade
  const openRisk = todayOpenRisk(h, dateKey);
  const candidateRisk = candidate.riskAmount || 0;
  const projectedRisk = openRisk + candidateRisk;
  if (projectedRisk > s.dailyRiskLimit) {
    warnings.push(
      `Risque cumulé aujourd'hui : ${openRisk.toFixed(2)} € déjà engagés + ${candidateRisk.toFixed(2)} € sur ce trade = ${projectedRisk.toFixed(2)} €, au-delà de ta limite de ${s.dailyRiskLimit} €.`
    );
  }

  // Corrélation crypto : plusieurs positions crypto ouvertes en même temps
  // ne sont pas vraiment une diversification (elles bougent souvent ensemble).
    // Corrélation crypto : plusieurs positions crypto ouvertes en même temps
  // ne sont pas vraiment une diversification (elles bougent souvent ensemble).
  if (candidate.assetType === "crypto") {
    const openCrypto = getOpenTrades(h).filter((t) => t.assetType === "crypto").length;
    if (openCrypto >= 3) {
      warnings.push(
        `${openCrypto} position(s) crypto déjà ouverte(s) — ce nouveau trade crypto ajoute de la corrélation plutôt que de la diversification.`
      );
    }
  }

  // Corrélation forex : les paires majeures cotées contre l'USD (EUR, GBP,
  // NZD, AUD, CAD...) bougent souvent ensemble contre le dollar — plusieurs
  // positions forex simultanées ne sont pas non plus une vraie diversification.
  if (candidate.assetType === "forex") {
    const openForex = getOpenTrades(h).filter((t) => t.assetType === "forex").length;
    if (openForex >= 2) {
      warnings.push(
        `${openForex} position(s) forex déjà ouverte(s) — les paires majeures sont souvent corrélées entre elles contre l'USD, ce nouveau trade ajoute du risque groupé plutôt que de la diversification.`
      );
    }
  }

  return warnings;
}

  // Dépassement du budget journalier
  const remainingBudget = todayRemainingBudget(h, s, dateKey);
  if ((candidate.invested || 0) > remainingBudget) {
    warnings.push(
      `Budget du jour : il te reste ${remainingBudget.toFixed(2)} € sur ${s.dailyBudget} €, mais tu investis ${(candidate.invested || 0).toFixed(2)} € sur ce trade.`
    );
  }

  return warnings;
}
