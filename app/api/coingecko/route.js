export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const path = searchParams.get("path");
  if (!path) {
    return Response.json({ error: "Paramètre 'path' manquant" }, { status: 400 });
  }

  const params = new URLSearchParams(searchParams);
  params.delete("path");

  const url = `https://api.coingecko.com/api/v3/${path}?${params.toString()}`;

  const cgKey = process.env.COINGECKO_KEY?.trim();
  try {
    const res = await fetch(url, {
      headers: {
        Accept: "application/json",
        ...(cgKey ? { "x-cg-demo-api-key": cgKey } : {}),
      },
    });

    const data = await res.json();
    if (!res.ok) {
      return Response.json({ error: data?.status?.error_message || "Erreur CoinGecko" }, { status: res.status });
    }
    return Response.json(data);
  } catch (e) {
    return Response.json({ error: "Impossible de contacter CoinGecko" }, { status: 502 });
  }
}
