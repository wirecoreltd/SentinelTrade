// ============================================================
// FAIR VALUE GAP ENGINE
// ============================================================

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function detectFVG(history = []) {
  if (!Array.isArray(history) || history.length < 3) {
    return {
      bullish: [],
      bearish: [],
      active: null,
      score: 0,
      reasons: [],
      warnings: ["Not enough candles for FVG analysis"],
    };
  }

  const bullish = [];
  const bearish = [];

  for (let i = 2; i < history.length; i++) {
    const c1 = history[i - 2];
    const c2 = history[i - 1];
    const c3 = history[i];

    if (
      !isNum(c1.high) ||
      !isNum(c1.low) ||
      !isNum(c3.high) ||
      !isNum(c3.low)
    ) {
      continue;
    }

    // Bullish FVG:
    // low de la 3e bougie > high de la 1re
    if (c3.low > c1.high) {
      bullish.push({
        index: i,
        top: c3.low,
        bottom: c1.high,
        size: c3.low - c1.high,
        midpoint: (c3.low + c1.high) / 2,
      });
    }

    // Bearish FVG:
    // high de la 3e bougie < low de la 1re
    if (c3.high < c1.low) {
      bearish.push({
        index: i,
        top: c1.low,
        bottom: c3.high,
        size: c1.low - c3.high,
        midpoint: (c1.low + c3.high) / 2,
      });
    }
  }

  const activeBullish = bullish[bullish.length - 1] || null;
  const activeBearish = bearish[bearish.length - 1] || null;

  let active = null;

  if (activeBullish && activeBearish) {
    active =
      activeBullish.index > activeBearish.index
        ? {
            type: "bullish",
            ...activeBullish,
          }
        : {
            type: "bearish",
            ...activeBearish,
          };
  } else if (activeBullish) {
    active = {
      type: "bullish",
      ...activeBullish,
    };
  } else if (activeBearish) {
    active = {
      type: "bearish",
      ...activeBearish,
    };
  }

  let score = 0;
  const reasons = [];

  if (active) {
    score += 60;

    reasons.push(
      `${active.type === "bullish" ? "Bullish" : "Bearish"} FVG detected`
    );

    if (active.size > 0) {
      score += 40;
      reasons.push("Valid price imbalance detected");
    }
  }

  return {
    bullish,
    bearish,
    active,
    score: Math.min(score, 100),
    reasons,
    warnings: [],
  };
}

export default detectFVG;
