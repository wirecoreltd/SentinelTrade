// app/lib/watchlist.js
// Gestion de la watchlist "Long Terme" + cache des résultats + budget d'appels API.
// Tout est stocké dans localStorage (aucun backend, cohérent avec le reste de l'app).

const WATCHLIST_KEY = "st_longterm_watchlist";
const CACHE_KEY = "st_longterm_cache";
const QUOTA_KEY = "st_alphavantage_quota";

const DAILY_ALPHA_VANTAGE_QUOTA = 25; // plan gratuit
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24h — ajustable

// --- Watchlist ---------------------------------------------------------

export function getWatchlist() {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(WATCHLIST_KEY);
    return raw ? JSON.parse(raw) : defaultWatchlist();
  } catch {
    return defaultWatchlist();
  }
}

function defaultWatchlist() {
  // Liste de départ — à éditer depuis l'UI ensuite.
  return [
    { symbol: "AAPL", type: "stock" },
    { symbol: "MSFT", type: "stock" },
    { symbol: "EURUSD", type: "forex" },
    { symbol: "XAUUSD", type: "forex" },
    { symbol: "bitcoin", type: "crypto" }, // id CoinGecko
    { symbol: "ethereum", type: "crypto" },
  ];
}

export function saveWatchlist(list) {
  localStorage.setItem(WATCHLIST_KEY, JSON.stringify(list));
}

export function addToWatchlist(symbol, type) {
  const list = getWatchlist();
  if (list.some((a) => a.symbol === symbol && a.type === type)) return list;
  const updated = [...list, { symbol, type }];
  saveWatchlist(updated);
  return updated;
}

export function removeFromWatchlist(symbol, type) {
  const updated = getWatchlist().filter(
    (a) => !(a.symbol === symbol && a.type === type)
  );
  saveWatchlist(updated);
  return updated;
}

// --- Cache des scores ----------------------------------------------------

function getAllCache() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function cacheKey(symbol, type) {
  return `${type}:${symbol}`;
}

export function getCachedScore(symbol, type) {
  const all = getAllCache();
  const entry = all[cacheKey(symbol, type)];
  if (!entry) return null;
  const age = Date.now() - entry.timestamp;
  return { ...entry, isStale: age > CACHE_MAX_AGE_MS, ageMs: age };
}

export function setCachedScore(symbol, type, data) {
  const all = getAllCache();
  all[cacheKey(symbol, type)] = { ...data, timestamp: Date.now() };
  localStorage.setItem(CACHE_KEY, JSON.stringify(all));
}

// --- Budget quotidien Alpha Vantage ---------------------------------------

function todayStr() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD
}

function getQuotaState() {
  try {
    const raw = localStorage.getItem(QUOTA_KEY);
    const state = raw ? JSON.parse(raw) : null;
    if (!state || state.date !== todayStr()) {
      return { date: todayStr(), used: 0 };
    }
    return state;
  } catch {
    return { date: todayStr(), used: 0 };
  }
}

export function canUseAlphaVantageCall() {
  const state = getQuotaState();
  return state.used < DAILY_ALPHA_VANTAGE_QUOTA;
}

export function registerAlphaVantageCall() {
  const state = getQuotaState();
  state.used += 1;
  localStorage.setItem(QUOTA_KEY, JSON.stringify(state));
}

export function getRemainingQuota() {
  const state = getQuotaState();
  return Math.max(0, DAILY_ALPHA_VANTAGE_QUOTA - state.used);
}

// --- Ordonnancement du scan ------------------------------------------------

// Renvoie la watchlist triée: actifs sans cache ou les plus "périmés" d'abord.
// Utile pour décider quoi rafraîchir en premier avec un budget limité.
export function sortByStaleness(list) {
  return [...list].sort((a, b) => {
    const cacheA = getCachedScore(a.symbol, a.type);
    const cacheB = getCachedScore(b.symbol, b.type);
    const ageA = cacheA ? cacheA.ageMs : Infinity;
    const ageB = cacheB ? cacheB.ageMs : Infinity;
    return ageB - ageA; // plus vieux (ou jamais scanné) en premier
  });
}
