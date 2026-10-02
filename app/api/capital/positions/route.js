import { NextResponse } from "next/server";
import { capitalGet, capitalConfigured, tokenOk } from "../../../lib/capitalServer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request) {
  if (!capitalConfigured()) {
    return NextResponse.json({ ok: false, error: "Configuration serveur incomplète (CAPITAL_API_KEY, CAPITAL_IDENTIFIER, CAPITAL_API_PASSWORD, APP_ACCESS_TOKEN)." }, { status: 503 });
  }
  if (!tokenOk(request)) return NextResponse.json({ ok: false, error: "Accès refusé." }, { status: 401 });

  try {
    const accounts = await capitalGet("/api/v1/accounts");
    const pos = await capitalGet("/api/v1/positions");
    const acc = (accounts.accounts || []).find((a) => a.preferred) || accounts.accounts?.[0];

    const positions = [];
    for (const item of (pos.positions || []).slice(0, 8)) {
      const p = item.position || {};
      const m = item.market || {};
      let candles = [];
      try {
        const pr = await capitalGet(`/api/v1/prices/${encodeURIComponent(m.epic)}?resolution=DAY&max=120`);
        const mid = (o) => (o && o.bid != null && o.ask != null ? (o.bid + o.ask) / 2 : o?.bid ?? o?.ask);
        candles = (pr.prices || []).map((c) => ({
          open: mid(c.openPrice), high: mid(c.highPrice), low: mid(c.lowPrice), close: mid(c.closePrice),
        })).filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite));
      } catch {
        // pas d'historique : la position s'affiche sans analyse
      }
      positions.push({
        dealId: p.dealId, epic: m.epic, name: m.instrumentName || m.epic, type: m.instrumentType,
        direction: p.direction, size: p.size, entry: p.level, stop: p.stopLevel ?? null, takeProfit: p.profitLevel ?? null,
        upl: p.upl ?? null, currency: p.currency, leverage: p.leverage ?? null,
        bid: m.bid, offer: m.offer, candles,
      });
    }

    return NextResponse.json({
      ok: true,
      env: process.env.CAPITAL_ENV === "demo" ? "demo" : "live",
      account: acc ? { name: acc.accountName, currency: acc.currency, balance: acc.balance?.balance, available: acc.balance?.available, profitLoss: acc.balance?.profitLoss } : null,
      positions,
    });
  } catch (error) {
    return NextResponse.json({ ok: false, error: error?.message || "Erreur serveur." }, { status: error?.status === 451 ? 451 : 502 });
  }
}
