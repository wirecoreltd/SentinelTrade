"use client";

// Onglet "Mon Capital" : positions CFD réelles (lecture seule) + analyse
// technique simple, sensible au sens (achat/vente). Aucun ordre n'est envoyé.

import { useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { PANEL, ACCENT, TEXT, MUTED, LINE, POS, NEG, AMBER } from "../lib/theme";
import { formatPrice } from "../lib/format";
import { ema, rsi, atr } from "./BinanceAccountTab";

function analyse(p) {
  const c = p.candles;
  if (!c || c.length < 60) return null;
  const isLong = p.direction !== "SELL";
  const closes = c.map((x) => x.close);
  const price = isLong ? p.bid : p.offer;
  const e20 = ema(closes, 20).at(-1);
  const e50 = ema(closes, 50).at(-1);
  const r = rsi(closes);
  const a = atr(c);
  const pnlPct = p.entry ? ((isLong ? price - p.entry : p.entry - price) / p.entry) * 100 : null;
  const aligned = isLong ? price > e20 && e20 > e50 : price < e20 && e20 < e50;
  const opposed = isLong ? price < e20 && e20 < e50 : price > e20 && e20 > e50;
  const suggestedStop = isLong ? price - 2 * a : price + 2 * a;
  const stopHit = p.stop != null && (isLong ? price <= p.stop : price >= p.stop);
  const lossBig = p.entry && (isLong ? price <= p.entry - 2 * a : price >= p.entry + 2 * a);
  const overextended = isLong ? r > 75 : r < 25;

  let key, msg;
  if (stopHit || lossBig) { key = "alleger"; msg = stopHit ? "Ton stop est touché ou dépassé : protège ton capital." : "Perte supérieure à 2×ATR : le marché va contre toi, envisage de réduire ou sortir."; }
  else if (opposed) { key = "alleger"; msg = `Tendance contre ta position (${isLong ? "baissière" : "haussière"}) : envisage de réduire ou de resserrer le stop.`; }
  else if (overextended) { key = "surveiller"; msg = "RSI extrême : possible retournement, pense à sécuriser une partie des gains."; }
  else if (aligned) { key = "tenir"; msg = "Tendance alignée avec ta position : tenir."; }
  else { key = "surveiller"; msg = "Tendance indécise : surveille, pas de renforcement."; }
  if (p.stop == null && key !== "alleger") msg += " Attention : aucun stop-loss défini sur cette position.";
  return { key, msg, rsi: r, e20, e50, stop: suggestedStop, pnlPct, price };
}

const COLORS = { tenir: POS, surveiller: AMBER, alleger: NEG };
const LABELS = { tenir: "Tenir", surveiller: "Surveiller", alleger: "Alléger" };

export default function CapitalAccountTab() {
  const [state, setState] = useState({ status: "idle" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      let token = window.localStorage.getItem("st_access_token");
      if (!token) {
        token = window.prompt("Mot de passe d'accès (APP_ACCESS_TOKEN) :");
        if (!token) { setState({ status: "idle" }); return; }
      }
      const res = await fetch("/api/capital/positions", { headers: { "x-app-token": token }, cache: "no-store" });
      const data = await res.json();
      if (res.status === 401) window.localStorage.removeItem("st_access_token");
      if (!data.ok) { setState({ status: "error", error: data.error || "Échec." }); return; }
      window.localStorage.setItem("st_access_token", token);
      setState({ status: "ok", data });
    } catch {
      setState({ status: "error", error: "Impossible de joindre le serveur." });
    }
  }, []);

  const d = state.data;
  const card = { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, marginBottom: 12 };

  return (
    <div>
      <button onClick={load} disabled={state.status === "loading"} style={{ display: "flex", alignItems: "center", gap: 6, background: ACCENT, color: "#000", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer", marginBottom: 14 }}>
        <RefreshCw size={14} className={state.status === "loading" ? "spin" : ""} /> {d ? "Actualiser" : "Charger mon compte Capital.com"}
      </button>
      {state.status === "error" && <div style={{ ...card, color: NEG, fontSize: 13 }}>{state.error}</div>}
      {d && (
        <>
          <div style={{ ...card, fontSize: 12, color: MUTED }}>
            Compte {d.env === "demo" ? "DÉMO" : "RÉEL"}{d.account?.name ? ` « ${d.account.name} »` : ""} :
            {d.account && <> solde <strong style={{ color: TEXT }}>{d.account.balance} {d.account.currency}</strong> · disponible {d.account.available} · P&L latent <span style={{ color: d.account.profitLoss >= 0 ? POS : NEG }}>{d.account.profitLoss}</span></>}
            <br />{d.positions.length} position(s) ouverte(s)
          </div>
          {d.positions.length === 0 && <div style={{ ...card, fontSize: 13, color: MUTED }}>Aucune position ouverte.</div>}
          {d.positions.map((p) => {
            const a = analyse(p);
            const up = p.upl;
            return (
              <div key={p.dealId} style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 15 }}>{p.name} <span style={{ fontSize: 11, color: p.direction === "BUY" ? POS : NEG }}>{p.direction === "BUY" ? "ACHAT" : "VENTE"}</span></strong>
                  {a && <span style={{ fontSize: 10, fontWeight: 700, color: COLORS[a.key], background: `${COLORS[a.key]}22`, padding: "3px 8px", borderRadius: 20, textTransform: "uppercase" }}>{LABELS[a.key]}</span>}
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 6, lineHeight: 1.7 }}>
                  Taille {p.size}{p.leverage ? ` · levier ×${p.leverage}` : ""} · entrée ${formatPrice(p.entry)} · actuel ${formatPrice(p.direction === "BUY" ? p.bid : p.offer)}<br />
                  Stop {p.stop != null ? `$${formatPrice(p.stop)}` : "—"} · TP {p.takeProfit != null ? `$${formatPrice(p.takeProfit)}` : "—"}
                  {up != null && <> · P&L <span style={{ color: up >= 0 ? POS : NEG, fontWeight: 700 }}>{up >= 0 ? "+" : ""}{up} {p.currency}</span></>}
                  {a?.pnlPct != null && <> ({a.pnlPct >= 0 ? "+" : ""}{a.pnlPct.toFixed(1)}%)</>}
                </div>
                {a ? (
                  <div style={{ fontSize: 12, color: TEXT, marginTop: 8, lineHeight: 1.5 }}>
                    {a.msg}
                    <div style={{ color: MUTED, marginTop: 4 }}>RSI {a.rsi.toFixed(0)} · EMA20 {formatPrice(a.e20)} · EMA50 {formatPrice(a.e50)} · stop suggéré {formatPrice(a.stop)}</div>
                  </div>
                ) : <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>Analyse indisponible (historique insuffisant).</div>}
              </div>
            );
          })}
          <div style={{ fontSize: 10, color: MUTED }}>Analyse technique indicative (EMA/RSI/ATR, bougies journalières). Pas un conseil financier ; aucun ordre n'est envoyé.</div>
        </>
      )}
    </div>
  );
}
