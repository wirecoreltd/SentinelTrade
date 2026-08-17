// Proxy vers Twelve Data — la clé vient d'une variable d'environnement
// côté serveur (TWELVE_DATA_API_KEY), jamais exposée au navigateur.
// Remplace Alpha Vantage (25 requêtes/jour) pour lever la limite trop
// basse pour scanner plusieurs watchlists (devises + actions) par jour.
// Twelve Data : 800 requêtes/jour gratuites, même API pour actions et forex.
//
// market=equity (défaut) : actions, ex. symbol=TSLA
// market=fx              : devises et métaux (or=XAU, argent=XAG), ex. symbol=EUR ou XAU, coté contre USD
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol");
  const kind = searchParams.get("kind"); // "quote" ou "history"
  const market = searchParams.get("market") || "equity";
  // .trim() : élimine un espace ou retour à la ligne invisible qui peut
  // s'être glissé lors du copier-coller de la clé dans Vercel.
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

  // Twelve Data attend "EUR/USD" pour le forex, pas "EUR" seul comme Alpha Vantage.
  const tdSymbol = market === "fx" ? `${symbol}/USD` : symbol;

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
