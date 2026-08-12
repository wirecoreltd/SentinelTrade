"use client";

// ============================================================================
// Historique des trades "pris" (marqués manuellement depuis le Calculateur)
// + garde-fous de discipline (surexposition sur un même actif, limite de
// risque cumulé par jour, limite du nombre de trades par jour).
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
};

function isBrowser() {
  return typeof window !== "undefined";
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
    realizedPnL: null,
    ...trade,
  };
  saveHistory([entry, ...list]);
  return entry;
}

export function updateTradeStatus(id, status, realizedPnL = null) {
  const next = loadHistory().map((t) =>
    t.id === id
      ? {
          ...t,
          status,
          closedAt: new Date().toISOString(),
          realizedPnL: realizedPnL != null ? realizedPnL : t.realizedPnL,
        }
      : t
  );
  saveHistory(next);
  return next;
}

export function deleteTrade(id) {
  const next = loadHistory().filter((t) => t.id !== id);
  saveHistory(next);
  return next;
}

// ---------- Lecture / stats ----------

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

export function exposureByType(history) {
  const map = {};
  getOpenTrades(history).forEach((t) => {
    map[t.assetType] = (map[t.assetType] || 0) + 1;
  });
  return map;
}

export function getOpenTradesForSymbol(history, symbol) {
  return getOpenTrades(history).filter((t) => t.symbol === symbol);
}

// ---------- Avis sur une position déjà ouverte ----------
// Compare chaque trade encore ouvert sur cet actif à l'état actuel du
// marché (prix courant + verdict frais retourné par runMarketAnalysis) et
// produit un avis en langage clair. Volontairement formulé au conditionnel
// ("envisage de", "vaut la peine de") : ce ne sont pas des ordres, juste une
// lecture des faits — la décision finale reste à toi.
// `market` attendu : { symbol, price, verdict }  (un résultat de runMarketAnalysis)
// `openTrades` : trades ouverts (status "ouvert") pour ce même symbole
export function buildPositionAdvisory(market, openTrades) {
  if (!openTrades || openTrades.length === 0) return null;
  const current = market.price;
  const freshVerdict = market.verdict;

  const trades = openTrades.map((t) => {
    const isLong = t.direction !== "short";
    const stopHit = t.stop != null && (isLong ? current <= t.stop : current >= t.stop);
    const targetHit = t.takeProfit != null && (isLong ? current >= t.takeProfit : current <= t.takeProfit);
    const pnlPct = t.entry ? (isLong ? ((current - t.entry) / t.entry) * 100 : ((t.entry - current) / t.entry) * 100) : null;

    let toTargetPct = null;
    if (t.takeProfit != null && t.entry != null) {
      const totalDist = Math.abs(t.takeProfit - t.entry);
      const doneDist = isLong ? current - t.entry : t.entry - current;
      toTargetPct = totalDist > 0 ? (doneDist / totalDist) * 100 : null;
    }

    const verdictFlipped = (isLong && freshVerdict === "baissier") || (!isLong && freshVerdict === "haussier");
    const verdictConfirmed = (isLong && freshVerdict === "haussier") || (!isLong && freshVerdict === "baissier");

    let advice;
    if (stopHit) {
      advice =
        "Le prix a atteint ou dépassé ton stop-loss — si le stop a été exécuté chez ton broker, ce trade devrait déjà être clôturé. Vérifie sur Capital.com/Binance et mets à jour son statut dans l'historique.";
    } else if (targetHit) {
      advice =
        "Le prix a atteint ou dépassé ton take-profit — ça vaut la peine d'envisager de sécuriser le gain (clôture totale ou partielle) plutôt que de laisser courir sans plan.";
    } else if (verdictFlipped) {
      advice =
        "Le signal technique s'est retourné dans le sens opposé à ta position depuis ta prise — plutôt que d'ajouter, envisage un stop resserré ou une clôture partielle.";
    } else if (verdictConfirmed && pnlPct != null && pnlPct > 0) {
      advice =
        "Le signal reste dans le même sens et la position est en gain — augmenter la mise ou le levier est envisageable si tu veux plus d'exposition, en gardant à l'esprit que ça reste le même actif, donc pas de diversification.";
    } else if (pnlPct != null && pnlPct < 0) {
      advice =
        "La position est en perte latente mais le signal n'a pas basculé contre toi — pas de signal technique de sortie pour l'instant ; ajouter maintenant reviendrait à moyenner à la baisse, à faire seulement si c'était ton plan de départ.";
    } else {
      advice = "Pas de mouvement significatif ni de changement de signal depuis la prise de position.";
    }

    return {
      id: t.id,
      direction: t.direction,
      entry: t.entry,
      stop: t.stop,
      takeProfit: t.takeProfit,
      createdAt: t.createdAt,
      verdictAtEntry: t.verdict,
      pnlPct,
      toTargetPct,
      stopHit,
      targetHit,
      advice,
    };
  });

  return { symbol: market.symbol, currentPrice: current, freshVerdict, trades };
}

// ---------- Garde-fous ----------
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
  if (candidate.assetType === "crypto") {
    const openCrypto = getOpenTrades(h).filter((t) => t.assetType === "crypto").length;
    if (openCrypto >= 3) {
      warnings.push(
        `${openCrypto} position(s) crypto déjà ouverte(s) — ce nouveau trade crypto ajoute de la corrélation plutôt que de la diversification.`
      );
    }
  }

  return warnings;
}
