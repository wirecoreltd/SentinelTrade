// Proxy vers Finnhub — la clé vient d'une variable d'environnement côté
// serveur (FINNHUB_API_KEY), jamais exposée au navigateur.
//
// Remplace Twelve Data (8 requêtes/minute sur le plan gratuit) par Finnhub
// (60 requêtes/minute sur le plan gratuit) — un scan complet de Top Devises
// & Or + Top Actions consomme environ 43 appels ; ça passait en 5-6 minutes
// avec Twelve Data (file d'attente à 8/min), ça passe en ~1 minute ici.
//
// market=equity (défaut) : actions, ex. symbol=TSLA
// market=fx              : devises (or/argent restent gérés via gold-api,
//                           pas cette route), ex. symbol=EUR ou GBP, coté
//                           contre USD via le pair OANDA:{SYM}_USD.
//                           Finnhub gratuit n'a pas de quote forex fiable en
//                           temps réel : le "prix actuel" est dérivé de la
//                           dernière bougie journalière, comme le fait déjà
//                           runMarketAnalysis() côté client pour l'analyse.

const RATE_LIMIT_PER_MINUTE = 55; // marge de sécurité sous les 60/min du plan gratuit
const RATE_WINDOW_MS = 60 * 1000;
const SAFETY_MARGIN_MS = 300;

let requestQueue = Promise.resolve();
let requestTimestamps = [];

function throttledFinnhubCall(fn) {
  const run = requestQueue.then(async () => {
    const now = Date.now();
    requestTimestamps = requestTimestamps.filter((t) => now - t < RATE_WINDOW_MS);
    if (requestTimestamps.length >= RATE_LIMIT_PER_MINUTE) {
      const oldest = requestTimestamps[0];
      const waitMs = RATE_WINDOW_MS - (now - oldest) + SAFETY_MARGIN_MS;
      await new Promise((r) => setTimeout(r, waitMs));
      requestTimestamps = requestTimestamps.filter((t) => Date.now() - t < RATE_WINDOW_MS);
    }
    requestTimestamps.push(Date.now());
    return fn();
  });
  requestQueue = run.catch(() => {});
  return run;
}

// Format candle Finnhub { c:[], h:[], l:[], o:[], t:[], s: "ok"|"no_data" }
// -> même forme que l'ancienne réponse Twelve Data ({ values: [...] })
// attendue par fetchAlphaHistory/fetchFxHistory dans TradingApp.jsx.
function toValuesArray(candles) {
  if (!candles || candles.s !== "ok" || !Array.isArray(candles.t)) return null;
  return candles.t.map((ts, i) => ({
    datetime: new Date(ts * 1000).toISOString(),
    open: candles.o[i],
    high: candles.h[i],
    low: candles.l[i],
    close: candles.c[i],
  }));
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol");
  const kind = searchParams.get("kind"); // "quote" ou "history"
  const market = searchParams.get("market") || "equity";
  const key = process.env.FINNHUB_API_KEY?.trim();

  if (!symbol || !kind) {
    return Response.json({ error: "Paramètres manquants (symbol, kind)" }, { status: 400 });
  }
  if (!key) {
    return Response.json(
      { error: "Clé Finnhub non configurée sur le serveur (variable FINNHUB_API_KEY manquante sur Vercel)" },
      { status: 500 }
    );
  }

  const finnhubFxSymbol = `OANDA:${symbol.toUpperCase()}_USD`;
  const finnhubEquitySymbol = symbol.toUpperCase();

  try {
    if (kind === "quote") {
      if (market === "fx") {
        const to = Math.floor(Date.now() / 1000);
        const from = to - 10 * 24 * 60 * 60;
        const url = `https://finnhub.io/api/v1/forex/candle?symbol=${encodeURIComponent(finnhubFxSymbol)}&resolution=D&from=${from}&to=${to}&token=${key}`;
        const data = await throttledFinnhubCall(async () => {
          const res = await fetch(url);
          return res.json();
        });
        const values = toValuesArray(data);
        if (!values || values.length === 0) {
          return Response.json({ status: "error", message: "Devise introuvable (ex: EUR, GBP)" });
        }
        const last = values[values.length - 1];
        const prev = values.length >= 2 ? values[values.length - 2] : null;
        const percentChange = prev && prev.close ? ((last.close - prev.close) / prev.close) * 100 : null;
        return Response.json({ close: last.close, percent_change: percentChange });
      }

      const url = `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(finnhubEquitySymbol)}&token=${key}`;
      const data = await throttledFinnhubCall(async () => {
        const res = await fetch(url);
        return res.json();
      });
      if (!data || (data.c === 0 && data.pc === 0)) {
        return Response.json({ status: "error", message: "Symbole introuvable" });
      }
      return Response.json({ close: data.c, percent_change: data.dp });
    }

    if (kind === "history") {
      const to = Math.floor(Date.now() / 1000);
      const from = to - 200 * 24 * 60 * 60; // ~200 jours calendaires -> environ 130-140 bougies ouvrées
      const endpoint = market === "fx" ? "forex/candle" : "stock/candle";
      const finnhubSymbol = market === "fx" ? finnhubFxSymbol : finnhubEquitySymbol;
      const url = `https://finnhub.io/api/v1/${endpoint}?symbol=${encodeURIComponent(finnhubSymbol)}&resolution=D&from=${from}&to=${to}&token=${key}`;
      const data = await throttledFinnhubCall(async () => {
        const res = await fetch(url);
        return res.json();
      });
      const values = toValuesArray(data);
      if (!values || values.length === 0) {
        return Response.json({
          status: "error",
          message: market === "fx" ? "Historique indisponible pour cette devise" : "Historique indisponible pour ce symbole",
        });
      }
      return Response.json({ values });
    }

    return Response.json({ error: "Paramètre kind invalide (quote ou history)" }, { status: 400 });
  } catch (err) {
    return Response.json({ error: "Impossible de contacter Finnhub" }, { status: 500 });
  }
}
