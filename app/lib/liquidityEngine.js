// ============================================================
// LIQUIDITY ENGINE
// Détection des zones de liquidité et des sweeps
// ============================================================

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function detectLiquidity(history = [], options = {}) {
  const lookback = options.lookback ?? 30;
  const tolerancePct = options.tolerancePct ?? 0.0015;

  if (!Array.isArray(history) || history.length < 10) {
    return {
      buySide: [],
      sellSide: [],
      equalHigh: false,
      equalLow: false,
      sweep: null,
      score: 0,
      reasons: [],
      warnings: ["Not enough candles for liquidity analysis"],
    };
  }

  const candles = history.slice(-lookback);

  const highs = candles
    .map((c, i) => ({ price: Number(c.high), index: i }))
    .filter((x) => isNum(x.price));

  const lows = candles
    .map((c, i) => ({ price: Number(c.low), index: i }))
    .filter((x) => isNum(x.price));

  const equalHighs = [];
  const equalLows = [];

  // ----------------------------------------------------------
  // Equal Highs
  // ----------------------------------------------------------

  for (let i = 0; i < highs.length; i++) {
    for (let j = i + 1; j < highs.length; j++) {
      const a = highs[i].price;
      const b = highs[j].price;

      if (Math.abs(a - b) / Math.max(a, b) <= tolerancePct) {
        equalHighs.push({
          price: (a + b) / 2,
          firstIndex: highs[i].index,
          secondIndex: highs[j].index,
        });
      }
    }
  }

  // ----------------------------------------------------------
  // Equal Lows
  // ----------------------------------------------------------

  for (let i = 0; i < lows.length; i++) {
    for (let j = i + 1; j < lows.length; j++) {
      const a = lows[i].price;
      const b = lows[j].price;

      if (Math.abs(a - b) / Math.max(a, b) <= tolerancePct) {
        equalLows.push({
          price: (a + b) / 2,
          firstIndex: lows[i].index,
          secondIndex: lows[j].index,
        });
      }
    }
  }

  const last = candles[candles.length - 1];

  const currentHigh = Number(last.high);
  const currentLow = Number(last.low);
  const currentClose = Number(last.close);

  let sweep = null;

  // ----------------------------------------------------------
  // Liquidity sweep
  // ----------------------------------------------------------

  for (const level of equalHighs) {
    if (
      currentHigh > level.price &&
      currentClose < level.price
    ) {
      sweep = {
        type: "buy_side_sweep",
        level: level.price,
        direction: "bearish",
      };
    }
  }

  for (const level of equalLows) {
    if (
      currentLow < level.price &&
      currentClose > level.price
    ) {
      sweep = {
        type: "sell_side_sweep",
        level: level.price,
        direction: "bullish",
      };
    }
  }

  // ----------------------------------------------------------
  // Score
  // ----------------------------------------------------------

  let score = 0;
  const reasons = [];
  const warnings = [];

  if (equalHighs.length > 0) {
    score += 25;
    reasons.push("Equal highs / buy-side liquidity detected");
  }

  if (equalLows.length > 0) {
    score += 25;
    reasons.push("Equal lows / sell-side liquidity detected");
  }

  if (sweep) {
    score += 50;
    reasons.push(`Liquidity sweep detected: ${sweep.type}`);
  }

  return {
    buySide: equalHighs,
    sellSide: equalLows,

    equalHigh: equalHighs.length > 0,
    equalLow: equalLows.length > 0,

    sweep,

    score: Math.min(score, 100),

    reasons,
    warnings,
  };
}

export default detectLiquidity;
