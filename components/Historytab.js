"use client";

import { useEffect, useState } from "react";
import { NAVY, PANEL, ACCENT, TEXT, MUTED, LINE, POS, NEG, AMBER } from "../lib/theme";
import { formatPrice } from "../lib/format";
import {
  loadHistory,
  loadSettings,
  saveSettings,
  updateTradeStatus,
  deleteTrade,
  toLocalDateKey,
  getTodayTrades,
  todayOpenRisk,
} from "../lib/tradeHistory";

const STATUS_STYLE = {
  ouvert: { label: "OUVERT", color: ACCENT },
  "gagné": { label: "GAGNÉ", color: POS },
  "perdu": { label: "PERDU", color: NEG },
  "clôturé": { label: "CLÔTURÉ", color: MUTED },
};

function fmtDateHeader(dateKey) {
  const d = new Date(`${dateKey}T00:00:00`);
  const today = toLocalDateKey();
  const yesterday = toLocalDateKey(new Date(Date.now() - 86400000));
  if (dateKey === today) return "Aujourd'hui";
  if (dateKey === yesterday) return "Hier";
  return d.toLocaleDateString("fr-FR", { weekday: "long", day: "2-digit", month: "long" });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
}

export default function HistoryTab() {
  const [history, setHistory] = useState([]);
  const [settings, setSettings] = useState(null);
  const [showSettings, setShowSettings] = useState(false);

  useEffect(() => {
    setHistory(loadHistory());
    setSettings(loadSettings());
  }, []);

  const refresh = () => setHistory(loadHistory());

  const handleClose = (id, status) => {
    const trade = history.find((t) => t.id === id);
    let pnl = null;
    if (status === "gagné") pnl = trade?.potentialGain ?? null;
    else if (status === "perdu") pnl = trade ? -Math.abs(trade.riskAmount || 0) : null;
    else if (status === "clôturé") {
      const raw = window.prompt("Résultat réel (€) — laisse vide si tu ne sais pas :", "");
      if (raw !== null && raw.trim() !== "" && !Number.isNaN(parseFloat(raw))) pnl = parseFloat(raw);
    }
    updateTradeStatus(id, status, pnl);
    refresh();
  };

  const handleDelete = (id) => {
    if (!window.confirm("Supprimer cette entrée de l'historique ?")) return;
    deleteTrade(id);
    refresh();
  };

  const saveSettingsForm = (next) => {
    setSettings(next);
    saveSettings(next);
  };

  if (!settings) return null; // évite un flash avant hydration côté client

  const todayKey = toLocalDateKey();
  const today = getTodayTrades(history, todayKey);
  const openRisk = todayOpenRisk(history, todayKey);
  const riskOver = openRisk > settings.dailyRiskLimit;
  const countOver = today.length >= settings.maxTradesPerDay;

  // Regroupement par jour, jours les plus récents en premier
  const byDay = {};
  history.forEach((t) => {
    if (!byDay[t.dateKey]) byDay[t.dateKey] = [];
    byDay[t.dateKey].push(t);
  });
  const dayKeys = Object.keys(byDay).sort((a, b) => (a < b ? 1 : -1));

  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 16 }}>
        Trades marqués comme pris depuis le Calculateur. Sert à repérer la surexposition et le
        risque cumulé avant d'en prendre un de plus.
      </div>

      {/* Résumé du jour */}
      <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 10 }}>
          Aujourd'hui
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
          <div>
            <div style={{ fontSize: 11, color: MUTED }}>Trades pris</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: countOver ? NEG : TEXT }}>
              {today.length} / {settings.maxTradesPerDay}
            </div>
          </div>
          <div>
            <div style={{ fontSize: 11, color: MUTED }}>Risque ouvert</div>
            <div style={{ fontSize: 16, fontWeight: 700, color: riskOver ? NEG : TEXT }}>
              {openRisk.toFixed(2)} € / {settings.dailyRiskLimit} €
            </div>
          </div>
        </div>
        {(riskOver || countOver) && (
          <div style={{ fontSize: 11, color: NEG, marginTop: 10 }}>
            ⚠️ {riskOver ? "Limite de risque quotidien dépassée. " : ""}
            {countOver ? "Limite de trades du jour atteinte." : ""}
          </div>
        )}
      </div>

      {/* Réglages */}
      <button
        onClick={() => setShowSettings((v) => !v)}
        style={{ fontSize: 12, color: ACCENT, background: "none", border: "none", cursor: "pointer", padding: 0, marginBottom: 10 }}
      >
        {showSettings ? "▾ Masquer les réglages de risque" : "▸ Réglages de risque"}
      </button>

      {showSettings && (
        <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
          {[
            { key: "dailyRiskLimit", label: "Limite de risque quotidien (€)" },
            { key: "maxTradesPerDay", label: "Nombre max de trades / jour" },
            { key: "maxTradesPerAsset", label: "Max de trades sur le même actif + sens / jour" },
          ].map(({ key, label }) => (
            <div key={key} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>{label}</div>
              <input
                value={settings[key]}
                onChange={(e) => {
                  const v = e.target.value;
                  saveSettingsForm({ ...settings, [key]: v === "" ? "" : Number(v) });
                }}
                inputMode="decimal"
                style={{ width: "100%", background: NAVY, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 10px", color: TEXT, fontSize: 13 }}
              />
            </div>
          ))}
        </div>
      )}

      {/* Liste par jour */}
      {dayKeys.length === 0 && (
        <div style={{ fontSize: 13, color: MUTED, textAlign: "center", padding: "30px 0" }}>
          Aucun trade enregistré pour l'instant. Marque un trade comme "pris" depuis le Calculateur pour le voir apparaître ici.
        </div>
      )}

      {dayKeys.map((dateKey) => (
        <div key={dateKey} style={{ marginBottom: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
            {fmtDateHeader(dateKey)}
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {byDay[dateKey].map((t) => {
              const st = STATUS_STYLE[t.status] || STATUS_STYLE.ouvert;
              return (
                <div key={t.id} style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                    <div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 700 }}>{t.symbol}</span>
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 700,
                            color: t.direction === "short" ? NEG : POS,
                            background: `${t.direction === "short" ? NEG : POS}22`,
                            padding: "2px 6px",
                            borderRadius: 6,
                            textTransform: "uppercase",
                          }}
                        >
                          {t.direction === "short" ? "Short" : "Long"}
                        </span>
                      </div>
                      <div style={{ fontSize: 11, color: MUTED, marginTop: 2 }}>{fmtTime(t.createdAt)}</div>
                    </div>
                    <span
                      style={{
                        fontSize: 11,
                        fontWeight: 800,
                        color: st.color,
                        background: `${st.color}22`,
                        padding: "4px 10px",
                        borderRadius: 20,
                        letterSpacing: 0.5,
                      }}
                    >
                      {st.label}
                    </span>
                  </div>

                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
                    <div>
                      <div style={{ fontSize: 10, color: MUTED }}>Entrée</div>
                      <div style={{ fontSize: 12, fontWeight: 600 }}>{formatPrice(t.entry)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: MUTED }}>Stop</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: NEG }}>{formatPrice(t.stop)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 10, color: MUTED }}>TP</div>
                      <div style={{ fontSize: 12, fontWeight: 600, color: POS }}>{t.takeProfit != null ? formatPrice(t.takeProfit) : "—"}</div>
                    </div>
                  </div>

                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: MUTED, marginBottom: t.status === "ouvert" ? 10 : 0 }}>
                    <span>Risque : <strong style={{ color: NEG }}>{(t.riskAmount || 0).toFixed(2)} €</strong></span>
                    {t.status === "ouvert" ? (
                      t.potentialGain != null && <span>Gain visé : <strong style={{ color: POS }}>{t.potentialGain.toFixed(2)} €</strong></span>
                    ) : (
                      t.realizedPnL != null && (
                        <span>Résultat : <strong style={{ color: t.realizedPnL >= 0 ? POS : NEG }}>{t.realizedPnL >= 0 ? "+" : ""}{t.realizedPnL.toFixed(2)} €</strong></span>
                      )
                    )}
                  </div>

                  {t.status === "ouvert" && (
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => handleClose(t.id, "gagné")} style={{ flex: 1, background: "rgba(61,214,140,0.12)", border: `1px solid ${POS}`, color: POS, borderRadius: 6, padding: "6px 0", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                        TP touché
                      </button>
                      <button onClick={() => handleClose(t.id, "perdu")} style={{ flex: 1, background: "rgba(255,103,103,0.12)", border: `1px solid ${NEG}`, color: NEG, borderRadius: 6, padding: "6px 0", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                        SL touché
                      </button>
                      <button onClick={() => handleClose(t.id, "clôturé")} style={{ flex: 1, background: "transparent", border: `1px solid ${LINE}`, color: MUTED, borderRadius: 6, padding: "6px 0", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                        Clôturer
                      </button>
                    </div>
                  )}
                  {t.status !== "ouvert" && (
                    <button onClick={() => handleDelete(t.id)} style={{ marginTop: 8, background: "none", border: "none", color: MUTED, fontSize: 10, cursor: "pointer", padding: 0 }}>
                      Supprimer
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
