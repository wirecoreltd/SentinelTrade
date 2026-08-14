"use client";

// ============================================================================
// Onglet "Historique" — affiche les trades marqués comme pris depuis le
// Calculateur, avec un résumé du jour (nb de trades, risque cumulé), les
// stats de performance réelle (win-rate, R:R réalisé) et la possibilité de
// clôturer (avec un prix de sortie réel, ou sans résultat) ou supprimer une
// entrée.
//
// La logique de stockage/garde-fous/stats vit dans ../lib/tradeHistory.js —
// ce fichier ne fait que l'affichage.
// ============================================================================

import { useEffect, useMemo, useState } from "react";
import { Trash2, TrendingUp, TrendingDown, CircleDot, Check, X } from "lucide-react";
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
  getStats,
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

function StatRow({ label, value, color }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "5px 0" }}>
      <span style={{ fontSize: 12, color: MUTED }}>{label}</span>
      <span style={{ fontSize: 12, fontWeight: 700, color: color || TEXT }}>{value}</span>
    </div>
  );
}

function StatsSummary({ stats }) {
  if (!stats || stats.totalClosed === 0) {
    return (
      <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, marginBottom: 16, fontSize: 12, color: MUTED }}>
        Aucun trade clôturé avec un prix de sortie pour l'instant — les stats de performance apparaîtront ici une fois que tu auras clôturé des trades avec un résultat chiffré.
      </div>
    );
  }

  const winRateColor = stats.winRate >= 50 ? POS : NEG;
  const verdictEntries = Object.entries(stats.byVerdict).filter(([, v]) => v.total > 0);

  return (
    <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 14, marginBottom: 16 }}>
      <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 8 }}>
        Performance réelle ({stats.totalClosed} trade{stats.totalClosed > 1 ? "s" : ""} clôturé{stats.totalClosed > 1 ? "s" : ""})
      </div>

      <StatRow label="Win-rate global" value={`${stats.winRate.toFixed(0)}% (${stats.wins}G / ${stats.losses}P)`} color={winRateColor} />
      <StatRow label="P&L cumulé" value={`${stats.totalPnL >= 0 ? "+" : ""}${stats.totalPnL.toFixed(2)} €`} color={stats.totalPnL >= 0 ? POS : NEG} />
      <StatRow label="P&L moyen / trade" value={`${stats.avgPnLPct >= 0 ? "+" : ""}${stats.avgPnLPct.toFixed(1)}% de la mise`} color={stats.avgPnLPct >= 0 ? POS : NEG} />
      {stats.avgRealizedRR != null && (
        <StatRow label="R:R moyen réalisé (trades gagnants)" value={`${stats.avgRealizedRR.toFixed(2)}:1`} />
      )}

      {verdictEntries.length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${LINE}` }}>
          <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", marginBottom: 4 }}>Win-rate par verdict</div>
          {verdictEntries.map(([verdict, v]) => (
            <StatRow
              key={verdict}
              label={`${verdict} (${v.total})`}
              value={v.winRate != null ? `${v.winRate.toFixed(0)}%` : "—"}
              color={v.winRate != null ? (v.winRate >= 50 ? POS : NEG) : MUTED}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function TradeCard({ trade, onCloseWithResult, onCloseNoResult, onDelete }) {
  const [closing, setClosing] = useState(false);
  const [exitInput, setExitInput] = useState("");

  const isLong = trade.direction !== "short";
  const DirIcon = isLong ? TrendingUp : TrendingDown;
  const dirColor = isLong ? POS : NEG;
  const isOpen = trade.status === "ouvert";

  const parsedExit = parseFloat(exitInput);
  const exitValid = Number.isFinite(parsedExit) && parsedExit > 0;

  const confirmExit = () => {
    if (!exitValid) return;
    onCloseWithResult(trade.id, parsedExit);
    setClosing(false);
    setExitInput("");
  };

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

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: isOpen || trade.exitPrice != null ? 10 : 0 }}>
        <span style={{ fontSize: 11, color: MUTED }}>
          Mise {trade.invested?.toFixed(2)} € · Risque{" "}
          <span style={{ color: NEG, fontWeight: 700 }}>{trade.riskAmount != null ? `${trade.riskAmount.toFixed(2)} €` : "—"}</span>
        </span>
        {trade.realizedPnL != null && (
          <span style={{ fontSize: 12, fontWeight: 700, color: trade.realizedPnL >= 0 ? POS : NEG }}>
            {trade.realizedPnL >= 0 ? "+" : ""}
            {trade.realizedPnL.toFixed(2)} € ({trade.realizedPnLPct >= 0 ? "+" : ""}
            {trade.realizedPnLPct?.toFixed(1)}%)
          </span>
        )}
      </div>

      {trade.exitPrice != null && (
        <div style={{ fontSize: 11, color: MUTED, marginBottom: isOpen ? 10 : 0 }}>
          Sortie à {formatPrice(trade.exitPrice)}
        </div>
      )}

      {isOpen && (
        <>
          {closing ? (
            <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
              <input
                value={exitInput}
                onChange={(e) => setExitInput(e.target.value)}
                placeholder="Prix de sortie réel"
                inputMode="decimal"
                autoFocus
                style={{
                  flex: 1,
                  background: NAVY,
                  border: `1px solid ${LINE}`,
                  borderRadius: 8,
                  padding: "8px 10px",
                  color: TEXT,
                  fontSize: 13,
                }}
              />
              <button
                onClick={confirmExit}
                disabled={!exitValid}
                style={{
                  width: 34,
                  height: 34,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: exitValid ? "rgba(61,214,140,0.14)" : "transparent",
                  border: `1px solid ${exitValid ? POS : LINE}`,
                  color: exitValid ? POS : MUTED,
                  borderRadius: 8,
                  cursor: exitValid ? "pointer" : "not-allowed",
                }}
                title="Confirmer"
              >
                <Check size={14} />
              </button>
              <button
                onClick={() => {
                  setClosing(false);
                  setExitInput("");
                }}
                style={{
                  width: 34,
                  height: 34,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: "transparent",
                  border: `1px solid ${LINE}`,
                  color: MUTED,
                  borderRadius: 8,
                  cursor: "pointer",
                }}
                title="Annuler"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", gap: 6 }}>
              <button
                onClick={() => setClosing(true)}
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                  background: "rgba(79,140,255,0.12)",
                  border: `1px solid ${ACCENT}`,
                  color: ACCENT,
                  borderRadius: 8,
                  padding: "7px 0",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                Clôturer avec résultat
              </button>
              <button
                onClick={() => onCloseNoResult(trade.id)}
                title="Clôturer sans résultat (annulé, jamais entré...)"
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 4,
                  background: "transparent",
                  border: `1px solid ${LINE}`,
                  color: MUTED,
                  borderRadius: 8,
                  padding: "7px 10px",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                  whiteSpace: "nowrap",
                }}
              >
                <CircleDot size={12} />
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
          )}
        </>
      )}

      {!isOpen && (
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

  // Clôture avec résultat : le statut (gagné/perdu) est dérivé du signe du
  // P&L calculé par tradeHistory.js à partir du prix de sortie saisi — plus
  // de bouton "Gagné"/"Perdu" à choisir soi-même.
  const handleCloseWithResult = (id, exitPrice) => {
    const trade = history.find((t) => t.id === id);
    if (!trade) return;
    const isLong = trade.direction !== "short";
    const pnl = isLong ? exitPrice - trade.entry : trade.entry - exitPrice;
    const status = pnl >= 0 ? "gagné" : "perdu";
    const next = updateTradeStatus(id, status, { exitPrice });
    setHistory(next);
  };

  const handleCloseNoResult = (id) => {
    const next = updateTradeStatus(id, "clôturé");
    setHistory(next);
  };

  const handleDelete = (id) => {
    const next = deleteTrade(id);
    setHistory(next);
  };

  const todayKey = toLocalDateKey();
  const todayTrades = useMemo(() => getTodayTrades(history, todayKey), [history, todayKey]);
  const openRiskToday = useMemo(() => todayOpenRisk(history, todayKey), [history, todayKey]);
  const stats = useMemo(() => getStats(history), [history]);

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

      <StatsSummary stats={stats} />

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
            <TradeCard
              key={trade.id}
              trade={trade}
              onCloseWithResult={handleCloseWithResult}
              onCloseNoResult={handleCloseNoResult}
              onDelete={handleDelete}
            />
          ))}
        </div>
      )}
    </div>
  );
}
