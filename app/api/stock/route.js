// Proxy vers Twelve Data — la clé vient d'une variable d'environnement
// côté serveur (TWELVE_DATA_API_KEY), jamais exposée au navigateur.
//
// market=equity (défaut) : actions, ex. symbol=TSLA
// market=fx              : devises (or/argent restent gérés via gold-api,
//                           pas cette route), ex. symbol=EUR ou GBP, coté
//                           contre USD → converti en "EUR/USD" pour Twelve Data
//
// Limite de débit : le plan gratuit Twelve Data autorise 8 requêtes/minute
// (en plus du quota de 800/jour). Depuis que l'app scanne 4 onglets en
// parallèle au chargement (useMarketScans), plusieurs appels peuvent partir
// en même temps et dépasser ce seuil. La file ci-dessous sérialise TOUS les
// appels sortants vers Twelve Data, quel que soit le client qui les déclenche,
// avec un espacement garantissant max 8 requêtes par fenêtre de 60s.
// Persiste tant que l'instance serverless reste "chaude" (suffisant pour un
// usage perso mono-utilisateur ; pas une garantie distribuée multi-instance).
const RATE_LIMIT_PER_MINUTE = 8;
const RATE_WINDOW_MS = 60 * 1000;
const SAFETY_MARGIN_MS = 500; // petite marge pour éviter les cas limites

let requestQueue = Promise.resolve();
let requestTimestamps = [];

function throttledTwelveDataCall(fn) {
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

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol");
  const kind = searchParams.get("kind"); // "quote" ou "history"
  const market = searchParams.get("market") || "equity";
  const key = process.env.TWELVE_DATA_API_KEY?.trim();
  if (!symbol || !kind) {
    return Response.json({ error: "Paramètres manquants (symbol, kind)" }, { status: 400 });
  }
  if (!key) {
    return Response.json(
      { error: "Clé Twelve Data non configurée sur le serveur (variable TWELVE_DATA_API_KEY manquante sur Vercel)" },
      { status: 500 }
    );
  }
  const tdSymbol = market === "fx" ? `${symbol.toUpperCase()}/USD` : symbol.toUpperCase();
  const url =
    kind === "history"
      ? `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=1day&outputsize=100&apikey=${key}`
      : `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(tdSymbol)}&apikey=${key}`;
  try {
    const data = await throttledTwelveDataCall(async () => {
      const res = await fetch(url);
      return res.json();
    });
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: "Impossible de contacter Twelve Data" }, { status: 500 });
  }
}
