"use client";
import { useState, useEffect } from "react";

// Source unique de vérité pour la correspondance CoinGecko id → symbole
// Binance. Utilisée par TradingApp.jsx (watchlists, Dossier, Long terme) et
// par HistoryTab.jsx (prix live des positions crypto ouvertes).
export const COINGECKO_TO_BINANCE = {
  bitcoin: "BTCUSDT",
  ethereum: "ETHUSDT",
  solana: "SOLUSDT",
  binancecoin: "BNBUSDT",
  ripple: "XRPUSDT",
  cardano: "ADAUSDT",
  dogecoin: "DOGEUSDT",
  "avalanche-2": "AVAXUSDT",
  polkadot: "DOTUSDT",
  chainlink: "LINKUSDT",
  tron: "TRXUSDT",
  "matic-network": "POLUSDT",
  litecoin: "LTCUSDT",
  "shiba-inu": "SHIBUSDT",
  uniswap: "UNIUSDT",
};

export function getBinanceSymbol(coingeckoId) {
  if (!coingeckoId) return null;
  return COINGECKO_TO_BINANCE[coingeckoId.toLowerCase()] || null;
}

// ids : tableau d'ids CoinGecko (ex: ["bitcoin", "ethereum"]).
export function useBinanceLivePrices(ids) {
  const [prices, setPrices] = useState({});
  const idsKey = [...new Set(ids.filter((id) => getBinanceSymbol(id)))].sort().join(",");

  useEffect(() => {
    const activeIds = idsKey ? idsKey.split(",") : [];
    if (activeIds.length === 0) return;

    const streams = activeIds.map((id) => `${getBinanceSymbol(id).toLowerCase()}@trade`).join("/");
    let ws;
    let reconnectTimer;
    let cancelled = false;

    const connect = () => {
      ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams}`);

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          const symbol = msg?.data?.s?.toLowerCase();
          const price = parseFloat(msg?.data?.p);
          if (!symbol || !Number.isFinite(price)) return;
          const id = Object.keys(COINGECKO_TO_BINANCE).find(
            (k) => getBinanceSymbol(k).toLowerCase() === symbol
          );
          if (!id) return;
          setPrices((prev) => (prev[id] === price ? prev : { ...prev, [id]: price }));
        } catch {
          // trame malformée, on ignore
        }
      };

      ws.onclose = () => {
        if (cancelled) return;
        reconnectTimer = setTimeout(connect, 3000);
      };

      ws.onerror = () => ws.close();
    };

    connect();

    return () => {
      cancelled = true;
      clearTimeout(reconnectTimer);
      if (ws) {
        ws.onclose = null;
        ws.close();
      }
    };
  }, [idsKey]);

  return prices;
}
