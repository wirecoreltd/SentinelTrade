// Proxy vers Alpha Vantage — la clé vient d'une variable d'environnement
// côté serveur (ALPHA_VANTAGE_KEY), jamais exposée au navigateur.
//
// market=equity (défaut) : actions, ex. symbol=TSLA
// market=fx              : devises et métaux (or=XAU, argent=XAG), ex. symbol=EUR ou XAU, coté contre USD
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol");
  const kind = searchParams.get("kind"); // "quote" ou "history"
  const market = searchParams.get("market") || "equity";

  // .trim() : élimine un espace ou retour à la ligne invisible qui peut
  // s'être glissé lors du copier-coller de la clé dans Vercel — cause
  // fréquente d'un "Invalid API call" trompeur côté Alpha Vantage.
  const key = process.env.ALPHA_VANTAGE_KEY?.trim();

  if (!symbol || !kind) {
    return Response.json({ error: "Paramètres manquants (symbol, kind)" }, { status: 400 });
  }
  if (!key) {
    return Response.json(
      { error: "Clé Alpha Vantage non configurée sur le serveur (variable ALPHA_VANTAGE_KEY manquante sur Vercel)" },
      { status: 500 }
    );
  }
  let url;
  if (market === "fx") {
    url =
      kind === "history"
        ? `https://www.alphavantage.co/query?function=FX_DAILY&from_symbol=${encodeURIComponent(symbol)}&to_symbol=USD&outputsize=compact&apikey=${key}`
        : `https://www.alphavantage.co/query?function=CURRENCY_EXCHANGE_RATE&from_currency=${encodeURIComponent(symbol)}&to_currency=USD&apikey=${key}`;
  } else {
    const fn = kind === "history" ? "TIME_SERIES_DAILY" : "GLOBAL_QUOTE";
    const extra = kind === "history" ? "&outputsize=compact" : "";
    url = `https://www.alphavantage.co/query?function=${fn}&symbol=${encodeURIComponent(symbol)}&apikey=${key}${extra}`;
  }
  try {
    const res = await fetch(url);
    const data = await res.json();
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: "Impossible de contacter Alpha Vantage" }, { status: 500 });
  }
}
