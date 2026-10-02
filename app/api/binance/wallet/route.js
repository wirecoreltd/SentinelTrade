import { NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Lecture seule : solde du compte Spot Binance, valorisé en USDT.
// Variables d'environnement (Vercel → Settings → Environment Variables) :
//   BINANCE_API_KEY, BINANCE_API_SECRET  → clé SANS droit de trading ni retrait
//   APP_ACCESS_TOKEN                     → mot de passe perso pour protéger cette route
//   BINANCE_API_BASE_URL (optionnel)     → défaut https://api.binance.com
const BASE = process.env.BINANCE_API_BASE_URL || "https://api.binance.com";
const PRICES_URL = "https://data-api.binance.vision/api/v3/ticker/price";
const STABLES = new Set(["USDT", "USDC", "FDUSD", "BUSD", "TUSD"]);

function tokenOk(req) {
  const expected = process.env.APP_ACCESS_TOKEN;
  const given = req.headers.get("x-app-token") || "";
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function GET(request) {
  const key = process.env.BINANCE_API_KEY;
  const secret = process.env.BINANCE_API_SECRET;

  if (!process.env.APP_ACCESS_TOKEN || !key || !secret) {
    return NextResponse.json(
      { ok: false, error: "Configuration serveur incomplète (BINANCE_API_KEY, BINANCE_API_SECRET, APP_ACCESS_TOKEN)." },
      { status: 503 }
    );
  }
  if (!tokenOk(request)) {
    return NextResponse.json({ ok: false, error: "Accès refusé." }, { status: 401 });
  }

  try {
    const query = `timestamp=${Date.now()}&recvWindow=5000&omitZeroBalances=true`;
    const signature = crypto.createHmac("sha256", secret).update(query).digest("hex");

    const [accRes, priceRes] = await Promise.all([
      fetch(`${BASE}/api/v3/account?${query}&signature=${signature}`, {
        headers: { "X-MBX-APIKEY": key },
        cache: "no-store",
      }),
      fetch(PRICES_URL, { cache: "no-store" }),
    ]);

    const acc = await accRes.json();
    if (!accRes.ok) {
      return NextResponse.json(
        { ok: false, status: accRes.status, error: acc?.msg || "Erreur Binance." },
        { status: accRes.status === 451 ? 451 : 502 }
      );
    }

    const prices = {};
    if (priceRes.ok) {
      for (const p of await priceRes.json()) prices[p.symbol] = parseFloat(p.price);
    }

    const balances = (acc.balances || [])
      .map((b) => {
        const qty = parseFloat(b.free) + parseFloat(b.locked);
        const usdt = STABLES.has(b.asset) ? qty : qty * (prices[`${b.asset}USDT`] || 0);
        return { asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked), usdtValue: usdt };
      })
      .filter((b) => b.free + b.locked > 0)
      .sort((x, y) => y.usdtValue - x.usdtValue);

    return NextResponse.json({
      ok: true,
      canTrade: acc.canTrade,
      totalUsdt: balances.reduce((s, b) => s + b.usdtValue, 0),
      balances,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || "Erreur serveur." }, { status: 500 });
  }
}
