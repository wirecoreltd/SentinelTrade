// Proxy vers Yahoo Finance — endpoint non-officiel mais très stable
// (v8/finance/chart), gratuit, SANS clé API, sans limite de débit
// documentée ("généreux pour un usage individuel"). Remplace Finnhub
// (historique passé payant) et Twelve Data (trop lent avec 8 req/min).
//
// Couvre actions ET forex sur le même endpoint :
//   - market=equity (défaut) : symbol=TSLA, symbol=AAPL, ...
//   - market=fx              : symbol=EUR, symbol=GBP, ... -> mappé vers
//                               le ticker Yahoo "EURUSD=X" (coté contre USD)
//   (l'or/argent restent gérés via gold-api ailleurs dans le projet,
//    comme avant — cette route ne change rien à ça)
//
// Pas de clé à configurer sur Vercel : aucune variable d'environnement
// n'est nécessaire pour cette route.
//
// Deux hôtes existent chez Yahoo (query1 / query2), parfois l'un des
// deux répond mal isolément : on retente automatiquement sur l'autre
// avant d'abandonner.

const YAHOO_HOSTS = ["query1.finance.yahoo.com", "query2.finance.yahoo.com"];

const FETCH_HEADERS = {
  // Un User-Agent est obligatoire, sinon Yahoo répond 403.
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
  Accept: "application/json",
};

async function fetchYahooChart(symbol, { range, interval }) {
  let lastError = null;

  for (const host of YAHOO_HOSTS) {
    const url = `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
    try {
      const res = await fetch(url, { headers: FETCH_HEADERS });
      if (!res.ok) {
        lastError = new Error(`Yahoo a répondu ${res.status} (${host})`);
        continue;
      }
      const data = await res.json();
      const result = data?.chart?.result?.[0];
      const error = data?.chart?.error;
      if (error || !result) {
        lastError = new Error(error?.description || `Réponse Yahoo vide (${host})`);
        continue;
      }
      return result;
    } catch (err) {
      lastError = err;
      continue;
    }
  }

  throw lastError || new Error("Impossible de contacter Yahoo Finance");
}

// Résultat Yahoo -> même forme que l'ancienne réponse Finnhub/Twelve Data
// ({ values: [...] }) attendue par fetchAlphaHistory/fetchFxHistory dans
// TradingApp.jsx.
function toValuesArray(result) {
  const timestamps = result?.timestamp;
  const quote = result?.indicators?.quote?.[0];
  if (!Array.isArray(timestamps) || !quote) return null;

  const values = timestamps
    .map((ts, i) => ({
      datetime: new Date(ts * 1000).toISOString(),
      open: quote.open?.[i],
      high: quote.high?.[i],
      low: quote.low?.[i],
      close: quote.close?.[i],
    }))
    // Yahoo renvoie parfois des trous (close: null) sur les jours fériés
    // partiels ou les tout premiers points d'un ticker récent.
    .filter((v) => v.close !== null && v.close !== undefined);

  return values.length > 0 ? values : null;
}

// Devises conventionnellement cotées avec l'USD comme MONNAIE DE BASE
// (USD/JPY, USD/CHF, ...) plutôt que comme devise cotée contre l'USD.
// Pour celles-ci, le ticker Yahoo doit être "USD" + symbole, pas l'inverse.
const USD_BASE_CURRENCIES = ["JPY", "CHF", "CAD", "CNY", "INR", "MXN", "SEK", "NOK", "SGD"];

function yahooFxSymbol(symbol) {
  const s = symbol.toUpperCase();
  if (USD_BASE_CURRENCIES.includes(s)) {
    return `USD${s}=X`;
  }
  return `${s}USD=X`;
}

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol");
  const kind = searchParams.get("kind"); // "quote" ou "history"
  const market = searchParams.get("market") || "equity";

  if (!symbol || !kind) {
    return Response.json({ error: "Paramètres manquants (symbol, kind)" }, { status: 400 });
  }

  const yahooSymbol = market === "fx" ? yahooFxSymbol(symbol) : symbol.toUpperCase();

  try {
    if (kind === "quote") {
      // range=5d suffit largement : on ne se sert que des deux dernières
      // valeurs (meta.regularMarketPrice / meta.previousClose), mais un
      // petit historique sert de filet de sécurité si le meta est incomplet.
      const result = await fetchYahooChart(yahooSymbol, { range: "5d", interval: "1d" });
      const meta = result?.meta;

      let close = meta?.regularMarketPrice;
      let previousClose = meta?.previousClose ?? meta?.chartPreviousClose;

      // Filet de sécurité si le meta ne contient pas ce qu'il faut.
      if (close === undefined || previousClose === undefined) {
        const values = toValuesArray(result);
        if (values && values.length > 0) {
          close = close ?? values[values.length - 1].close;
          if (previousClose === undefined && values.length >= 2) {
            previousClose = values[values.length - 2].close;
          }
        }
      }

      if (close === undefined || close === null) {
        return Response.json({
          status: "error",
          message: market === "fx" ? "Devise introuvable (ex: EUR, GBP)" : "Symbole introuvable",
        });
      }

      const percentChange =
        previousClose && previousClose !== 0 ? ((close - previousClose) / previousClose) * 100 : null;

      return Response.json({ close, percent_change: percentChange });
    }

    if (kind === "history") {
      // ~1 an de bougies journalières (largement plus que les ~130-140
      // bougies ouvrées qu'on avait avec Finnhub sur 200 jours calendaires).
      const result = await fetchYahooChart(yahooSymbol, { range: "1y", interval: "1d" });
      const values = toValuesArray(result);

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
    return Response.json({ error: "Impossible de contacter Yahoo Finance" }, { status: 500 });
  }
}
