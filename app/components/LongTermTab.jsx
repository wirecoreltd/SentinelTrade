"use client";

import { useState, useEffect } from "react";
import {
  getWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  getCachedScore,
  setCachedScore,
  sortByStaleness,
  getRemainingQuota,
} from "../lib/watchlist";
import { fetchSeries, computeLongTermScore } from "../lib/engines/longTermScore";

const VERDICT_STYLE = {
  STRONG_CANDIDATE: { label: "🟢 STRONG CANDIDATE", color: "#16a34a" },
  NEUTRAL: { label: "🟡 NEUTRAL", color: "#ca8a04" },
  WEAK: { label: "🔴 WEAK", color: "#dc2626" },
};

export default function LongTermTab() {
  const [watchlist, setWatchlist] = useState([]);
  const [results, setResults] = useState({}); // key -> score data
  const [scanning, setScanning] = useState(false);
  const [newSymbol, setNewSymbol] = useState("");
  const [newType, setNewType] = useState("stock");
  const [remainingQuota, setRemainingQuota] = useState(0);

  useEffect(() => {
    const list = getWatchlist();
    setWatchlist(list);
    setRemainingQuota(getRemainingQuota());

    // Charge d'abord tout ce qui est déjà en cache, sans appel réseau.
    const cached = {};
    list.forEach((a) => {
      const c = getCachedScore(a.symbol, a.type);
      if (c) cached[`${a.type}:${a.symbol}`] = c;
    });
    setResults(cached);
  }, []);

  async function scanWatchlist() {
    setScanning(true);
    const ordered = sortByStaleness(watchlist);
    const updated = { ...results };

    for (const asset of ordered) {
      const key = `${asset.type}:${asset.symbol}`;
      const cached = getCachedScore(asset.symbol, asset.type);

      // On garde le cache si frais, pour économiser le quota Alpha Vantage.
      if (cached && !cached.isStale) {
        updated[key] = cached;
        continue;
      }

      if (asset.type !== "crypto" && getRemainingQuota() <= 0) {
        // Plus de quota Alpha Vantage aujourd'hui : on garde l'ancien
        // résultat (même périmé) plutôt que de bloquer le scan.
        if (cached) updated[key] = cached;
        continue;
      }

      const series = await fetchSeries(asset.symbol, asset.type);
      if (series.error) {
        updated[key] = { error: series.error };
        setResults({ ...updated });
        continue;
      }

      const score = computeLongTermScore(series.closes);
      setCachedScore(asset.symbol, asset.type, score);
      updated[key] = { ...score, timestamp: Date.now(), isStale: false };
      setResults({ ...updated }); // affichage progressif, résultat par résultat
    }

    setRemainingQuota(getRemainingQuota());
    setScanning(false);
  }

  function handleAdd() {
    if (!newSymbol.trim()) return;
    const updated = addToWatchlist(newSymbol.trim().toUpperCase(), newType);
    setWatchlist(updated);
    setNewSymbol("");
  }

  function handleRemove(symbol, type) {
    const updated = removeFromWatchlist(symbol, type);
    setWatchlist(updated);
  }

  // Classement : les meilleurs scores en premier (seulement ceux calculés)
  const ranked = watchlist
    .map((a) => ({ ...a, result: results[`${a.type}:${a.symbol}`] }))
    .filter((a) => a.result && !a.result.error)
    .sort((a, b) => b.result.score - a.result.score);

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2>Investissement Long Terme</h2>
        <span style={{ fontSize: 12, opacity: 0.7 }}>
          Quota Alpha Vantage restant aujourd'hui : {remainingQuota}
        </span>
      </div>

      <p style={{ fontSize: 13, opacity: 0.8, marginBottom: 16 }}>
        Score de qualité de candidat long terme (1M / 3M / 6M) basé sur momentum,
        cohérence de tendance et volatilité. Ce n'est pas une prédiction de prix.
      </p>

      {/* Ajout à la watchlist */}
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <input
          value={newSymbol}
          onChange={(e) => setNewSymbol(e.target.value)}
          placeholder="Symbole (ex: AAPL, EURUSD, bitcoin)"
        />
        <select value={newType} onChange={(e) => setNewType(e.target.value)}>
          <option value="stock">Action</option>
          <option value="forex">Forex</option>
          <option value="crypto">Crypto (id CoinGecko)</option>
        </select>
        <button onClick={handleAdd}>Ajouter</button>
        <button onClick={scanWatchlist} disabled={scanning}>
          {scanning ? "Scan en cours..." : "Scanner la watchlist"}
        </button>
      </div>

      {/* Classement */}
      <div>
        {ranked.length === 0 && (
          <p style={{ opacity: 0.6 }}>Aucun résultat pour l'instant — lance un scan.</p>
        )}
        {ranked.map((a) => {
          const v = VERDICT_STYLE[a.result.verdict];
          return (
            <div
              key={`${a.type}:${a.symbol}`}
              style={{
                border: "1px solid #333",
                borderRadius: 8,
                padding: 12,
                marginBottom: 8,
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
              }}
            >
              <div>
                <strong>{a.symbol}</strong>{" "}
                <span style={{ fontSize: 11, opacity: 0.6 }}>({a.type})</span>
                <div style={{ fontSize: 12, opacity: 0.8 }}>
                  {a.result.reasons?.slice(0, 3).join(" · ")}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontWeight: 700 }}>{a.result.score}/100</div>
                <div style={{ color: v?.color, fontSize: 12 }}>{v?.label}</div>
                <button
                  onClick={() => handleRemove(a.symbol, a.type)}
                  style={{ fontSize: 11, marginTop: 4 }}
                >
                  Retirer
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
