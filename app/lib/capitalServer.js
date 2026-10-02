import crypto from "crypto";

// Client Capital.com côté serveur UNIQUEMENT, limité à des appels GET de lecture
// (comptes, positions, prix). Aucune fonction d'ordre n'est implémentée ici.
const HOSTS = {
  live: "https://api-capital.backend-capital.com",
  demo: "https://demo-api-capital.backend-capital.com",
};
const BASE = HOSTS[process.env.CAPITAL_ENV === "demo" ? "demo" : "live"];

let cached = null; // { cst, sec, exp } — la session expire après 10 min d'inactivité
let pending = null; // une seule création de session à la fois (limite : 1 requête/seconde)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function getSession() {
  if (cached && cached.exp > Date.now()) return Promise.resolve(cached);
  if (!pending) {
    pending = createSession().finally(() => {
      pending = null;
    });
  }
  return pending;
}

export function tokenOk(req) {
  const expected = process.env.APP_ACCESS_TOKEN;
  const given = req.headers.get("x-app-token") || "";
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function capitalConfigured() {
  return !!(process.env.CAPITAL_API_KEY && process.env.CAPITAL_IDENTIFIER && process.env.CAPITAL_API_PASSWORD && process.env.APP_ACCESS_TOKEN);
}

async function createSession(attempt = 0) {
  const res = await fetch(`${BASE}/api/v1/session`, {
    method: "POST",
    headers: { "X-CAP-API-KEY": process.env.CAPITAL_API_KEY, "Content-Type": "application/json" },
    body: JSON.stringify({
      identifier: process.env.CAPITAL_IDENTIFIER,
      password: process.env.CAPITAL_API_PASSWORD,
      encryptedPassword: false,
    }),
    cache: "no-store",
  });
  if (res.status === 429 && attempt < 2) {
    await sleep(1500);
    return createSession(attempt + 1);
  }
  if (!res.ok) {
    let msg = "Connexion Capital.com refusée.";
    try { msg = (await res.json())?.errorCode || msg; } catch {}
    const err = new Error(msg);
    err.status = res.status;
    throw err;
  }
  cached = { cst: res.headers.get("CST"), sec: res.headers.get("X-SECURITY-TOKEN"), exp: Date.now() + 9 * 60 * 1000 };
  return cached;
}

export async function capitalGet(path, retry = true) {
  const s = await getSession();
  const res = await fetch(`${BASE}${path}`, {
    headers: { CST: s.cst, "X-SECURITY-TOKEN": s.sec },
    cache: "no-store",
  });
  if (res.status === 401 && retry) {
    cached = null;
    return capitalGet(path, false);
  }
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.errorCode || "Erreur Capital.com.");
    err.status = res.status;
    throw err;
  }
  return data;
}
