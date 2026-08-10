// Proxy vers Alpha Vantage — la clé vient d'une variable d'environnement
// côté serveur (ALPHA_VANTAGE_KEY), jamais exposée au navigateur.

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const symbol = searchParams.get("symbol");
  const kind = searchParams.get("kind"); // "quote" ou "history"
  const key = process.env.ALPHA_VANTAGE_KEY;

  if (!symbol || !kind) {
    return Response.json({ error: "Paramètres manquants (symbol, kind)" }, { status: 400 });
  }
  if (!key) {
    return Response.json(
      { error: "Clé Alpha Vantage non configurée sur le serveur (variable ALPHA_VANTAGE_KEY manquante sur Vercel)" },
      { status: 500 }
    );
  }

  const fn = kind === "history" ? "TIME_SERIES_DAILY" : "GLOBAL_QUOTE";
  const extra = kind === "history" ? "&outputsize=compact" : "";

  try {
    const url = `https://www.alphavantage.co/query?function=${fn}&symbol=${encodeURIComponent(symbol)}&apikey=${key}${extra}`;
    const res = await fetch(url);
    const data = await res.json();
    return Response.json(data);
  } catch (err) {
    return Response.json({ error: "Impossible de contacter Alpha Vantage" }, { status: 500 });
  }
}
