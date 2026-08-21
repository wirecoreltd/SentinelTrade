"use client";

// ============================================================================
// Onglet "Historique" — version compacte façon broker (Capital.com) :
// les positions ouvertes sur un même actif (même symbole + même sens) sont
// regroupées sous une carte d'en-tête agrégée (entrée moyenne pondérée,
// actuel, SL/TP, P&L cumulé, "Tout fermer"), et chaque renforcement reste
// listé en dessous avec ses propres niveaux et son bouton "Fermer" individuel.
// Toute la logique de stockage/garde-fous/stats reste dans
// ../lib/tradeHistory.js — ce fichier ne fait que l'affichage + la
// récupération de prix "actuel" pour le P&L en direct.
// ============================================================================

import { useEffect, useMemo, useState, useCallback } from "react";
import { Trash2, TrendingUp, TrendingDown, CircleDot, Check, X, Pencil, RefreshCw } from "lucide-react";
import { NAVY, PANEL, ACCENT, TEXT, MUTED, LINE, POS, NEG, AMBER } from "../lib/theme";
import { formatPrice } from "../lib/format";
import { useBinanceLivePrices } from "../lib/binance";
import { fetchCurrentPriceFor } from "../lib/marketPrices";
import {
  loadHistory,
  loadSettings,
  saveSettings,
  updateTradeStatus,
  deleteTrade,
  getTodayTrades,
  todayOpenRisk,
  todayInvested,
  todayRemainingBudget,
  toLocalDateKey,
  getStats,
} from "../lib/tradeHistory";

const STATUS_LABEL = { ouvert: "Ouvert", "gagné": "Gagné", perdu: "Perdu", "clôturé": "Clôturé" };
const STATUS_COLOR = { ouvert: ACCENT, "gagné": POS, perdu: NEG, "clôturé": MUTED };

function LiveBadge() {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 3, fontSize: 9, color: POS, fontWeight: 700 }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: POS, display: "inline-block" }} />
      LIVE
    </span>
  );
}

function StatusBadge({ status }) {
  const color = STATUS_COLOR[status] || MUTED;
  return (
    <span style={{ fontSize: 10, fontWeight: 700, color, background: `${color}22`, padding: "3px 8px", borderRadius: 20, textTransform: "uppercase", letterSpacing: 0.4, whiteSpace: "nowrap" }}>
      {STATUS_LABEL[status] || status}
    </span>
  );
}

function formatDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("fr-FR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });
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
      {stats.avgRealizedRR != null && <StatRow label="R:R moyen réalisé (trades gagnants)" value={`${stats.avgRealizedRR.toFixed(2)}:1`} />}
      {verdictEntries.length > 0 && (
        <div style={{ marginTop: 8, paddingTop: 8, borderTop: `1px solid ${LINE}` }}>
          <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase", marginBottom: 4 }}>Win-rate par verdict</div>
          {verdictEntries.map(([verdict, v]) => (
            <StatRow key={verdict} label={`${verdict} (${v.total})`} value={v.winRate != null ? `${v.winRate.toFixed(0)}%` : "—"} color={v.winRate != null ? (v.winRate >= 50 ? POS : NEG) : MUTED} />
          ))}
        </div>
      )}
    </div>
  );
}

// Un petit bloc chiffré réutilisable pour le résumé du haut (Trades /
// Risque / Budget), avec édition inline optionnelle (utilisé pour le
// budget du jour).
function SummaryCard({ label, value, sub, danger, editable, onSave }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  return (
    <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <div style={{ fontSize: 10, color: MUTED, textTransform: "uppercase" }}>{label}</div>
        {editable && !editing && (
          <button
            onClick={() => { setDraft(""); setEditing(true); }}
            style={{ background: "transparent", border: "none", color: MUTED, cursor: "pointer", padding: 0, display: "flex" }}
            title="Modifier"
          >
            <Pencil size={11} />
          </button>
        )}
      </div>
      {editing ? (
        <div style={{ display: "flex", gap: 4 }}>
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            inputMode="decimal"
            placeholder="€"
            style={{ width: 60, background: NAVY, border: `1px solid ${LINE}`, borderRadius: 6, padding: "4px 6px", color: TEXT, fontSize: 13 }}
          />
          <button
            onClick={() => { const v = parseFloat(draft); if (Number.isFinite(v) && v > 0) onSave(v); setEditing(false); }}
            style={{ background: "rgba(61,214,140,0.14)", border: `1px solid ${POS}`, color: POS, borderRadius: 6, padding: "0 8px", cursor: "pointer" }}
          >
            <Check size={12} />
          </button>
        </div>
      ) : (
        <div style={{ fontSize: 16, fontWeight: 700, color: danger ? NEG : TEXT }}>
          {value} {sub && <span style={{ fontSize: 12, color: MUTED, fontWeight: 400 }}>{sub}</span>}
        </div>
      )}
    </div>
  );
}

function CompactTradeRow({ trade, currentPrice, isLivePrice, onCloseWithResult, onCloseNoResult, onDelete, nested = false }) {
  const [closing, setClosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [exitInput, setExitInput] = useState("");
  const [editInput, setEditInput] = useState(trade.exitPrice?.toString() || "");

  const parsedEdit = parseFloat(editInput);
  const editValid = Number.isFinite(parsedEdit) && parsedEdit > 0;

  const confirmEdit = () => {
    if (!editValid) return;
    onCloseWithResult(trade.id, parsedEdit);
    setEditing(false);
  };

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

  // P&L en direct (positions ouvertes avec un prix actuel connu) — purement
  // indicatif, ne modifie jamais les niveaux enregistrés du trade.
  const hasLivePnL = isOpen && currentPrice != null && trade.quantity != null;
  const unrealizedPnL = hasLivePnL
    ? isLong ? trade.quantity * (currentPrice - trade.entry) : trade.quantity * (trade.entry - currentPrice)
    : null;
  const unrealizedPnLPct = hasLivePnL && trade.invested > 0 ? (unrealizedPnL / trade.invested) * 100 : null;

  const pnlValue = trade.realizedPnL != null ? trade.realizedPnL : unrealizedPnL;
  const pnlPct = trade.realizedPnLPct != null ? trade.realizedPnLPct : unrealizedPnLPct;

  return (
    <div style={{ background: nested ? NAVY : PANEL, border: `1px solid ${LINE}`, borderRadius: 10, padding: "10px 12px" }}>
      {/* Ligne 1 : symbole + statut + P&L */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          {!nested && (
            <div style={{ width: 22, height: 22, borderRadius: 6, background: `${dirColor}1a`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <DirIcon size={12} color={dirColor} />
            </div>
          )}
          <div style={{ minWidth: 0 }}>
            {!nested && <div style={{ fontSize: 13, fontWeight: 700 }}>{trade.symbol}</div>}
            <div style={{ fontSize: 10, color: MUTED }}>{formatDate(trade.createdAt)}</div>
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
          {pnlValue != null && (
            <span style={{ fontSize: 12, fontWeight: 700, color: pnlValue >= 0 ? POS : NEG, whiteSpace: "nowrap" }}>
              {pnlValue >= 0 ? "+" : ""}{pnlValue.toFixed(2)} €{pnlPct != null ? ` (${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}%)` : ""}
            </span>
          )}
          <StatusBadge status={trade.status} />
        </div>
      </div>

      {/* Ligne 2 : entrée / actuel / SL / TP */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
        <div style={{ background: nested ? PANEL : NAVY, borderRadius: 7, padding: "6px 7px" }}>
          <div style={{ fontSize: 9, color: MUTED }}>Entrée</div>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{formatPrice(trade.entry)}</div>
        </div>
        <div style={{ background: nested ? PANEL : NAVY, borderRadius: 7, padding: "6px 7px" }}>
          <div style={{ fontSize: 9, color: MUTED, display: "flex", alignItems: "center", gap: 3 }}>
            Actuel {isLivePrice && <LiveBadge />}
          </div>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{currentPrice != null ? formatPrice(currentPrice) : "—"}</div>
        </div>
        <div style={{ background: nested ? PANEL : NAVY, borderRadius: 7, padding: "6px 7px" }}>
          <div style={{ fontSize: 9, color: MUTED }}>SL</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: NEG }}>{formatPrice(trade.stop)}</div>
        </div>
        <div style={{ background: nested ? PANEL : NAVY, borderRadius: 7, padding: "6px 7px" }}>
          <div style={{ fontSize: 9, color: MUTED }}>TP</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: POS }}>{trade.takeProfit != null ? formatPrice(trade.takeProfit) : "—"}</div>
        </div>
      </div>

      {/* Ligne 3 : mise / risque + sortie si clôturé */}
      <div style={{ fontSize: 10, color: MUTED, marginBottom: isOpen || trade.exitPrice != null ? 8 : 0 }}>
        Mise {trade.invested?.toFixed(2)} € {trade.leverage ? `· x${trade.leverage}` : ""} · Risque{" "}
        <span style={{ color: NEG, fontWeight: 700 }}>{trade.riskAmount != null ? `${trade.riskAmount.toFixed(2)} €` : "—"}</span>
        {trade.exitPrice != null && <> · Sortie à {formatPrice(trade.exitPrice)}</>}
      </div>

      {/* Actions */}
      {isOpen && (
        closing ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              value={exitInput}
              onChange={(e) => setExitInput(e.target.value)}
              placeholder="Prix de sortie réel"
              inputMode="decimal"
              autoFocus
              style={{ flex: 1, background: NAVY, border: `1px solid ${LINE}`, borderRadius: 8, padding: "7px 9px", color: TEXT, fontSize: 12 }}
            />
            <button onClick={confirmExit} disabled={!exitValid} style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: exitValid ? "rgba(61,214,140,0.14)" : "transparent", border: `1px solid ${exitValid ? POS : LINE}`, color: exitValid ? POS : MUTED, borderRadius: 8, cursor: exitValid ? "pointer" : "not-allowed" }} title="Confirmer">
              <Check size={13} />
            </button>
            <button onClick={() => { setClosing(false); setExitInput(""); }} style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid ${LINE}`, color: MUTED, borderRadius: 8, cursor: "pointer" }} title="Annuler">
              <X size={13} />
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", gap: 6 }}>
            <button onClick={() => setClosing(true)} style={{ flex: 1, background: "rgba(255,103,103,0.10)", border: `1px solid ${NEG}`, color: NEG, borderRadius: 8, padding: "7px 0", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
              Fermer
            </button>
            <button onClick={() => onCloseNoResult(trade.id)} title="Clôturer sans résultat (annulé, jamais entré...)" style={{ display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid ${LINE}`, color: MUTED, borderRadius: 8, padding: "7px 10px", cursor: "pointer" }}>
              <CircleDot size={12} />
            </button>
            <button onClick={() => onDelete(trade.id)} title="Supprimer" style={{ width: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid ${LINE}`, color: MUTED, borderRadius: 8, cursor: "pointer" }}>
              <Trash2 size={12} />
            </button>
          </div>
        )
      )}
      {!isOpen && (
        editing ? (
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              value={editInput}
              onChange={(e) => setEditInput(e.target.value)}
              placeholder="Vrai prix de sortie"
              inputMode="decimal"
              autoFocus
              style={{ flex: 1, background: NAVY, border: `1px solid ${LINE}`, borderRadius: 8, padding: "7px 9px", color: TEXT, fontSize: 12 }}
            />
            <button onClick={confirmEdit} disabled={!editValid} style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: editValid ? "rgba(61,214,140,0.14)" : "transparent", border: `1px solid ${editValid ? POS : LINE}`, color: editValid ? POS : MUTED, borderRadius: 8, cursor: editValid ? "pointer" : "not-allowed" }} title="Confirmer">
              <Check size={13} />
            </button>
            <button onClick={() => { setEditing(false); setEditInput(trade.exitPrice?.toString() || ""); }} style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid ${LINE}`, color: MUTED, borderRadius: 8, cursor: "pointer" }} title="Annuler">
              <X size={13} />
            </button>
          </div>
        ) : (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 6 }}>
            <button onClick={() => setEditing(true)} title="Modifier le prix de sortie" style={{ width: 30, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid ${LINE}`, color: MUTED, borderRadius: 8, cursor: "pointer" }}>
              <Pencil size={12} />
            </button>
            <button onClick={() => onDelete(trade.id)} title="Supprimer" style={{ width: 30, height: 26, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid ${LINE}`, color: MUTED, borderRadius: 8, cursor: "pointer" }}>
              <Trash2 size={12} />
            </button>
          </div>
        )
      )}
    </div>
  );
}

// ============================================================================
// Regroupement par position — plusieurs trades "ouvert" sur le même
// symbole + même sens (ex: renforcements successifs) sont affichés sous
// une carte d'en-tête agrégée façon broker (Capital.com), avec un bouton
// "Tout fermer" en plus des boutons "Fermer" individuels.
// ============================================================================

function groupKey(t) {
  return `${t.symbol}|${t.direction}|${t.assetType}`;
}

// Conserve l'ordre d'apparition (les trades les plus récents en premier,
// comme dans l'historique) : un groupe apparaît à la position de son
// trade "ouvert" le plus récent.
function buildGroups(trades) {
  const groups = [];
  const indexByKey = {};
  trades.forEach((t) => {
    if (t.status !== "ouvert") {
      groups.push({ key: t.id, trades: [t] });
      return;
    }
    const key = groupKey(t);
    if (indexByKey[key] == null) {
      indexByKey[key] = groups.length;
      groups.push({ key, trades: [t] });
    } else {
      groups[indexByKey[key]].trades.push(t);
    }
  });
  return groups;
}

function GroupHeader({ trades, currentPrice, isLivePrice, onCloseAll }) {
  const [closingAll, setClosingAll] = useState(false);
  const [exitInput, setExitInput] = useState("");

  const first = trades[0];
  const isLong = first.direction !== "short";
  const DirIcon = isLong ? TrendingUp : TrendingDown;
  const dirColor = isLong ? POS : NEG;

  const totalInvested = trades.reduce((s, t) => s + (t.invested || 0), 0);
  const totalQty = trades.reduce((s, t) => s + (t.quantity || 0), 0);
  const weightedEntry = totalQty > 0 ? trades.reduce((s, t) => s + (t.entry || 0) * (t.quantity || 0), 0) / totalQty : null;

  const totalPnL =
    currentPrice != null
      ? trades.reduce((s, t) => {
          if (t.quantity == null) return s;
          const pnl = isLong ? t.quantity * (currentPrice - t.entry) : t.quantity * (t.entry - currentPrice);
          return s + pnl;
        }, 0)
      : null;
  const totalPnLPct = totalPnL != null && totalInvested > 0 ? (totalPnL / totalInvested) * 100 : null;

  const sameLeverage = trades.every((t) => t.leverage === first.leverage);
  const sameSL = trades.every((t) => t.stop === first.stop);
  const sameTP = trades.every((t) => t.takeProfit === first.takeProfit);

  const parsedExit = parseFloat(exitInput);
  const exitValid = Number.isFinite(parsedExit) && parsedExit > 0;
  const confirmCloseAll = () => {
    if (!exitValid) return;
    onCloseAll(trades.map((t) => t.id), parsedExit);
    setClosingAll(false);
    setExitInput("");
  };

  return (
    <div style={{ background: "rgba(79,140,255,0.06)", border: `1px solid ${ACCENT}66`, borderRadius: 10, padding: "10px 12px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
          <div style={{ width: 22, height: 22, borderRadius: 6, background: `${dirColor}1a`, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
            <DirIcon size={12} color={dirColor} />
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 13, fontWeight: 800 }}>{first.symbol}</div>
            <div style={{ fontSize: 10, color: MUTED }}>
              {trades.length} position{trades.length > 1 ? "s" : ""} {isLong ? "Long" : "Short"}
              {sameLeverage && first.leverage ? ` · x${first.leverage}` : ""}
            </div>
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {totalPnL != null && (
            <div style={{ fontSize: 12, fontWeight: 700, color: totalPnL >= 0 ? POS : NEG, whiteSpace: "nowrap" }}>
              {totalPnL >= 0 ? "+" : ""}{totalPnL.toFixed(2)} €{totalPnLPct != null ? ` (${totalPnLPct >= 0 ? "+" : ""}${totalPnLPct.toFixed(1)}%)` : ""}
            </div>
          )}
          <div style={{ fontSize: 10, color: MUTED }}>Mise {totalInvested.toFixed(2)} €</div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 6, marginBottom: 8 }}>
        <div style={{ background: NAVY, borderRadius: 7, padding: "6px 7px" }}>
          <div style={{ fontSize: 9, color: MUTED }}>Entrée moy.</div>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{weightedEntry != null ? formatPrice(weightedEntry) : "—"}</div>
        </div>
        <div style={{ background: NAVY, borderRadius: 7, padding: "6px 7px" }}>
          <div style={{ fontSize: 9, color: MUTED, display: "flex", alignItems: "center", gap: 3 }}>
            Actuel {isLivePrice && <LiveBadge />}
          </div>
          <div style={{ fontSize: 12, fontWeight: 700 }}>{currentPrice != null ? formatPrice(currentPrice) : "—"}</div>
        </div>
        <div style={{ background: NAVY, borderRadius: 7, padding: "6px 7px" }}>
          <div style={{ fontSize: 9, color: MUTED }}>SL</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: NEG }}>{sameSL ? formatPrice(first.stop) : "mixte"}</div>
        </div>
        <div style={{ background: NAVY, borderRadius: 7, padding: "6px 7px" }}>
          <div style={{ fontSize: 9, color: MUTED }}>TP</div>
          <div style={{ fontSize: 12, fontWeight: 700, color: POS }}>
            {sameTP ? (first.takeProfit != null ? formatPrice(first.takeProfit) : "—") : "mixte"}
          </div>
        </div>
      </div>

      {closingAll ? (
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          <input
            value={exitInput}
            onChange={(e) => setExitInput(e.target.value)}
            placeholder="Prix de sortie réel (toutes les positions)"
            inputMode="decimal"
            autoFocus
            style={{ flex: 1, background: NAVY, border: `1px solid ${LINE}`, borderRadius: 8, padding: "7px 9px", color: TEXT, fontSize: 12 }}
          />
          <button onClick={confirmCloseAll} disabled={!exitValid} style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: exitValid ? "rgba(61,214,140,0.14)" : "transparent", border: `1px solid ${exitValid ? POS : LINE}`, color: exitValid ? POS : MUTED, borderRadius: 8, cursor: exitValid ? "pointer" : "not-allowed" }} title="Confirmer">
            <Check size={13} />
          </button>
          <button onClick={() => { setClosingAll(false); setExitInput(""); }} style={{ width: 30, height: 30, display: "flex", alignItems: "center", justifyContent: "center", background: "transparent", border: `1px solid ${LINE}`, color: MUTED, borderRadius: 8, cursor: "pointer" }} title="Annuler">
            <X size={13} />
          </button>
        </div>
      ) : (
        <button
          onClick={() => setClosingAll(true)}
          style={{ width: "100%", background: "rgba(255,103,103,0.10)", border: `1px solid ${NEG}`, color: NEG, borderRadius: 8, padding: "8px 0", fontSize: 11, fontWeight: 700, cursor: "pointer" }}
        >
          Tout fermer ({trades.length})
        </button>
      )}
    </div>
  );
}

function PositionGroup({ trades, priceFor, onCloseWithResult, onCloseNoResult, onDelete, onCloseAllGroup }) {
  const { price, isLive } = priceFor(trades[0]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <GroupHeader trades={trades} currentPrice={price} isLivePrice={isLive} onCloseAll={onCloseAllGroup} />
      <div style={{ display: "flex", flexDirection: "column", gap: 6, paddingLeft: 10, borderLeft: `2px solid ${LINE}`, marginLeft: 4 }}>
        {trades.map((trade) => {
          const { price: p, isLive: l } = priceFor(trade);
          return (
            <CompactTradeRow
              key={trade.id}
              trade={trade}
              currentPrice={p}
              isLivePrice={l}
              onCloseWithResult={onCloseWithResult}
              onCloseNoResult={onCloseNoResult}
              onDelete={onDelete}
              nested
            />
          );
        })}
      </div>
    </div>
  );
}

export default function HistoryTab() {
  const [history, setHistory] = useState([]);
  const [settings, setSettings] = useState(null);
  const [filter, setFilter] = useState("tous");
  const [otherPrices, setOtherPrices] = useState({}); // { "symbol:assetType": price }
  const [refreshing, setRefreshing] = useState(false);

  useEffect(() => {
    setHistory(loadHistory());
    setSettings(loadSettings());
  }, []);

  const openTrades = useMemo(() => history.filter((t) => t.status === "ouvert"), [history]);

  // Prix live crypto via Binance WS — trade.symbol pour les cryptos est déjà
  // l'id CoinGecko en majuscules (ex: "BITCOIN"), donc symbol.toLowerCase()
  // correspond directement à l'id attendu par useBinanceLivePrices.
  const cryptoIds = useMemo(
    () => openTrades.filter((t) => t.assetType === "crypto").map((t) => t.symbol.toLowerCase()),
    [openTrades]
  );
  const livePrices = useBinanceLivePrices(cryptoIds);

  // Prix "quasi-live" pour actions/forex/matières : un fetch au chargement
  // + bouton actualiser (pas de streaming, pour ménager le quota Twelve Data).
  const fetchOtherPrices = useCallback(async () => {
    const targets = openTrades.filter((t) => t.assetType !== "crypto");
    if (targets.length === 0) return;
    setRefreshing(true);
    const next = {};
    for (const t of targets) {
      const key = `${t.symbol}:${t.assetType}`;
      try {
        next[key] = await fetchCurrentPriceFor(t.symbol, t.assetType);
      } catch {
        // symbole introuvable / quota atteint : on garde "—" pour cette ligne
      }
      // léger espacement pour rester sous les 8 req/min du plan gratuit Twelve Data
      await new Promise((r) => setTimeout(r, 900));
    }
    setOtherPrices((prev) => ({ ...prev, ...next }));
    setRefreshing(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openTrades.map((t) => `${t.symbol}:${t.assetType}`).join(",")]);

  useEffect(() => {
    fetchOtherPrices();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchOtherPrices]);

  const priceFor = (trade) => {
    if (trade.assetType === "crypto") {
      const p = livePrices[trade.symbol.toLowerCase()];
      return { price: p ?? null, isLive: p != null };
    }
    const p = otherPrices[`${trade.symbol}:${trade.assetType}`];
    return { price: p ?? null, isLive: false };
  };

  const handleCloseWithResult = (id, exitPrice) => {
    const trade = history.find((t) => t.id === id);
    if (!trade) return;
    const isLong = trade.direction !== "short";
    const pnl = isLong ? exitPrice - trade.entry : trade.entry - exitPrice;
    const status = pnl >= 0 ? "gagné" : "perdu";
    setHistory(updateTradeStatus(id, status, { exitPrice }));
  };

  // Ferme d'un coup toutes les positions d'un groupe (bouton "Tout fermer"),
  // au même prix de sortie saisi par l'utilisateur.
  const handleCloseAllGroup = (ids, exitPrice) => {
    let result = history;
    ids.forEach((id) => {
      const trade = history.find((t) => t.id === id);
      if (!trade) return;
      const isLong = trade.direction !== "short";
      const pnl = isLong ? exitPrice - trade.entry : trade.entry - exitPrice;
      const status = pnl >= 0 ? "gagné" : "perdu";
      result = updateTradeStatus(id, status, { exitPrice });
    });
    setHistory(result);
  };

  const handleCloseNoResult = (id) => setHistory(updateTradeStatus(id, "clôturé"));
  const handleDelete = (id) => setHistory(deleteTrade(id));

  const handleSaveBudget = (newBudget) => {
    const next = { ...settings, dailyBudget: newBudget };
    saveSettings(next);
    setSettings(next);
  };

  const todayKey = toLocalDateKey();
  const todayTrades = useMemo(() => getTodayTrades(history, todayKey), [history, todayKey]);
  const openRiskToday = useMemo(() => todayOpenRisk(history, todayKey), [history, todayKey]);
  const investedToday = useMemo(() => todayInvested(history, todayKey), [history, todayKey]);
  const remainingBudget = useMemo(
    () => (settings ? todayRemainingBudget(history, settings, todayKey) : 0),
    [history, settings, todayKey]
  );
  const stats = useMemo(() => getStats(history), [history]);

  const filtered = useMemo(() => {
    if (filter === "ouvert") return history.filter((t) => t.status === "ouvert");
    if (filter === "clos") return history.filter((t) => t.status !== "ouvert");
    return history;
  }, [history, filter]);

  // Les trades "ouvert" du même symbole + même sens sont regroupés ; les
  // autres statuts (gagné/perdu/clôturé) restent affichés individuellement.
  const groups = useMemo(() => buildGroups(filtered), [filtered]);

  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 14 }}>
        Trades marqués comme pris depuis le Calculateur. Stocké uniquement sur cet appareil.
      </div>

      {settings && (
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 16 }}>
          <SummaryCard
            label="Trades aujourd'hui"
            value={todayTrades.length}
            sub={`/ ${settings.maxTradesPerDay}`}
            danger={todayTrades.length >= settings.maxTradesPerDay}
          />
          <SummaryCard
            label="Risque ouvert"
            value={`${openRiskToday.toFixed(0)} €`}
            sub={`/ ${settings.dailyRiskLimit} €`}
            danger={openRiskToday >= settings.dailyRiskLimit}
          />
          <SummaryCard
            label="Budget restant"
            value={`${remainingBudget.toFixed(0)} €`}
            sub={`/ ${settings.dailyBudget} € (investi ${investedToday.toFixed(0)} €)`}
            danger={remainingBudget <= 0}
            editable
            onSave={handleSaveBudget}
          />
        </div>
      )}

      <StatsSummary stats={stats} />

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ display: "flex", gap: 6 }}>
          {[{ id: "tous", label: "Tous" }, { id: "ouvert", label: "Ouverts" }, { id: "clos", label: "Clos" }].map((f) => (
            <button
              key={f.id}
              onClick={() => setFilter(f.id)}
              style={{ padding: "6px 12px", borderRadius: 20, border: `1px solid ${filter === f.id ? ACCENT : LINE}`, background: filter === f.id ? "rgba(79,140,255,0.12)" : "transparent", color: filter === f.id ? ACCENT : MUTED, fontSize: 12, fontWeight: 600, cursor: "pointer" }}
            >
              {f.label}
            </button>
          ))}
        </div>
        <button
          onClick={fetchOtherPrices}
          disabled={refreshing}
          title="Actualiser les prix actions / forex / or"
          style={{ display: "flex", alignItems: "center", gap: 5, background: "transparent", border: `1px solid ${LINE}`, color: MUTED, borderRadius: 8, padding: "6px 10px", fontSize: 11, cursor: refreshing ? "not-allowed" : "pointer" }}
        >
          <RefreshCw size={12} className={refreshing ? "spin" : ""} /> {refreshing ? "…" : "Actualiser"}
        </button>
      </div>

      {filtered.length === 0 ? (
        <div style={{ fontSize: 13, color: MUTED, textAlign: "center", padding: "30px 0" }}>
          Aucun trade {filter === "ouvert" ? "ouvert" : filter === "clos" ? "clos" : "enregistré"} pour l'instant.
          Marque un trade comme pris depuis le Calculateur pour le voir apparaître ici.
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {groups.map((g) => {
            if (g.trades.length === 1) {
              const trade = g.trades[0];
              const { price, isLive } = priceFor(trade);
              return (
                <CompactTradeRow
                  key={trade.id}
                  trade={trade}
                  currentPrice={price}
                  isLivePrice={isLive}
                  onCloseWithResult={handleCloseWithResult}
                  onCloseNoResult={handleCloseNoResult}
                  onDelete={handleDelete}
                />
              );
            }
            return (
              <PositionGroup
                key={g.key}
                trades={g.trades}
                priceFor={priceFor}
                onCloseWithResult={handleCloseWithResult}
                onCloseNoResult={handleCloseNoResult}
                onDelete={handleDelete}
                onCloseAllGroup={handleCloseAllGroup}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}
