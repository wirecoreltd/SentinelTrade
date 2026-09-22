// ============================================================
// DISPLACEMENT ENGINE
// ============================================================

export function detectDisplacement(history = [], atr = null) {
  if (!Array.isArray(history) || history.length < 5 || !atr) {
    return {
      detected: false,
      direction: null,
      ratio: null,
      score: 0,
      reasons: [],
      warnings: ["Insufficient data for displacement"],
    };
  }

  const last = history[history.length - 1];

  const range = Number(last.high) - Number(last.low);

  if (!Number.isFinite(range) || atr <= 0) {
    return {
      detected: false,
      direction: null,
      ratio: null,
      score: 0,
      reasons: [],
      warnings: [],
    };
  }

  const ratio = range / atr;

  const bullish = last.close > last.open;
  const bearish = last.close < last.open;

  let score = 0;
  const reasons = [];

  if (ratio >= 1.5) {
    score = 70;
    reasons.push(`Strong displacement (${ratio.toFixed(2)} ATR)`);
  } else if (ratio >= 1.2) {
    score = 45;
    reasons.push(`Moderate displacement (${ratio.toFixed(2)} ATR)`);
  }

  if (score > 0) {
    score += 30;
  }

  return {
    detected: score > 0,
    direction: bullish ? "bullish" : bearish ? "bearish" : "neutral",
    ratio,
    score: Math.min(score, 100),
    reasons,
    warnings: [],
  };
}

export default detectDisplacement;
