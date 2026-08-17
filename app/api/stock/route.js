// Proxy vers Twelve Data — la clé vient d'une variable d'environnement
// côté serveur (TWELVE_DATA_API_KEY), jamais exposée au navigateur.
//
// market=equity (défaut) : actions, ex. symbol=TSLA
// market=fx              : devises (or/argent restent gérés via gold-api,
//                           pas cette route), ex. symbol=EUR ou GBP, coté
//                           contre USD → converti en "EUR/USD" pour Twelve Data
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
    const res = await fetch(url);
    const data = await res.json();
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: "Impossible de contacter Twelve Data" }, { status: 500 });
  }
}
