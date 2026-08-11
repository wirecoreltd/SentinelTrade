"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Search,
  LineChart,
  FileText,
  Calculator,
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  Send,
  ListOrdered,
} from "lucide-react";

// ---------- Thème ----------
const NAVY = "#0E1420";
const PANEL = "#161D2B";
const ACCENT = "#4F8CFF";
const TEXT = "#EEF1F6";
const MUTED = "#8A93A6";
const LINE = "#232C3D";
const POS = "#3DD68C";
const NEG = "#FF6767";

// ---------- Helper: extrait un message d'erreur exploitable d'une réponse Alpha Vantage ----------
// Alpha Vantage renvoie l'erreur / le message de quota sous des clés différentes
// selon le cas : "Note" (ancien format quota), "Information" (nouveau format,
// quota ou fonction premium), "Error Message" (paramètre/symbole invalide).
function alphaVantageErrorMessage(data) {
  return data?.Note || data?.Information || data?.["Error Message"] || null;
}

// ---------- Métaux précieux (or, argent) ----------
// Alpha Vantage renvoie "Invalid API call" sur CURRENCY_EXCHANGE_RATE / FX_DAILY
// pour XAU et XAG : ces symboles ne sont pas supportés sur le plan gratuit.
// On les route donc vers gold-api.com : gratuit, sans clé API, CORS activé,
// appelable directement depuis le navigateur. Limite : leur endpoint
// d'historique nécessite une clé (10 req/h en gratuit), donc on affiche le
// prix en temps réel mais pas de support/résistance pour ces deux actifs.
const METAL_SYMBOLS = ["XAU", "XAG"];
function isMetal(symbol) {
  return METAL_SYMBOLS.includes(symbol.toUpperCase());
}

async function fetchMetalPrice(symbol) {
  const res = await fetch(`https://api.gold-api.com/price/${encodeURIComponent(symbol.toUpperCase())}`);
  if (!res.ok) throw new Error("Métal introuvable (XAU pour l'or, XAG pour l'argent)");
  const data = await res.json();
  if (typeof data.price !== "number") throw new Error("Prix du métal indisponible");
  return { price: data.price, change24h: null };
}

// ---------- Helpers API ----------
async function fetchCoinGeckoPrice(id) {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`
  );
  if (!res.ok) throw new Error("Identifiant crypto introuvable");
  const data = await res.json();
  if (!data[id]) throw new Error("Identifiant crypto introuvable");
  return { price: data[id].usd, change24h: data[id].usd_24h_change };
}

async function fetchCoinGeckoHistory(id, days) {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`
  );
  if (!res.ok) throw new Error("Historique crypto indisponible");
  const data = await res.json();
  // CoinGecko market_chart ne fournit qu'un prix de clôture par jour, pas de
  // vraies bougies OHLC. On approxime high = low = close : l'ATR/ADX calculés
  // dessus sont donc une volatilité clôture-à-clôture, pas une vraie amplitude
  // intrajournalière. C'est signalé dans le raisonnement du Dossier.
  // "open" est approximé par la clôture de la veille (convention standard
  // quand l'open réel n'est pas disponible) : sert au pivot DeMark.
  return data.prices.map(([ts, price], i, arr) => ({
    date: ts,
    close: price,
    high: price,
    low: price,
    open: i === 0 ? price : arr[i - 1][1],
  }));
}

async function fetchCoinGeckoTop(n = 10) {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${n}&page=1&price_change_percentage=24h`
  );
  if (!res.ok) throw new Error("Scanner indisponible");
  return res.json();
}

async function fetchAlphaQuote(symbol) {
  const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&kind=quote`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const q = data["Global Quote"];
  if (!q || !q["05. price"]) {
    const reason = alphaVantageErrorMessage(data);
    throw new Error(reason || "Symbole introuvable");
  }
  return {
    price: parseFloat(q["05. price"]),
    change24h: parseFloat(q["10. change percent"]),
  };
}

async function fetchAlphaHistory(symbol) {
  const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&kind=history`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const series = data["Time Series (Daily)"];
  if (!series) {
    const reason = alphaVantageErrorMessage(data);
    throw new Error(reason || "Historique indisponible");
  }
  return Object.entries(series)
    .map(([date, v]) => ({
      date,
      close: parseFloat(v["4. close"]),
      high: parseFloat(v["2. high"]),
      low: parseFloat(v["3. low"]),
      open: parseFloat(v["1. open"]),
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Devises classiques uniquement (les métaux passent par fetchMetalPrice ci-dessus)
async function fetchFxQuote(symbol) {
  const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&kind=quote&market=fx`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const q = data["Realtime Currency Exchange Rate"];
  if (!q || !q["5. Exchange Rate"]) {
    const reason = alphaVantageErrorMessage(data);
    throw new Error(reason || "Devise introuvable (ex: EUR, GBP)");
  }
  return { price: parseFloat(q["5. Exchange Rate"]), change24h: null };
}

async function fetchFxHistory(symbol) {
  const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&kind=history&market=fx`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const series = data["Time Series FX (Daily)"];
  if (!series) {
    const reason = alphaVantageErrorMessage(data);
    throw new Error(reason || "Historique indisponible");
  }
  return Object.entries(series)
    .map(([date, v]) => ({
      date,
      close: parseFloat(v["4. close"]),
      high: parseFloat(v["2. high"]),
      low: parseFloat(v["3. low"]),
      open: parseFloat(v["1. open"]),
    }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function fetchNewsSentiment(query) {
  const res = await fetch(`/api/news?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Actualités indisponibles");
  const articles = (data.results || []).slice(0, 15);

  const POS_WORDS = ["surge", "rally", "gain", "bullish", "soar", "jump", "rise", "beat", "strong", "growth", "upgrade", "hausse", "record"];
  const NEG_WORDS = ["drop", "fall", "plunge", "bearish", "crash", "decline", "loss", "weak", "cut", "downgrade", "concern", "fear", "baisse", "chute"];

  let score = 0;
  for (const a of articles) {
    const text = `${a.title || ""} ${a.description || ""}`.toLowerCase();
    for (const w of POS_WORDS) if (text.includes(w)) score += 1;
    for (const w of NEG_WORDS) if (text.includes(w)) score -= 1;
  }

  let label = "mitigé";
  if (score >= 2) label = "positif";
  else if (score <= -2) label = "négatif";

  return { label, score, articleCount: articles.length, headlines: articles.slice(0, 3).map((a) => a.title) };
}

// ---------- Calculs ----------
function trendFromHistory(history, days) {
  if (!history || history.length < 2) return null;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const inWindow = history.filter((h) => new Date(h.date).getTime() >= cutoff);
  const series = inWindow.length >= 2 ? inWindow : history;
  const first = series[0].close;
  const last = series[series.length - 1].close;
  const pct = ((last - first) / first) * 100;
  let direction = "plat";
  if (pct > 1) direction = "haussier";
  else if (pct < -1) direction = "baissier";
  return { pct, direction };
}

function supportResistance(history) {
  const closes = history.map((h) => h.close);
  return { support: Math.min(...closes), resistance: Math.max(...closes) };
}

// ---------- Analyse technique ----------
// Socle volontairement restreint (plutôt que d'empiler tous les indicateurs
// possibles) : EMA + ADX/DMI + Ichimoku + structure de marché pour la
// direction, RSI comme filtre de prudence (pas un signal directionnel), ATR
// pour dimensionner le stop-loss selon la volatilité réelle plutôt qu'un
// pourcentage fixe.

function calcEMA(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  values.forEach((v, i) => {
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  });
  return out;
}

function calcTrueRange(history) {
  return history.map((h, i) => {
    if (i === 0) return h.high - h.low;
    const prevClose = history[i - 1].close;
    return Math.max(h.high - h.low, Math.abs(h.high - prevClose), Math.abs(h.low - prevClose));
  });
}

// ATR lissé façon Wilder (14 périodes par défaut). Tableau aligné sur
// l'historique, null tant qu'il n'y a pas assez de données.
function calcATR(history, period = 14) {
  const tr = calcTrueRange(history);
  const out = new Array(history.length).fill(null);
  if (tr.length <= period) return out;
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = atr;
  for (let i = period; i < tr.length; i++) {
    atr = (atr * (period - 1) + tr[i]) / period;
    out[i] = atr;
  }
  return out;
}

// ==================================================================
// PASS 1 — Nouveaux indicateurs techniques (Trend / Momentum / Volatility)
// Ajoutés en complément du socle EMA/ADX/Ichimoku/Structure ci-dessus.
// Tous acceptent le même format d'historique { date, close, high, low }.
// Pour les cryptos (CoinGecko market_chart), high = low = close, donc les
// indicateurs basés sur l'amplitude (Stochastic, CCI, Aroon, Supertrend,
// PSAR, Williams %R, Choppiness, Keltner) dégénèrent partiellement — c'est
// la même limitation que pour l'ATR/ADX existants, déjà documentée plus haut.
// ==================================================================

// --- Trend ---

function calcSMA(values, period) {
  const out = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    out[i] = sum / period;
  }
  return out;
}

function calcWMA(values, period) {
  const out = new Array(values.length).fill(null);
  const denom = (period * (period + 1)) / 2;
  for (let i = period - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = 0; j < period; j++) sum += values[i - period + 1 + j] * (j + 1);
    out[i] = sum / denom;
  }
  return out;
}

// Hull MA = WMA(2×WMA(n/2) − WMA(n), √n). Réagit plus vite que l'EMA tout en
// restant lissée. Approximation : les nulls de tête de la WMA intermédiaire
// sont remplacés par la valeur brute avant le second passage WMA, pour ne
// pas perdre toute la série — sans impact une fois la période "period" passée.
function calcHMA(values, period) {
  const halfPeriod = Math.max(1, Math.round(period / 2));
  const sqrtPeriod = Math.max(1, Math.round(Math.sqrt(period)));
  const wmaHalf = calcWMA(values, halfPeriod);
  const wmaFull = calcWMA(values, period);
  const diff = values.map((_, i) => (wmaHalf[i] != null && wmaFull[i] != null ? 2 * wmaHalf[i] - wmaFull[i] : null));
  const filled = diff.map((d, i) => (d == null ? values[i] : d));
  const hma = calcWMA(filled, sqrtPeriod);
  return hma.map((h, i) => (diff[i] == null ? null : h));
}

function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signalPeriod);
  const histogram = macdLine.map((m, i) => m - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

// Supertrend (période ATR 10, multiplicateur 3 par défaut).
function calcSupertrend(history, period = 10, multiplier = 3) {
  const atr = calcATR(history, period);
  const n = history.length;
  const finalUpper = new Array(n).fill(null);
  const finalLower = new Array(n).fill(null);
  const trend = new Array(n).fill(null); // 'up' | 'down'
  for (let i = 0; i < n; i++) {
    if (atr[i] == null) continue;
    const mid = (history[i].high + history[i].low) / 2;
    const basicUpper = mid + multiplier * atr[i];
    const basicLower = mid - multiplier * atr[i];
    if (finalUpper[i - 1] == null) {
      finalUpper[i] = basicUpper;
      finalLower[i] = basicLower;
      trend[i] = history[i].close > basicUpper ? "up" : "down";
      continue;
    }
    finalUpper[i] =
      basicUpper < finalUpper[i - 1] || history[i - 1].close > finalUpper[i - 1] ? basicUpper : finalUpper[i - 1];
    finalLower[i] =
      basicLower > finalLower[i - 1] || history[i - 1].close < finalLower[i - 1] ? basicLower : finalLower[i - 1];
    const prevTrend = trend[i - 1];
    trend[i] =
      prevTrend === "up"
        ? history[i].close < finalLower[i] ? "down" : "up"
        : history[i].close > finalUpper[i] ? "up" : "down";
  }
  return { trend, upperBand: finalUpper, lowerBand: finalLower };
}

function calcAroon(history, period = 25) {
  const n = history.length;
  const aroonUp = new Array(n).fill(null);
  const aroonDown = new Array(n).fill(null);
  for (let i = period; i < n; i++) {
    const windowSlice = history.slice(i - period, i + 1); // period+1 bougies jusqu'à i inclus
    let highestIdx = 0, lowestIdx = 0;
    windowSlice.forEach((h, j) => {
      if (h.high >= windowSlice[highestIdx].high) highestIdx = j;
      if (h.low <= windowSlice[lowestIdx].low) lowestIdx = j;
    });
    aroonUp[i] = (highestIdx / period) * 100;
    aroonDown[i] = (lowestIdx / period) * 100;
  }
  return { aroonUp, aroonDown };
}

// Parabolic SAR (accélération 0.02, max 0.2 par défaut).
function calcParabolicSAR(history, step = 0.02, maxStep = 0.2) {
  const n = history.length;
  const sar = new Array(n).fill(null);
  const trend = new Array(n).fill(null);
  if (n < 2) return { sar, trend };
  let isUp = history[1].close > history[0].close;
  let af = step;
  let ep = isUp ? history[0].high : history[0].low;
  let currentSar = isUp ? history[0].low : history[0].high;
  sar[0] = currentSar;
  trend[0] = isUp ? "up" : "down";
  for (let i = 1; i < n; i++) {
    currentSar = currentSar + af * (ep - currentSar);
    if (isUp) {
      const prevLow2 = i >= 2 ? history[i - 2].low : history[i - 1].low;
      currentSar = Math.min(currentSar, history[i - 1].low, prevLow2);
      if (history[i].low < currentSar) {
        isUp = false;
        currentSar = ep;
        ep = history[i].low;
        af = step;
      } else if (history[i].high > ep) {
        ep = history[i].high;
        af = Math.min(af + step, maxStep);
      }
    } else {
      const prevHigh2 = i >= 2 ? history[i - 2].high : history[i - 1].high;
      currentSar = Math.max(currentSar, history[i - 1].high, prevHigh2);
      if (history[i].high > currentSar) {
        isUp = true;
        currentSar = ep;
        ep = history[i].high;
        af = step;
      } else if (history[i].low < ep) {
        ep = history[i].low;
        af = Math.min(af + step, maxStep);
      }
    }
    sar[i] = currentSar;
    trend[i] = isUp ? "up" : "down";
  }
  return { sar, trend };
}

// --- Momentum ---

function calcStochastic(history, period = 14, smoothK = 3, smoothD = 3) {
  const n = history.length;
  const rawK = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const windowSlice = history.slice(i - period + 1, i + 1);
    const highestHigh = Math.max(...windowSlice.map((h) => h.high));
    const lowestLow = Math.min(...windowSlice.map((h) => h.low));
    rawK[i] = highestHigh === lowestLow ? 50 : ((history[i].close - lowestLow) / (highestHigh - lowestLow)) * 100;
  }
  // Lissage SMA sur les valeurs déjà valides uniquement (0 en placeholder avant, retiré après).
  const kFilled = calcSMA(rawK.map((v) => (v == null ? 0 : v)), smoothK).map((v, i) => (rawK[i] == null ? null : v));
  const dFilled = calcSMA(kFilled.map((v) => (v == null ? 0 : v)), smoothD).map((v, i) => (kFilled[i] == null ? null : v));
  return { k: kFilled, d: dFilled };
}

function calcWilliamsR(history, period = 14) {
  const n = history.length;
  const out = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const windowSlice = history.slice(i - period + 1, i + 1);
    const highestHigh = Math.max(...windowSlice.map((h) => h.high));
    const lowestLow = Math.min(...windowSlice.map((h) => h.low));
    out[i] = highestHigh === lowestLow ? -50 : ((highestHigh - history[i].close) / (highestHigh - lowestLow)) * -100;
  }
  return out;
}

function calcCCI(history, period = 20) {
  const n = history.length;
  const typicalPrices = history.map((h) => (h.high + h.low + h.close) / 3);
  const out = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const windowSlice = typicalPrices.slice(i - period + 1, i + 1);
    const sma = windowSlice.reduce((a, b) => a + b, 0) / period;
    const meanDev = windowSlice.reduce((a, b) => a + Math.abs(b - sma), 0) / period;
    out[i] = meanDev === 0 ? 0 : (typicalPrices[i] - sma) / (0.015 * meanDev);
  }
  return out;
}

function calcROC(closes, period = 12) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  for (let i = period; i < n; i++) out[i] = ((closes[i] - closes[i - period]) / closes[i - period]) * 100;
  return out;
}

// True Strength Index (double lissage EMA du momentum, 25/13 par défaut).
function calcTSI(closes, longPeriod = 25, shortPeriod = 13) {
  const n = closes.length;
  const momentum = new Array(n).fill(0);
  for (let i = 1; i < n; i++) momentum[i] = closes[i] - closes[i - 1];
  const emaMomentumDouble = calcEMA(calcEMA(momentum, longPeriod), shortPeriod);
  const absMomentum = momentum.map((m) => Math.abs(m));
  const emaAbsDouble = calcEMA(calcEMA(absMomentum, longPeriod), shortPeriod);
  return emaMomentumDouble.map((v, i) => (emaAbsDouble[i] ? (100 * v) / emaAbsDouble[i] : null));
}

// Awesome Oscillator = SMA5(prix médian) − SMA34(prix médian).
function calcAwesomeOscillator(history) {
  const median = history.map((h) => (h.high + h.low) / 2);
  const sma5 = calcSMA(median, 5);
  const sma34 = calcSMA(median, 34);
  return median.map((_, i) => (sma5[i] != null && sma34[i] != null ? sma5[i] - sma34[i] : null));
}

// --- Volatility ---

function calcBollingerBands(closes, period = 20, stdDevMult = 2) {
  const n = closes.length;
  const middle = calcSMA(closes, period);
  const upper = new Array(n).fill(null);
  const lower = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const windowSlice = closes.slice(i - period + 1, i + 1);
    const mean = middle[i];
    const variance = windowSlice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    const sd = Math.sqrt(variance);
    upper[i] = mean + stdDevMult * sd;
    lower[i] = mean - stdDevMult * sd;
  }
  return { upper, middle, lower };
}

function calcKeltnerChannels(history, closes, period = 20, atrMult = 2) {
  const middle = calcEMA(closes, period);
  const atr = calcATR(history, period);
  return {
    upper: middle.map((m, i) => (atr[i] != null ? m + atrMult * atr[i] : null)),
    middle,
    lower: middle.map((m, i) => (atr[i] != null ? m - atrMult * atr[i] : null)),
  };
}

function calcStdDev(closes, period = 20) {
  const n = closes.length;
  const out = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const windowSlice = closes.slice(i - period + 1, i + 1);
    const mean = windowSlice.reduce((a, b) => a + b, 0) / period;
    const variance = windowSlice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
    out[i] = Math.sqrt(variance);
  }
  return out;
}

// Choppiness Index : >61.8 = marché en range (pas de tendance fiable),
// <38.2 = marché directionnel. Entre les deux : zone de transition.
function calcChoppinessIndex(history, period = 14) {
  const n = history.length;
  const tr = calcTrueRange(history);
  const out = new Array(n).fill(null);
  for (let i = period - 1; i < n; i++) {
    const trSum = tr.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    const windowSlice = history.slice(i - period + 1, i + 1);
    const highestHigh = Math.max(...windowSlice.map((h) => h.high));
    const lowestLow = Math.min(...windowSlice.map((h) => h.low));
    const range = highestHigh - lowestLow;
    out[i] = range === 0 ? 0 : (100 * Math.log10(trSum / range)) / Math.log10(period);
  }
  return out;
}

function classifyMarketRegime(adxVal, choppinessVal) {
  if (choppinessVal != null && choppinessVal > 61.8) return "range";
  if (adxVal != null && adxVal > 25) return "tendance";
  return "transition";
}

// ==================================================================
// PASS 2 — Pivot Points & Fibonacci (niveaux de Support/Résistance avancés)
// Les pivots sont calculés à partir de la DERNIÈRE bougie complète de
// l'historique (H/L/C — et O pour DeMark) : ce sont donc les niveaux
// projetés pour la prochaine séance, comme sur un terminal de trading.
// Les niveaux Fibonacci sont calculés sur le dernier swing détecté par
// detectMarketStructure (swing low <-> swing high), pas sur tout
// l'historique : ça reste pertinent tant que ce swing est le mouvement
// dominant en cours.
// ==================================================================

// Pivot Points "Standard" (classique/floor trader).
function calcPivotStandard(h, l, c) {
  const pp = (h + l + c) / 3;
  return {
    pp,
    r1: 2 * pp - l,
    s1: 2 * pp - h,
    r2: pp + (h - l),
    s2: pp - (h - l),
    r3: h + 2 * (pp - l),
    s3: l - 2 * (h - pp),
  };
}

// Pivot Points "Fibonacci" : mêmes PP que le standard, mais les
// écartements R/S utilisent les ratios de Fibonacci (0.382/0.618/1.0)
// plutôt que la géométrie du floor trader.
function calcPivotFibonacci(h, l, c) {
  const pp = (h + l + c) / 3;
  const range = h - l;
  return {
    pp,
    r1: pp + 0.382 * range,
    s1: pp - 0.382 * range,
    r2: pp + 0.618 * range,
    s2: pp - 0.618 * range,
    r3: pp + range,
    s3: pp - range,
  };
}

// Pivot Points "Camarilla" : niveaux resserrés autour de la clôture,
// pensés pour du intraday (R3/S3 = zones de retournement probables,
// R4/S4 = zones de breakout).
function calcPivotCamarilla(h, l, c) {
  const range = h - l;
  return {
    pp: c,
    r1: c + (range * 1.1) / 12,
    s1: c - (range * 1.1) / 12,
    r2: c + (range * 1.1) / 6,
    s2: c - (range * 1.1) / 6,
    r3: c + (range * 1.1) / 4,
    s3: c - (range * 1.1) / 4,
    r4: c + (range * 1.1) / 2,
    s4: c - (range * 1.1) / 2,
  };
}

// Pivot Points "Woodie" : donne plus de poids à la clôture qu'à
// l'ouverture/l'amplitude, censé mieux coller aux marchés qui gappent.
function calcPivotWoodie(h, l, c) {
  const pp = (h + l + 2 * c) / 4;
  return {
    pp,
    r1: 2 * pp - l,
    s1: 2 * pp - h,
    r2: pp + (h - l),
    s2: pp - (h - l),
  };
}

// Pivot "DeMark" : asymétrique, dépend de la position de la clôture par
// rapport à l'ouverture. Nécessite un "open" — approximé pour les cryptos
// (clôture de la veille), voir fetchCoinGeckoHistory.
function calcPivotDeMark(h, l, c, o) {
  let x;
  if (c < o) x = h + 2 * l + c;
  else if (c > o) x = 2 * h + l + c;
  else x = h + l + 2 * c;
  const pp = x / 4;
  return {
    pp,
    r1: x / 2 - l,
    s1: x / 2 - h,
  };
}

function calcAllPivots(history, lastIdx) {
  const last = history[lastIdx];
  const { high: h, low: l, close: c } = last;
  const o = last.open != null ? last.open : c;
  return {
    standard: calcPivotStandard(h, l, c),
    fibonacci: calcPivotFibonacci(h, l, c),
    camarilla: calcPivotCamarilla(h, l, c),
    woodie: calcPivotWoodie(h, l, c),
    demark: calcPivotDeMark(h, l, c, o),
  };
}

// Retracements de Fibonacci entre un swing low et un swing high : niveaux
// classiques utilisés comme zones de support/résistance potentielles à
// l'intérieur du swing.
function calcFibonacciRetracement(low, high) {
  const range = high - low;
  return {
    "0.0": high,
    "0.236": high - 0.236 * range,
    "0.382": high - 0.382 * range,
    "0.5": high - 0.5 * range,
    "0.618": high - 0.618 * range,
    "0.786": high - 0.786 * range,
    "1.0": low,
  };
}

// Extensions de Fibonacci au-delà du swing : cibles de continuation si
// la tendance du swing se poursuit (haussier = extension au-dessus du
// high, baissier = extension en-dessous du low).
function calcFibonacciExtension(low, high, direction) {
  const range = high - low;
  if (direction === "haussier") {
    return {
      "1.272": high + 0.272 * range,
      "1.618": high + 0.618 * range,
      "2.0": high + range,
    };
  }
  return {
    "1.272": low - 0.272 * range,
    "1.618": low - 0.618 * range,
    "2.0": low - range,
  };
}

// ==================================================================
// PASS 3 — Entry Algos & Risk/Reward
// Ces fonctions ne votent PAS dans le verdict haussier/baissier/mitigé :
// elles répondent à une question différente ("où/quand entrer si je suis
// déjà d'accord avec le biais directionnel"), pas "quel est le biais".
// Affichées comme information, pas comme signal supplémentaire.
// ==================================================================

// Z-score de la clôture par rapport à sa moyenne/écart-type glissants
// (période 20 par défaut) : base du signal Mean Reversion.
function calcZScore(closes, period = 20) {
  const sma = calcSMA(closes, period);
  const std = calcStdDev(closes, period);
  return closes.map((c, i) => (sma[i] != null && std[i] ? (c - sma[i]) / std[i] : null));
}

// Breakout + Retest : le prix a cassé un niveau clé de la structure
// (résistance en haussier, support en baissier) dans les `lookback`
// dernières bougies, et se retrouve maintenant à moins de 1.5% de ce
// niveau — configuration classique d'entrée sur retour au niveau cassé.
function detectBreakoutRetest(history, structure, lookback = 10) {
  if (!structure.resistance || !structure.support || structure.regime === "range") return { active: false };
  const level = structure.regime === "haussier" ? structure.resistance : structure.support;
  const recentBars = history.slice(-lookback, -1); // exclut la bougie courante
  const broke =
    structure.regime === "haussier"
      ? recentBars.some((h) => h.close > level)
      : recentBars.some((h) => h.close < level);
  if (!broke) return { active: false };
  const currentPrice = history[history.length - 1].close;
  const distancePct = (Math.abs(currentPrice - level) / level) * 100;
  return { active: distancePct < 1.5, level, distancePct, direction: structure.regime };
}

// Pullback Entry : dans une tendance établie, le prix est revenu tout
// près de l'EMA20 sans l'avoir franchie dans le sens contraire — repli
// classique avant une reprise de tendance.
function detectPullback(currentPrice, ema20, trendDirection) {
  if (ema20 == null || !trendDirection || trendDirection === "range" || trendDirection === "indéterminé") {
    return { active: false };
  }
  const distancePct = (Math.abs(currentPrice - ema20) / ema20) * 100;
  const nearEma = distancePct < 1.0;
  const aligned = trendDirection === "haussier" ? currentPrice >= ema20 * 0.99 : currentPrice <= ema20 * 1.01;
  return { active: nearEma && aligned, distancePct, ema20 };
}

// Mean Reversion (Z-score) : |z| > 2 = extension statistique significative
// par rapport à la moyenne 20 périodes — pari sur un retour vers la
// moyenne, donc SIGNAL OPPOSÉ à la direction de l'extension.
function detectMeanReversion(zScoreLast) {
  if (zScoreLast == null) return { active: false, zScore: null };
  if (zScoreLast > 2) return { active: true, direction: "baissier", zScore: zScoreLast };
  if (zScoreLast < -2) return { active: true, direction: "haussier", zScore: zScoreLast };
  return { active: false, zScore: zScoreLast };
}

// Ratio Risque/Récompense explicite : distance entrée→stop vs entrée→cible.
function calcRiskReward(entry, stop, target) {
  if (entry == null || stop == null || target == null) return null;
  const risk = Math.abs(entry - stop);
  const reward = Math.abs(target - entry);
  if (risk === 0) return null;
  return { risk, reward, ratio: reward / risk };
}

// DMI / ADX façon Wilder.
function calcADX(history, period = 14) {
  const n = history.length;
  const plusDM = new Array(n).fill(0);
  const minusDM = new Array(n).fill(0);
  const tr = calcTrueRange(history);
  for (let i = 1; i < n; i++) {
    const upMove = history[i].high - history[i - 1].high;
    const downMove = history[i - 1].low - history[i].low;
    plusDM[i] = upMove > downMove && upMove > 0 ? upMove : 0;
    minusDM[i] = downMove > upMove && downMove > 0 ? downMove : 0;
  }

  function wilderSmooth(arr) {
    const out = new Array(arr.length).fill(null);
    if (arr.length <= period) return out;
    let sum = arr.slice(1, period + 1).reduce((a, b) => a + b, 0);
    out[period] = sum;
    for (let i = period + 1; i < arr.length; i++) {
      sum = out[i - 1] - out[i - 1] / period + arr[i];
      out[i] = sum;
    }
    return out;
  }

  const smoothTR = wilderSmooth(tr);
  const smoothPlusDM = wilderSmooth(plusDM);
  const smoothMinusDM = wilderSmooth(minusDM);

  const plusDI = smoothTR.map((v, i) => (v ? (100 * smoothPlusDM[i]) / v : null));
  const minusDI = smoothTR.map((v, i) => (v ? (100 * smoothMinusDM[i]) / v : null));
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i];
    if (p == null || m == null || p + m === 0) return null;
    return (100 * Math.abs(p - m)) / (p + m);
  });

  const firstValid = dx.findIndex((v) => v != null);
  const adx = new Array(n).fill(null);
  if (firstValid !== -1 && dx.length >= firstValid + period) {
    let avg = dx.slice(firstValid, firstValid + period).reduce((a, b) => a + b, 0) / period;
    adx[firstValid + period - 1] = avg;
    for (let i = firstValid + period; i < n; i++) {
      avg = (adx[i - 1] * (period - 1) + dx[i]) / period;
      adx[i] = avg;
    }
  }

  return { plusDI, minusDI, adx };
}

// RSI façon Wilder (14 périodes). Sert de garde-fou de prudence
// (suracheté/survendu), pas de signal directionnel principal.
function calcRSI(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff >= 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

// Nuage d'Ichimoku. cloudTopAt(i)/cloudBottomAt(i) renvoient le nuage tel
// qu'il serait affiché au jour i (projection standard de 26 périodes).
function calcIchimoku(history) {
  const highs = history.map((h) => h.high);
  const lows = history.map((h) => h.low);

  function rangeMid(period, idx) {
    const start = Math.max(0, idx - period + 1);
    const hSlice = highs.slice(start, idx + 1);
    const lSlice = lows.slice(start, idx + 1);
    return (Math.max(...hSlice) + Math.min(...lSlice)) / 2;
  }

  const tenkan = history.map((_, i) => rangeMid(9, i));
  const kijun = history.map((_, i) => rangeMid(26, i));
  const senkouARaw = history.map((_, i) => (tenkan[i] + kijun[i]) / 2);
  const senkouBRaw = history.map((_, i) => rangeMid(52, i));

  const cloudTopAt = (i) => {
    const j = i - 26;
    return j < 0 ? null : Math.max(senkouARaw[j], senkouBRaw[j]);
  };
  const cloudBottomAt = (i) => {
    const j = i - 26;
    return j < 0 ? null : Math.min(senkouARaw[j], senkouBRaw[j]);
  };

  return { cloudTopAt, cloudBottomAt };
}

// Points de swing (fractale à 5 barres) pour détecter la structure de
// marché : Higher High/Higher Low = haussier, Lower High/Lower Low =
// baissier. BOS = cassure dans le sens de la tendance (continuation).
// CHOCH = cassure du côté opposé (signal de retournement potentiel).
function detectMarketStructure(history, span = 2) {
  const highs = history.map((h) => h.high);
  const lows = history.map((h) => h.low);
  const swingHighs = [];
  const swingLows = [];

  for (let i = span; i < history.length - span; i++) {
    const windowH = highs.slice(i - span, i + span + 1);
    const windowL = lows.slice(i - span, i + span + 1);
    if (highs[i] === Math.max(...windowH)) swingHighs.push({ price: highs[i] });
    if (lows[i] === Math.min(...windowL)) swingLows.push({ price: lows[i] });
  }

  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { regime: "indéterminé", bos: false, choch: false, support: null, resistance: null };
  }

  const lastHigh = swingHighs[swingHighs.length - 1];
  const prevHigh = swingHighs[swingHighs.length - 2];
  const lastLow = swingLows[swingLows.length - 1];
  const prevLow = swingLows[swingLows.length - 2];

  const higherHigh = lastHigh.price > prevHigh.price;
  const higherLow = lastLow.price > prevLow.price;
  const lowerHigh = lastHigh.price < prevHigh.price;
  const lowerLow = lastLow.price < prevLow.price;

  let regime = "range";
  if (higherHigh && higherLow) regime = "haussier";
  else if (lowerHigh && lowerLow) regime = "baissier";

  const currentPrice = history[history.length - 1].close;
  const bos =
    (regime === "haussier" && currentPrice > lastHigh.price) ||
    (regime === "baissier" && currentPrice < lastLow.price);
  const choch =
    (regime === "haussier" && currentPrice < lastLow.price) ||
    (regime === "baissier" && currentPrice > lastHigh.price);

  return { regime, bos, choch, support: lastLow.price, resistance: lastHigh.price };
}

// ---------- Moteur d'analyse partagé (Dossier + Top 15) ----------
// Pour les devises classiques, on ne fait plus qu'UN SEUL appel Alpha Vantage
// (l'historique) au lieu de deux : le dernier cours de la série sert de prix
// actuel. Ça divise par deux la consommation de quota (25 req/jour) pour
// chaque analyse, ce qui est indispensable pour pouvoir scanner plusieurs
// devises d'affilée dans le Top 15 sans épuiser le quota du jour.
async function runMarketAnalysis(type, query) {
  let price, history;
  const metal = type === "fx" && isMetal(query);

  if (type === "crypto") {
    const id = query.toLowerCase();
    [price, history] = await Promise.all([
      fetchCoinGeckoPrice(id),
      fetchCoinGeckoHistory(id, 90),
    ]);
  } else if (type === "fx") {
    const sym = query.toUpperCase();
    if (metal) {
      // Or / argent : pas d'historique gratuit, donc pas d'analyse technique.
      price = await fetchMetalPrice(sym);
      history = null;
    } else {
      history = await fetchFxHistory(sym);
      const last = history[history.length - 1];
      price = { price: last.close, change24h: null };
    }
  } else {
    const sym = query.toUpperCase();
    [price, history] = await Promise.all([
      fetchAlphaQuote(sym),
      fetchAlphaHistory(sym),
    ]);
  }

  let news = null;
  let newsError = "";
  try {
    news = await fetchNewsSentiment(query);
  } catch (e) {
    newsError = e.message;
  }

  // Pas assez d'historique (or/argent, ou série trop courte) pour une
  // analyse technique fiable : verdict basé uniquement sur les actualités.
  if (!history || history.length < 60) {
    let verdict = "mitigé";
    if (news?.label === "positif") verdict = "haussier";
    else if (news?.label === "négatif") verdict = "baissier";
    const reasoning = [
      history
        ? "Historique insuffisant pour une analyse technique complète (moins de 60 jours) — verdict basé sur les actualités uniquement"
        : "Historique de prix indisponible gratuitement pour l'or/l'argent — verdict basé sur les actualités uniquement",
      news
        ? `Actualités : ton ${news.label} sur ${news.articleCount} articles récents`
        : newsError
        ? `Actualités indisponibles : ${newsError}`
        : "Actualités non incluses",
    ];
    return {
      symbol: query.toUpperCase(),
      price: price.price,
      support: null,
      resistance: null,
      verdict,
      score: news?.label === "positif" ? 1 : news?.label === "négatif" ? -1 : 0,
      reasoning,
      news,
      atrStop: null,
      atrStopShort: null,
    };
  }

  const closes = history.map((h) => h.close);
  const currentPrice = closes[closes.length - 1];
  const lastIdx = history.length - 1;

  const ema20 = calcEMA(closes, 20)[lastIdx];
  const ema50 = calcEMA(closes, 50)[lastIdx];

  const { plusDI, minusDI, adx } = calcADX(history, 14);
  const adxLast = adx[lastIdx];
  const plusDILast = plusDI[lastIdx];
  const minusDILast = minusDI[lastIdx];

  const ichimoku = calcIchimoku(history);
  const cloudTop = ichimoku.cloudTopAt(lastIdx);
  const cloudBottom = ichimoku.cloudBottomAt(lastIdx);

  const structure = detectMarketStructure(history);
  const rsi = calcRSI(closes, 14)[lastIdx];
  const atr = calcATR(history, 14)[lastIdx];

  // ---- Pass 1 : nouveaux indicateurs (Trend / Momentum / Volatility) ----
  const smaLast = calcSMA(closes, 50)[lastIdx];
  const hmaSeries = calcHMA(closes, 20);
  const hmaLast = hmaSeries[lastIdx];
  const hmaPrev = hmaSeries[lastIdx - 1];

  const { macdLine, signalLine, histogram } = calcMACD(closes);
  const macdLast = macdLine[lastIdx];
  const macdSignalLast = signalLine[lastIdx];
  const macdHistLast = histogram[lastIdx];

  const supertrend = calcSupertrend(history, 10, 3);
  const supertrendLast = supertrend.trend[lastIdx];

  const aroon = calcAroon(history, 25);
  const aroonUpLast = aroon.aroonUp[lastIdx];
  const aroonDownLast = aroon.aroonDown[lastIdx];

  const psar = calcParabolicSAR(history);
  const psarLast = psar.sar[lastIdx];

  const stochastic = calcStochastic(history);
  const stochKLast = stochastic.k[lastIdx];
  const stochDLast = stochastic.d[lastIdx];

  const williamsRLast = calcWilliamsR(history)[lastIdx];
  const cciLast = calcCCI(history)[lastIdx];
  const rocLast = calcROC(closes)[lastIdx];
  const tsiLast = calcTSI(closes)[lastIdx];
  const aoSeries = calcAwesomeOscillator(history);
  const aoLast = aoSeries[lastIdx];
  const aoPrev = aoSeries[lastIdx - 1];

  const bb = calcBollingerBands(closes);
  const bbUpperLast = bb.upper[lastIdx];
  const bbLowerLast = bb.lower[lastIdx];

  const keltner = calcKeltnerChannels(history, closes);
  const keltnerUpperLast = keltner.upper[lastIdx];
  const keltnerLowerLast = keltner.lower[lastIdx];

  const stdDevLast = calcStdDev(closes)[lastIdx];
  const choppinessLast = calcChoppinessIndex(history)[lastIdx];
  const marketRegime = classifyMarketRegime(adxLast, choppinessLast);

  // ---- Pass 2 : Pivot Points & Fibonacci ----
  const pivots = calcAllPivots(history, lastIdx);
  const fibRetracement =
    structure.support != null && structure.resistance != null
      ? calcFibonacciRetracement(structure.support, structure.resistance)
      : null;
  const fibExtension =
    structure.support != null && structure.resistance != null && structure.regime !== "range"
      ? calcFibonacciExtension(structure.support, structure.resistance, structure.regime)
      : null;

  const atrSeriesAll = calcATR(history, 14).filter((v) => v != null);
  const atrAvg = atrSeriesAll.length ? atrSeriesAll.reduce((a, b) => a + b, 0) / atrSeriesAll.length : null;
  const volRegime =
    atrAvg != null && atr != null
      ? atr > atrAvg * 1.3
        ? "élevée"
        : atr < atrAvg * 0.7
        ? "faible"
        : "normale"
      : null;

  // --- Vote multi-facteurs : chaque brique contribue 1 point (0.5 pour un
  // signal de confirmation secondaire) au camp haussier ou baissier. ---
  let bull = 0, bear = 0;

  if (ema20 != null && ema50 != null) {
    if (currentPrice > ema20 && ema20 > ema50) bull += 1;
    else if (currentPrice < ema20 && ema20 < ema50) bear += 1;
  }

  if (adxLast != null && adxLast > 20 && plusDILast != null && minusDILast != null) {
    if (plusDILast > minusDILast) bull += 1;
    else if (minusDILast > plusDILast) bear += 1;
  }

  if (cloudTop != null && cloudBottom != null) {
    if (currentPrice > cloudTop) bull += 1;
    else if (currentPrice < cloudBottom) bear += 1;
  }

  if (structure.regime === "haussier") bull += 1;
  else if (structure.regime === "baissier") bear += 1;
  if (structure.bos) {
    if (structure.regime === "haussier") bull += 0.5;
    else bear += 0.5;
  }
  if (structure.choch) {
    // Une cassure du côté opposé à la tendance en cours est un signal de
    // retournement : elle vote contre le camp de la tendance affichée.
    if (structure.regime === "haussier") bear += 1;
    else bull += 1;
  }

  if (news?.label === "positif") bull += 1;
  else if (news?.label === "négatif") bear += 1;

  // MACD : croisement ligne MACD / ligne signal, confirmé par l'histogramme.
  if (macdLast != null && macdSignalLast != null) {
    if (macdLast > macdSignalLast && macdHistLast > 0) bull += 1;
    else if (macdLast < macdSignalLast && macdHistLast < 0) bear += 1;
  }

  // Supertrend : direction de la tendance.
  if (supertrendLast === "up") bull += 1;
  else if (supertrendLast === "down") bear += 1;

  // Signaux de confirmation secondaires (poids réduit, pour ne pas noyer
  // les signaux principaux ci-dessus) : SAR, Aroon, CCI, pente de la HMA.
  if (psarLast != null) {
    if (currentPrice > psarLast) bull += 0.5;
    else bear += 0.5;
  }
  if (aroonUpLast != null && aroonDownLast != null) {
    if (aroonUpLast > 70 && aroonUpLast > aroonDownLast) bull += 0.5;
    else if (aroonDownLast > 70 && aroonDownLast > aroonUpLast) bear += 0.5;
  }
  if (cciLast != null) {
    if (cciLast > 100) bull += 0.5;
    else if (cciLast < -100) bear += 0.5;
  }
  if (hmaLast != null && hmaPrev != null) {
    if (hmaLast > hmaPrev) bull += 0.5;
    else if (hmaLast < hmaPrev) bear += 0.5;
  }
  // Pivot Point standard : position du prix par rapport au pivot central,
  // signal de confirmation secondaire au même titre que les briques ci-dessus.
  if (pivots?.standard?.pp != null) {
    if (currentPrice > pivots.standard.pp) bull += 0.5;
    else if (currentPrice < pivots.standard.pp) bear += 0.5;
  }

  let verdict = "mitigé";
  if (bull - bear >= 2) verdict = "haussier";
  else if (bear - bull >= 2) verdict = "baissier";

  // RSI = garde-fou de prudence, pas un signal directionnel : un verdict
  // haussier sur un actif suracheté (ou baissier sur un actif survendu) est
  // ramené à "mitigé" pour éviter d'entrer trop tard sur le mouvement.
  if (verdict === "haussier" && rsi != null && rsi > 75) verdict = "mitigé";
  if (verdict === "baissier" && rsi != null && rsi < 25) verdict = "mitigé";

  // Stochastique : même logique de garde-fou que le RSI.
  if (verdict === "haussier" && stochKLast != null && stochKLast > 80) verdict = "mitigé";
  if (verdict === "baissier" && stochKLast != null && stochKLast < 20) verdict = "mitigé";

  // Choppiness Index > 61.8 : marché en range, aucune tendance fiable —
  // on neutralise le verdict quel que soit le score des autres briques.
  if (choppinessLast != null && choppinessLast > 61.8) verdict = "mitigé";

  const support = structure.support;
  const resistance = structure.resistance;
  // Stop-loss basé sur la volatilité réelle (ATR) plutôt qu'un pourcentage
  // fixe : plus l'actif est volatil, plus le stop est éloigné de l'entrée.
  const atrStop = support != null && atr != null ? support - 1.2 * atr : null;
  const atrStopShort = resistance != null && atr != null ? resistance + 1.2 * atr : null;

  // ---- Pass 3 : Entry Algos & Risk/Reward ----
  const zScoreLast = calcZScore(closes, 20)[lastIdx];
  const breakoutRetest = detectBreakoutRetest(history, structure);
  const pullback = detectPullback(currentPrice, ema20, structure.regime);
  const meanReversion = detectMeanReversion(zScoreLast);

  const riskReward =
    structure.regime === "haussier"
      ? calcRiskReward(currentPrice, atrStop, resistance)
      : structure.regime === "baissier"
      ? calcRiskReward(currentPrice, atrStopShort, support)
      : null;

  const trendLabel =
    ema20 != null && ema50 != null
      ? currentPrice > ema20 && ema20 > ema50
        ? "haussière"
        : currentPrice < ema20 && ema20 < ema50
        ? "baissière"
        : "mixte"
      : null;

  const reasoning = [
    trendLabel && `EMA20/EMA50 : tendance ${trendLabel}`,
    smaLast != null && `SMA(50) : $${smaLast.toFixed(2)} — prix ${currentPrice > smaLast ? "au-dessus" : "en-dessous"}`,
    hmaLast != null &&
      `HMA(20) : $${hmaLast.toFixed(2)}, pente ${hmaPrev != null ? (hmaLast > hmaPrev ? "haussière" : "baissière") : "n/a"}`,
    macdLast != null &&
      `MACD(12,26,9) : ligne ${macdLast.toFixed(2)} vs signal ${macdSignalLast.toFixed(2)}, histogramme ${macdHistLast > 0 ? "positif" : "négatif"}`,
    supertrendLast && `Supertrend(10,3) : tendance ${supertrendLast === "up" ? "haussière" : "baissière"}`,
    aroonUpLast != null && `Aroon(25) : Up ${aroonUpLast.toFixed(0)} / Down ${aroonDownLast.toFixed(0)}`,
    psarLast != null && `Parabolic SAR : $${psarLast.toFixed(2)} (prix ${currentPrice > psarLast ? "au-dessus" : "en-dessous"})`,
    adxLast != null &&
      `ADX ${adxLast.toFixed(0)} (${adxLast > 20 ? "tendance significative" : "pas de tendance nette"}), +DI ${plusDILast?.toFixed(0)} / -DI ${minusDILast?.toFixed(0)}`,
    cloudTop != null
      ? `Prix ${currentPrice > cloudTop ? "au-dessus" : currentPrice < cloudBottom ? "en-dessous" : "dans"} le nuage Ichimoku`
      : null,
    `Structure de marché : ${structure.regime}${structure.bos ? " — cassure de continuation (BOS)" : ""}${structure.choch ? " — signal de retournement (CHOCH)" : ""}`,
    support != null && `Support (swing low) : $${support.toFixed(2)} — Résistance (swing high) : $${resistance.toFixed(2)}`,
    rsi != null &&
      `RSI(14) : ${rsi.toFixed(0)}${rsi > 75 ? " — suracheté, prudence" : rsi < 25 ? " — survendu, prudence" : ""}`,
    stochKLast != null &&
      `Stochastique(14,3,3) : %K ${stochKLast.toFixed(0)} / %D ${stochDLast != null ? stochDLast.toFixed(0) : "n/a"}${stochKLast > 80 ? " — suracheté" : stochKLast < 20 ? " — survendu" : ""}`,
    williamsRLast != null &&
      `Williams %R(14) : ${williamsRLast.toFixed(0)}${williamsRLast > -20 ? " — suracheté" : williamsRLast < -80 ? " — survendu" : ""}`,
    cciLast != null &&
      `CCI(20) : ${cciLast.toFixed(0)}${cciLast > 100 ? " — zone haussière extrême" : cciLast < -100 ? " — zone baissière extrême" : ""}`,
    rocLast != null && `ROC(12) : ${rocLast > 0 ? "+" : ""}${rocLast.toFixed(1)}%`,
    tsiLast != null && `TSI(25,13) : ${tsiLast.toFixed(0)}`,
    aoLast != null &&
      `Awesome Oscillator : ${aoLast > 0 ? "positif" : "négatif"}${aoPrev != null ? (aoLast > aoPrev ? ", en hausse" : ", en baisse") : ""}`,
    bbUpperLast != null &&
      `Bollinger Bands(20,2) : prix ${currentPrice > bbUpperLast ? "au-dessus de la bande haute" : currentPrice < bbLowerLast ? "en-dessous de la bande basse" : "dans le canal"} ($${bbLowerLast.toFixed(2)} – $${bbUpperLast.toFixed(2)})`,
    keltnerUpperLast != null &&
      `Keltner Channels(20, 2×ATR) : $${keltnerLowerLast.toFixed(2)} – $${keltnerUpperLast.toFixed(2)}`,
    stdDevLast != null && `Écart-type(20) des clôtures : $${stdDevLast.toFixed(2)}`,
    choppinessLast != null && `Choppiness Index(14) : ${choppinessLast.toFixed(0)}`,
    `Régime de marché : ${marketRegime}${volRegime ? ` — volatilité ${volRegime}` : ""}`,
    pivots?.standard != null &&
      `Pivot Point (Standard) : $${pivots.standard.pp.toFixed(2)} — R1 $${pivots.standard.r1.toFixed(2)} / S1 $${pivots.standard.s1.toFixed(2)}, prix ${currentPrice > pivots.standard.pp ? "au-dessus" : "en-dessous"} du pivot`,
    pivots?.camarilla != null &&
      `Pivot Camarilla : R3 $${pivots.camarilla.r3.toFixed(2)} / S3 $${pivots.camarilla.s3.toFixed(2)} (zones de retournement intraday)`,
    fibRetracement != null &&
      `Retracements Fibonacci du dernier swing : 38,2% $${fibRetracement["0.382"].toFixed(2)} — 50% $${fibRetracement["0.5"].toFixed(2)} — 61,8% $${fibRetracement["0.618"].toFixed(2)}`,
    fibExtension != null &&
      `Extensions Fibonacci (cibles de continuation ${structure.regime}) : 127,2% $${fibExtension["1.272"].toFixed(2)} — 161,8% $${fibExtension["1.618"].toFixed(2)}`,
    breakoutRetest?.active &&
      `Breakout+Retest : cassure ${breakoutRetest.direction} de $${breakoutRetest.level.toFixed(2)} confirmée, retest en cours (${breakoutRetest.distancePct.toFixed(1)}% du niveau)`,
    pullback?.active &&
      `Pullback Entry : repli sur l'EMA20 ($${pullback.ema20.toFixed(2)}, ${pullback.distancePct.toFixed(1)}% d'écart) dans une tendance ${structure.regime}`,
    meanReversion?.active &&
      `Mean Reversion : Z-score ${meanReversion.zScore.toFixed(2)} — extension statistique, pari sur un retour ${meanReversion.direction}`,
    riskReward != null &&
      `Risk/Reward : 1:${riskReward.ratio.toFixed(1)} (risque $${riskReward.risk.toFixed(2)} pour un potentiel de $${riskReward.reward.toFixed(2)})`,
    atr != null &&
      `ATR(14) : $${atr.toFixed(2)}${atrAvg != null ? ` (moyenne : $${atrAvg.toFixed(2)})` : ""}${type === "crypto" ? " — approximé en clôture-à-clôture faute d'OHLC gratuit" : ""}`,
    news
      ? `Actualités : ton ${news.label} sur ${news.articleCount} articles récents`
      : newsError
      ? `Actualités indisponibles : ${newsError}`
      : "Actualités non incluses",
  ].filter(Boolean);

  return {
    symbol: query.toUpperCase(),
    price: currentPrice,
    support,
    resistance,
    verdict,
    score: bull - bear,
    reasoning,
    news,
    atrStop,
    atrStopShort,
    pivots,
    fibRetracement,
    fibExtension,
    breakoutRetest,
    pullback,
    meanReversion,
    riskReward,
  };
}

// ---------- UI: petit composant de tendance ----------
function TrendBadge({ label, trend }) {
  if (!trend) return null;
  const color = trend.direction === "haussier" ? POS : trend.direction === "baissier" ? NEG : MUTED;
  const Icon = trend.direction === "haussier" ? TrendingUp : trend.direction === "baissier" ? TrendingDown : Minus;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, background: NAVY, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 10px" }}>
      <Icon size={14} color={color} />
      <div>
        <div style={{ fontSize: 11, color: MUTED }}>{label}</div>
        <div style={{ fontSize: 13, fontWeight: 700, color }}>
          {trend.direction} ({trend.pct > 0 ? "+" : ""}{trend.pct.toFixed(1)}%)
        </div>
      </div>
    </div>
  );
}

// ================= Scanner =================
const FX_SHORTCUTS = [
  { label: "Or (XAU)", type: "fx", query: "XAU" },
  { label: "Argent (XAG)", type: "fx", query: "XAG" },
  { label: "EUR/USD", type: "fx", query: "EUR" },
  { label: "GBP/USD", type: "fx", query: "GBP" },
];

function Scanner({ onPick }) {
  const [coins, setCoins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchCoinGeckoTop(10)
      .then(setCoins)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
        Or &amp; devises
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
        {FX_SHORTCUTS.map((s) => (
          <button
            key={s.query}
            onClick={() => onPick(s)}
            style={{
              padding: "8px 12px",
              borderRadius: 20,
              border: `1px solid ${LINE}`,
              background: PANEL,
              color: TEXT,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 13, color: MUTED, marginBottom: 14 }}>
        Top 10 crypto par capitalisation — clique un actif pour l'ouvrir dans Prix &amp; Niveaux.
      </div>
      {loading && <Loader2 className="spin" size={20} color={ACCENT} />}
      {error && <div style={{ color: NEG, fontSize: 13 }}>{error}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {coins.map((c) => (
          <button
            key={c.id}
            onClick={() => onPick({ type: "crypto", query: c.id })}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: PANEL,
              border: `1px solid ${LINE}`,
              borderRadius: 10,
              padding: "12px 14px",
              cursor: "pointer",
              color: TEXT,
              textAlign: "left",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <img src={c.image} alt="" width={22} height={22} style={{ borderRadius: "50%" }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</div>
                <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase" }}>{c.symbol}</div>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>${c.current_price.toLocaleString()}</div>
              <div style={{ fontSize: 12, color: c.price_change_percentage_24h >= 0 ? POS : NEG }}>
                {c.price_change_percentage_24h >= 0 ? "+" : ""}
                {c.price_change_percentage_24h?.toFixed(2)}%
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ================= Prix & Niveaux =================
function PrixNiveaux({ prefill, setTab, setPrefillCalc }) {
  const [type, setType] = useState(prefill?.type || "crypto");
  const [query, setQuery] = useState(prefill?.query || "");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const runSearch = useCallback(async (t, q) => {
    if (!q) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      if (t === "crypto") {
        const [price, history] = await Promise.all([
          fetchCoinGeckoPrice(q.toLowerCase()),
          fetchCoinGeckoHistory(q.toLowerCase(), 30),
        ]);
        const { support, resistance } = supportResistance(history);
        setResult({ ...price, support, resistance, symbol: q.toUpperCase() });
      } else if (t === "fx") {
        if (isMetal(q)) {
          // Or / argent : prix temps réel via gold-api.com, pas d'historique
          // gratuit disponible donc pas de support/résistance pour ces deux actifs.
          const price = await fetchMetalPrice(q);
          setResult({ ...price, support: null, resistance: null, symbol: `${q.toUpperCase()}/USD` });
        } else {
          const [price, history] = await Promise.all([
            fetchFxQuote(q.toUpperCase()),
            fetchFxHistory(q.toUpperCase()),
          ]);
          const { support, resistance } = supportResistance(history);
          setResult({ ...price, support, resistance, symbol: `${q.toUpperCase()}/USD` });
        }
      } else {
        const [price, history] = await Promise.all([
          fetchAlphaQuote(q.toUpperCase()),
          fetchAlphaHistory(q.toUpperCase()),
        ]);
        const { support, resistance } = supportResistance(history);
        setResult({ ...price, support, resistance, symbol: q.toUpperCase() });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (prefill?.query) runSearch(prefill.type, prefill.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const TYPES = [
    { id: "crypto", label: "Crypto" },
    { id: "stock", label: "Actions" },
    { id: "fx", label: "Devises & Or" },
  ];

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {TYPES.map(({ id: t, label }) => (
          <button
            key={t}
            onClick={() => setType(t)}
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${type === t ? ACCENT : LINE}`,
              background: type === t ? "rgba(79,140,255,0.12)" : "transparent",
              color: type === t ? ACCENT : MUTED,
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          runSearch(type, query);
        }}
        style={{ display: "flex", gap: 8, marginBottom: 16 }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={type === "crypto" ? "ex: bitcoin" : type === "fx" ? "ex: XAU (or), EUR, GBP" : "ex: TSLA"}
          style={{
            flex: 1,
            background: NAVY,
            border: `1px solid ${LINE}`,
            borderRadius: 8,
            padding: "10px 12px",
            color: TEXT,
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          style={{ background: ACCENT, border: "none", borderRadius: 8, padding: "0 14px", cursor: "pointer" }}
        >
          <Search size={16} color="#fff" />
        </button>
      </form>

      {loading && <Loader2 className="spin" size={20} color={ACCENT} />}
      {error && <div style={{ color: NEG, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {result && (
        <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{result.symbol}</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>${result.price.toLocaleString()}</div>
          </div>

          {result.support != null ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
              <div style={{ background: NAVY, borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 11, color: MUTED }}>Support (30j)</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: POS }}>${result.support.toFixed(2)}</div>
              </div>
              <div style={{ background: NAVY, borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 11, color: MUTED }}>Résistance (30j)</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: NEG }}>${result.resistance.toFixed(2)}</div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>
              Historique indisponible gratuitement pour l'or/l'argent — prix en temps réel uniquement.
            </div>
          )}

          <button
            onClick={() => {
              setPrefillCalc(
                result.support != null
                  ? { entry: result.price, stop: result.support }
                  : { entry: result.price }
              );
              setTab("calc");
            }}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              background: "rgba(79,140,255,0.12)",
              border: `1px solid ${ACCENT}`,
              color: ACCENT,
              borderRadius: 8,
              padding: "9px 0",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <Send size={13} /> Envoyer au calculateur
          </button>
        </div>
      )}
    </div>
  );
}

// ================= Dossier d'analyse =================
function Dossier({ setTab, setPrefillCalc }) {
  const [type, setType] = useState("crypto");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dossier, setDossier] = useState(null);

  const analyser = async () => {
    if (!query) return;
    setLoading(true);
    setError("");
    setDossier(null);
    try {
      const result = await runMarketAnalysis(type, query);
      setDossier(result);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const verdictColor = dossier?.verdict === "haussier" ? POS : dossier?.verdict === "baissier" ? NEG : MUTED;

  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 12 }}>
        Analyse multi-échelles + niveaux + sentiment actu, avec raisonnement détaillé. Ce n'est pas un signal garanti, juste une synthèse structurée.
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {[
          { id: "crypto", label: "Crypto" },
          { id: "stock", label: "Actions" },
          { id: "fx", label: "Devises & Or" },
        ].map(({ id: t, label }) => (
          <button
            key={t}
            onClick={() => setType(t)}
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${type === t ? ACCENT : LINE}`,
              background: type === t ? "rgba(79,140,255,0.12)" : "transparent",
              color: type === t ? ACCENT : MUTED,
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          analyser();
        }}
        style={{ display: "flex", gap: 8, marginBottom: 16 }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={type === "crypto" ? "ex: bitcoin" : type === "fx" ? "ex: XAU (or), EUR, GBP" : "ex: TSLA"}
          style={{ flex: 1, background: NAVY, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px", color: TEXT, fontSize: 14 }}
        />
        <button type="submit" style={{ background: ACCENT, border: "none", borderRadius: 8, padding: "0 14px", cursor: "pointer", color: "#fff", fontWeight: 600, fontSize: 13 }}>
          Analyser
        </button>
      </form>

      {loading && <Loader2 className="spin" size={20} color={ACCENT} />}
      {error && <div style={{ color: NEG, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {dossier && (
        <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{dossier.symbol}</div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: verdictColor,
                background: `${verdictColor}22`,
                padding: "4px 10px",
                borderRadius: 20,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {dossier.verdict}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
            {dossier.reasoning.map((line, i) => (
              <div key={i} style={{ fontSize: 13, color: MUTED, display: "flex", gap: 6 }}>
                <span style={{ color: ACCENT }}>•</span> {line}
              </div>
            ))}
          </div>

          {dossier.pivots && (
            <div style={{ marginBottom: 14, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 8, textTransform: "uppercase" }}>
                Pivot Points (Standard)
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6, marginBottom: 12 }}>
                <div style={{ background: NAVY, borderRadius: 8, padding: 8, textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: MUTED }}>S1</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: POS }}>${dossier.pivots.standard.s1.toFixed(2)}</div>
                </div>
                <div style={{ background: NAVY, borderRadius: 8, padding: 8, textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: MUTED }}>Pivot</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: ACCENT }}>${dossier.pivots.standard.pp.toFixed(2)}</div>
                </div>
                <div style={{ background: NAVY, borderRadius: 8, padding: 8, textAlign: "center" }}>
                  <div style={{ fontSize: 10, color: MUTED }}>R1</div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: NEG }}>${dossier.pivots.standard.r1.toFixed(2)}</div>
                </div>
              </div>

              {dossier.fibRetracement && (
                <>
                  <div style={{ fontSize: 11, color: MUTED, marginBottom: 8, textTransform: "uppercase" }}>
                    Retracements Fibonacci (dernier swing)
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: dossier.fibExtension ? 12 : 0 }}>
                    {["0.236", "0.382", "0.5", "0.618", "0.786"].map((k) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                        <span style={{ color: MUTED }}>{(parseFloat(k) * 100).toFixed(1)}%</span>
                        <span style={{ color: TEXT, fontWeight: 600 }}>${dossier.fibRetracement[k].toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

              {dossier.fibExtension && (
                <>
                  <div style={{ fontSize: 11, color: MUTED, marginBottom: 8, textTransform: "uppercase" }}>
                    Extensions Fibonacci (cibles)
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {["1.272", "1.618", "2.0"].map((k) => (
                      <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
                        <span style={{ color: MUTED }}>{(parseFloat(k) * 100).toFixed(1)}%</span>
                        <span style={{ color: ACCENT, fontWeight: 600 }}>${dossier.fibExtension[k].toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          )}

          {(dossier.breakoutRetest?.active || dossier.pullback?.active || dossier.meanReversion?.active || dossier.riskReward) && (
            <div style={{ marginBottom: 14, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 8, textTransform: "uppercase" }}>
                Setups d'entrée
              </div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {dossier.breakoutRetest?.active && (
                  <div style={{ background: NAVY, borderRadius: 8, padding: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: ACCENT }}>Breakout + Retest</div>
                    <div style={{ fontSize: 12, color: MUTED }}>
                      Cassure {dossier.breakoutRetest.direction} de ${dossier.breakoutRetest.level.toFixed(2)}, retest à {dossier.breakoutRetest.distancePct.toFixed(1)}%
                    </div>
                  </div>
                )}
                {dossier.pullback?.active && (
                  <div style={{ background: NAVY, borderRadius: 8, padding: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: ACCENT }}>Pullback Entry</div>
                    <div style={{ fontSize: 12, color: MUTED }}>
                      Repli sur l'EMA20 (${dossier.pullback.ema20.toFixed(2)}, {dossier.pullback.distancePct.toFixed(1)}% d'écart)
                    </div>
                  </div>
                )}
                {dossier.meanReversion?.active && (
                  <div style={{ background: NAVY, borderRadius: 8, padding: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: ACCENT }}>Mean Reversion</div>
                    <div style={{ fontSize: 12, color: MUTED }}>
                      Z-score {dossier.meanReversion.zScore.toFixed(2)} — pari {dossier.meanReversion.direction} (contrarian)
                    </div>
                  </div>
                )}
                {dossier.riskReward && (
                  <div style={{ background: NAVY, borderRadius: 8, padding: 10, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: MUTED }}>Risk/Reward</span>
                    <span style={{ fontSize: 15, fontWeight: 700, color: dossier.riskReward.ratio >= 2 ? POS : dossier.riskReward.ratio >= 1 ? MUTED : NEG }}>
                      1:{dossier.riskReward.ratio.toFixed(1)}
                    </span>
                  </div>
                )}
              </div>
            </div>
          )}

          {dossier.news?.headlines?.length > 0 && (
            <div style={{ marginBottom: 14, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 6, textTransform: "uppercase" }}>Titres récents</div>
              {dossier.news.headlines.map((h, i) => (
                <div key={i} style={{ fontSize: 12, color: TEXT, marginBottom: 4 }}>
                  {h}
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => {
              setPrefillCalc(
                dossier.support != null
                  ? {
                      entry: dossier.price,
                      stop:
                        dossier.verdict === "baissier"
                          ? dossier.atrStopShort ?? dossier.resistance
                          : dossier.atrStop ?? dossier.support,
                    }
                  : { entry: dossier.price }
              );
              setTab("calc");
            }}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              background: "rgba(79,140,255,0.12)",
              border: `1px solid ${ACCENT}`,
              color: ACCENT,
              borderRadius: 8,
              padding: "9px 0",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <Send size={13} /> Envoyer au calculateur
          </button>
        </div>
      )}
    </div>
  );
}

// ================= Top 15 marchés =================
// Liste fixe : 8 cryptos (CoinGecko, gratuit/illimité) + or/argent
// (gold-api.com, gratuit/illimité) + 5 devises majeures (Alpha Vantage,
// 1 seul appel chacune grâce à runMarketAnalysis) = 5 crédits Alpha Vantage
// consommés par scan, sur un quota de 25/jour.
const WATCHLIST = [
  { type: "crypto", query: "bitcoin", label: "Bitcoin (BTC)" },
  { type: "crypto", query: "ethereum", label: "Ethereum (ETH)" },
  { type: "crypto", query: "solana", label: "Solana (SOL)" },
  { type: "crypto", query: "binancecoin", label: "BNB" },
  { type: "crypto", query: "ripple", label: "XRP" },
  { type: "crypto", query: "cardano", label: "Cardano (ADA)" },
  { type: "crypto", query: "dogecoin", label: "Dogecoin (DOGE)" },
  { type: "crypto", query: "avalanche-2", label: "Avalanche (AVAX)" },
  { type: "fx", query: "XAU", label: "Or (XAU/USD)" },
  { type: "fx", query: "XAG", label: "Argent (XAG/USD)" },
  { type: "fx", query: "EUR", label: "EUR/USD" },
  { type: "fx", query: "GBP", label: "GBP/USD" },
  { type: "fx", query: "JPY", label: "JPY/USD" },
  { type: "fx", query: "CHF", label: "CHF/USD" },
  { type: "fx", query: "CAD", label: "CAD/USD" },
];

// Traduction du verdict en action concrète pour l'utilisateur.
const ACTION_MAP = {
  haussier: { label: "GO", color: POS },
  baissier: { label: "AVOID", color: NEG },
  mitigé: { label: "WAIT", color: MUTED },
};

// "Bitcoin (BTC)" -> { name: "Bitcoin", ticker: "BTC" }. Si pas de
// parenthèses (ex: "EUR/USD"), le label entier sert de nom.
function splitLabel(label) {
  const m = label.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (m) return { name: m[1], ticker: m[2] };
  return { name: label, ticker: "" };
}

function TopMarkets({ onSendToCalculator }) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: WATCHLIST.length });
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [hasRun, setHasRun] = useState(false);

  const runScan = async () => {
    setLoading(true);
    setError("");
    setResults([]);
    setProgress({ done: 0, total: WATCHLIST.length });
    const out = [];

    for (const item of WATCHLIST) {
      try {
        const r = await runMarketAnalysis(item.type, item.query);
        out.push({ ...r, label: item.label, type: item.type, query: item.query });
      } catch (e) {
        out.push({ label: item.label, type: item.type, query: item.query, error: e.message });
      }
      setProgress((p) => ({ ...p, done: p.done + 1 }));
      // Pause de sécurité entre chaque appel : CoinGecko rate-limite si on
      // enchaîne trop de requêtes d'affilée (d'où les "Failed to fetch" sur
      // les cryptos), et Alpha Vantage limite à 5 requêtes/minute en plus
      // du quota de 25/jour.
      if (item.type === "fx" && !isMetal(item.query)) {
        await new Promise((res) => setTimeout(res, 3000));
      } else {
        await new Promise((res) => setTimeout(res, 800));
      }
    }

    const ok = out.filter((r) => !r.error);
    const failed = out.filter((r) => r.error);
    ok.sort((a, b) => b.score - a.score);
    setResults([...ok, ...failed]);
    if (failed.length > 0 && ok.length === 0) {
      setError("Le scan a échoué pour tous les marchés — réessaie plus tard.");
    }
    setHasRun(true);
    setLoading(false);
  };

  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>
        Scan classé de 15 marchés (8 cryptos, or, argent, 5 devises majeures) avec la même
        analyse que le Dossier — tendances 7j/30j/90j + sentiment des actualités. Clique un
        marché pour l'envoyer directement au calculateur. Le scan prend environ 20 à 30 secondes.
      </div>

      <button
        onClick={runScan}
        disabled={loading}
        style={{
          width: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 8,
          background: loading ? PANEL : ACCENT,
          border: "none",
          borderRadius: 8,
          padding: "12px 0",
          color: loading ? MUTED : "#fff",
          fontWeight: 700,
          fontSize: 14,
          cursor: loading ? "default" : "pointer",
          marginBottom: 16,
        }}
      >
        {loading ? (
          <>
            <Loader2 className="spin" size={16} /> Analyse {progress.done}/{progress.total}…
          </>
        ) : (
          <>
            <ListOrdered size={16} /> {hasRun ? "Relancer le scan" : "Lancer le scan"}
          </>
        )}
      </button>

      {error && <div style={{ color: NEG, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {results.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {results.map((r) => {
            const { name, ticker } = splitLabel(r.label);

            if (r.error) {
              return (
                <div
                  key={`${r.type}-${r.query}`}
                  style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}
                >
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 2 }}>{name}</div>
                  <div style={{ fontSize: 12, color: NEG }}>{r.error}</div>
                </div>
              );
            }

            const action = ACTION_MAP[r.verdict] || ACTION_MAP["mitigé"];
            const hasLevels = r.support != null && r.resistance != null;
            // Prix d'achat = support (swing low, zone d'entrée) ; prix de
            // vente = résistance (swing high, zone de sortie). Stop-loss =
            // support - 1.2×ATR, dimensionné sur la volatilité réelle de
            // l'actif (repli sur -2% si l'ATR est indisponible). Pour
            // l'or/argent (pas d'historique gratuit), on n'envoie que le prix actuel.
            const buyPrice = hasLevels ? r.support : r.price;
            const sellPrice = hasLevels ? r.resistance : null;
            const stopPrice = hasLevels ? r.atrStop ?? buyPrice * 0.98 : null;

            return (
              <button
                key={`${r.type}-${r.query}`}
                onClick={() =>
                  onSendToCalculator(
                    hasLevels
                      ? { entry: buyPrice, stop: stopPrice, takeProfit: sellPrice }
                      : { entry: buyPrice }
                  )
                }
                style={{
                  background: PANEL,
                  border: `1px solid ${LINE}`,
                  borderRadius: 10,
                  padding: "12px 14px",
                  cursor: "pointer",
                  color: TEXT,
                  textAlign: "left",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: hasLevels ? 10 : 0 }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{name}</div>
                    {ticker && (
                      <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase" }}>{ticker}</div>
                    )}
                    <div style={{ fontSize: 13, fontWeight: 600, marginTop: 4 }}>${r.price.toLocaleString()}</div>
                  </div>
                  <div
                    style={{
                      fontSize: 12,
                      fontWeight: 800,
                      color: action.color,
                      background: `${action.color}22`,
                      padding: "5px 12px",
                      borderRadius: 20,
                      letterSpacing: 0.5,
                    }}
                  >
                    {action.label}
                  </div>
                </div>

                {hasLevels && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                    <div style={{ background: NAVY, borderRadius: 8, padding: 8 }}>
                      <div style={{ fontSize: 10, color: MUTED }}>Prix d'achat</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: POS }}>${buyPrice.toFixed(2)}</div>
                    </div>
                    <div style={{ background: NAVY, borderRadius: 8, padding: 8 }}>
                      <div style={{ fontSize: 10, color: MUTED }}>Prix de vente</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: NEG }}>${sellPrice.toFixed(2)}</div>
                    </div>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ================= Calculateur =================
const LEVERAGE_PRESETS = {
  crypto: { label: "Crypto (CFD)", leverage: 2 },
  forex: { label: "Forex", leverage: 30 },
  actions: { label: "Actions", leverage: 5 },
  matieres: { label: "Matières premières / Or", leverage: 20 },
  spot: { label: "Spot (Binance, sans levier)", leverage: 1 },
};

// Défini en dehors de Calculateur : sinon React recrée ce composant à
// chaque frappe et l'input perd le focus après chaque caractère.
function CalcField({ label, value, onChange, placeholder }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
        style={{ width: "100%", background: NAVY, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px", color: TEXT, fontSize: 14 }}
      />
    </div>
  );
}

function Calculateur({ prefill }) {
  const [assetType, setAssetType] = useState("crypto");
  const [invested, setInvested] = useState("50");
  const [leverage, setLeverage] = useState(LEVERAGE_PRESETS.crypto.leverage.toString());
  const [entry, setEntry] = useState(prefill?.entry?.toString() || "");
  const [stop, setStop] = useState(prefill?.stop?.toString() || "");
  const [takeProfit, setTakeProfit] = useState(prefill?.takeProfit?.toString() || "");

  useEffect(() => {
    if (prefill?.entry) setEntry(prefill.entry.toString());
    if (prefill?.stop) setStop(prefill.stop.toString());
    if (prefill?.takeProfit) setTakeProfit(prefill.takeProfit.toString());
  }, [prefill]);

  const onAssetType = (t) => {
    setAssetType(t);
    setLeverage(LEVERAGE_PRESETS[t].leverage.toString());
  };

  const inv = parseFloat(invested);
  const lev = parseFloat(leverage);
  const e = parseFloat(entry);
  const s = parseFloat(stop);
  const tp = parseFloat(takeProfit);

  const valid = inv > 0 && lev > 0 && e > 0 && s > 0 && e !== s;
  const positionValue = valid ? inv * lev : null; // taille totale de la position en €
  const quantity = valid ? positionValue / e : null; // à saisir dans le champ "Taille"/"Quantité" du broker
  const distance = valid ? Math.abs(e - s) : null; // "Distance" du stop, comme sur Capital.com
  const distancePct = valid ? (distance / e) * 100 : null; // "Distance (%)"
  const lossAmount = valid ? quantity * distance : null;
  const lossPctOfInvested = valid ? (lossAmount / inv) * 100 : null;
  const gainAmount = valid && tp > 0 ? quantity * Math.abs(tp - e) : null;
  const gainDistance = valid && tp > 0 ? Math.abs(tp - e) : null;
  const gainDistancePct = valid && tp > 0 ? (gainDistance / e) * 100 : null;

  return (
    <div>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Type d'actif (fixe le levier par défaut)</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {Object.entries(LEVERAGE_PRESETS).map(([key, v]) => (
          <button
            key={key}
            onClick={() => onAssetType(key)}
            style={{
              padding: "6px 10px",
              borderRadius: 20,
              border: `1px solid ${assetType === key ? ACCENT : LINE}`,
              background: assetType === key ? "rgba(79,140,255,0.12)" : "transparent",
              color: assetType === key ? ACCENT : MUTED,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {v.label}
          </button>
        ))}
      </div>

      <CalcField label="Montant à investir — ta mise / marge (€)" value={invested} onChange={setInvested} placeholder="ex: 50" />
      <CalcField label="Levier (x1 = sans levier, ex: Binance spot)" value={leverage} onChange={setLeverage} placeholder="ex: 2" />
      <CalcField label="Prix d'entrée" value={entry} onChange={setEntry} placeholder="ex: 4346.55" />
      <CalcField label="Stop-loss" value={stop} onChange={setStop} placeholder="ex: 4300.00" />
      <CalcField label="Take-profit (optionnel)" value={takeProfit} onChange={setTakeProfit} placeholder="ex: 4420.00" />

      {valid ? (
        <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 16, marginTop: 8 }}>
          <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${LINE}` }}>
            <div style={{ fontSize: 12, color: ACCENT, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
              À saisir sur Capital.com / Binance
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 13, color: MUTED }}>Taille</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: ACCENT }}>{quantity.toFixed(6)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
              <span style={{ fontSize: 13, color: MUTED }}>Stop loss — Niveau de prix</span>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{s}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: MUTED }}>Distance</span>
              <span style={{ fontSize: 12, color: MUTED }}>
                {distance.toFixed(2)} ({distancePct.toFixed(2)}%)
              </span>
            </div>
            {tp > 0 && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span style={{ fontSize: 13, color: MUTED }}>Take-profit — Niveau de prix</span>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{tp}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, color: MUTED }}>Distance</span>
                  <span style={{ fontSize: 12, color: MUTED }}>
                    {gainDistance.toFixed(2)} ({gainDistancePct.toFixed(2)}%)
                  </span>
                </div>
              </>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: MUTED }}>Taille totale de la position</span>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{positionValue.toFixed(2)} €</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: MUTED }}>Marge requise</span>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{inv.toFixed(2)} €</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: MUTED }}>Perte si stop touché</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: NEG }}>
              -{lossAmount.toFixed(2)} € ({lossPctOfInvested.toFixed(0)}% de ta mise)
            </span>
          </div>
          {gainAmount !== null && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13, color: MUTED }}>Gain si take-profit touché</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: POS }}>+{gainAmount.toFixed(2)} €</span>
            </div>
          )}
          {lossPctOfInvested > 100 && (
            <div style={{ fontSize: 11, color: NEG, marginTop: 10 }}>
              ⚠️ La perte potentielle dépasse ta mise de départ — avec ce levier, ta position peut être liquidée avant que le stop ne soit atteint. Réduis le levier ou resserre le stop.
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>Remplis montant, levier, entrée et stop-loss pour voir le calcul.</div>
      )}
    </div>
  );
}

// ================= App =================
export default function TradingApp() {
  const [tab, setTab] = useState("top15");
  const [prefillPrix, setPrefillPrix] = useState(null);
  const [prefillCalc, setPrefillCalc] = useState(null);

  const tabs = [
    { id: "top15", label: "Top 15", icon: ListOrdered },
    { id: "scan", label: "Scanner", icon: Search },
    { id: "prix", label: "Prix & Niveaux", icon: LineChart },
    { id: "dossier", label: "Dossier", icon: FileText },
    { id: "calc", label: "Calculateur", icon: Calculator },
  ];

  return (
    <div style={{ minHeight: "100vh", background: NAVY, color: TEXT, padding: "28px 18px 60px" }}>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 0.8s linear infinite; }
      `}</style>

      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: ACCENT, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>
            Discipline de trading
          </div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>Top 15 marchés &amp; calculateur</div>
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: `1px solid ${LINE}`, paddingBottom: 4, flexWrap: "wrap" }}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "none",
                color: tab === id ? TEXT : MUTED,
                fontWeight: tab === id ? 700 : 500,
                fontSize: 13,
                padding: "8px 10px",
                borderBottom: tab === id ? `2px solid ${ACCENT}` : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {tab === "top15" && (
          <TopMarkets
            onSendToCalculator={(prefill) => {
              setPrefillCalc(prefill);
              setTab("calc");
            }}
          />
        )}
        {tab === "scan" && (
          <Scanner
            onPick={(r) => {
              setPrefillPrix(r);
              setTab("prix");
            }}
          />
        )}
        {tab === "prix" && (
          <PrixNiveaux prefill={prefillPrix} setTab={setTab} setPrefillCalc={setPrefillCalc} />
        )}
        {tab === "dossier" && (
          <Dossier setTab={setTab} setPrefillCalc={setPrefillCalc} />
        )}
        {tab === "calc" && <Calculateur prefill={prefillCalc} />}
      </div>
    </div>
  );
}
