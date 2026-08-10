"use client";

import { useState, useEffect, useCallback } from "react";
import {
  Search,
  LineChart,
  FileText,
  Calculator,
  Loader2,
  TrendingUp,
  TrendingDown,
  Minus,
  Send,
} from "lucide-react";

// ---------- Thème ----------
const NAVY = "#0E1420";
const PANEL = "#161D2B";
const ACCENT = "#4F8CFF";
const TEXT = "#EEF1F6";
const MUTED = "#8A93A6";
const LINE = "#232C3D";
const POS = "#3DD68C";
const NEG = "#FF6767";

// ---------- Helper: extrait un message d'erreur exploitable d'une réponse Alpha Vantage ----------
// Alpha Vantage renvoie l'erreur / le message de quota sous des clés différentes
// selon le cas : "Note" (ancien format quota), "Information" (nouveau format,
// quota ou fonction premium), "Error Message" (paramètre/symbole invalide).
function alphaVantageErrorMessage(data) {
  return data?.Note || data?.Information || data?.["Error Message"] || null;
}

// ---------- Métaux précieux (or, argent) ----------
// Alpha Vantage renvoie "Invalid API call" sur CURRENCY_EXCHANGE_RATE / FX_DAILY
// pour XAU et XAG : ces symboles ne sont pas supportés sur le plan gratuit.
// On les route donc vers gold-api.com : gratuit, sans clé API, CORS activé,
// appelable directement depuis le navigateur. Limite : leur endpoint
// d'historique nécessite une clé (10 req/h en gratuit), donc on affiche le
// prix en temps réel mais pas de support/résistance pour ces deux actifs.
const METAL_SYMBOLS = ["XAU", "XAG"];
function isMetal(symbol) {
  return METAL_SYMBOLS.includes(symbol.toUpperCase());
}

async function fetchMetalPrice(symbol) {
  const res = await fetch(`https://api.gold-api.com/price/${encodeURIComponent(symbol.toUpperCase())}`);
  if (!res.ok) throw new Error("Métal introuvable (XAU pour l'or, XAG pour l'argent)");
  const data = await res.json();
  if (typeof data.price !== "number") throw new Error("Prix du métal indisponible");
  return { price: data.price, change24h: null };
}

// ---------- Helpers API ----------
async function fetchCoinGeckoPrice(id) {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true`
  );
  if (!res.ok) throw new Error("Identifiant crypto introuvable");
  const data = await res.json();
  if (!data[id]) throw new Error("Identifiant crypto introuvable");
  return { price: data[id].usd, change24h: data[id].usd_24h_change };
}

async function fetchCoinGeckoHistory(id, days) {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=${days}&interval=daily`
  );
  if (!res.ok) throw new Error("Historique crypto indisponible");
  const data = await res.json();
  return data.prices.map(([ts, price]) => ({ date: ts, close: price }));
}

async function fetchCoinGeckoTop(n = 10) {
  const res = await fetch(
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${n}&page=1&price_change_percentage=24h`
  );
  if (!res.ok) throw new Error("Scanner indisponible");
  return res.json();
}

async function fetchAlphaQuote(symbol) {
  const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&kind=quote`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const q = data["Global Quote"];
  if (!q || !q["05. price"]) {
    const reason = alphaVantageErrorMessage(data);
    throw new Error(reason || "Symbole introuvable");
  }
  return {
    price: parseFloat(q["05. price"]),
    change24h: parseFloat(q["10. change percent"]),
  };
}

async function fetchAlphaHistory(symbol) {
  const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&kind=history`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const series = data["Time Series (Daily)"];
  if (!series) {
    const reason = alphaVantageErrorMessage(data);
    throw new Error(reason || "Historique indisponible");
  }
  return Object.entries(series)
    .map(([date, v]) => ({ date, close: parseFloat(v["4. close"]) }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

// Devises classiques uniquement (les métaux passent par fetchMetalPrice ci-dessus)
async function fetchFxQuote(symbol) {
  const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&kind=quote&market=fx`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const q = data["Realtime Currency Exchange Rate"];
  if (!q || !q["5. Exchange Rate"]) {
    const reason = alphaVantageErrorMessage(data);
    throw new Error(reason || "Devise introuvable (ex: EUR, GBP)");
  }
  return { price: parseFloat(q["5. Exchange Rate"]), change24h: null };
}

async function fetchFxHistory(symbol) {
  const res = await fetch(`/api/stock?symbol=${encodeURIComponent(symbol)}&kind=history&market=fx`);
  const data = await res.json();
  if (data.error) throw new Error(data.error);
  const series = data["Time Series FX (Daily)"];
  if (!series) {
    const reason = alphaVantageErrorMessage(data);
    throw new Error(reason || "Historique indisponible");
  }
  return Object.entries(series)
    .map(([date, v]) => ({ date, close: parseFloat(v["4. close"]) }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function fetchNewsSentiment(query) {
  const res = await fetch(`/api/news?q=${encodeURIComponent(query)}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Actualités indisponibles");
  const articles = (data.results || []).slice(0, 15);

  const POS_WORDS = ["surge", "rally", "gain", "bullish", "soar", "jump", "rise", "beat", "strong", "growth", "upgrade", "hausse", "record"];
  const NEG_WORDS = ["drop", "fall", "plunge", "bearish", "crash", "decline", "loss", "weak", "cut", "downgrade", "concern", "fear", "baisse", "chute"];

  let score = 0;
  for (const a of articles) {
    const text = `${a.title || ""} ${a.description || ""}`.toLowerCase();
    for (const w of POS_WORDS) if (text.includes(w)) score += 1;
    for (const w of NEG_WORDS) if (text.includes(w)) score -= 1;
  }

  let label = "mitigé";
  if (score >= 2) label = "positif";
  else if (score <= -2) label = "négatif";

  return { label, score, articleCount: articles.length, headlines: articles.slice(0, 3).map((a) => a.title) };
}

// ---------- Calculs ----------
function trendFromHistory(history, days) {
  if (!history || history.length < 2) return null;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const inWindow = history.filter((h) => new Date(h.date).getTime() >= cutoff);
  const series = inWindow.length >= 2 ? inWindow : history;
  const first = series[0].close;
  const last = series[series.length - 1].close;
  const pct = ((last - first) / first) * 100;
  let direction = "plat";
  if (pct > 1) direction = "haussier";
  else if (pct < -1) direction = "baissier";
  return { pct, direction };
}

function supportResistance(history) {
  const closes = history.map((h) => h.close);
  return { support: Math.min(...closes), resistance: Math.max(...closes) };
}

// ---------- UI: petit composant de tendance ----------
function TrendBadge({ label, trend }) {
  if (!trend) return null;
  const color = trend.direction === "haussier" ? POS : trend.direction === "baissier" ? NEG : MUTED;
  const Icon = trend.direction === "haussier" ? TrendingUp : trend.direction === "baissier" ? TrendingDown : Minus;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 6, background: NAVY, border: `1px solid ${LINE}`, borderRadius: 8, padding: "8px 10px" }}>
      <Icon size={14} color={color} />
      <div>
        <div style={{ fontSize: 11, color: MUTED }}>{label}</div>
        <div style={{ fontSize: 13, fontWeight: 700, color }}>
          {trend.direction} ({trend.pct > 0 ? "+" : ""}{trend.pct.toFixed(1)}%)
        </div>
      </div>
    </div>
  );
}

// ================= Scanner =================
const FX_SHORTCUTS = [
  { label: "Or (XAU)", type: "fx", query: "XAU" },
  { label: "Argent (XAG)", type: "fx", query: "XAG" },
  { label: "EUR/USD", type: "fx", query: "EUR" },
  { label: "GBP/USD", type: "fx", query: "GBP" },
];

function Scanner({ onPick }) {
  const [coins, setCoins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    fetchCoinGeckoTop(10)
      .then(setCoins)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  return (
    <div>
      <div style={{ fontSize: 11, color: MUTED, marginBottom: 8, textTransform: "uppercase", letterSpacing: 0.5 }}>
        Or &amp; devises
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 18, flexWrap: "wrap" }}>
        {FX_SHORTCUTS.map((s) => (
          <button
            key={s.query}
            onClick={() => onPick(s)}
            style={{
              padding: "8px 12px",
              borderRadius: 20,
              border: `1px solid ${LINE}`,
              background: PANEL,
              color: TEXT,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 13, color: MUTED, marginBottom: 14 }}>
        Top 10 crypto par capitalisation — clique un actif pour l'ouvrir dans Prix &amp; Niveaux.
      </div>
      {loading && <Loader2 className="spin" size={20} color={ACCENT} />}
      {error && <div style={{ color: NEG, fontSize: 13 }}>{error}</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {coins.map((c) => (
          <button
            key={c.id}
            onClick={() => onPick({ type: "crypto", query: c.id })}
            style={{
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              background: PANEL,
              border: `1px solid ${LINE}`,
              borderRadius: 10,
              padding: "12px 14px",
              cursor: "pointer",
              color: TEXT,
              textAlign: "left",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <img src={c.image} alt="" width={22} height={22} style={{ borderRadius: "50%" }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>{c.name}</div>
                <div style={{ fontSize: 11, color: MUTED, textTransform: "uppercase" }}>{c.symbol}</div>
              </div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>${c.current_price.toLocaleString()}</div>
              <div style={{ fontSize: 12, color: c.price_change_percentage_24h >= 0 ? POS : NEG }}>
                {c.price_change_percentage_24h >= 0 ? "+" : ""}
                {c.price_change_percentage_24h?.toFixed(2)}%
              </div>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

// ================= Prix & Niveaux =================
function PrixNiveaux({ prefill, setTab, setPrefillCalc }) {
  const [type, setType] = useState(prefill?.type || "crypto");
  const [query, setQuery] = useState(prefill?.query || "");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const runSearch = useCallback(async (t, q) => {
    if (!q) return;
    setLoading(true);
    setError("");
    setResult(null);
    try {
      if (t === "crypto") {
        const [price, history] = await Promise.all([
          fetchCoinGeckoPrice(q.toLowerCase()),
          fetchCoinGeckoHistory(q.toLowerCase(), 30),
        ]);
        const { support, resistance } = supportResistance(history);
        setResult({ ...price, support, resistance, symbol: q.toUpperCase() });
      } else if (t === "fx") {
        if (isMetal(q)) {
          // Or / argent : prix temps réel via gold-api.com, pas d'historique
          // gratuit disponible donc pas de support/résistance pour ces deux actifs.
          const price = await fetchMetalPrice(q);
          setResult({ ...price, support: null, resistance: null, symbol: `${q.toUpperCase()}/USD` });
        } else {
          const [price, history] = await Promise.all([
            fetchFxQuote(q.toUpperCase()),
            fetchFxHistory(q.toUpperCase()),
          ]);
          const { support, resistance } = supportResistance(history);
          setResult({ ...price, support, resistance, symbol: `${q.toUpperCase()}/USD` });
        }
      } else {
        const [price, history] = await Promise.all([
          fetchAlphaQuote(q.toUpperCase()),
          fetchAlphaHistory(q.toUpperCase()),
        ]);
        const { support, resistance } = supportResistance(history);
        setResult({ ...price, support, resistance, symbol: q.toUpperCase() });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (prefill?.query) runSearch(prefill.type, prefill.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  const TYPES = [
    { id: "crypto", label: "Crypto" },
    { id: "stock", label: "Actions" },
    { id: "fx", label: "Devises & Or" },
  ];

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {TYPES.map(({ id: t, label }) => (
          <button
            key={t}
            onClick={() => setType(t)}
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${type === t ? ACCENT : LINE}`,
              background: type === t ? "rgba(79,140,255,0.12)" : "transparent",
              color: type === t ? ACCENT : MUTED,
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          runSearch(type, query);
        }}
        style={{ display: "flex", gap: 8, marginBottom: 16 }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={type === "crypto" ? "ex: bitcoin" : type === "fx" ? "ex: XAU (or), EUR, GBP" : "ex: TSLA"}
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
          <Search size={16} color="#fff" />
        </button>
      </form>

      {loading && <Loader2 className="spin" size={20} color={ACCENT} />}
      {error && <div style={{ color: NEG, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {result && (
        <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{result.symbol}</div>
            <div style={{ fontSize: 22, fontWeight: 700 }}>${result.price.toLocaleString()}</div>
          </div>

          {result.support != null ? (
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 12 }}>
              <div style={{ background: NAVY, borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 11, color: MUTED }}>Support (30j)</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: POS }}>${result.support.toFixed(2)}</div>
              </div>
              <div style={{ background: NAVY, borderRadius: 8, padding: 10 }}>
                <div style={{ fontSize: 11, color: MUTED }}>Résistance (30j)</div>
                <div style={{ fontSize: 15, fontWeight: 700, color: NEG }}>${result.resistance.toFixed(2)}</div>
              </div>
            </div>
          ) : (
            <div style={{ fontSize: 12, color: MUTED, marginBottom: 12 }}>
              Historique indisponible gratuitement pour l'or/l'argent — prix en temps réel uniquement.
            </div>
          )}

          <button
            onClick={() => {
              setPrefillCalc(
                result.support != null
                  ? { entry: result.price, stop: result.support }
                  : { entry: result.price }
              );
              setTab("calc");
            }}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              background: "rgba(79,140,255,0.12)",
              border: `1px solid ${ACCENT}`,
              color: ACCENT,
              borderRadius: 8,
              padding: "9px 0",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <Send size={13} /> Envoyer au calculateur
          </button>
        </div>
      )}
    </div>
  );
}

// ================= Dossier d'analyse =================
function Dossier({ setTab, setPrefillCalc }) {
  const [type, setType] = useState("crypto");
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [dossier, setDossier] = useState(null);

  const analyser = async () => {
    if (!query) return;
    setLoading(true);
    setError("");
    setDossier(null);
    try {
      let price, history;
      if (type === "crypto") {
        const id = query.toLowerCase();
        [price, history] = await Promise.all([
          fetchCoinGeckoPrice(id),
          fetchCoinGeckoHistory(id, 90),
        ]);
      } else if (type === "fx") {
        const sym = query.toUpperCase();
        if (isMetal(sym)) {
          // Pas d'historique gratuit pour l'or/argent : on analyse sans les
          // tendances de prix, seulement le sentiment des actualités.
          price = await fetchMetalPrice(sym);
          history = null;
        } else {
          [price, history] = await Promise.all([
            fetchFxQuote(sym),
            fetchFxHistory(sym),
          ]);
        }
      } else {
        const sym = query.toUpperCase();
        [price, history] = await Promise.all([
          fetchAlphaQuote(sym),
          fetchAlphaHistory(sym),
        ]);
      }

      const t7 = history ? trendFromHistory(history, 7) : null;
      const t30 = history ? trendFromHistory(history, 30) : null;
      const t90 = history ? trendFromHistory(history, 90) : null;
      const { support, resistance } = history
        ? supportResistance(
            history.filter((h) => new Date(h.date).getTime() >= Date.now() - 30 * 86400000)
          )
        : { support: null, resistance: null };

      let news = null;
      let newsError = "";
      try {
        news = await fetchNewsSentiment(query);
      } catch (e) {
        newsError = e.message;
      }

      const trends = [t7, t30, t90].filter(Boolean);
      let bullCount = trends.filter((t) => t.direction === "haussier").length;
      let bearCount = trends.filter((t) => t.direction === "baissier").length;
      if (news?.label === "positif") bullCount += 1;
      if (news?.label === "négatif") bearCount += 1;

      let verdict = "mitigé";
      if (bullCount > bearCount) verdict = "haussier";
      else if (bearCount > bullCount) verdict = "baissier";

      const reasoning = [
        t7 && `Court terme (7j) : ${t7.direction} (${t7.pct > 0 ? "+" : ""}${t7.pct.toFixed(1)}%)`,
        t30 && `Moyen terme (30j) : ${t30.direction} (${t30.pct > 0 ? "+" : ""}${t30.pct.toFixed(1)}%)`,
        t90 && `Long terme (90j) : ${t90.direction} (${t90.pct > 0 ? "+" : ""}${t90.pct.toFixed(1)}%)`,
        support != null
          ? `Support 30j : $${support.toFixed(2)} — Résistance 30j : $${resistance.toFixed(2)}`
          : "Historique de prix indisponible gratuitement pour l'or/l'argent — analyse basée sur le prix actuel et les actualités uniquement",
        news
          ? `Actualités : ton ${news.label} sur ${news.articleCount} articles récents`
          : newsError
          ? `Actualités indisponibles : ${newsError}`
          : "Actualités non incluses",
      ].filter(Boolean);

      setDossier({
        symbol: query.toUpperCase(),
        price: price.price,
        support,
        resistance,
        verdict,
        reasoning,
        news,
      });
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  const verdictColor = dossier?.verdict === "haussier" ? POS : dossier?.verdict === "baissier" ? NEG : MUTED;

  return (
    <div>
      <div style={{ fontSize: 13, color: MUTED, marginBottom: 12 }}>
        Analyse multi-échelles + niveaux + sentiment actu, avec raisonnement détaillé. Ce n'est pas un signal garanti, juste une synthèse structurée.
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {[
          { id: "crypto", label: "Crypto" },
          { id: "stock", label: "Actions" },
          { id: "fx", label: "Devises & Or" },
        ].map(({ id: t, label }) => (
          <button
            key={t}
            onClick={() => setType(t)}
            style={{
              flex: 1,
              padding: "8px 10px",
              borderRadius: 8,
              border: `1px solid ${type === t ? ACCENT : LINE}`,
              background: type === t ? "rgba(79,140,255,0.12)" : "transparent",
              color: type === t ? ACCENT : MUTED,
              fontWeight: 600,
              fontSize: 13,
              cursor: "pointer",
            }}
          >
            {label}
          </button>
        ))}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          analyser();
        }}
        style={{ display: "flex", gap: 8, marginBottom: 16 }}
      >
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={type === "crypto" ? "ex: bitcoin" : type === "fx" ? "ex: XAU (or), EUR, GBP" : "ex: TSLA"}
          style={{ flex: 1, background: NAVY, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px", color: TEXT, fontSize: 14 }}
        />
        <button type="submit" style={{ background: ACCENT, border: "none", borderRadius: 8, padding: "0 14px", cursor: "pointer", color: "#fff", fontWeight: 600, fontSize: 13 }}>
          Analyser
        </button>
      </form>

      {loading && <Loader2 className="spin" size={20} color={ACCENT} />}
      {error && <div style={{ color: NEG, fontSize: 13, marginBottom: 10 }}>{error}</div>}

      {dossier && (
        <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>{dossier.symbol}</div>
            <div
              style={{
                fontSize: 13,
                fontWeight: 700,
                color: verdictColor,
                background: `${verdictColor}22`,
                padding: "4px 10px",
                borderRadius: 20,
                textTransform: "uppercase",
                letterSpacing: 0.5,
              }}
            >
              {dossier.verdict}
            </div>
          </div>

          <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 14 }}>
            {dossier.reasoning.map((line, i) => (
              <div key={i} style={{ fontSize: 13, color: MUTED, display: "flex", gap: 6 }}>
                <span style={{ color: ACCENT }}>•</span> {line}
              </div>
            ))}
          </div>

          {dossier.news?.headlines?.length > 0 && (
            <div style={{ marginBottom: 14, borderTop: `1px solid ${LINE}`, paddingTop: 10 }}>
              <div style={{ fontSize: 11, color: MUTED, marginBottom: 6, textTransform: "uppercase" }}>Titres récents</div>
              {dossier.news.headlines.map((h, i) => (
                <div key={i} style={{ fontSize: 12, color: TEXT, marginBottom: 4 }}>
                  {h}
                </div>
              ))}
            </div>
          )}

          <button
            onClick={() => {
              setPrefillCalc(
                dossier.support != null
                  ? {
                      entry: dossier.price,
                      stop: dossier.verdict === "baissier" ? dossier.resistance : dossier.support,
                    }
                  : { entry: dossier.price }
              );
              setTab("calc");
            }}
            style={{
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
              background: "rgba(79,140,255,0.12)",
              border: `1px solid ${ACCENT}`,
              color: ACCENT,
              borderRadius: 8,
              padding: "9px 0",
              fontSize: 13,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            <Send size={13} /> Envoyer au calculateur
          </button>
        </div>
      )}
    </div>
  );
}

// ================= Calculateur =================
const LEVERAGE_PRESETS = {
  crypto: { label: "Crypto (CFD)", leverage: 2 },
  forex: { label: "Forex", leverage: 30 },
  actions: { label: "Actions", leverage: 5 },
  matieres: { label: "Matières premières / Or", leverage: 20 },
  spot: { label: "Spot (Binance, sans levier)", leverage: 1 },
};

// Défini en dehors de Calculateur : sinon React recrée ce composant à
// chaque frappe et l'input perd le focus après chaque caractère.
function CalcField({ label, value, onChange, placeholder }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>{label}</div>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        inputMode="decimal"
        style={{ width: "100%", background: NAVY, border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px", color: TEXT, fontSize: 14 }}
      />
    </div>
  );
}

function Calculateur({ prefill }) {
  const [assetType, setAssetType] = useState("crypto");
  const [invested, setInvested] = useState("50");
  const [leverage, setLeverage] = useState(LEVERAGE_PRESETS.crypto.leverage.toString());
  const [entry, setEntry] = useState(prefill?.entry?.toString() || "");
  const [stop, setStop] = useState(prefill?.stop?.toString() || "");
  const [takeProfit, setTakeProfit] = useState("");

  useEffect(() => {
    if (prefill?.entry) setEntry(prefill.entry.toString());
    if (prefill?.stop) setStop(prefill.stop.toString());
  }, [prefill]);

  const onAssetType = (t) => {
    setAssetType(t);
    setLeverage(LEVERAGE_PRESETS[t].leverage.toString());
  };

  const inv = parseFloat(invested);
  const lev = parseFloat(leverage);
  const e = parseFloat(entry);
  const s = parseFloat(stop);
  const tp = parseFloat(takeProfit);

  const valid = inv > 0 && lev > 0 && e > 0 && s > 0 && e !== s;
  const positionValue = valid ? inv * lev : null; // taille totale de la position en €
  const quantity = valid ? positionValue / e : null; // à saisir dans le champ "Taille"/"Quantité" du broker
  const distance = valid ? Math.abs(e - s) : null; // "Distance" du stop, comme sur Capital.com
  const distancePct = valid ? (distance / e) * 100 : null; // "Distance (%)"
  const lossAmount = valid ? quantity * distance : null;
  const lossPctOfInvested = valid ? (lossAmount / inv) * 100 : null;
  const gainAmount = valid && tp > 0 ? quantity * Math.abs(tp - e) : null;
  const gainDistance = valid && tp > 0 ? Math.abs(tp - e) : null;
  const gainDistancePct = valid && tp > 0 ? (gainDistance / e) * 100 : null;

  return (
    <div>
      <div style={{ fontSize: 12, color: MUTED, marginBottom: 6 }}>Type d'actif (fixe le levier par défaut)</div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {Object.entries(LEVERAGE_PRESETS).map(([key, v]) => (
          <button
            key={key}
            onClick={() => onAssetType(key)}
            style={{
              padding: "6px 10px",
              borderRadius: 20,
              border: `1px solid ${assetType === key ? ACCENT : LINE}`,
              background: assetType === key ? "rgba(79,140,255,0.12)" : "transparent",
              color: assetType === key ? ACCENT : MUTED,
              fontSize: 12,
              fontWeight: 600,
              cursor: "pointer",
            }}
          >
            {v.label}
          </button>
        ))}
      </div>

      <CalcField label="Montant à investir — ta mise / marge (€)" value={invested} onChange={setInvested} placeholder="ex: 50" />
      <CalcField label="Levier (x1 = sans levier, ex: Binance spot)" value={leverage} onChange={setLeverage} placeholder="ex: 2" />
      <CalcField label="Prix d'entrée" value={entry} onChange={setEntry} placeholder="ex: 4346.55" />
      <CalcField label="Stop-loss" value={stop} onChange={setStop} placeholder="ex: 4300.00" />
      <CalcField label="Take-profit (optionnel)" value={takeProfit} onChange={setTakeProfit} placeholder="ex: 4420.00" />

      {valid ? (
        <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 16, marginTop: 8 }}>
          <div style={{ marginBottom: 12, paddingBottom: 12, borderBottom: `1px solid ${LINE}` }}>
            <div style={{ fontSize: 12, color: ACCENT, fontWeight: 700, textTransform: "uppercase", letterSpacing: 0.5, marginBottom: 6 }}>
              À saisir sur Capital.com / Binance
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 13, color: MUTED }}>Taille</span>
              <span style={{ fontSize: 16, fontWeight: 700, color: ACCENT }}>{quantity.toFixed(6)}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
              <span style={{ fontSize: 13, color: MUTED }}>Stop loss — Niveau de prix</span>
              <span style={{ fontSize: 14, fontWeight: 700 }}>{s}</span>
            </div>
            <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 6 }}>
              <span style={{ fontSize: 11, color: MUTED }}>Distance</span>
              <span style={{ fontSize: 12, color: MUTED }}>
                {distance.toFixed(2)} ({distancePct.toFixed(2)}%)
              </span>
            </div>
            {tp > 0 && (
              <>
                <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
                  <span style={{ fontSize: 13, color: MUTED }}>Take-profit — Niveau de prix</span>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>{tp}</span>
                </div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span style={{ fontSize: 11, color: MUTED }}>Distance</span>
                  <span style={{ fontSize: 12, color: MUTED }}>
                    {gainDistance.toFixed(2)} ({gainDistancePct.toFixed(2)}%)
                  </span>
                </div>
              </>
            )}
          </div>

          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: MUTED }}>Taille totale de la position</span>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{positionValue.toFixed(2)} €</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: MUTED }}>Marge requise</span>
            <span style={{ fontSize: 14, fontWeight: 700 }}>{inv.toFixed(2)} €</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: MUTED }}>Perte si stop touché</span>
            <span style={{ fontSize: 14, fontWeight: 700, color: NEG }}>
              -{lossAmount.toFixed(2)} € ({lossPctOfInvested.toFixed(0)}% de ta mise)
            </span>
          </div>
          {gainAmount !== null && (
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              <span style={{ fontSize: 13, color: MUTED }}>Gain si take-profit touché</span>
              <span style={{ fontSize: 14, fontWeight: 700, color: POS }}>+{gainAmount.toFixed(2)} €</span>
            </div>
          )}
          {lossPctOfInvested > 100 && (
            <div style={{ fontSize: 11, color: NEG, marginTop: 10 }}>
              ⚠️ La perte potentielle dépasse ta mise de départ — avec ce levier, ta position peut être liquidée avant que le stop ne soit atteint. Réduis le levier ou resserre le stop.
            </div>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>Remplis montant, levier, entrée et stop-loss pour voir le calcul.</div>
      )}
    </div>
  );
}

// ================= App =================
export default function TradingApp() {
  const [tab, setTab] = useState("scan");
  const [prefillPrix, setPrefillPrix] = useState(null);
  const [prefillCalc, setPrefillCalc] = useState(null);

  const tabs = [
    { id: "scan", label: "Scanner", icon: Search },
    { id: "prix", label: "Prix & Niveaux", icon: LineChart },
    { id: "dossier", label: "Dossier", icon: FileText },
    { id: "calc", label: "Calculateur", icon: Calculator },
  ];

  return (
    <div style={{ minHeight: "100vh", background: NAVY, color: TEXT, padding: "28px 18px 60px" }}>
      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .spin { animation: spin 0.8s linear infinite; }
      `}</style>

      <div style={{ maxWidth: 480, margin: "0 auto" }}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ fontSize: 12, color: ACCENT, letterSpacing: 1.5, textTransform: "uppercase", fontWeight: 700, marginBottom: 4 }}>
            Discipline de trading
          </div>
          <div style={{ fontSize: 24, fontWeight: 700 }}>Scanner, analyse &amp; calculateur</div>
        </div>

        <div style={{ display: "flex", gap: 4, marginBottom: 20, borderBottom: `1px solid ${LINE}`, paddingBottom: 4, flexWrap: "wrap" }}>
          {tabs.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 6,
                background: "none",
                border: "none",
                color: tab === id ? TEXT : MUTED,
                fontWeight: tab === id ? 700 : 500,
                fontSize: 13,
                padding: "8px 10px",
                borderBottom: tab === id ? `2px solid ${ACCENT}` : "2px solid transparent",
                cursor: "pointer",
              }}
            >
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        {tab === "scan" && (
          <Scanner
            onPick={(r) => {
              setPrefillPrix(r);
              setTab("prix");
            }}
          />
        )}
        {tab === "prix" && (
          <PrixNiveaux prefill={prefillPrix} setTab={setTab} setPrefillCalc={setPrefillCalc} />
        )}
        {tab === "dossier" && (
          <Dossier setTab={setTab} setPrefillCalc={setPrefillCalc} />
        )}
        {tab === "calc" && <Calculateur prefill={prefillCalc} />}
      </div>
    </div>
  );
}
