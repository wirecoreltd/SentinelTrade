"use client";

// Fonctions de récupération de prix "actuel" partagées entre TradingApp.jsx
// (Dossier, Top 15, Long terme) et HistoryTab.jsx (prix live des positions
// ouvertes). Twelve Data côté actions/forex, gold-api pour l'or/l'argent,
// proxy CoinGecko côté crypto.

const apiCache = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000; // 15 minutes

export async function cachedFetch(key, fetcher) {
  const cached = apiCache.get(key);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.data;
  }
  const data = await fetcher();
  apiCache.set(key, { data, ts: Date.now() });
  return data;
}

export const METAL_SYMBOLS = ["XAU", "XAG"];
export function isMetal(symbol) {
  return METAL_SYMBOLS.includes(symbol.toUpperCase());
}

export async function fetchMetalPrice(symbol) {
  const res = await fetch(`https://api.gold-api.com/price/${encodeURIComponent(symbol.toUpperCase())}`);
  if (!res.ok) throw new Error("Métal introuvable (XAU pour l'or, XAG pour l'argent)");
  const data = await res.json();
  if (typeof data.price !== "number") throw new Error("Prix du métal indisponible");
  return { price: data.price, change24h: null };
}

export async function coingeckoProxy(path, params = {}) {
  const query = new URLSearchParams({ path, ...params }).toString();
  const res = await fetch(`/api/coingecko?${query}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data?.error || "Erreur CoinGecko");
  return data;
}

export async function fetchCoinGeckoPrice(id) {
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

export async function fetchAlphaQuote(symbol) {
  return cachedFetch(`quote:${symbol}`, async () => {
    const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&kind=quote`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.status === "error" || data.close == null) {
      throw new Error(data.message || "Symbole introuvable");
    }
    return { price: parseFloat(data.close), change24h: parseFloat(data.percent_change) };
  });
}

export async function fetchFxQuote(symbol) {
  return cachedFetch(`fxquote:${symbol}`, async () => {
    const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&kind=quote&market=fx`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    if (data.status === "error" || data.close == null) {
      throw new Error(data.message || "Devise introuvable (ex: EUR, GBP)");
    }
    return { price: parseFloat(data.close), change24h: parseFloat(data.percent_change) };
  });
}

// Prix "actuel" générique pour une position de l'Historique, quel que soit
// son type d'actif. Sert uniquement à l'affichage (P&L en direct) — ne
// touche jamais aux niveaux entrée/stop/TP figés à la prise du trade.
export async function fetchCurrentPriceFor(symbol, assetType) {
  if (assetType === "crypto") {
    const r = await fetchCoinGeckoPrice(symbol.toLowerCase());
    return r.price;
  }
  if (assetType === "matieres") {
    const r = await fetchMetalPrice(symbol);
    return r.price;
  }
  if (assetType === "forex") {
    const r = await fetchFxQuote(symbol);
    return r.price;
  }
  const r = await fetchAlphaQuote(symbol);
  return r.price;
}
