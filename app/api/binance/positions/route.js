import { NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lecture seule : positions Spot (avoirs hors stablecoins), prix d'achat moyen
// estimé depuis l'historique de tes trades, et ordres ouverts.
const BASE = process.env.BINANCE_API_BASE_URL || "https://api.binance.com";
const PRICES_URL = "https://data-api.binance.vision/api/v3/ticker/price";
const STABLES = new Set(["USDT", "USDC", "FDUSD", "BUSD", "TUSD"]);
const MIN_USDT = 1; // ignore la poussière

function tokenOk(req) {
  const expected = process.env.APP_ACCESS_TOKEN;
  const given = req.headers.get("x-app-token") || "";
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function signedGet(path, params, key, secret) {
  const qs = new URLSearchParams({ ...params, timestamp: String(Date.now()), recvWindow: "5000" }).toString();
  const sig = crypto.createHmac("sha256", secret).update(qs).digest("hex");
  const res = await fetch(`${BASE}${path}?${qs}&signature=${sig}`, { headers: { "X-MBX-APIKEY": key }, cache: "no-store" });
  const data = await res.json();
  if (!res.ok) {
    const err = new Error(data?.msg || "Erreur Binance.");
    err.status = res.status;
    throw err;
  }
  return data;
}

// Prix d'achat moyen pondéré : les ventes retirent du coût au prix moyen courant.
function averageEntry(trades, asset) {
  let qty = 0;
  let cost = 0;
  for (const t of [...trades].sort((x, y) => x.time - y.time)) {
    const q = parseFloat(t.qty);
    const quote = parseFloat(t.quoteQty);
    if (t.isBuyer) {
      const fee = t.commissionAsset === asset ? parseFloat(t.commission) : 0;
      qty += q - fee;
      cost += quote;
    } else if (qty > 0) {
      const avg = cost / qty;
      const sold = Math.min(q, qty);
      cost -= sold * avg;
      qty -= sold;
    }
  }
  return qty > 0 && cost > 0 ? cost / qty : null;
}

export async function GET(request) {
  const key = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;
  if (!process.env.APP_ACCESS_TOKEN || !key || !secret) {
    return NextResponse.json({ ok: false, error: "Configuration serveur incomplète." }, { status: 503 });
  }
  if (!tokenOk(request)) return NextResponse.json({ ok: false, error: "Accès refusé." }, { status: 401 });

  try {
    const [acc, orders, priceRes] = await Promise.all([
      signedGet("/api/v3/account", { omitZeroBalances: "true" }, key, secret),
      signedGet("/api/v3/openOrders", {}, key, secret),
      fetch(PRICES_URL, { cache: "no-store" }),
    ]);
    const prices = {};
    if (priceRes.ok) for (const p of await priceRes.json()) prices[p.symbol] = parseFloat(p.price);

    const holdings = (acc.balances || [])
      .map((b) => ({ asset: b.asset, qty: parseFloat(b.free) + parseFloat(b.locked) }))
      .filter((b) => !STABLES.has(b.asset) && b.qty > 0 && prices[`${b.asset}USDT`])
      .map((b) => ({ ...b, symbol: `${b.asset}USDT`, price: prices[`${b.asset}USDT`], value: b.qty * prices[`${b.asset}USDT`] }))
      .filter((b) => b.value >= MIN_USDT)
      .sort((x, y) => y.value - x.value)
      .slice(0, 10);

    const positions = [];
    for (const h of holdings) {
      let entry = null;
      try {
        entry = averageEntry(await signedGet("/api/v3/myTrades", { symbol: h.symbol, limit: "1000" }, key, secret), h.asset);
      } catch {
        // pas d'historique lisible : on affichera la position sans prix d'entrée
      }
      positions.push({ ...h, entry });
    }

    const stableTotal = (acc.balances || [])
      .filter((b) => STABLES.has(b.asset))
      .reduce((s, b) => s + parseFloat(b.free) + parseFloat(b.locked), 0);

    return NextResponse.json({
      ok: true,
      stableUsdt: stableTotal,
      positions,
      openOrders: orders.map((o) => ({
        symbol: o.symbol, side: o.side, type: o.type,
        price: parseFloat(o.price), stopPrice: parseFloat(o.stopPrice),
        qty: parseFloat(o.origQty), filled: parseFloat(o.executedQty),
      })),
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || "Erreur serveur." }, { status: error?.status === 451 ? 451 : 502 });
  }
}
