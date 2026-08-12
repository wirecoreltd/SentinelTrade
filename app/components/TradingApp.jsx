"use client";

import { useState, useEffect, useCallback, useRef } from "react";
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
  History as HistoryIcon,
} from "lucide-react";
import { NAVY, PANEL, ACCENT, TEXT, MUTED, LINE, POS, NEG, AMBER, LOCKED_BG } from "../lib/theme";
import { formatPrice } from "../lib/format";
import { addTrade, checkGuidance, loadHistory, getOpenTrades } from "../lib/tradeHistory";
import HistoryTab from "../components/HistoryTab";

// ---------- Helper: extrait un message d'erreur exploitable d'une réponse Alpha Vantage ----------
function alphaVantageErrorMessage(data) {
  return data?.Note || data?.Information || data?.["Error Message"] || null;
}

// ---------- Cache mémoire avec expiration ----------
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

// ---------- File d'attente pour les appels /api/news ----------
// Espace les appels vers /api/news d'au moins NEWS_MIN_GAP_MS, quel que soit
// le parallélisme utilisé ailleurs (prix crypto/stock/fx). Ça évite de taper
// le rate-limit de NewsData.io quand plusieurs actifs sont analysés d'un coup
// (ex: le scan "Top 15").
let newsQueue = Promise.resolve();
const NEWS_MIN_GAP_MS = 600;

function throttledNewsCall(fn) {
  const run = newsQueue.then(async () => {
    const result = await fn();
    await new Promise((r) => setTimeout(r, NEWS_MIN_GAP_MS));
    return result;
  });
  // Si un appel échoue, on ne bloque pas la file pour les suivants.
  newsQueue = run.catch(() => {});
  return run;
}

// ---------- Cache news persistant (localStorage) ----------
// Le plan gratuit NewsData.io autorise seulement 30 requêtes / 15 minutes
// (pas juste 200/jour). Un cache en mémoire JS (comme apiCache plus haut)
// est vidé à chaque rechargement de page — donc 2-3 refresh en quelques
// minutes suffisent à dépasser la limite. On persiste donc les résultats
// news dans localStorage pour qu'ils survivent aux rechargements.
const NEWS_CACHE_TTL_MS = 20 * 60 * 1000; // 20 minutes
const NEWS_CACHE_PREFIX = "trading-app:news-cache:";

function readNewsCache(query) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(NEWS_CACHE_PREFIX + query);
    if (!raw) return null;
    const { data, ts } = JSON.parse(raw);
    if (Date.now() - ts > NEWS_CACHE_TTL_MS) return null;
    return data;
  } catch {
    return null;
  }
}

function writeNewsCache(query, data) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(NEWS_CACHE_PREFIX + query, JSON.stringify({ data, ts: Date.now() }));
  } catch {
    // localStorage plein/indisponible : on continue sans cache persistant
  }
}

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

async function fetchCoinGeckoMarketsByIds(ids) {
  if (!ids || ids.length === 0) return [];
  return coingeckoProxy("coins/markets", {
    vs_currency: "usd",
    ids: ids.join(","),
    price_change_percentage: "24h",
  }).catch(() => []);
}

async function fetchCoinGeckoOHLC(id, days) {
  const data = await coingeckoProxy(`coins/${id}/ohlc`, {
    vs_currency: "usd",
    days: days.toString(),
  }).catch(() => {
    throw new Error("Chandelier indisponible pour cette crypto");
  });
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error("Chandelier indisponible pour cette crypto");
  }
  return data.map(([ts, open, high, low, close]) => ({ date: ts, open, high, low, close }));
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
        open: parseFloat(v["1. open"]),
        close: parseFloat(v["4. close"]),
        high: parseFloat(v["2. high"]),
        low: parseFloat(v["3. low"]),
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  });
}

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
        open: parseFloat(v["1. open"]),
        close: parseFloat(v["4. close"]),
        high: parseFloat(v["2. high"]),
        low: parseFloat(v["3. low"]),
      }))
      .sort((a, b) => new Date(a.date) - new Date(b.date));
  });
}

// Cache persistant (localStorage, 20 min) vérifié EN PREMIER — donc un
// rechargement de page ne redéclenche pas d'appel réseau pour un actif déjà
// interrogé récemment. Si rien en cache, appel réel via la file throttlée
// (600ms d'écart mini) pour ne pas taper le rate-limit NewsData.io quand
// plusieurs actifs sont analysés en même temps (ex: scan Top 15).
async function fetchNewsSentiment(query) {
  const persisted = readNewsCache(query);
  if (persisted) return persisted;

  return cachedFetch(`news:${query}`, () =>
    throttledNewsCall(async () => {
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

      const result = { label, score, articleCount: articles.length, headlines: articles.slice(0, 3).map((a) => a.title) };
      writeNewsCache(query, result);
      return result;
    })
  );
}

function supportResistance(history) {
  const closes = history.map((h) => h.close);
  return { support: Math.min(...closes), resistance: Math.max(...closes) };
}

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

function detectPullback(currentPrice, ema20, structure) {
  if (ema20 == null || !structure) return { active: false };
  const distPct = (Math.abs(currentPrice - ema20) / ema20) * 100;
  const inTrend = structure.regime === "haussier" || structure.regime === "baissier";
  return { active: inTrend && distPct <= 1.5 && !structure.choch };
}

function detectMeanReversion(currentPrice, ema20, atr, rsi) {
  if (ema20 == null || atr == null || rsi == null) return { active: false };
  const distanceInATR = Math.abs(currentPrice - ema20) / atr;
  const extreme = rsi > 75 || rsi < 25;
  return { active: distanceInATR >= 2 && extreme };
}

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

const MIN_STRUCTURAL_RR = 1.2;
const PROJECTED_RR = 2;
const ATR_FALLBACK_STOP_MULT = 1.5;
const PRICE_PCT_FALLBACK_STOP = 0.03; // 3% du prix courant
const MIN_ATR_PCT_OF_PRICE = 0.008;

function computeTradeLevels({ verdict, currentPrice, support, resistance, atr }) {
  const rawEffectiveAtr = atr != null ? atr : currentPrice * PRICE_PCT_FALLBACK_STOP;
  const effectiveAtr = Math.max(rawEffectiveAtr, currentPrice * MIN_ATR_PCT_OF_PRICE);

  if (verdict === "haussier") {
    if (support == null) return { stop: null, target: null, riskReward: null, projected: false };
    let stop = support - 1.2 * effectiveAtr;
    let risk = currentPrice - stop;
    let projected = false;
    if (risk <= 0) {
      stop = currentPrice - ATR_FALLBACK_STOP_MULT * effectiveAtr;
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
    let stop = resistance + 1.2 * effectiveAtr;
    let risk = stop - currentPrice;
    let projected = false;
    if (risk <= 0) {
      stop = currentPrice + ATR_FALLBACK_STOP_MULT * effectiveAtr;
      risk = stop - currentPrice;
      projected = true;
    }

    let target = null;
    if (!projected && support != null && support < currentPrice) {
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

  if (!history || history.length < 60) {
    let verdict = "mitigé";
    if (news?.label === "positif") verdict = "haussier";
    else if (news?.label === "négatif") verdict = "baissier";

    const levelsDirection = verdict === "baissier" ? "baissier" : "haussier";

    let support = null, resistance = null, atrStop = null, atrStopShort = null;
    let takeProfit = null, riskReward = null;
    let levelsNote;

    if (metal) {
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
      rawQuery: query,
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
    if (structure.regime === "haussier") bear += 1;
    else bull += 1;
  }

  if (news?.label === "positif") bull += 1;
  else if (news?.label === "négatif") bear += 1;

  let verdict = "mitigé";
  if (bull - bear >= 2) verdict = "haussier";
  else if (bear - bull >= 2) verdict = "baissier";

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

  const levelsDirection =
    verdict === "baissier" ? "baissier" : verdict === "haussier" ? "haussier" : bull >= bear ? "haussier" : "baissier";

  const tradeLevels = computeTradeLevels({ verdict: levelsDirection, currentPrice, support, resistance, atr });

  let rrDowngraded = false;
  if ((verdict === "haussier" || verdict === "baissier") && (tradeLevels.riskReward == null || tradeLevels.riskReward < 1)) {
    verdict = "mitigé";
    rrDowngraded = true;
  }

  const showTrade = verdict === "haussier" || verdict === "baissier";
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
    rawQuery: query,
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
    sentinel,
  };
}

const RANGE_OPTIONS = [
  { key: "1j", label: "1J" },
  { key: "5j", label: "5J" },
  { key: "1m", label: "1M" },
  { key: "6m", label: "6M" },
];

// Chandeliers en bleu (ACCENT) pour une bougie haussière, rouge (NEG) pour
// une bougie baissière — remplace le vert/rouge par défaut.
function CandleChart({ candles, overlays = [], height = 260 }) {
  if (!candles || candles.length === 0) return null;

  const width = 640;
  const padLeft = 6;
  const padRight = 56;
  const padTop = 14;
  const padBottom = 26;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;

  const allHighs = candles.map((c) => c.high);
  const allLows = candles.map((c) => c.low);
  const overlayValues = overlays.filter((o) => o.value != null).map((o) => o.value);
  let domainMax = Math.max(...allHighs, ...overlayValues);
  let domainMin = Math.min(...allLows, ...overlayValues);
  if (domainMax === domainMin) {
    domainMax += Math.abs(domainMax) * 0.01 || 1;
    domainMin -= Math.abs(domainMin) * 0.01 || 1;
  }
  const domainPad = (domainMax - domainMin) * 0.08;
  domainMax += domainPad;
  domainMin -= domainPad;

  const yFor = (v) => padTop + innerH - ((v - domainMin) / (domainMax - domainMin)) * innerH;

  const n = candles.length;
  const slot = innerW / n;
  const bodyWidth = Math.max(1.5, Math.min(10, slot * 0.6));

  const dateTickIdx = [0, Math.floor((n - 1) / 3), Math.floor((2 * (n - 1)) / 3), n - 1].filter(
    (v, i, arr) => arr.indexOf(v) === i
  );
  const fmtDate = (ts) => {
    const d = new Date(ts);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
  };

  const priceTicks = [0, 1, 2, 3].map((i) => domainMin + ((domainMax - domainMin) * i) / 3);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} style={{ display: "block" }}>
      {priceTicks.map((v, i) => (
        <g key={i}>
          <line x1={padLeft} x2={width - padRight} y1={yFor(v)} y2={yFor(v)} stroke={LINE} strokeWidth={1} />
          <text x={width - padRight + 6} y={yFor(v) + 3} fontSize={9} fill={MUTED}>
            {formatPrice(v)}
          </text>
        </g>
      ))}

      {overlays
        .filter((o) => o.value != null)
        .map((o, i) => (
          <g key={`ov-${i}`}>
            <line
              x1={padLeft}
              x2={width - padRight}
              y1={yFor(o.value)}
              y2={yFor(o.value)}
              stroke={o.color}
              strokeWidth={1.5}
              strokeDasharray={o.dashed === false ? undefined : "5,4"}
            />
            <text x={padLeft + 2} y={yFor(o.value) - 4} fontSize={9} fontWeight={700} fill={o.color}>
              {o.label} {formatPrice(o.value)}
            </text>
          </g>
        ))}

      {candles.map((c, i) => {
        const x = padLeft + i * slot + slot / 2;
        const up = c.close >= c.open;
        const color = up ? ACCENT : NEG;
        const bodyTop = yFor(Math.max(c.open, c.close));
        const bodyBottom = yFor(Math.min(c.open, c.close));
        const bodyH = Math.max(1, bodyBottom - bodyTop);
        return (
          <g key={i}>
            <line x1={x} x2={x} y1={yFor(c.high)} y2={yFor(c.low)} stroke={color} strokeWidth={1} />
            <rect
              x={x - bodyWidth / 2}
              y={bodyTop}
              width={bodyWidth}
              height={bodyH}
              fill={color}
              opacity={0.95}
            />
          </g>
        );
      })}

      {dateTickIdx.map((idx) => {
        const x = padLeft + idx * slot + slot / 2;
        return (
          <text key={idx} x={x} y={height - 8} fontSize={9} fill={MUTED} textAnchor="middle">
            {fmtDate(candles[idx].date)}
          </text>
        );
      })}
    </svg>
  );
}

const CRYPTO_DAYS_BY_RANGE = { "1j": 1, "5j": 7, "1m": 30, "6m": 180 };
const DAILY_BARS_BY_RANGE = { "1j": 2, "5j": 5, "1m": 22, "6m": 130 };

async function fetchCalculatorCandles({ assetType, rawQuery, rangeKey }) {
  if (!rawQuery) throw new Error("Actif inconnu");

  if (assetType === "crypto") {
    const days = CRYPTO_DAYS_BY_RANGE[rangeKey];
    const candles = await fetchCoinGeckoOHLC(rawQuery.toLowerCase(), days);
    return { candles, note: null };
  }

  if (assetType === "matieres") {
    throw new Error("Historique indisponible gratuitement pour l'or/l'argent — seul le prix en temps réel est affiché ailleurs dans l'appli.");
  }

  if (assetType === "forex") {
    const full = await fetchFxHistory(rawQuery.toUpperCase());
    const bars = DAILY_BARS_BY_RANGE[rangeKey];
    const candles = full.slice(-bars);
    const note = rangeKey === "1j" ? "Pas d'historique intraday disponible (plan Alpha Vantage gratuit) — dernières bougies journalières affichées." : null;
    return { candles, note };
  }

  const full = await fetchAlphaHistory(rawQuery.toUpperCase());
  const bars = DAILY_BARS_BY_RANGE[rangeKey];
  const candles = full.slice(-bars);
  const note = rangeKey === "1j" ? "Pas d'historique intraday disponible (plan Alpha Vantage gratuit) — dernières bougies journalières affichées." : null;
  return { candles, note };
}

// Range par défaut : 5J (au lieu de 1M)
function TradeChart({ assetType, rawQuery, symbol, entry, stop, takeProfit, support, resistance }) {
  const [range, setRange] = useState("5j");
  const [state, setState] = useState({ loading: true, error: "", candles: [], note: null });
  const cacheRef = useRef(new Map());

  useEffect(() => {
    if (!rawQuery || !assetType) return;
    const cacheKey = `${assetType}:${rawQuery}:${range}`;
    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setState({ loading: false, error: "", candles: cached.candles, note: cached.note });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, loading: true, error: "" }));
    fetchCalculatorCandles({ assetType, rawQuery, rangeKey: range })
      .then(({ candles, note }) => {
        if (cancelled) return;
        cacheRef.current.set(cacheKey, { candles, note });
        setState({ loading: false, error: "", candles, note });
      })
      .catch((e) => {
        if (cancelled) return;
        setState({ loading: false, error: e.message, candles: [], note: null });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assetType, rawQuery, range]);

  if (!rawQuery || !assetType) {
    return (
      <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 16, marginBottom: 16, fontSize: 12, color: MUTED, textAlign: "center" }}>
        Envoie un actif depuis le Dossier ou le Top 15 pour afficher son graphique en chandelier ici.
      </div>
    );
  }

  const overlays = [
    entry != null && { value: entry, color: ACCENT, label: "Entrée", dashed: true },
    stop != null && { value: stop, color: NEG, label: "Stop", dashed: true },
    takeProfit != null && { value: takeProfit, color: POS, label: "TP", dashed: true },
    support != null && { value: support, color: MUTED, label: "Support", dashed: true },
    resistance != null && { value: resistance, color: MUTED, label: "Résist.", dashed: true },
  ].filter(Boolean);

  return (
    <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontSize: 13, fontWeight: 700 }}>{symbol}</div>
        <div style={{ display: "flex", gap: 4 }}>
          {RANGE_OPTIONS.map((r) => (
            <button
              key={r.key}
              onClick={() => setRange(r.key)}
              style={{
                padding: "4px 10px",
                borderRadius: 6,
                border: `1px solid ${range === r.key ? ACCENT : LINE}`,
                background: range === r.key ? "rgba(79,140,255,0.12)" : "transparent",
                color: range === r.key ? ACCENT : MUTED,
                fontSize: 11,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {state.loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "40px 0", justifyContent: "center", color: MUTED, fontSize: 12 }}>
          <Loader2 className="spin" size={14} color={ACCENT} /> Chargement du graphique…
        </div>
      )}

      {!state.loading && state.error && (
        <div style={{ fontSize: 12, color: NEG, padding: "20px 0", textAlign: "center" }}>{state.error}</div>
      )}

      {!state.loading && !state.error && state.candles.length > 0 && (
        <>
          <CandleChart candles={state.candles} overlays={overlays} />
          {state.note && <div style={{ fontSize: 10, color: MUTED, marginTop: 6 }}>ℹ️ {state.note}</div>}
        </>
      )}
    </div>
  );
}

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
                support: dossier.support,
                resistance: dossier.resistance,
                assetType: type === "crypto" ? "crypto" : type === "fx" && isMetal(query) ? "matieres" : type === "fx" ? "forex" : "actions",
                direction: dossier.levelsDirection === "baissier" ? "short" : "long",
                symbol: dossier.symbol,
                rawQuery: dossier.rawQuery,
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

const ACTION_MAP = {
  haussier: { label: "GO", color: POS },
  baissier: { label: "AVOID", color: NEG },
  mitigé: { label: "WAIT", color: MUTED },
};

// ============================================================================
// Croisement Top 15 <-> historique de trades (positions ouvertes)
// ============================================================================

// Détermine le assetType (même convention que tradeHistory / Calculateur)
// pour un résultat de scan Top 15.
function assetTypeForResult(r) {
  if (r.type === "crypto") return "crypto";
  if (r.type === "fx" && isMetal(r.query)) return "matieres";
  if (r.type === "fx") return "forex";
  return "actions";
}

const POSITION_BADGE = {
  stopTouched: { label: "STOP TOUCHÉ", color: NEG },
  stopProche: { label: "STOP PROCHE", color: NEG },
  objectifAtteint: { label: "OBJECTIF ATTEINT", color: POS },
  cloturer: { label: "CLÔTURER", color: NEG },
  objectifProche: { label: "OBJECTIF PROCHE", color: POS },
  renforcer: { label: "RENFORCER", color: POS },
  patienter: { label: "PATIENTER", color: AMBER },
};

function formatTradeDateShort(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit" });
}

// Calcule la recommandation de gestion de position pour un trade ouvert
// donné, en croisant son entrée/stop/TP avec le prix et le verdict actuels
// du marché issus du scan Top 15.
function computePositionGuidance(trade, r) {
  const isLong = trade.direction !== "short";
  const currentPrice = r.price;
  const entryPrice = trade.entry;
  const stopPrice = trade.stop;
  const tpPrice = trade.takeProfit;

  const pnlPct =
    entryPrice != null && entryPrice !== 0
      ? (isLong ? (currentPrice - entryPrice) / entryPrice : (entryPrice - currentPrice) / entryPrice) * 100
      : null;
  const pnlText = pnlPct != null ? `${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%` : "—";
  const base = `En position depuis le ${formatTradeDateShort(trade.createdAt)}, entrée $${formatPrice(entryPrice)}, prix actuel $${formatPrice(currentPrice)} (${pnlText}).`;

  // 1. Stop touché
  if (stopPrice != null && (isLong ? currentPrice <= stopPrice : currentPrice >= stopPrice)) {
    return { key: "stopTouched", message: `${base} Le stop-loss ($${formatPrice(stopPrice)}) est touché ou dépassé — protège ton capital.` };
  }

  // 2. Stop proche (moins de 25% de la distance d'entrée au stop)
  if (stopPrice != null) {
    const totalStopDistance = isLong ? entryPrice - stopPrice : stopPrice - entryPrice;
    const distanceToStop = isLong ? currentPrice - stopPrice : stopPrice - currentPrice;
    if (totalStopDistance > 0 && distanceToStop / totalStopDistance <= 0.25) {
      return { key: "stopProche", message: `${base} Prix à ${(100 * distanceToStop / totalStopDistance).toFixed(0)}% de la distance du stop ($${formatPrice(stopPrice)}) — surveille de près.` };
    }
  }

  // 3. Take-profit atteint ou dépassé
  if (tpPrice != null && (isLong ? currentPrice >= tpPrice : currentPrice <= tpPrice)) {
    return { key: "objectifAtteint", message: `${base} Le take-profit ($${formatPrice(tpPrice)}) est atteint ou dépassé — envisage de sécuriser les gains.` };
  }

  const marketBullish = r.verdict === "haussier";
  const marketBearish = r.verdict === "baissier";

  // 4. Le marché s'est retourné contre la position
  if ((isLong && marketBearish) || (!isLong && marketBullish)) {
    return { key: "cloturer", message: `${base} Le marché s'est retourné contre ta position (signal désormais ${r.verdict}) — envisage de clôturer pour limiter le risque.` };
  }

  // 5. Take-profit proche (moins de 25% de la distance restante)
  if (tpPrice != null) {
    const totalTpDistance = isLong ? tpPrice - entryPrice : entryPrice - tpPrice;
    const distanceToTp = isLong ? tpPrice - currentPrice : currentPrice - tpPrice;
    if (totalTpDistance > 0 && distanceToTp / totalTpDistance <= 0.25) {
      return { key: "objectifProche", message: `${base} Prix à ${(100 * distanceToTp / totalTpDistance).toFixed(0)}% de la distance de l'objectif ($${formatPrice(tpPrice)}) — envisage de sécuriser une partie des gains.` };
    }
  }

  // 6. Le marché confirme toujours la direction de la position
  if ((isLong && marketBullish) || (!isLong && marketBearish)) {
    return { key: "renforcer", message: `${base} Signal toujours ${r.verdict} — tu peux envisager de renforcer la position.` };
  }

  // 7. Rien de particulier
  return { key: "patienter", message: `${base} Signal neutre, rien de particulier à signaler pour l'instant — patiente.` };
}

function splitLabel(label) {
  const m = label.match(/^(.+?)\s*\(([^)]+)\)$/);
  if (m) return { name: m[1], ticker: m[2] };
  return { name: label, ticker: "" };
}

function TopMarkets({ onSendToCalculator, onGoToHistorique }) {
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: WATCHLIST.length });
  const [results, setResults] = useState([]);
  const [error, setError] = useState("");
  const [openTrades, setOpenTrades] = useState([]);

  useEffect(() => {
    setOpenTrades(getOpenTrades(loadHistory()));
  }, []);

  const runScan = useCallback(async () => {
    setLoading(true);
    setError("");
    setResults([]);
    setProgress({ done: 0, total: WATCHLIST.length });
    setOpenTrades(getOpenTrades(loadHistory()));

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
        await new Promise((res) => setTimeout(res, 1000));
      }
    };

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

  useEffect(() => {
    runScan();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>
        Scan classé de 15 marchés (8 cryptos, or, argent, 5 devises majeures) avec la même
        analyse que le Dossier — tendances 7j/30j/90j + sentiment des actualités. Pour un actif
        où tu as déjà une position ouverte, le badge devient une recommandation de gestion de
        position (renforcer, conserver, sécuriser, clôturer…) basée sur ton historique. Clique
        un marché pour l'envoyer au calculateur ou gérer la position existante.
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

            const resultSymbol = r.symbol || r.query.toUpperCase();
            const resultAssetType = assetTypeForResult(r);
            const matchedTrade = openTrades.find(
              (t) => t.symbol === resultSymbol && t.assetType === resultAssetType
            );
            const guidance = matchedTrade ? computePositionGuidance(matchedTrade, r) : null;

            const action = guidance ? POSITION_BADGE[guidance.key] : ACTION_MAP[r.verdict] || ACTION_MAP["mitigé"];

            const isBearishLevels = r.levelsDirection === "baissier";
            const buyPrice = r.price;
            const sellPrice = r.takeProfit;
            const stopPrice = isBearishLevels ? r.atrStopShort : r.atrStop;
            const hasLevels = !guidance && sellPrice != null && stopPrice != null;
            const hasChange = r.change24h != null;
            const hasRR = !guidance && r.riskReward != null && Number.isFinite(r.riskReward);

            // Pour une position déjà ouverte gérée depuis l'Historique
            // (stop/objectif proche ou atteint, ou retournement), le clic
            // amène vers l'onglet Historique plutôt que de proposer un
            // nouveau trade. "Renforcer" pré-remplit le Calculateur en
            // combinant l'historique (montant investi, levier, sens, actif
            // — tirés du trade ouvert lui-même) et l'analyse en cours de
            // l'appli (prix d'entrée, stop, take-profit recalculés à
            // l'instant T par le moteur). L'absence de position ouverte
            // envoie vers le Calculateur comme pour un nouveau trade.
            const handleClick = () => {
              if (guidance && guidance.key !== "renforcer" && guidance.key !== "patienter") {
                onGoToHistorique();
                return;
              }

              if (guidance && guidance.key === "renforcer") {
                const isLong = matchedTrade.direction !== "short";
                onSendToCalculator({
                  entry: buyPrice,
                  stop: isLong ? r.atrStop : r.atrStopShort,
                  takeProfit: r.takeProfit,
                  support: r.support,
                  resistance: r.resistance,
                  assetType: matchedTrade.assetType,
                  direction: matchedTrade.direction,
                  symbol: matchedTrade.symbol,
                  rawQuery: r.rawQuery || r.query,
                  verdict: r.verdict,
                  invested: matchedTrade.invested,
                  leverage: matchedTrade.leverage,
                });
                return;
              }

              onSendToCalculator({
                entry: buyPrice,
                stop: stopPrice,
                takeProfit: sellPrice,
                support: r.support,
                resistance: r.resistance,
                assetType: resultAssetType,
                direction: isBearishLevels ? "short" : "long",
                symbol: resultSymbol,
                rawQuery: r.rawQuery || r.query,
                verdict: r.verdict,
              });
            };

            return (
              <button
                key={`${r.type}-${r.query}`}
                onClick={handleClick}
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
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: hasLevels || guidance ? 10 : 0 }}>
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

                {guidance && (
                  <div style={{ background: NAVY, borderRadius: 8, padding: "8px 10px", fontSize: 12, color: TEXT, lineHeight: 1.5 }}>
                    {guidance.message}
                  </div>
                )}

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

const LEVERAGE_PRESETS = {
  crypto: { label: "Crypto (CFD)", leverage: 2 },
  forex: { label: "Forex", leverage: 30 },
  actions: { label: "Actions", leverage: 5 },
  matieres: { label: "Matières premières / Or", leverage: 20 },
  spot: { label: "Spot (Binance, sans levier)", leverage: 1 },
};

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

  // --- Historique / garde-fous ---
  const [guidanceWarnings, setGuidanceWarnings] = useState([]);
  const [pendingLog, setPendingLog] = useState(null);
  const [logged, setLogged] = useState(false);

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
    setGuidanceWarnings([]);
    setPendingLog(null);
    setLogged(false);
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

  // Construit l'objet trade à partir des valeurs actuelles du calcul, pour
  // le bouton "Marquer comme pris" (onglet Historique).
  const buildCandidateTrade = () => {
    const direction = prefill?.direction || (s < e ? "long" : "short");
    return {
      symbol: prefill?.symbol || assetType,
      assetType,
      direction,
      entry: e,
      stop: s,
      takeProfit: tp > 0 ? tp : null,
      invested: inv,
      leverage: lev,
      quantity,
      positionValue,
      riskAmount: lossAmount,
      potentialGain: gainAmount,
      riskPct: lossPctOfInvested,
      verdict: prefill?.verdict || null,
    };
  };

  const handleTradePris = () => {
    if (!valid) return;
    const candidate = buildCandidateTrade();
    const warnings = checkGuidance(candidate);
    if (warnings.length > 0) {
      setGuidanceWarnings(warnings);
      setPendingLog(candidate);
    } else {
      addTrade(candidate);
      setLogged(true);
      setTimeout(() => setLogged(false), 2500);
    }
  };

  const confirmLogAnyway = () => {
    if (!pendingLog) return;
    addTrade(pendingLog);
    setGuidanceWarnings([]);
    setPendingLog(null);
    setLogged(true);
    setTimeout(() => setLogged(false), 2500);
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        <button onClick={() => setMode("auto")} style={{ flex: 1, padding: "9px 10px", borderRadius: 8, border: `1px solid ${mode === "auto" ? AMBER : LINE}`, background: mode === "auto" ? "rgba(252,211,77,0.12)" : "transparent", color: mode === "auto" ? AMBER : MUTED, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>⚡ Automatique — Signal</button>
        <button onClick={() => setMode("manual")} style={{ flex: 1, padding: "9px 10px", borderRadius: 8, border: `1px solid ${mode === "manual" ? AMBER : LINE}`, background: mode === "manual" ? "rgba(252,211,77,0.12)" : "transparent", color: mode === "manual" ? AMBER : MUTED, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>✎ Manuel</button>
      </div>

      <TradeChart
        assetType={prefill?.assetType}
        rawQuery={prefill?.rawQuery}
        symbol={prefill?.symbol}
        entry={prefill?.entry}
        stop={prefill?.stop}
        takeProfit={prefill?.takeProfit}
        support={prefill?.support}
        resistance={prefill?.resistance}
      />

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

      {valid && (
        <div style={{ marginTop: 12 }}>
          {guidanceWarnings.length > 0 ? (
            <div style={{ background: "rgba(255,103,103,0.08)", border: `1px solid ${NEG}`, borderRadius: 10, padding: 12 }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: NEG, marginBottom: 6 }}>⚠️ Avant de confirmer :</div>
              {guidanceWarnings.map((w, i) => (
                <div key={i} style={{ fontSize: 12, color: TEXT, marginBottom: 4 }}>• {w}</div>
              ))}
              <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
                <button
                  onClick={confirmLogAnyway}
                  style={{ flex: 1, background: NEG, border: "none", borderRadius: 8, padding: "8px 0", color: "#fff", fontWeight: 700, fontSize: 12, cursor: "pointer" }}
                >
                  Confirmer quand même
                </button>
                <button
                  onClick={() => { setGuidanceWarnings([]); setPendingLog(null); }}
                  style={{ flex: 1, background: "transparent", border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 0", color: MUTED, fontWeight: 700, fontSize: 12, cursor: "pointer" }}
                >
                  Annuler
                </button>
              </div>
            </div>
          ) : (
            <button
              onClick={handleTradePris}
              style={{
                width: "100%",
                background: logged ? POS : "rgba(61,214,140,0.12)",
                border: `1px solid ${POS}`,
                color: logged ? "#06231a" : POS,
                borderRadius: 8,
                padding: "10px 0",
                fontSize: 13,
                fontWeight: 700,
                cursor: "pointer",
              }}
            >
              {logged ? "✓ Enregistré dans l'historique" : "✅ Marquer comme pris"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

export default function TradingApp() {
  const [tab, setTab] = useState("top15");
  const [prefillCalc, setPrefillCalc] = useState(null);

  const tabs = [
    { id: "top15", label: "Top 15", icon: ListOrdered },
    { id: "dossier", label: "Dossier", icon: FileText },
    { id: "calc", label: "Calculateur", icon: Calculator },
    { id: "historique", label: "Historique", icon: HistoryIcon },
  ];

  return (
    <div style={{ minHeight: "100vh", background: "#000000", color: TEXT, padding: "28px 18px 60px" }}>
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
            onGoToHistorique={() => setTab("historique")}
          />
        )}
        {tab === "dossier" && <Dossier setTab={setTab} setPrefillCalc={setPrefillCalc} />}
        {tab === "calc" && <Calculateur prefill={prefillCalc} />}
        {tab === "historique" && <HistoryTab />}
      </div>
    </div>
  );
}
