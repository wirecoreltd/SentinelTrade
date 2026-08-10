// app/lib/engines/longTermScore.js
//
// Philosophie inchangée : aucune prédiction de prix futur. On mesure des
// conditions passées/actuelles (momentum sur 1M/3M/6M, cohérence de
// tendance, volatilité) et on en tire un score de "qualité de candidat
// long terme" + un verdict, avec les raisons détaillées.
//
// Utilise les mêmes routes serveur que le reste de l'app (/api/stock,
// /api/crypto) — pas de clé API côté client.

import { canUseAlphaVantageCall, registerAlphaVantageCall } from "../watchlist";

const METAL_SYMBOLS = ["XAU", "XAG"];
function isMetal(symbol) {
  return METAL_SYMBOLS.includes(symbol.toUpperCase());
}

function alphaVantageErrorMessage(data) {
  return data?.Note || data?.Information || data?.["Error Message"] || null;
}

// --- 1. Récupération des historiques ---------------------------------------

async function fetchStockHistory(symbol) {
  if (!canUseAlphaVantageCall()) return { error: "quota_exceeded" };
  const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&kind=history`);
  const data = await res.json();
  registerAlphaVantageCall();
  if (data.error) return { error: data.error };
  const series = data["Time Series (Daily)"];
  if (!series) return { error: alphaVantageErrorMessage(data) || "no_data" };

  return {
    closes: Object.entries(series)
      .map(([date, v]) => ({ date, close: parseFloat(v["4. close"]) }))
      .sort((a, b) => new Date(a.date) - new Date(b.date)),
  };
}

async function fetchForexHistory(symbol) {
  if (isMetal(symbol)) {
    // gold-api.com ne fournit pas d'historique gratuit — pas de score
    // long terme possible pour XAU/XAG pour l'instant.
    return { error: "no_history_for_metals" };
  }
  if (!canUseAlphaVantageCall()) return { error: "quota_exceeded" };
  const res = await fetch(
    `/api/stock?symbol=${encodeURIComponent(symbol)}&kind=history&market=fx`
  );
  const data = await res.json();
  registerAlphaVantageCall();
  if (data.error) return { error: data.error };
  const series = data["Time Series FX (Daily)"];
  if (!series) return { error: alphaVantageErrorMessage(data) || "no_data" };

  return {
    closes: Object.entries(series)
      .map(([date, v]) => ({ date, close: parseFloat(v["4. close"]) }))
      .sort((a, b) => new Date(a.date) - new Date(b.date)),
  };
}

async function fetchCryptoHistory(id, days = 210) {
  const res = await fetch(
    `/api/crypto?path=coins/${id}/market_chart&vs_currency=usd&days=${days}&interval=daily`
  );
  if (!res.ok) return { error: "no_data" };
  const data = await res.json();
  if (!data.prices) return { error: "no_data" };

  return {
    closes: data.prices.map(([ts, price]) => ({
      date: new Date(ts).toISOString().slice(0, 10),
      close: price,
    })),
  };
}

export async function fetchLongTermSeries(symbol, type) {
  if (type === "stock") return fetchStockHistory(symbol.toUpperCase());
  if (type === "forex") return fetchForexHistory(symbol.toUpperCase());
  if (type === "crypto") return fetchCryptoHistory(symbol.toLowerCase());
  return { error: "unknown_type" };
}

// --- 2. Momentum / volatilité / cohérence -----------------------------------

// Même logique que trendFromHistory() dans TradingApp.jsx : fenêtre en
// jours calendaires, avec repli sur toute la série si la fenêtre est trop
// courte (utile quand l'historique dispo est limité, ex: Alpha Vantage
// "compact" ≈ 100 jours).
function pctChangeOverDays(closes, days) {
  if (!closes || closes.length < 2) return null;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const inWindow = closes.filter((c) => new Date(c.date).getTime() >= cutoff);
  const series = inWindow.length >= 2 ? inWindow : closes;
  const first = series[0].close;
  const last = series[series.length - 1].close;
  return ((last - first) / first) * 100;
}

function spanInDays(closes) {
  if (!closes || closes.length < 2) return 0;
  const first = new Date(closes[0].date).getTime();
  const last = new Date(closes[closes.length - 1].date).getTime();
  return (last - first) / (24 * 60 * 60 * 1000);
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
  return Math.sqrt(variance) * 100;
}

function computeTrendConsistency(closes, days) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const recent = closes.filter((c) => new Date(c.date).getTime() >= cutoff);
  const series = recent.length >= 5 ? recent : closes;
  if (series.length < 5) return null;

  let above = 0;
  for (let i = 1; i < series.length; i++) {
    const avg =
      series.slice(0, i + 1).reduce((a, c) => a + c.close, 0) / (i + 1);
    if (series[i].close >= avg) above++;
  }
  return (above / (series.length - 1)) * 100;
}

// --- 3. Score final ----------------------------------------------------

export function computeLongTermScore(closes) {
  if (!closes || closes.length < 10) {
    return { error: "insufficient_data" };
  }

  const coverageDays = spanInDays(closes);

  const m1 = pctChangeOverDays(closes, 30);
  const m3 = pctChangeOverDays(closes, 90);
  const m6 = coverageDays >= 120 ? pctChangeOverDays(closes, 180) : null;
  const consistency6M = computeTrendConsistency(closes, 180);
  const volatility = computeVolatility(closes);

  let score = 50;
  const reasons = [];

  [
    ["1M", m1],
    ["3M", m3],
    ["6M", m6],
  ].forEach(([label, m]) => {
    if (m === null) return;
    if (m > 0) {
      score += 5;
      reasons.push(`+ Momentum ${label} positif (${m.toFixed(1)}%)`);
    } else {
      score -= 5;
      reasons.push(`- Momentum ${label} négatif (${m.toFixed(1)}%)`);
    }
  });

  if (consistency6M !== null) {
    if (consistency6M > 65) {
      score += 15;
      reasons.push(`+ Tendance cohérente (${consistency6M.toFixed(0)}%)`);
    } else if (consistency6M < 40) {
      score -= 10;
      reasons.push(`- Tendance erratique (${consistency6M.toFixed(0)}%)`);
    }
  }

  let riskLabel = "MODERATE";
  if (volatility !== null) {
    if (volatility > 8) riskLabel = "HIGH";
    else if (volatility < 3) riskLabel = "LOW";
  }

  if (coverageDays < 120) {
    reasons.push(`⚠️ Historique limité à ~${Math.round(coverageDays)}j — score 6M moins fiable`);
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
    coverageDays: Math.round(coverageDays),
    reasons,
  };
}
