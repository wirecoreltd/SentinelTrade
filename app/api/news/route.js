// Proxy vers NewsData.io — évite les soucis de CORS depuis le navigateur.
// La clé reste fournie par l'utilisateur (stockée côté client), on la relaie simplement ici.

export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const q = searchParams.get("q");
  const apikey = searchParams.get("apikey");

  if (!q || !apikey) {
    return Response.json(
      { error: "Paramètres manquants (q, apikey)" },
      { status: 400 }
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
    return Response.json(
      { error: "Impossible de contacter NewsData.io" },
      { status: 500 }
    );
  }
}
