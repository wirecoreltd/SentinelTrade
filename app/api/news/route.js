// Proxy vers NewsData.io — la clé vient d'une variable d'environnement
// côté serveur (NEWSDATA_KEY), jamais exposée au navigateur.
//
// Ajout : cache en mémoire par requête (TTL) pour absorber les rafales
// de requêtes (ex: plusieurs actifs interrogés en même temps côté client)
// et éviter de taper le rate-limit de NewsData.io. Le cache vit tant que
// l'instance serverless reste "chaude" — ce n'est pas un cache durable,
// mais ça suffit à éliminer les 429 causés par des appels en rafale.

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const cache = new Map(); // q -> { data, expiresAt }

// Si NewsData.io répond 429, on garde la dernière réponse valide un peu
// plus longtemps plutôt que de renvoyer une erreur au client.
const STALE_ON_RATE_LIMIT_MS = 60 * 60 * 1000; // 1 heure

function getFromCache(q) {
  const entry = cache.get(q);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) return null;
  return entry.data;
}

function setCache(q, data, ttl = CACHE_TTL_MS) {
  cache.set(q, { data, expiresAt: Date.now() + ttl });
}

// Renvoie la dernière donnée connue même expirée (utilisé en secours sur 429)
function getStale(q) {
  const entry = cache.get(q);
  return entry ? entry.data : null;
}

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

  // 1. Cache frais dispo -> on le sert direct, pas d'appel externe
  const cached = getFromCache(q);
  if (cached) {
    return Response.json(cached);
  }

  try {
    const url = `https://newsdata.io/api/1/news?apikey=${encodeURIComponent(
      apikey
    )}&q=${encodeURIComponent(q)}&language=en,fr&category=business`;
    const res = await fetch(url);
    const data = await res.json();

    if (!res.ok) {
      // 2. Rate-limité par NewsData.io -> on sert la dernière donnée connue
      // si on en a une, plutôt que de propager le 429 au client.
      if (res.status === 429) {
        const stale = getStale(q);
        if (stale) {
          return Response.json(stale);
        }
      }
      return Response.json(
        { error: data?.results?.message || "Erreur NewsData.io" },
        { status: res.status }
      );
    }

    setCache(q, data);
    return Response.json(data);
  } catch (err) {
    // 3. Erreur réseau -> même logique de secours sur le cache périmé
    const stale = getStale(q);
    if (stale) {
      return Response.json(stale);
    }
    return Response.json({ error: "Impossible de contacter NewsData.io" }, { status: 500 });
  }
}
