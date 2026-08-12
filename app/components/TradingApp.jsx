"use client";

import { useState, useEffect, useCallback } from "react";
import { calculateSentinelScore } from "../lib/sentinelEngine";
import {
  FileText,
  Calculator,
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  Send,
  ListOrdered,
  Lock,
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
const AMBER = "#FCD34D"; // amber-300
const LOCKED_BG = "#10151F";

// ---------- Formatage des prix ----------
// Décimales adaptatives selon l'ordre de grandeur : un prix fixe à 2
// décimales écrase le mouvement réel sur les actifs sous $1 (JPY/USD,
// DOGE, etc.) où tout se joue à la 4e/5e décimale.
function formatPrice(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  let decimals;
  if (abs === 0) decimals = 2;
  else if (abs < 0.01) decimals = 6;
  else if (abs < 1) decimals = 4;
  else if (abs < 10) decimals = 3;
  else decimals = 2;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// ---------- Helper: extrait un message d'erreur exploitable d'une réponse Alpha Vantage ----------
// Alpha Vantage renvoie l'erreur / le message de quota sous des clés différentes
// selon le cas : "Note" (ancien format quota), "Information" (nouveau format,
// quota ou fonction premium), "Error Message" (paramètre/symbole invalide).
function alphaVantageErrorMessage(data) {
  return data?.Note || data?.Information || data?.["Error Message"] || null;
}

// ---------- Cache mémoire avec expiration ----------
// Le quota Alpha Vantage (25 req/jour gratuit) s'épuise très vite dès qu'on
// navigue entre onglets ou qu'on relance une analyse. On met en cache
// chaque résultat pendant 15 minutes : dans cette fenêtre, on réutilise la
// donnée déjà récupérée au lieu de renvoyer un appel réseau.
const apiCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

async function cachedFetch(key, fetcher) {
  const cached = apiCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await fetcher();
  apiCache.set(key, { data, ts: Date.now() });
  return data;
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
// Toutes les requêtes CoinGecko passent par le proxy interne /api/coingecko
// (route.js) : ça évite les erreurs CORS que CoinGecko renvoie parfois côté
// navigateur en cas de rate-limit, et ça permet d'utiliser la clé API côté
// serveur (COINGECKO_KEY) pour un quota plus large.
async function coingeckoProxy(path, params = {}) {
  const query = new URLSearchParams({ path, ...params }).toString();
  const res = await fetch(`/api/coingecko?${query}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "Erreur CoinGecko");
  return data;
}

async function fetchCoinGeckoPrice(id) {
  const data = await coingeckoProxy("simple/price", {
    ids: id,
    vs_currencies: "usd",
    include_24hr_change: "true",
  }).catch(() => {
    throw new Error("Identifiant crypto introuvable");
  });
  if (!data[id]) throw new Error("Identifiant crypto introuvable");
  return { price: data[id].usd, change24h: data[id].usd_24h_change };
}

async function fetchCoinGeckoHistory(id, days) {
  const data = await coingeckoProxy(`coins/${id}/market_chart`, {
    vs_currency: "usd",
    days: days.toString(),
    interval: "daily",
  }).catch(() => {
    throw new Error("Historique crypto indisponible");
  });
  // CoinGecko market_chart ne fournit qu'un prix de clôture par jour, pas de
  // vraies bougies OHLC. On approxime high = low = close : l'ATR/ADX calculés
  // dessus sont donc une volatilité clôture-à-clôture, pas une vraie amplitude
  // intrajournalière. C'est signalé dans le raisonnement du Dossier.
  return data.prices.map(([ts, price]) => ({ date: ts, close: price, high: price, low: price }));
}

async function fetchCoinGeckoTop(n = 10) {
  return coingeckoProxy("coins/markets", {
    vs_currency: "usd",
    order: "market_cap_desc",
    per_page: n.toString(),
    page: "1",
    price_change_percentage: "24h",
  }).catch(() => {
    throw new Error("Scanner indisponible");
  });
}

// Logos + variation 24h pour un lot de cryptos en un seul appel groupé
// (au lieu d'un appel par actif). Utilisé par le Top 15 pour afficher les
// petits logos et les pourcentages de variation.
async function fetchCoinGeckoMarketsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  return coingeckoProxy("coins/markets", {
    vs_currency: "usd",
    ids: ids.join(","),
    price_change_percentage: "24h",
  }).catch(() => []);
}

async function fetchAlphaQuote(symbol) {
  return cachedFetch(`quote:${symbol}`, async () => {
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
  });
}

async function fetchAlphaHistory(symbol) {
  return cachedFetch(`history:${symbol}`, async () => {
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
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  });
}

// Devises classiques uniquement (les métaux passent par fetchMetalPrice ci-dessus)
async function fetchFxQuote(symbol) {
  return cachedFetch(`fxquote:${symbol}`, async () => {
    const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&kind=quote&market=fx`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    const q = data["Realtime Currency Exchange Rate"];
    if (!q || !q["5. Exchange Rate"]) {
      const reason = alphaVantageErrorMessage(data);
      throw new Error(reason || "Devise introuvable (ex: EUR, GBP)");
    }
    return { price: parseFloat(q["5. Exchange Rate"]), change24h: null };
  });
}

async function fetchFxHistory(symbol) {
  return cachedFetch(`fxhistory:${symbol}`, async () => {
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
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  });
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

// ---------- Indicateurs additionnels pour Sentinel Engine ----------

function calcMACD(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = calcEMA(closes, fast);
  const emaSlow = calcEMA(closes, slow);
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = calcEMA(macdLine, signalPeriod);
  const histogram = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, histogram };
}

function calcATRAverage(atrSeries, period = 50) {
  const valid = atrSeries.filter((v) => v != null);
  if (valid.length === 0) return null;
  const slice = valid.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / slice.length;
}

function volatilityRegimeLabel(atr, atrAvg) {
  if (atr == null || atrAvg == null || atrAvg === 0) return null;
  const ratio = atr / atrAvg;
  return ratio <= 1.3 ? "modérée" : "élevée";
}

// Cassure du niveau clé (support/résistance de structure) suivie d'un retour
// à proximité de ce niveau (dans un rayon de 0.5 ATR) : signe de retest validé.
function detectBreakoutRetest(history, structure, atr) {
  if (!structure || structure.resistance == null || structure.support == null || atr == null) {
    return { active: false };
  }
  const closes = history.map((h) => h.close);
  const n = closes.length;
  const level = structure.regime === "haussier" ? structure.resistance
    : structure.regime === "baissier" ? structure.support
    : null;
  if (level == null) return { active: false };
  const lookback = closes.slice(Math.max(0, n - 10), n);
  const broke = structure.regime === "haussier"
    ? lookback.some((c) => c > level)
    : lookback.some((c) => c < level);
  const current = closes[n - 1];
  const nearLevel = Math.abs(current - level) <= atr * 0.5;
  return { active: broke && nearLevel };
}

// Prix revenu proche de l'EMA20 sans que la structure ne se soit inversée.
function detectPullback(currentPrice, ema20, structure) {
  if (ema20 == null || !structure) return { active: false };
  const distPct = (Math.abs(currentPrice - ema20) / ema20) * 100;
  const inTrend = structure.regime === "haussier" || structure.regime === "baissier";
  return { active: inTrend && distPct <= 1.5 && !structure.choch };
}

// Prix étiré loin de sa moyenne (≥2 ATR) avec un RSI en zone extrême.
function detectMeanReversion(currentPrice, ema20, atr, rsi) {
  if (ema20 == null || atr == null || rsi == null) return { active: false };
  const distanceInATR = Math.abs(currentPrice - ema20) / atr;
  const extreme = rsi > 75 || rsi < 25;
  return { active: distanceInATR >= 2 && extreme };
}

// Points pivots classiques calculés sur la dernière période complète.
function calcPivotPoints(history) {
  if (!history || history.length < 2) return null;
  const prev = history[history.length - 2];
  const { high, low, close } = prev;
  const p = (high + low + close) / 3;
  return {
    pivot: p,
    r1: 2 * p - low,
    s1: 2 * p - high,
    r2: p + (high - low),
    s2: p - (high - low),
  };
}

// Retracements Fibonacci entre le swing low et le swing high de structure.
function calcFibRetracement(structure) {
  if (!structure || structure.support == null || structure.resistance == null) return null;
  const { support: low, resistance: high } = structure;
  const range = high - low;
  if (range <= 0) return null;
  return {
    "0.236": high - range * 0.236,
    "0.382": high - range * 0.382,
    "0.5": high - range * 0.5,
    "0.618": high - range * 0.618,
    "0.786": high - range * 0.786,
  };
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

// ---------- Niveaux de trade cohérents (stop / take-profit) ----------
// Bug corrigé : le take-profit réutilisait la résistance/support de
// structure même quand le prix l'avait déjà dépassée (ce qui arrive
// précisément lors d'un BOS). Résultat : un signal "haussier" pouvait
// afficher un prix de vente sous le prix d'achat. Ici, on ne garde le
// niveau structurel comme cible que s'il est encore devant le prix ET
// qu'il offre un ratio risque/récompense correct ; sinon on projette une
// cible à PROJECTED_RR fois la distance du stop, ce qui garantit toujours
// un take-profit du bon côté du prix avec un R:R raisonnable.
const MIN_STRUCTURAL_RR = 1.2;
const PROJECTED_RR = 2;

// Distance de secours (en multiples d'ATR) utilisée pour le stop quand le
// niveau structurel (support/résistance) donne un risque nul ou négatif —
// typiquement quand le prix a déjà dépassé ce niveau dans le sens opposé à
// la direction choisie pour les niveaux (ex: prix au-dessus de la
// résistance alors qu'on calcule un stop "baissier"). Sans ce filet, la
// fonction renvoyait target: null et l'actif restait WAIT sans aucun prix
// affiché (cas vu sur Bitcoin / Dogecoin).
const ATR_FALLBACK_STOP_MULT = 1.5;

function computeTradeLevels({ verdict, currentPrice, support, resistance, atr }) {
  if (atr == null) return { stop: null, target: null, riskReward: null, projected: false };

  if (verdict === "haussier") {
    if (support == null) return { stop: null, target: null, riskReward: null, projected: false };
    let stop = support - 1.2 * atr;
    let risk = currentPrice - stop;
    let projected = false;
    if (risk <= 0) {
      // Niveau structurel invalide relativement au prix courant : on
      // retombe sur un stop purement basé sur l'ATR, qui garantit toujours
      // un risque positif.
      stop = currentPrice - ATR_FALLBACK_STOP_MULT * atr;
      risk = currentPrice - stop;
      projected = true;
    }

    let target = null;
    if (!projected && resistance != null && resistance > currentPrice) {
      const rr = (resistance - currentPrice) / risk;
      if (rr >= MIN_STRUCTURAL_RR) target = resistance;
    }
    if (target == null) {
      target = currentPrice + PROJECTED_RR * risk;
      projected = true;
    }
    const riskReward = (target - currentPrice) / risk;
    return { stop, target, riskReward, projected };
  } 

  if (verdict === "baissier") {
    if (resistance == null) return { stop: null, target: null, riskReward: null, projected: false };
    const stop = resistance + 1.2 * atr;
    const risk = stop - currentPrice;
    if (risk <= 0) return { stop, target: null, riskReward: null, projected: false };

    let target = null;
    let projected = false;
    if (support != null && support < currentPrice) {
      const rr = (currentPrice - support) / risk;
      if (rr >= MIN_STRUCTURAL_RR) target = support;
    }
    if (target == null) {
      target = currentPrice - PROJECTED_RR * risk;
      projected = true;
    }
    const riskReward = (currentPrice - target) / risk;
    return { stop, target, riskReward, projected };
  }

  return { stop: null, target: null, riskReward: null, projected: false };
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

  // Variation 24h : on prend celle fournie directement par la source
  // (CoinGecko / Alpha Vantage) quand elle existe ; sinon (devises, sans
  // "10. change percent" côté FX) on la dérive de l'avant-dernière clôture
  // de l'historique.
  let change24h = price.change24h;
  if (change24h == null && history && history.length >= 2) {
    const prevClose = history[history.length - 2].close;
    const lastClose = history[history.length - 1].close;
    if (prevClose) change24h = ((lastClose - prevClose) / prevClose) * 100;
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

    // Direction utilisée pour calculer des niveaux d'achat/vente à
    // afficher même quand le verdict est neutre (WAIT) — par défaut
    // haussier faute d'autre signal directionnel disponible ici.
    const levelsDirection = verdict === "baissier" ? "baissier" : "haussier";

    let support = null, resistance = null, atrStop = null, atrStopShort = null;
    let takeProfit = null, riskReward = null;
    let levelsNote;

    if (metal) {
      // Or/argent : bande à ±1.5% du prix courant (heuristique, pas un
      // vrai support/résistance faute d'historique gratuit).
      const pct = 0.015;
      const bandLow = price.price * (1 - pct);
      const bandHigh = price.price * (1 + pct);
      if (levelsDirection === "haussier") {
        support = bandLow;
        atrStop = support * 0.995;
        resistance = bandHigh;
        takeProfit = resistance;
        riskReward = (takeProfit - price.price) / (price.price - atrStop);
      } else {
        resistance = bandHigh;
        atrStopShort = resistance * 1.005;
        support = bandLow;
        takeProfit = support;
        riskReward = (price.price - takeProfit) / (atrStopShort - price.price);
      }
      levelsNote =
        verdict === "mitigé"
          ? "Historique de prix indisponible gratuitement pour l'or/l'argent — actualités neutres, niveaux approximés à ±1,5% du prix courant à titre indicatif"
          : "Historique de prix indisponible gratuitement pour l'or/l'argent — niveaux approximés à ±1,5% du prix courant (pas un calcul technique réel), verdict basé sur les actualités";
    } else if (history && history.length >= 2) {
      const sr = supportResistance(history);
      support = sr.support;
      resistance = sr.resistance;
      const range = resistance - support;
      if (levelsDirection === "haussier" && range > 0) {
        atrStop = support - range * 0.1;
        takeProfit = resistance;
        riskReward = (takeProfit - price.price) / (price.price - atrStop);
      } else if (levelsDirection === "baissier" && range > 0) {
        atrStopShort = resistance + range * 0.1;
        takeProfit = support;
        riskReward = (price.price - takeProfit) / (atrStopShort - price.price);
      }
     levelsNote =
        verdict === "mitigé"
          ? "Historique insuffisant pour une analyse technique complète (moins de 60 jours) — actualités neutres, niveaux basés sur le min/max de la période disponible à titre indicatif"
          : "Historique insuffisant pour une analyse technique complète (moins de 60 jours) — niveaux basés sur le min/max de la période disponible, verdict basé sur les actualités";
    } else {
      levelsNote =
        verdict === "mitigé"
          ? "Historique de prix indisponible — actualités neutres, aucun signal directionnel"
          : "Historique de prix indisponible — verdict basé uniquement sur les actualités";
    }

    // Même garde-fou risque/récompense que la branche technique complète :
    // sans lui, un actif comme l'or/l'argent (bande fixe ±1.5% / stop
    // ±0.5% => R:R structurellement ~0.75:1 dans les deux sens) pouvait
    // afficher un GO/AVOID basé uniquement sur les actualités, avec un
    // ratio risque/récompense défavorable et aucun avertissement.
    let rrDowngraded = false;
    if ((verdict === "haussier" || verdict === "baissier") && (riskReward == null || riskReward < 1)) {
      verdict = "mitigé";
      rrDowngraded = true;
    }

    const reasoning = [
      levelsNote,
      rrDowngraded && "Signal neutralisé (WAIT) : ratio risque/récompense insuffisant sur ce setup",
      news
        ? `Actualités : ton ${news.label} sur ${news.articleCount} articles récents`
        : newsError
        ? `Actualités indisponibles : ${newsError}`
        : "Actualités non incluses",
    ].filter(Boolean);

    return {
      symbol: query.toUpperCase(),
      price: price.price,
      change24h,
      support,
      resistance,
      verdict,
      levelsDirection,
      score: news?.label === "positif" ? 1 : news?.label === "négatif" ? -1 : 0,
      reasoning,
      news,
      atrStop,
      atrStopShort,
      takeProfit,
      riskReward,
      sentinel: null,
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

  // --- Vote multi-facteurs : chaque brique contribue 1 point (0.5 pour un
  // BOS de confirmation) au camp haussier ou baissier. ---
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

  let verdict = "mitigé";
  if (bull - bear >= 2) verdict = "haussier";
  else if (bear - bull >= 2) verdict = "baissier";

  // RSI = garde-fou de prudence, pas un signal directionnel : un verdict
  // haussier sur un actif suracheté (ou baissier sur un actif survendu) est
  // ramené à "mitigé" pour éviter d'entrer trop tard sur le mouvement.
  if (verdict === "haussier" && rsi != null && rsi > 75) verdict = "mitigé";
  if (verdict === "baissier" && rsi != null && rsi < 25) verdict = "mitigé";

  let support = structure.support;
  let resistance = structure.resistance;
  let structureFallback = false;
  if (support == null || resistance == null) {
    const sr = supportResistance(history);
    support = support ?? sr.support;
    resistance = resistance ?? sr.resistance;
    structureFallback = true;
  }

  // Direction utilisée pour calculer les niveaux d'achat/vente : celle du
  // verdict quand il est directionnel, sinon un biais par défaut basé sur
  // le vote technique (bull vs bear) — pour toujours pouvoir afficher un
  // prix d'achat et un prix de vente, même sur un signal WAIT.
  const levelsDirection =
    verdict === "baissier" ? "baissier" : verdict === "haussier" ? "haussier" : bull >= bear ? "haussier" : "baissier";

  const tradeLevels = computeTradeLevels({ verdict: levelsDirection, currentPrice, support, resistance, atr });

  // Garde-fou risque/récompense : même si le vote technique est
  // directionnel, on ne propose pas de trade si le ratio risque/récompense
  // est défavorable (ou si aucune cible fiable n'a pu être calculée). Le
  // signal est alors neutralisé en "mitigé", comme pour le garde-fou RSI.
  let rrDowngraded = false;
  if ((verdict === "haussier" || verdict === "baissier") && (tradeLevels.riskReward == null || tradeLevels.riskReward < 1)) {
    verdict = "mitigé";
    rrDowngraded = true;
  }

  const showTrade = verdict === "haussier" || verdict === "baissier";
  // Niveaux toujours calculés et affichés (achat/vente) — seuls le badge
  // GO/AVOID/WAIT et la mention "signal neutralisé" reflètent le verdict
  // final.
  const atrStop = levelsDirection === "haussier" ? tradeLevels.stop : null;
  const atrStopShort = levelsDirection === "baissier" ? tradeLevels.stop : null;
  const takeProfit = tradeLevels.target;
  const riskReward = tradeLevels.riskReward;

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
    adxLast != null &&
      `ADX ${adxLast.toFixed(0)} (${adxLast > 20 ? "tendance significative" : "pas de tendance nette"}), +DI ${plusDILast?.toFixed(0)} / -DI ${minusDILast?.toFixed(0)}`,
    cloudTop != null
      ? `Prix ${currentPrice > cloudTop ? "au-dessus" : currentPrice < cloudBottom ? "en-dessous" : "dans"} le nuage Ichimoku`
      : null,
    `Structure de marché : ${structure.regime}${structure.bos ? " — cassure de continuation (BOS)" : ""}${structure.choch ? " — signal de retournement (CHOCH)" : ""}`,
    support != null && resistance != null && `Support (swing low) : $${formatPrice(support)} — Résistance (swing high) : $${formatPrice(resistance)}`,
    structureFallback &&
      "Structure de marché indéterminée (pas assez de swing points) — niveaux approximés sur le min/max de la période",
    rsi != null &&
      `RSI(14) : ${rsi.toFixed(0)}${rsi > 75 ? " — suracheté, prudence" : rsi < 25 ? " — survendu, prudence" : ""}`,
   atr != null &&
      `ATR(14) : $${formatPrice(atr)} (volatilité${type === "crypto" ? ", approximée en clôture-à-clôture faute d'OHLC gratuit" : ""})`,
    atr == null &&
      "ATR indisponible sur cet historique — niveaux d'achat/vente non calculables pour cet actif",
    tradeLevels.stop != null &&
      tradeLevels.target != null &&
      `Stop-loss : $${formatPrice(tradeLevels.stop)} — Take-profit : $${formatPrice(tradeLevels.target)} (R:R ${riskReward != null ? riskReward.toFixed(2) : "—"}:1${tradeLevels.projected ? ", cible projetée car le niveau structurel est déjà dépassé" : ""}${!showTrade ? " — indicatif, signal neutre" : ""})`,
    rrDowngraded && "Signal neutralisé (WAIT) : ratio risque/récompense insuffisant sur ce setup",
    news
      ? `Actualités : ton ${news.label} sur ${news.articleCount} articles récents`
      : newsError
      ? `Actualités indisponibles : ${newsError}`
      : "Actualités non incluses",
  ].filter(Boolean);

  // --- Indicateurs additionnels nécessaires uniquement à Sentinel Engine ---
  const macd = calcMACD(closes);
  const macdHistogramLast = macd.histogram[lastIdx];

  const atrSeries = calcATR(history, 14);
  const atrAvg = calcATRAverage(atrSeries, 50);
  const volatilityRegime = volatilityRegimeLabel(atr, atrAvg);

  const breakoutRetest = detectBreakoutRetest(history, structure, atr);
  const pullback = detectPullback(currentPrice, ema20, structure);
  const meanReversion = detectMeanReversion(currentPrice, ema20, atr, rsi);

  const pivots = calcPivotPoints(history);
  const fibRetracement = calcFibRetracement(structure);

  const riskRewardForSentinel = showTrade
    ? {
        ratio: riskReward,
        risk: Math.abs(currentPrice - tradeLevels.stop),
        reward: Math.abs(tradeLevels.target - currentPrice),
        stop: tradeLevels.stop,
        target: tradeLevels.target,
      }
    : null;

  // Sentinel attend `structure.direction` OU `structure.regime` selon les
  // fonctions internes du moteur (incohérence dans sentinel-engine.js) :
  // on fournit les deux pour couvrir tous les cas.
  const sentinelInput = {
    currentPrice,
    support,
    resistance,
    structure: { ...structure, direction: structure.regime },
    ema20,
    ema50,
    adx: adxLast,
    plusDI: plusDILast,
    minusDI: minusDILast,
    rsi,
    atr,
    atrAvg,
    volatilityRegime,
    macd: { histogram: macdHistogramLast },
    breakoutRetest,
    pullback,
    meanReversion,
    pivots,
    fibRetracement,
    riskReward: riskRewardForSentinel,
    verdict,
  };

  const sentinel = calculateSentinelScore(sentinelInput);

  return {
    symbol: query.toUpperCase(),
    price: currentPrice,
    change24h,
    support,
    resistance,
    verdict,
    levelsDirection,
    score: bull - bear,
    reasoning,
    news,
    atrStop,
    atrStopShort,
    takeProfit,
    riskReward,
    sentinel, // { score, bias, setup, status, breakdown, reasons, warnings }
  };
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

          {dossier.sentinel && (
            <div style={{ marginBottom: 14, borderBottom: `1px solid ${LINE}`, paddingBottom: 14 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                <span style={{ fontSize: 12, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5 }}>
                  Sentinel Score
                </span>
                <span
                  style={{
                    fontSize: 13,
                    fontWeight: 800,
                    color:
                      dossier.sentinel.status === "VALID" ? POS
                      : dossier.sentinel.status === "WAIT" ? MUTED
                      : NEG,
                  }}
                >
                  {dossier.sentinel.score}/100 — {dossier.sentinel.status}
                </span>
              </div>

              {dossier.sentinel.warnings.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  {dossier.sentinel.warnings.slice(0, 3).map((w, i) => (
                    <div key={i} style={{ fontSize: 11, color: NEG }}>
                      ⚠️ {w}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
            {dossier.reasoning.map((line, i) => (
              <div key={i} style={{ fontSize: 13, color: MUTED, display: "flex", gap: 6 }}>
                <span style={{ color: ACCENT }}>•</span> {line}
              </div>
            ))}
          </div>

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
              setPrefillCalc({
                entry: dossier.price,
                stop: dossier.levelsDirection === "baissier" ? dossier.atrStopShort : dossier.atrStop,
                takeProfit: dossier.takeProfit,
                assetType: type === "crypto" ? "crypto" : type === "fx" && isMetal(query) ? "matieres" : type === "fx" ? "forex" : "actions",
                direction: dossier.levelsDirection === "baissier" ? "short" : "long",
                symbol: dossier.symbol,
                verdict: dossier.verdict,
              });
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

  const runScan = useCallback(async () => {
    setLoading(true);
    setError("");
    setResults([]);
    setProgress({ done: 0, total: WATCHLIST.length });

    // Logos + variation 24h pour les cryptos : un seul appel groupé
    // (coins/markets avec ids=...) plutôt qu'un appel par actif.
    const cryptoIds = WATCHLIST.filter((w) => w.type === "crypto").map((w) => w.query);
    const marketsMeta = await fetchCoinGeckoMarketsByIds(cryptoIds);
    const metaMap = {};
    (marketsMeta || []).forEach((m) => {
      metaMap[m.id] = m;
    });

    const settled = new Array(WATCHLIST.length);
    let doneCount = 0;
    const markDone = (idx, value) => {
      settled[idx] = value;
      doneCount += 1;
      setProgress({ done: doneCount, total: WATCHLIST.length });
    };

    // On sépare les marchés selon leur contrainte de débit :
    // - crypto + or/argent (CoinGecko / gold-api.com) : pas de vraie limite,
    //   on peut les lancer en parallèle par petits paquets.
    // - devises (Alpha Vantage, 5 req/min en gratuit) : on les garde
    //   espacées, mais ce bloc tourne EN MEME TEMPS que le bloc rapide
    //   au lieu d'attendre qu'il ait fini.
    const fastIndexes = [];
    const fxIndexes = [];
    WATCHLIST.forEach((item, idx) => {
      if (item.type === "fx" && !isMetal(item.query)) fxIndexes.push(idx);
      else fastIndexes.push(idx);
    });

    const runOne = async (idx, attempt = 0) => {
      const item = WATCHLIST[idx];
      try {
        const r = await runMarketAnalysis(item.type, item.query);
        const meta = item.type === "crypto" ? metaMap[item.query] : null;
        markDone(idx, {
          ...r,
          label: item.label,
          type: item.type,
          query: item.query,
          image: meta?.image || null,
          change24h: r.change24h != null ? r.change24h : meta?.price_change_percentage_24h ?? null,
        });
      } catch (e) {
        const isFx = item.type === "fx" && !isMetal(item.query);
        // Un seul retry, et seulement pour crypto/métaux (pas les devises,
        // pour ne pas gaspiller le quota Alpha Vantage) : CoinGecko renvoie
        // souvent une erreur passagère de rate-limit sur les scans à 8 actifs.
        if (!isFx && attempt < 1) {
          await new Promise((res) => setTimeout(res, 2000));
          return runOne(idx, attempt + 1);
        }
        markDone(idx, { label: item.label, type: item.type, query: item.query, error: e.message });
      }
    };

    const BATCH_SIZE = 4;
    const runFast = async () => {
      for (let i = 0; i < fastIndexes.length; i += BATCH_SIZE) {
        const batch = fastIndexes.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map((idx) => runOne(idx)));
      }
    };

    const runFx = async () => {
      for (const idx of fxIndexes) {
        await runOne(idx);
        // Espacement réduit à 1s (au lieu de 3s) : 5 devises = 5 requêtes
        // Alpha Vantage, largement sous la limite de 5/min même avec ce délai.
        await new Promise((res) => setTimeout(res, 1000));
      }
    };

    // Les deux blocs tournent en parallèle : le temps total du scan est
    // borné par le plus lent des deux, pas par leur somme.
    await Promise.all([runFast(), runFx()]);

    const ok = settled.filter((r) => !r.error);
    const failed = settled.filter((r) => r.error);
    ok.sort((a, b) => b.score - a.score);
    setResults([...ok, ...failed]);
    if (failed.length > 0 && ok.length === 0) {
      setError("Le scan a échoué pour tous les marchés — réessaie plus tard.");
    }
    setLoading(false);
  }, []);

  // Scan automatique à l'ouverture de l'onglet — plus de bouton manuel.
  // Le cache (15 min) sur les appels Alpha Vantage/CoinGecko limite les
  // doublons si l'onglet est réouvert peu après.
  useEffect(() => {
    runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>
        Scan classé de 15 marchés (8 cryptos, or, argent, 5 devises majeures) avec la même
        analyse que le Dossier — tendances 7j/30j/90j + sentiment des actualités. Clique un
        marché pour l'envoyer directement au calculateur.
      </div>

      {loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 16, color: MUTED, fontSize: 13 }}>
          <Loader2 className="spin" size={16} color={ACCENT} />
          Analyse {progress.done}/{progress.total}…
        </div>
      )}

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
            // Le stop-loss doit suivre la direction utilisée pour calculer
            // les niveaux (levelsDirection), pas le verdict final : sur un
            // WAIT, verdict et levelsDirection peuvent diverger (ex: vote
            // technique légèrement baissier neutralisé par le garde-fou
            // RSI/R:R). Utiliser verdict ici pointait vers un champ
            // (atrStop / atrStopShort) resté à null, ce qui cassait
            // l'affichage des niveaux sur certains actifs WAIT (cas
            // observé sur Bitcoin / Dogecoin).
            const isBearishLevels = r.levelsDirection === "baissier";
            // L'entrée automatique est le prix courant. Le take-profit
            // vient du moteur (cible corrigée, cohérente avec le sens du
            // signal, calculée même sur un WAIT) ; le stop-loss selon la
            // direction.
            const buyPrice = r.price;
            const sellPrice = r.takeProfit;
            const stopPrice = isBearishLevels ? r.atrStopShort : r.atrStop;
            const hasLevels = sellPrice != null && stopPrice != null;
            const hasChange = r.change24h != null;
            // R:R déjà calculé par runMarketAnalysis mais jusqu'ici jamais
            // affiché dans le Top 15 — sans lui, deux signaux avec des
            // % de mouvement très différents (ex: +3% vs +7,5%) sont
            // indiscernables en qualité de setup (stop serré + bon R:R vs
            // stop large + R:R faible peuvent donner le même % affiché).
            const hasRR = r.riskReward != null && Number.isFinite(r.riskReward);

            return (
              <button
                key={`${r.type}-${r.query}`}
                onClick={() =>
                  onSendToCalculator({
                    entry: buyPrice,
                    stop: stopPrice,
                    takeProfit: sellPrice,
                    assetType: r.type === "crypto" ? "crypto" : r.type === "fx" && isMetal(r.query) ? "matieres" : r.type === "fx" ? "forex" : "actions",
                    direction: isBearishLevels ? "short" : "long",
                    symbol: r.symbol || r.query.toUpperCase(),
                    verdict: r.verdict,
                  })
                }
                style={{
                  background: PANEL,
                  border: `1px solid ${LINE}`,
                  borderRadius: 10,
                  padding: "12px 14px",
                  cursor: "pointer",
                  color: TEXT,
                  textAlign: "left",
                  width: "100%",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: hasLevels ? 10 : 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    {r.image ? (
                      <img src={r.image} alt="" width={22} height={22} style={{ borderRadius: "50%", flexShrink: 0 }} />
                    ) : (
                      <div
                        style={{
                          width: 22,
                          height: 22,
                          borderRadius: "50%",
                          background: NAVY,
                          border: `1px solid ${LINE}`,
                          flexShrink: 0,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 9,
                          color: MUTED,
                          fontWeight: 700,
                        }}
                      >
                        {(ticker || name).slice(0, 2)}
                      </div>
                    )}
                    <div>
                      <div style={{ fontWeight: 700, fontSize: 14 }}>{name}</div>
                      {ticker && <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase" }}>{ticker}</div>}
                      <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginTop: 4 }}>
                        <span style={{ fontSize: 13, fontWeight: 600 }}>${formatPrice(r.price)}</span>
                        {hasChange && (
                          <span style={{ fontSize: 11, fontWeight: 700, color: r.change24h >= 0 ? POS : NEG }}>
                            {r.change24h >= 0 ? "+" : ""}
                            {r.change24h.toFixed(2)}%
                          </span>
                        )}
                      </div>
                    </div>
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
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: hasRR ? 8 : 0 }}>
                    <div style={{ background: NAVY, borderRadius: 8, padding: 8 }}>
                      <div style={{ fontSize: 10, color: MUTED }}>Prix d'achat</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: POS }}>${formatPrice(buyPrice)}</div>
                    </div>
                    <div style={{ background: NAVY, borderRadius: 8, padding: 8 }}>
                      <div style={{ fontSize: 10, color: MUTED }}>Prix de vente</div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: NEG }}>${formatPrice(sellPrice)}</div>
                    </div>
                  </div>
                )}

                {hasLevels && hasRR && (
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: NAVY, borderRadius: 8, padding: "6px 8px" }}>
                    <span style={{ fontSize: 10, color: MUTED }}>
                      Stop-loss : ${formatPrice(stopPrice)}
                    </span>
                    <span style={{ fontSize: 11, fontWeight: 700, color: r.riskReward >= 1.5 ? POS : r.riskReward >= 1 ? AMBER : NEG }}>
                      R:R {r.riskReward.toFixed(2)}:1
                    </span>
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
// Style volontairement très différent entre verrouillé (mode auto : la
// valeur vient du moteur, non modifiable) et modifiable (mode manuel, ou
// le champ "Montant à investir" qui reste éditable même en mode auto) :
// gris + icône cadenas d'un côté, bordure ambre de l'autre.
function CalcField({ label, value, onChange, placeholder, readOnly = false }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div
        style={{
          fontSize: 12,
          color: readOnly ? MUTED : AMBER,
          marginBottom: 4,
          fontWeight: readOnly ? 400 : 700,
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {label}
        {readOnly && <Lock size={11} color={MUTED} />}
      </div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        readOnly={readOnly}
        inputMode="decimal"
        style={{
          width: "100%",
          background: readOnly ? LOCKED_BG : NAVY,
          border: `1px solid ${readOnly ? LINE : AMBER}`,
          borderRadius: 8,
          padding: "10px 12px",
          color: readOnly ? MUTED : TEXT,
          fontSize: 14,
          cursor: readOnly ? "not-allowed" : "text",
        }}
      />
    </div>
  );
}

function Calculateur({ prefill }) {
  const hasFullLevels = (p) => p && p.entry != null && p.stop != null;
  const [mode, setMode] = useState(hasFullLevels(prefill) ? "auto" : "manual");
  const [assetType, setAssetType] = useState(prefill?.assetType || "crypto");
  const [invested, setInvested] = useState(prefill?.invested?.toString() || "50");
  const [leverage, setLeverage] = useState(prefill?.leverage?.toString() || LEVERAGE_PRESETS[prefill?.assetType || "crypto"].leverage.toString());
  const [entry, setEntry] = useState(prefill?.entry?.toString() || "");
  const [stop, setStop] = useState(prefill?.stop?.toString() || "");
  const [takeProfit, setTakeProfit] = useState(prefill?.takeProfit?.toString() || "");

  useEffect(() => {
    if (!prefill) return;
    const nextAsset = prefill.assetType || "crypto";
    setMode(hasFullLevels(prefill) ? "auto" : "manual");
    setAssetType(nextAsset);
    setInvested(prefill.invested?.toString() || "50");
    setLeverage(prefill.leverage?.toString() || LEVERAGE_PRESETS[nextAsset].leverage.toString());
    setEntry(prefill.entry?.toString() || "");
    setStop(prefill.stop?.toString() || "");
    setTakeProfit(prefill.takeProfit?.toString() || "");
  }, [prefill]);

  const onAssetType = (t) => {
    setAssetType(t);
    setLeverage(LEVERAGE_PRESETS[t].leverage.toString());
  };

  const autoLocked = mode === "auto";
  const inv = parseFloat(invested);
  const lev = parseFloat(leverage);
  const e = parseFloat(entry);
  const s = parseFloat(stop);
  const tp = parseFloat(takeProfit);
  const valid = inv > 0 && lev > 0 && e > 0 && s > 0 && e !== s;
  const positionValue = valid ? inv * lev : null;
  const quantity = valid ? positionValue / e : null;
  const distance = valid ? Math.abs(e - s) : null;
  const distancePct = valid ? (distance / e) * 100 : null;
  const lossAmount = valid ? quantity * distance : null;
  const lossPctOfInvested = valid ? (lossAmount / inv) * 100 : null;
  const gainAmount = valid && tp > 0 ? quantity * Math.abs(tp - e) : null;
  const gainDistance = valid && tp > 0 ? Math.abs(tp - e) : null;
  const gainDistancePct = valid && tp > 0 ? (gainDistance / e) * 100 : null;

  const field = (label, value, onChange, placeholder, locked = autoLocked) => (
    <CalcField label={label} value={value} onChange={onChange} placeholder={placeholder} readOnly={locked} />
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        <button onClick={() => setMode("auto")} style={{ flex: 1, padding: "9px 10px", borderRadius: 8, border: `1px solid ${mode === "auto" ? AMBER : LINE}`, background: mode === "auto" ? "rgba(252,211,77,0.12)" : "transparent", color: mode === "auto" ? AMBER : MUTED, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>⚡ Automatique — Signal</button>
        <button onClick={() => setMode("manual")} style={{ flex: 1, padding: "9px 10px", borderRadius: 8, border: `1px solid ${mode === "manual" ? AMBER : LINE}`, background: mode === "manual" ? "rgba(252,211,77,0.12)" : "transparent", color: mode === "manual" ? AMBER : MUTED, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>✎ Manuel</button>
      </div>

      {prefill?.symbol && (
        <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12, marginBottom: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div><div style={{ fontSize: 11, color: MUTED }}>Marché sélectionné</div><div style={{ fontSize: 16, fontWeight: 700 }}>{prefill.symbol}</div></div>
            {prefill.verdict && <div style={{ fontSize: 12, fontWeight: 800, color: prefill.verdict === "haussier" ? POS : prefill.verdict === "baissier" ? NEG : MUTED, textTransform: "uppercase" }}>{prefill.verdict}</div>}
          </div>
          {autoLocked && (
            <div style={{ fontSize: 11, color: MUTED, marginTop: 6, display: "flex", alignItems: "center", gap: 4 }}>
              <Lock size={11} color={MUTED} /> Valeurs issues du moteur d'analyse et verrouillées — seul le montant à investir reste modifiable.
            </div>
          )}
        </div>
      )}

      <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Type d'actif (fixe le levier par défaut)</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {Object.entries(LEVERAGE_PRESETS).map(([key, v]) => (
          <button key={key} onClick={() => onAssetType(key)} disabled={autoLocked} style={{ padding: "6px 10px", borderRadius: 20, border: `1px solid ${assetType === key ? ACCENT : LINE}`, background: assetType === key ? "rgba(79,140,255,0.12)" : "transparent", color: assetType === key ? ACCENT : MUTED, fontSize: 12, fontWeight: 600, cursor: autoLocked ? "not-allowed" : "pointer", opacity: autoLocked && assetType !== key ? 0.55 : 1 }}>{v.label}</button>
        ))}
      </div>

      {field("Montant à investir — ta mise / marge (€)", invested, setInvested, "ex: 50", false)}
      {field("Levier (x1 = sans levier, ex: Binance spot)", leverage, setLeverage, "ex: 2")}
      {field("Prix d'entrée", entry, setEntry, "ex: 4346.55")}
      {field("Stop-loss", stop, setStop, "ex: 4300.00")}
      {field("Take-profit (optionnel)", takeProfit, setTakeProfit, "ex: 4420.00")}

      {valid ? (
        <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 16, marginTop: 8 }}>
          <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${LINE}` }}>
            <div style={{ fontSize: 12, color: ACCENT, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>À saisir sur Capital.com / Binance</div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span style={{ fontSize: 13, color: MUTED }}>Taille</span><span style={{ fontSize: 16, fontWeight: 700, color: ACCENT }}>{quantity.toFixed(6)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}><span style={{ fontSize: 13, color: MUTED }}>Stop loss — Niveau de prix</span><span style={{ fontSize: 14, fontWeight: 700 }}>{formatPrice(s)}</span></div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}><span style={{ fontSize: 11, color: MUTED }}>Distance</span><span style={{ fontSize: 12, color: MUTED }}>{formatPrice(distance)} ({distancePct.toFixed(2)}%)</span></div>
            {tp > 0 && <><div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}><span style={{ fontSize: 13, color: MUTED }}>Take-profit — Niveau de prix</span><span style={{ fontSize: 14, fontWeight: 700 }}>{formatPrice(tp)}</span></div><div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 11, color: MUTED }}>Distance</span><span style={{ fontSize: 12, color: MUTED }}>{formatPrice(gainDistance)} ({gainDistancePct.toFixed(2)}%)</span></div></>}
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><span style={{ fontSize: 13, color: MUTED }}>Taille totale de la position</span><span style={{ fontSize: 14, fontWeight: 700 }}>{positionValue.toFixed(2)} €</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><span style={{ fontSize: 13, color: MUTED }}>Marge requise</span><span style={{ fontSize: 14, fontWeight: 700 }}>{inv.toFixed(2)} €</span></div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}><span style={{ fontSize: 13, color: MUTED }}>Perte si stop touché</span><span style={{ fontSize: 14, fontWeight: 700, color: NEG }}>-{lossAmount.toFixed(2)} € ({lossPctOfInvested.toFixed(0)}% de ta mise)</span></div>
          {gainAmount !== null && <div style={{ display: "flex", justifyContent: "space-between" }}><span style={{ fontSize: 13, color: MUTED }}>Gain si take-profit touché</span><span style={{ fontSize: 14, fontWeight: 700, color: POS }}>+{gainAmount.toFixed(2)} €</span></div>}
          {lossPctOfInvested > 100 && <div style={{ fontSize: 11, color: NEG, marginTop: 10 }}>⚠️ La perte potentielle dépasse ta mise de départ — avec ce levier, ta position peut être liquidée avant que le stop ne soit atteint. Réduis le levier ou resserre le stop.</div>}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>{autoLocked && prefill?.symbol ? "Le moteur n'a pas fourni tous les niveaux nécessaires pour calculer automatiquement ce trade. Passe en mode Manuel pour définir les niveaux." : "Remplis montant, levier, entrée et stop-loss pour voir le calcul."}</div>
      )}
    </div>
  );
}

// ================= App =================
export default function TradingApp() {
  const [tab, setTab] = useState("top15");
  const [prefillCalc, setPrefillCalc] = useState(null);

  const tabs = [
    { id: "top15", label: "Top 15", icon: ListOrdered },
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
        {tab === "dossier" && <Dossier setTab={setTab} setPrefillCalc={setPrefillCalc} />}
        {tab === "calc" && <Calculateur prefill={prefillCalc} />}
      </div>
    </div>
  );
}
