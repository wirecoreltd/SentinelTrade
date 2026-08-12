"use client";

// ============================================================================
// Onglet "Historique" — affiche les trades marqués comme pris depuis le
// Calculateur, avec un résumé du jour (nb de trades, risque cumulé) et la
// possibilité de clôturer (gagné/perdu/clôturé) ou supprimer une entrée.
//
// La logique de stockage/garde-fous vit dans ../lib/tradeHistory.js — ce
// fichier ne fait que l'affichage.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { Trash2, TrendingUp, TrendingDown, CheckCircle2, XCircle, CircleDot } from "lucide-react";
import { NAVY, PANEL, ACCENT, TEXT, MUTED, LINE, POS, NEG, AMBER } from "../lib/theme";
import { formatPrice } from "../lib/format";
import {
  loadHistory,
  loadSettings,
  updateTradeStatus,
  deleteTrade,
  getTodayTrades,
  todayOpenRisk,
  toLocalDateKey,
} from "../lib/tradeHistory";

const STATUS_LABEL = {
  ouvert: "Ouvert",
  "gagné": "Gagné",
  perdu: "Perdu",
  "clôturé": "Clôturé",
};

const STATUS_COLOR = {
  ouvert: ACCENT,
  "gagné": POS,
  perdu: NEG,
  "clôturé": MUTED,
};

function StatusBadge({ status }) {
  const color = STATUS_COLOR[status] || MUTED;
  return (
    <span
      style={{
        fontSize: 11,
        fontWeight: 700,
        color,
        background: `${color}22`,
        padding: "3px 9px",
        borderRadius: 20,
        textTransform: "uppercase",
        letterSpacing: 0.4,
        whiteSpace: "nowrap",
      }}
    >
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("fr-FR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function TradeCard({ trade, onClose, onDelete }) {
  const isLong = trade.direction !== "short";
  const DirIcon = isLong ? TrendingUp : TrendingDown;
  const dirColor = isLong ? POS : NEG;
  const isOpen = trade.status === "ouvert";

  return (
    <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <div
            style={{
              width: 26,
              height: 26,
              borderRadius: 8,
              background: `${dirColor}1a`,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              flexShrink: 0,
            }}
          >
            <DirIcon size={14} color={dirColor} />
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 700 }}>{trade.symbol}</div>
            <div style={{ fontSize: 11, color: MUTED }}>
              {isLong ? "Long" : "Short"} · {formatDate(trade.createdAt)}
            </div>
          </div>
        </div>
        <StatusBadge status={trade.status} />
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 10 }}>
        <div style={{ background: NAVY, borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 10, color: MUTED }}>Entrée</div>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{formatPrice(trade.entry)}</div>
        </div>
        <div style={{ background: NAVY, borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 10, color: MUTED }}>Stop</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: NEG }}>{formatPrice(trade.stop)}</div>
        </div>
        <div style={{ background: NAVY, borderRadius: 8, padding: 8 }}>
          <div style={{ fontSize: 10, color: MUTED }}>TP</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: POS }}>
            {trade.takeProfit != null ? formatPrice(trade.takeProfit) : "—"}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: isOpen ? 10 : 0 }}>
        <span style={{ fontSize: 11, color: MUTED }}>
          Mise {trade.invested?.toFixed(2)} € · Risque{" "}
          <span style={{ color: NEG, fontWeight: 700 }}>{trade.riskAmount != null ? `${trade.riskAmount.toFixed(2)} €` : "—"}</span>
        </span>
        {trade.realizedPnL != null && (
          <span style={{ fontSize: 12, fontWeight: 700, color: trade.realizedPnL >= 0 ? POS : NEG }}>
            {trade.realizedPnL >= 0 ? "+" : ""}
            {trade.realizedPnL.toFixed(2)} €
          </span>
        )}
      </div>

      {isOpen ? (
        <div style={{ display: "flex", gap: 6 }}>
          <button
            onClick={() => onClose(trade.id, "gagné")}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              background: "rgba(61,214,140,0.12)",
              border: `1px solid ${POS}`,
              color: POS,
              borderRadius: 8,
              padding: "7px 0",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            <CheckCircle2 size={12} /> Gagné
          </button>
          <button
            onClick={() => onClose(trade.id, "perdu")}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              background: "rgba(255,103,103,0.12)",
              border: `1px solid ${NEG}`,
              color: NEG,
              borderRadius: 8,
              padding: "7px 0",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            <XCircle size={12} /> Perdu
          </button>
          <button
            onClick={() => onClose(trade.id, "clôturé")}
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 4,
              background: "transparent",
              border: `1px solid ${LINE}`,
              color: MUTED,
              borderRadius: 8,
              padding: "7px 0",
              fontSize: 11,
              fontWeight: 700,
              cursor: "pointer",
            }}
          >
            <CircleDot size={12} /> Clôturé
          </button>
          <button
            onClick={() => onDelete(trade.id)}
            title="Supprimer"
            style={{
              width: 32,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: `1px solid ${LINE}`,
              color: MUTED,
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button
            onClick={() => onDelete(trade.id)}
            title="Supprimer"
            style={{
              width: 32,
              height: 28,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "transparent",
              border: `1px solid ${LINE}`,
              color: MUTED,
              borderRadius: 8,
              cursor: "pointer",
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      )}
    </div>
  );
}

export default function HistoryTab() {
  const [history, setHistory] = useState([]);
  const [settings, setSettings] = useState(null);
  const [filter, setFilter] = useState("tous"); // "tous" | "ouvert" | "clos"

  useEffect(() => {
    setHistory(loadHistory());
    setSettings(loadSettings());
  }, []);

  const handleClose = (id, status) => {
    const next = updateTradeStatus(id, status);
    setHistory(next);
  };

  const handleDelete = (id) => {
    const next = deleteTrade(id);
    setHistory(next);
  };

  const todayKey = toLocalDateKey();
  const todayTrades = useMemo(() => getTodayTrades(history, todayKey), [history, todayKey]);
  const openRiskToday = useMemo(() => todayOpenRisk(history, todayKey), [history, todayKey]);

  const filtered = useMemo(() => {
    if (filter === "ouvert") return history.filter((t) => t.status === "ouvert");
    if (filter === "clos") return history.filter((t) => t.status !== "ouvert");
    return history;
  }, [history, filter]);

  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 14 }}>
        Trades marqués comme pris depuis le Calculateur. Stocké uniquement sur cet appareil.
      </div>

      {settings && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 16 }}>
          <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", marginBottom: 4 }}>
              Trades aujourd'hui
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: todayTrades.length >= settings.maxTradesPerDay ? NEG : TEXT }}>
              {todayTrades.length} <span style={{ fontSize: 12, color: MUTED, fontWeight: 400 }}>/ {settings.maxTradesPerDay}</span>
            </div>
          </div>
          <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
            <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", marginBottom: 4 }}>
              Risque ouvert aujourd'hui
            </div>
            <div style={{ fontSize: 16, fontWeight: 700, color: openRiskToday >= settings.dailyRiskLimit ? NEG : TEXT }}>
              {openRiskToday.toFixed(2)} € <span style={{ fontSize: 12, color: MUTED, fontWeight: 400 }}>/ {settings.dailyRiskLimit} €</span>
            </div>
          </div>
        </div>
      )}

      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {[
          { id: "tous", label: "Tous" },
          { id: "ouvert", label: "Ouverts" },
          { id: "clos", label: "Clos" },
        ].map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            style={{
              padding: "6px 12px",
              borderRadius: 20,
              border: `1px solid ${filter === f.id ? ACCENT : LINE}`,
              background: filter === f.id ? "rgba(79,140,255,0.12)" : "transparent",
              color: filter === f.id ? ACCENT : MUTED,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div style={{ fontSize: 13, color: MUTED, textAlign: "center", padding: "30px 0" }}>
          Aucun trade {filter === "ouvert" ? "ouvert" : filter === "clos" ? "clos" : "enregistré"} pour l'instant.
          Marque un trade comme pris depuis le Calculateur pour le voir apparaître ici.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {filtered.map((trade) => (
            <TradeCard key={trade.id} trade={trade} onClose={handleClose} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
