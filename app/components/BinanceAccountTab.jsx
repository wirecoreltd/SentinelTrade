"use client";

// Onglet "Mon Binance" : positions Spot réelles (lecture seule) + analyse
// technique simple de chaque position (tendance EMA, RSI, ATR → stop suggéré).
// Aucun ordre n'est envoyé : l'app propose, tu décides.

import { useState, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { PANEL, ACCENT, TEXT, MUTED, LINE, POS, NEG, AMBER } from "../lib/theme";
import { formatPrice } from "../lib/format";

function ema(values, period) {
  const k = 2 / (period + 1);
  return values.reduce((acc, v, i) => (i === 0 ? [v] : [...acc, v * k + acc[i - 1] * (1 - k)]), []);
}
function rsi(closes, period = 14) {
  let g = 0, l = 0;
  for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; d >= 0 ? (g += d) : (l -= d); }
  g /= period; l /= period;
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    g = (g * (period - 1) + Math.max(d, 0)) / period;
    l = (l * (period - 1) + Math.max(-d, 0)) / period;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}
function atr(c, period = 14) {
  const tr = c.slice(1).map((x, i) => Math.max(x.high - x.low, Math.abs(x.high - c[i].close), Math.abs(x.low - c[i].close)));
  return tr.slice(-period).reduce((s, v) => s + v, 0) / Math.min(period, tr.length);
}

function analyse(pos, candles) {
  const closes = candles.map((c) => c.close);
  const price = pos.price;
  const e20 = ema(closes, 20).at(-1);
  const e50 = ema(closes, 50).at(-1);
  const r = rsi(closes);
  const a = atr(candles);
  const stop = price - 2 * a;
  const pnlPct = pos.entry ? ((price - pos.entry) / pos.entry) * 100 : null;
  const bullish = price > e20 && e20 > e50;
  const bearish = price < e20 && e20 < e50;

  let key = "tenir", msg;
  if (pos.entry && price <= pos.entry - 2 * a) {
    key = "alleger"; msg = "Perte supérieure à 2×ATR : le marché va contre toi, envisage de réduire ou de sortir.";
  } else if (bearish) {
    key = "alleger"; msg = "Tendance baissière (prix sous EMA20 < EMA50) : envisage d'alléger ou de placer un stop.";
  } else if (r > 75) {
    key = "surveiller"; msg = "RSI très élevé (surachat) : possible repli, pense à sécuriser une partie des gains.";
  } else if (bullish) {
    key = "tenir"; msg = "Tendance haussière confirmée (prix > EMA20 > EMA50) : tenir la position.";
  } else {
    key = "surveiller"; msg = "Tendance indécise : garde un œil dessus, pas de renforcement.";
  }
  return { key, msg, rsi: r, e20, e50, stop, pnlPct };
}

const COLORS = { tenir: POS, surveiller: AMBER, alleger: NEG };
const LABELS = { tenir: "Tenir", surveiller: "Surveiller", alleger: "Alléger" };

export default function BinanceAccountTab() {
  const [state, setState] = useState({ status: "idle" });

  const load = useCallback(async () => {
    setState({ status: "loading" });
    try {
      let token = window.localStorage.getItem("st_access_token");
      if (!token) {
        token = window.prompt("Mot de passe d'accès (APP_ACCESS_TOKEN) :");
        if (!token) { setState({ status: "idle" }); return; }
      }
      const res = await fetch("/api/binance/positions", { headers: { "x-app-token": token }, cache: "no-store" });
      const data = await res.json();
      if (res.status === 401) window.localStorage.removeItem("st_access_token");
      if (!data.ok) { setState({ status: "error", error: data.error || "Échec." }); return; }
      window.localStorage.setItem("st_access_token", token);

      const positions = await Promise.all(
        data.positions.map(async (p) => {
          try {
            const k = await fetch(`/api/binance/klines?symbol=${p.symbol}&range=6m`).then((r) => r.json());
            return { ...p, analysis: k.ok && k.candles.length >= 60 ? analyse(p, k.candles) : null };
          } catch { return { ...p, analysis: null }; }
        })
      );
      setState({ status: "ok", data: { ...data, positions }, at: new Date() });
    } catch {
      setState({ status: "error", error: "Impossible de joindre le serveur." });
    }
  }, []);

  const d = state.data;
  const card = { background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, marginBottom: 12 };

  return (
    <div>
      <button onClick={load} disabled={state.status === "loading"} style={{ display: "flex", alignItems: "center", gap: 6, background: ACCENT, color: "#000", border: "none", borderRadius: 8, padding: "8px 14px", fontWeight: 700, fontSize: 13, cursor: "pointer", marginBottom: 14 }}>
        <RefreshCw size={14} className={state.status === "loading" ? "spin" : ""} /> {d ? "Actualiser" : "Charger mon compte Binance"}
      </button>

      {state.status === "error" && <div style={{ ...card, color: NEG, fontSize: 13 }}>{state.error}</div>}

      {d && (
        <>
          <div style={{ ...card, fontSize: 12, color: MUTED }}>
            Liquidités (stablecoins) : <strong style={{ color: TEXT }}>{d.stableUsdt.toFixed(2)} USDT</strong> · {d.positions.length} position(s) · {d.openOrders.length} ordre(s) ouvert(s)
          </div>

          {d.positions.length === 0 && <div style={{ ...card, fontSize: 13, color: MUTED }}>Aucune position ouverte (hors stablecoins).</div>}

          {d.positions.map((p) => {
            const a = p.analysis;
            const pnlColor = a?.pnlPct == null ? MUTED : a.pnlPct >= 0 ? POS : NEG;
            return (
              <div key={p.symbol} style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <strong style={{ fontSize: 15 }}>{p.asset}</strong>
                  {a && <span style={{ fontSize: 10, fontWeight: 700, color: COLORS[a.key], background: `${COLORS[a.key]}22`, padding: "3px 8px", borderRadius: 20, textTransform: "uppercase" }}>{LABELS[a.key]}</span>}
                </div>
                <div style={{ fontSize: 12, color: MUTED, marginTop: 6, lineHeight: 1.7 }}>
                  Quantité {p.qty} · valeur <span style={{ color: TEXT }}>${p.value.toFixed(2)}</span><br />
                  Prix actuel ${formatPrice(p.price)}{p.entry ? ` · entrée moyenne $${formatPrice(p.entry)}` : " · entrée inconnue"}
                  {a?.pnlPct != null && <> · <span style={{ color: pnlColor, fontWeight: 700 }}>{a.pnlPct >= 0 ? "+" : ""}{a.pnlPct.toFixed(1)}%</span></>}
                </div>
                {a ? (
                  <div style={{ fontSize: 12, color: TEXT, marginTop: 8, lineHeight: 1.5 }}>
                    {a.msg}
                    <div style={{ color: MUTED, marginTop: 4 }}>RSI {a.rsi.toFixed(0)} · EMA20 ${formatPrice(a.e20)} · EMA50 ${formatPrice(a.e50)} · stop suggéré ${formatPrice(a.stop)}</div>
                  </div>
                ) : <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>Analyse indisponible (historique insuffisant).</div>}
              </div>
            );
          })}

          {d.openOrders.length > 0 && (
            <div style={card}>
              <div style={{ fontSize: 12, color: ACCENT, fontWeight: 700, marginBottom: 6, textTransform: "uppercase" }}>Ordres ouverts</div>
              {d.openOrders.map((o, i) => (
                <div key={i} style={{ fontSize: 12, color: TEXT, padding: "3px 0" }}>
                  {o.side} {o.symbol} · {o.type} · {o.qty} @ ${formatPrice(o.price || o.stopPrice)}
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 10, color: MUTED }}>Analyse technique indicative (EMA/RSI/ATR sur bougies journalières). Ce n'est pas un conseil financier ; aucun ordre n'est envoyé.</div>
        </>
      )}
    </div>
  );
}
