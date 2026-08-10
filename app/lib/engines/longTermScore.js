// app/lib/engines/longTermScore.js
//
// Philosophie : ce moteur ne prédit AUCUN prix futur. Il mesure des
// conditions actuelles et passées (momentum, tendance, volatilité) et en
// tire un score de "qualité de candidat long terme" sur 100, avec un
// verdict et les raisons. C'est le même principe que setupScore.js côté
// court terme, appliqué à une résolution mensuelle.

import { canUseAlphaVantageCall, registerAlphaVantageCall } from "../watchlist";

// --- 1. Récupération des séries de prix -----------------------------------

// À adapter : réutilise la fonction qui lit la clé Alpha Vantage stockée
// dans les Paramètres de l'app (déjà utilisée par l'onglet Scanner).
function getAlphaVantageKey() {
  if (typeof window === "undefined") return null;
  return localStorage.getItem("alphaVantageApiKey"); // ⚠️ vérifier la clé exacte utilisée ailleurs dans TradingApp.jsx
}

async function fetchStockMonthly(symbol) {
  if (!canUseAlphaVantageCall()) return { error: "quota_exceeded" };
  const key = getAlphaVantageKey();
  if (!key) return { error: "no_api_key" };

  const url = `https://www.alphavantage.co/query?function=TIME_SERIES_MONTHLY&symbol=${symbol}&apikey=${key}`;
  const res = await fetch(url);
  registerAlphaVantageCall();
  const data = await res.json();
  const series = data["Monthly Time Series"];
  if (!series) return { error: "no_data" };

  return {
    closes: Object.entries(series)
      .map(([date, v]) => ({ date, close: parseFloat(v["4. close"]) }))
      .sort((a, b) => new Date(a.date) - new Date(b.date)),
  };
}

async function fetchForexMonthly(fromSymbol, toSymbol) {
  if (!canUseAlphaVantageCall()) return { error: "quota_exceeded" };
  const key = getAlphaVantageKey();
  if (!key) return { error: "no_api_key" };

  const url = `https://www.alphavantage.co/query?function=FX_MONTHLY&from_symbol=${fromSymbol}&to_symbol=${toSymbol}&apikey=${key}`;
  const res = await fetch(url);
  registerAlphaVantageCall();
  const data = await res.json();
  const series = data["Time Series FX (Monthly)"];
  if (!series) return { error: "no_data" };

  return {
    closes: Object.entries(series)
      .map(([date, v]) => ({ date, close: parseFloat(v["4. close"]) }))
      .sort((a, b) => new Date(a.date) - new Date(b.date)),
  };
}

// Crypto via CoinGecko — pas de clé nécessaire, pas de quota strict.
async function fetchCryptoDaily(coingeckoId, days = 210) {
  const url = `https://api.coingecko.com/api/v3/coins/${coingeckoId}/market_chart?vs_currency=usd&days=${days}&interval=daily`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.prices) return { error: "no_data" };

  return {
    closes: data.prices.map(([ts, price]) => ({
      date: new Date(ts).toISOString().slice(0, 10),
      close: price,
    })),
  };
}

export async function fetchSeries(symbol, type) {
  if (type === "stock") return fetchStockMonthly(symbol);
  if (type === "forex") {
    // symbol attendu au format "EURUSD"
    const from = symbol.slice(0, 3);
    const to = symbol.slice(3, 6);
    return fetchForexMonthly(from, to);
  }
  if (type === "crypto") return fetchCryptoDaily(symbol);
  return { error: "unknown_type" };
}

// --- 2. Calculs de momentum / volatilité -----------------------------------

function closeNMonthsAgo(closes, months) {
  // Fonctionne aussi bien pour données mensuelles (Alpha Vantage) que
  // quotidiennes (crypto) — on approxime 1 mois ≈ 30 jours si daily.
  if (closes.length === 0) return null;
  const isDaily = closes.length > 24; // heuristique simple
  const stepsBack = isDaily ? months * 30 : months;
  const idx = closes.length - 1 - stepsBack;
  return idx >= 0 ? closes[idx].close : closes[0].close;
}

function pctChange(from, to) {
  if (!from || !to) return null;
  return ((to - from) / from) * 100;
}

function computeVolatility(closes) {
  if (closes.length < 2) return null;
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push((closes[i].close - closes[i - 1].close) / closes[i - 1].close);
  }
  const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance =
    returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  return Math.sqrt(variance) * 100; // écart-type des rendements, en %
}

function computeTrendConsistency(closes, months) {
  // % du temps où le prix était au-dessus de sa moyenne mobile sur la
  // période — mesure la "propreté" de la tendance, pas sa direction future.
  const isDaily = closes.length > 24;
  const window = isDaily ? months * 30 : months;
  const recent = closes.slice(-window);
  if (recent.length < 3) return null;

  let above = 0;
  for (let i = 1; i < recent.length; i++) {
    const avg =
      recent.slice(0, i + 1).reduce((a, c) => a + c.close, 0) / (i + 1);
    if (recent[i].close >= avg) above++;
  }
  return (above / (recent.length - 1)) * 100;
}

// --- 3. Score final ----------------------------------------------------

export function computeLongTermScore(closes) {
  if (!closes || closes.length < 10) {
    return { error: "insufficient_data" };
  }

  const latest = closes[closes.length - 1].close;

  const m1 = pctChange(closeNMonthsAgo(closes, 1), latest);
  const m3 = pctChange(closeNMonthsAgo(closes, 3), latest);
  const m6 = pctChange(closeNMonthsAgo(closes, 6), latest);

  const volatility = computeVolatility(closes);
  const consistency6M = computeTrendConsistency(closes, 6);

  // Pondération — ajustable selon ton propre jugement de risque.
  let score = 50; // point neutre
  const reasons = [];

  // Momentum positif sur les 3 horizons = bon signe de tendance de fond
  [m1, m3, m6].forEach((m, i) => {
    const label = ["1M", "3M", "6M"][i];
    if (m === null) return;
    if (m > 0) {
      score += 5;
      reasons.push(`+ Momentum ${label} positif (${m.toFixed(1)}%)`);
    } else {
      score -= 5;
      reasons.push(`- Momentum ${label} négatif (${m.toFixed(1)}%)`);
    }
  });

  // Cohérence de tendance sur 6M — une tendance "propre" vaut mieux
  // qu'une tendance en dents de scie, même de même amplitude.
  if (consistency6M !== null) {
    if (consistency6M > 65) {
      score += 15;
      reasons.push(`+ Tendance 6M cohérente (${consistency6M.toFixed(0)}%)`);
    } else if (consistency6M < 40) {
      score -= 10;
      reasons.push(`- Tendance 6M erratique (${consistency6M.toFixed(0)}%)`);
    }
  }

  // Volatilité — ni bonus ni malus direct, mais affecte le "risque" affiché
  let riskLabel = "MODERATE";
  if (volatility !== null) {
    if (volatility > 8) riskLabel = "HIGH";
    else if (volatility < 3) riskLabel = "LOW";
  }

  score = Math.max(0, Math.min(100, Math.round(score)));

  let verdict = "NEUTRAL";
  if (score >= 70) verdict = "STRONG_CANDIDATE";
  else if (score < 40) verdict = "WEAK";

  return {
    score,
    verdict,
    risk: riskLabel,
    momentum: { m1, m3, m6 },
    volatility,
    consistency6M,
    reasons,
  };
}
