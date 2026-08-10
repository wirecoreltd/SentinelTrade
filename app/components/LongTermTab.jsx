"use client";

import { useState, useEffect } from "react";
import { Loader2, ListOrdered, Trash2, Plus } from "lucide-react";
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getCachedScore,
  setCachedScore,
  sortByStaleness,
  getRemainingQuota,
} from "../lib/watchlist";
import { fetchLongTermSeries, computeLongTermScore } from "../lib/engines/longTermScore";

// Même palette que TradingApp.jsx — dupliquée ici volontairement pour ne
// pas toucher au fichier existant. Si tu préfères, on peut extraire ces
// constantes dans un fichier partagé app/lib/theme.js plus tard.
const NAVY = "#0E1420";
const PANEL = "#161D2B";
const ACCENT = "#4F8CFF";
const TEXT = "#EEF1F6";
const MUTED = "#8A93A6";
const LINE = "#232C3D";
const POS = "#3DD68C";
const NEG = "#FF6767";

const VERDICT_STYLE = {
  STRONG_CANDIDATE: { label: "STRONG CANDIDATE", color: POS },
  NEUTRAL: { label: "NEUTRAL", color: MUTED },
  WEAK: { label: "WEAK", color: NEG },
};

const TYPES = [
  { id: "stock", label: "Action" },
  { id: "forex", label: "Devise" },
  { id: "crypto", label: "Crypto (id CoinGecko)" },
];

export default function LongTermTab() {
  const [watchlist, setWatchlist] = useState([]);
  const [results, setResults] = useState({});
  const [scanning, setScanning] = useState(false);
  const [step, setStep] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [newType, setNewType] = useState("stock");
  const [remainingQuota, setRemainingQuota] = useState(0);

  useEffect(() => {
    const list = getWatchlist();
    setWatchlist(list);
    setRemainingQuota(getRemainingQuota());

    const cached = {};
    list.forEach((a) => {
      const c = getCachedScore(a.symbol, a.type);
      if (c) cached[`${a.type}:${a.symbol}`] = c;
    });
    setResults(cached);
  }, []);

  const scanWatchlist = async () => {
    setScanning(true);
    const ordered = sortByStaleness(watchlist);
    const updated = { ...results };

    for (const asset of ordered) {
      const key = `${asset.type}:${asset.symbol}`;
      setStep(`${asset.symbol}…`);
      const cached = getCachedScore(asset.symbol, asset.type);

      if (cached && !cached.isStale) {
        updated[key] = cached;
        setResults({ ...updated });
        continue;
      }

      if (asset.type !== "crypto" && getRemainingQuota() <= 0) {
        if (cached) updated[key] = cached;
        setResults({ ...updated });
        continue;
      }

      const series = await fetchLongTermSeries(asset.symbol, asset.type);
      if (series.error) {
        updated[key] = { error: series.error };
        setResults({ ...updated });
        continue;
      }

      const score = computeLongTermScore(series.closes);
      if (!score.error) setCachedScore(asset.symbol, asset.type, score);
      updated[key] = { ...score, timestamp: Date.now(), isStale: false };
      setResults({ ...updated });

      if (asset.type === "crypto") await new Promise((r) => setTimeout(r, 400));
    }

    setRemainingQuota(getRemainingQuota());
    setStep("");
    setScanning(false);
  };

  const handleAdd = () => {
    if (!newSymbol.trim()) return;
    const symbol = newType === "crypto" ? newSymbol.trim().toLowerCase() : newSymbol.trim().toUpperCase();
    const updated = addToWatchlist(symbol, newType);
    setWatchlist(updated);
    setNewSymbol("");
  };

  const handleRemove = (symbol, type) => {
    setWatchlist(removeFromWatchlist(symbol, type));
  };

  const ranked = watchlist
    .map((a) => ({ ...a, result: results[`${a.type}:${a.symbol}`] }))
    .filter((a) => a.result && !a.result.error)
    .sort((a, b) => b.result.score - a.result.score);

  const failed = watchlist
    .map((a) => ({ ...a, result: results[`${a.type}:${a.symbol}`] }))
    .filter((a) => a.result?.error);

  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 4, lineHeight: 1.5 }}>
        Score de qualité de candidat long terme (momentum 1M/3M/6M, cohérence de
        tendance, volatilité). Ce n'est pas une prédiction de prix — un filtre de discipline.
      </div>
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 16 }}>
        Quota Alpha Vantage restant aujourd'hui : {remainingQuota}/25 (crypto illimité)
      </div>

      {/* Ajout à la watchlist */}
      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {TYPES.map((t) => (
          <button
            key={t.id}
            onClick={() => setNewType(t.id)}
            style={{
              padding: "6px 10px",
              borderRadius: 20,
              border: `1px solid ${newType === t.id ? ACCENT : LINE}`,
              background: newType === t.id ? "rgba(79,140,255,0.12)" : "transparent",
              color: newType === t.id ? ACCENT : MUTED,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          handleAdd();
        }}
        style={{ display: "flex", gap: 8, marginBottom: 18 }}
      >
        <input
          value={newSymbol}
          onChange={(e) => setNewSymbol(e.target.value)}
          placeholder={
            newType === "stock" ? "ex: AAPL" : newType === "forex" ? "ex: EUR, GBP" : "ex: bitcoin"
          }
          style={{
            flex: 1,
            background: NAVY,
            border: `1px solid ${LINE}`,
            borderRadius: 8,
            padding: "10px 12px",
            color: TEXT,
            fontSize: 14,
          }}
        />
        <button
          type="submit"
          style={{ background: ACCENT, border: "none", borderRadius: 8, padding: "0 14px", cursor: "pointer" }}
        >
          <Plus size={16} color="#fff" />
        </button>
      </form>

      <button
        onClick={scanWatchlist}
        disabled={scanning || watchlist.length === 0}
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 6,
          width: "100%",
          background: ACCENT,
          border: "none",
          borderRadius: 8,
          padding: "10px 0",
          color: "#fff",
          fontSize: 13,
          fontWeight: 600,
          cursor: "pointer",
          marginBottom: 18,
        }}
      >
        {scanning ? <Loader2 className="spin" size={14} /> : <ListOrdered size={14} />}
        {scanning ? step || "Scan…" : "Scanner la watchlist"}
      </button>

      {/* Classement */}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {ranked.length === 0 && !scanning && (
          <div style={{ fontSize: 13, color: MUTED }}>Aucun résultat — ajoute des actifs puis lance un scan.</div>
        )}
        {ranked.map((a) => {
          const v = VERDICT_STYLE[a.result.verdict];
          return (
            <div
              key={`${a.type}:${a.symbol}`}
              style={{
                background: PANEL,
                border: `1px solid ${LINE}`,
                borderRadius: 10,
                padding: "12px 14px",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 14 }}>{a.symbol}</div>
                  <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase" }}>{a.type}</div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontWeight: 700, fontSize: 16 }}>{a.result.score}/100</div>
                  <div
                    style={{
                      fontSize: 11,
                      fontWeight: 700,
                      color: v?.color,
                      textTransform: "uppercase",
                    }}
                  >
                    {v?.label}
                  </div>
                </div>
              </div>
              <div style={{ marginTop: 8, display: "flex", flexDirection: "column", gap: 3 }}>
                {a.result.reasons?.map((r, i) => (
                  <div key={i} style={{ fontSize: 12, color: MUTED }}>
                    {r}
                  </div>
                ))}
              </div>
              <button
                onClick={() => handleRemove(a.symbol, a.type)}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 4,
                  background: "none",
                  border: "none",
                  color: MUTED,
                  fontSize: 11,
                  marginTop: 8,
                  cursor: "pointer",
                  padding: 0,
                }}
              >
                <Trash2 size={11} /> Retirer de la watchlist
              </button>
            </div>
          );
        })}

        {failed.length > 0 && (
          <div style={{ fontSize: 11, color: MUTED, marginTop: 4 }}>
            {failed.length} actif(s) sans résultat (quota atteint ou symbole invalide).
          </div>
        )}
      </div>
    </div>
  );
}
