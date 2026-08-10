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
  Settings,
  ChevronDown,
  ChevronUp,
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

async function fetchAlphaQuote(symbol, key) {
  const res = await fetch(
    `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${symbol}&apikey=${key}`
  );
  const data = await res.json();
  const q = data["Global Quote"];
  if (!q || !q["05. price"]) {
    throw new Error(
      data?.Note ? "Quota Alpha Vantage atteint (25/jour) — réessaie plus tard" : "Symbole introuvable"
    );
  }
  return {
    price: parseFloat(q["05. price"]),
    change24h: parseFloat(q["10. change percent"]),
  };
}

async function fetchAlphaHistory(symbol, key) {
  const res = await fetch(
    `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${symbol}&apikey=${key}&outputsize=compact`
  );
  const data = await res.json();
  const series = data["Time Series (Daily)"];
  if (!series) {
    throw new Error(
      data?.Note ? "Quota Alpha Vantage atteint (25/jour) — réessaie plus tard" : "Historique indisponible"
    );
  }
  return Object.entries(series)
    .map(([date, v]) => ({ date, close: parseFloat(v["4. close"]) }))
    .sort((a, b) => new Date(a.date) - new Date(b.date));
}

async function fetchNewsSentiment(query, key) {
  const res = await fetch(
    `/api/news?q=${encodeURIComponent(query)}&apikey=${encodeURIComponent(key)}`
  );
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
function PrixNiveaux({ prefill, alphaKey, setTab, setPrefillCalc }) {
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
      } else {
        if (!alphaKey) throw new Error("Colle ta clé Alpha Vantage ci-dessus (⚙️ Paramètres)");
        const [price, history] = await Promise.all([
          fetchAlphaQuote(q.toUpperCase(), alphaKey),
          fetchAlphaHistory(q.toUpperCase(), alphaKey),
        ]);
        const { support, resistance } = supportResistance(history);
        setResult({ ...price, support, resistance, symbol: q.toUpperCase() });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [alphaKey]);

  useEffect(() => {
    if (prefill?.query) runSearch(prefill.type, prefill.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefill]);

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
        {["crypto", "stock"].map((t) => (
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
            {t === "crypto" ? "Crypto" : "Action / Forex / Or"}
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
          placeholder={type === "crypto" ? "ex: bitcoin" : "ex: TSLA"}
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
          <button
            onClick={() => {
              setPrefillCalc({ entry: result.price, stop: result.support });
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
function Dossier({ alphaKey, newsKey, setTab, setPrefillCalc }) {
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
      } else {
        if (!alphaKey) throw new Error("Colle ta clé Alpha Vantage ci-dessus (⚙️ Paramètres)");
        const sym = query.toUpperCase();
        [price, history] = await Promise.all([
          fetchAlphaQuote(sym, alphaKey),
          fetchAlphaHistory(sym, alphaKey),
        ]);
      }

      const t7 = trendFromHistory(history, 7);
      const t30 = trendFromHistory(history, 30);
      const t90 = trendFromHistory(history, 90);
      const { support, resistance } = supportResistance(
        history.filter((h) => new Date(h.date).getTime() >= Date.now() - 30 * 86400000)
      );

      let news = null;
      let newsError = "";
      if (newsKey) {
        try {
          news = await fetchNewsSentiment(query, newsKey);
        } catch (e) {
          newsError = e.message;
        }
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
        `Support 30j : $${support.toFixed(2)} — Résistance 30j : $${resistance.toFixed(2)}`,
        news
          ? `Actualités : ton ${news.label} sur ${news.articleCount} articles récents`
          : newsError
          ? `Actualités indisponibles : ${newsError}`
          : "Actualités non incluses (clé NewsData.io non renseignée)",
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
        {["crypto", "stock"].map((t) => (
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
            {t === "crypto" ? "Crypto" : "Action / Forex / Or"}
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
          placeholder={type === "crypto" ? "ex: bitcoin" : "ex: TSLA"}
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
              setPrefillCalc({
                entry: dossier.price,
                stop: dossier.verdict === "baissier" ? dossier.resistance : dossier.support,
              });
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
function Calculateur({ prefill }) {
  const [balance, setBalance] = useState("");
  const [riskPct, setRiskPct] = useState("1");
  const [entry, setEntry] = useState(prefill?.entry?.toString() || "");
  const [stop, setStop] = useState(prefill?.stop?.toString() || "");

  useEffect(() => {
    if (prefill?.entry) setEntry(prefill.entry.toString());
    if (prefill?.stop) setStop(prefill.stop.toString());
  }, [prefill]);

  const b = parseFloat(balance);
  const r = parseFloat(riskPct);
  const e = parseFloat(entry);
  const s = parseFloat(stop);

  const valid = b > 0 && r > 0 && e > 0 && s > 0 && e !== s;
  const riskAmount = valid ? (b * r) / 100 : null;
  const distance = valid ? Math.abs(e - s) : null;
  const positionSize = valid ? riskAmount / distance : null;

  const Field = ({ label, value, onChange, placeholder }) => (
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

  return (
    <div>
      <Field label="Capital du compte ($)" value={balance} onChange={setBalance} placeholder="ex: 5000" />
      <Field label="Risque par trade (%)" value={riskPct} onChange={setRiskPct} placeholder="ex: 1" />
      <Field label="Prix d'entrée ($)" value={entry} onChange={setEntry} placeholder="ex: 4346.55" />
      <Field label="Stop-loss ($)" value={stop} onChange={setStop} placeholder="ex: 4300.00" />

      {valid ? (
        <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 12, padding: 16, marginTop: 8 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: MUTED }}>Montant risqué</span>
            <span style={{ fontSize: 14, fontWeight: 700 }}>${riskAmount.toFixed(2)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
            <span style={{ fontSize: 13, color: MUTED }}>Distance au stop</span>
            <span style={{ fontSize: 14, fontWeight: 700 }}>${distance.toFixed(2)}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", paddingTop: 10, borderTop: `1px solid ${LINE}` }}>
            <span style={{ fontSize: 13, color: ACCENT, fontWeight: 600 }}>Taille de position</span>
            <span style={{ fontSize: 18, fontWeight: 700, color: ACCENT }}>{positionSize.toFixed(4)} unités</span>
          </div>
        </div>
      ) : (
        <div style={{ fontSize: 12, color: MUTED, marginTop: 8 }}>Remplis les 4 champs pour voir le calcul.</div>
      )}
    </div>
  );
}

// ================= Paramètres (clés API) =================
function Parametres({ alphaKey, setAlphaKey, newsKey, setNewsKey }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 16, border: `1px solid ${LINE}`, borderRadius: 10, overflow: "hidden" }}>
      <button
        onClick={() => setOpen(!open)}
        style={{
          width: "100%",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          background: PANEL,
          border: "none",
          padding: "10px 12px",
          color: TEXT,
          cursor: "pointer",
        }}
      >
        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, fontWeight: 600 }}>
          <Settings size={14} /> Paramètres (clés API)
        </span>
        {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
      </button>
      {open && (
        <div style={{ padding: 12, background: NAVY }}>
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>
            Clé Alpha Vantage (actions/forex/or) — alphavantage.co/support/#api-key
          </div>
          <input
            value={alphaKey}
            onChange={(e) => setAlphaKey(e.target.value)}
            placeholder="Colle ta clé ici"
            style={{ width: "100%", background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 10px", color: TEXT, fontSize: 13, marginBottom: 10 }}
          />
          <div style={{ fontSize: 12, color: MUTED, marginBottom: 4 }}>
            Clé NewsData.io (sentiment actus) — newsdata.io/register
          </div>
          <input
            value={newsKey}
            onChange={(e) => setNewsKey(e.target.value)}
            placeholder="Colle ta clé ici (optionnel)"
            style={{ width: "100%", background: PANEL, border: `1px solid ${LINE}`, borderRadius: 8, padding: "9px 10px", color: TEXT, fontSize: 13 }}
          />
          <div style={{ fontSize: 11, color: MUTED, marginTop: 8 }}>
            Les clés sont sauvegardées uniquement dans ton navigateur (localStorage), jamais envoyées ailleurs qu'aux fournisseurs concernés.
          </div>
        </div>
      )}
    </div>
  );
}

// ================= App =================
export default function TradingApp() {
  const [tab, setTab] = useState("scan");
  const [prefillPrix, setPrefillPrix] = useState(null);
  const [prefillCalc, setPrefillCalc] = useState(null);
  const [alphaKey, setAlphaKey] = useState("");
  const [newsKey, setNewsKey] = useState("");

  useEffect(() => {
    setAlphaKey(localStorage.getItem("alphaKey") || "");
    setNewsKey(localStorage.getItem("newsKey") || "");
  }, []);
  useEffect(() => {
    localStorage.setItem("alphaKey", alphaKey);
  }, [alphaKey]);
  useEffect(() => {
    localStorage.setItem("newsKey", newsKey);
  }, [newsKey]);

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

        <Parametres alphaKey={alphaKey} setAlphaKey={setAlphaKey} newsKey={newsKey} setNewsKey={setNewsKey} />

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
          <PrixNiveaux prefill={prefillPrix} alphaKey={alphaKey} setTab={setTab} setPrefillCalc={setPrefillCalc} />
        )}
        {tab === "dossier" && (
          <Dossier alphaKey={alphaKey} newsKey={newsKey} setTab={setTab} setPrefillCalc={setPrefillCalc} />
        )}
        {tab === "calc" && <Calculateur prefill={prefillCalc} />}
      </div>
    </div>
  );
}
