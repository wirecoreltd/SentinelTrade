// Proxy vers NewsData.io — la clé vient d'une variable d'environnement
// côté serveur (NEWSDATA_KEY), jamais exposée au navigateur.

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");
  const apikey = process.env.NEWSDATA_KEY;

  if (!q) {
    return Response.json({ error: "Paramètre manquant (q)" }, { status: 400 });
  }
  if (!apikey) {
    return Response.json(
      { error: "Clé NewsData.io non configurée sur le serveur (variable NEWSDATA_KEY manquante sur Vercel)" },
      { status: 500 }
    );
  }

  try {
    const url = `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(
      apikey
    )}&q=${encodeURIComponent(q)}&language=en,fr&category=business`;

    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      return Response.json(
        { error: data?.results?.message || "Erreur NewsData.io" },
        { status: res.status }
      );
    }

    return Response.json(data);
  } catch (err) {
    return Response.json({ error: "Impossible de contacter NewsData.io" }, { status: 500 });
  }
}
