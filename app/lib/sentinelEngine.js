// ============================================================
// SENTINEL ENGINE V1
// Trade Quality Engine
//
// IMPORTANT:
// - Ce moteur ne prédit pas le prix.
// - Il ne génère pas de BUY/SELL.
// - Il mesure uniquement la qualité d'un setup existant.
// - Les données proviennent des calculs déjà présents
//   dans TradingApp.jsx.
// ============================================================

const clamp = (value, min = 0, max = 100) =>
  Math.max(min, Math.min(max, value));

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

const normalizeScore = (value, max) =>
  max <= 0 ? 0 : clamp((value / max) * 100);

// ------------------------------------------------------------
// 1. STRUCTURE SCORE / 20
// ------------------------------------------------------------

function calculateStructureScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const structure = data?.structure;

  if (!structure) {
    return {
      score: 0,
      max: 20,
      reasons: [],
      warnings: ["Market structure unavailable"],
    };
  }

  const direction = structure.regime;
  const regime = structure.regime;

  // Structure directionnelle
  if (direction === "haussier" || regime === "haussier") {
    score += 10;
    reasons.push("Bullish market structure");
  } else if (direction === "baissier" || regime === "baissier") {
    score += 10;
    reasons.push("Bearish market structure");
  } else {
    score += 4;
    warnings.push("Market structure is neutral");
  }

  // BOS
  if (structure.bos) {
    score += 5;
    reasons.push("Break of Structure detected");
  }

  // CHOCH / MSS
  if (structure.choch || structure.mss) {
    score += 5;
    reasons.push("Structure change detected");
  } else if (structure.bos) {
    // Si BOS existe mais pas de CHOCH, on conserve la qualité
    score += 0;
  }

  return {
    score: clamp(score, 0, 20),
    max: 20,
    reasons,
    warnings,
  };
}

// ------------------------------------------------------------
// 2. TREND SCORE / 15
// ------------------------------------------------------------

function calculateTrendScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const {
    currentPrice,
    ema20,
    ema50,
    adx,
    plusDI,
    minusDI,
    structure,
  } = data || {};

  const direction = structure?.direction || structure?.regime;

  // EMA alignment — même règle que le moteur principal (prix + EMA20 + EMA50)
  if (isFiniteNumber(currentPrice) && isFiniteNumber(ema20) && isFiniteNumber(ema50)) {
    if (direction === "haussier" && currentPrice > ema20 && ema20 > ema50) {
      score += 5;
      reasons.push("Price above EMA20, EMA20 above EMA50 (full alignment)");
    } else if (direction === "baissier" && currentPrice < ema20 && ema20 < ema50) {
      score += 5;
      reasons.push("Price below EMA20, EMA20 below EMA50 (full alignment)");
    } else if (
      (direction === "haussier" && ema20 > ema50) ||
      (direction === "baissier" && ema20 < ema50)
    ) {
      score += 2;
      warnings.push("EMA order confirms trend but current price has diverged from EMA20");
    } else {
      score += 1;
      warnings.push("EMA alignment conflicts with structure");
    }
  }

  // ADX = force de tendance, pas direction
  if (isFiniteNumber(adx)) {
    if (adx >= 25) {
      score += 5;
      reasons.push(`Strong trend strength (ADX ${adx.toFixed(1)})`);
    } else if (adx >= 20) {
      score += 3;
      reasons.push(`Moderate trend strength (ADX ${adx.toFixed(1)})`);
    } else {
      score += 1;
      warnings.push(`Weak trend strength (ADX ${adx.toFixed(1)})`);
    }
  }

  // DMI alignment
  if (isFiniteNumber(plusDI) && isFiniteNumber(minusDI)) {
    if (
      (direction === "haussier" && plusDI > minusDI) ||
      (direction === "baissier" && minusDI > plusDI)
    ) {
      score += 5;
      reasons.push("DMI confirms market direction");
    } else {
      score += 1;
      warnings.push("DMI conflicts with market direction");
    }
  }

  return {
    score: clamp(score, 0, 15),
    max: 15,
    reasons,
    warnings,
  };
}

// ------------------------------------------------------------
// 3. ENTRY SCORE / 15
// ------------------------------------------------------------

function calculateEntryScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const {
    breakoutRetest,
    pullback,
    meanReversion,
  } = data || {};

  // Breakout + Retest = meilleure confirmation
  if (breakoutRetest?.active) {
    score += 8;
    reasons.push("Breakout + Retest setup detected");
  }

  // Pullback
  if (pullback?.active) {
    score += 6;
    reasons.push("Pullback entry detected");
  }

  // Mean reversion
  if (meanReversion?.active) {
    score += 5;
    reasons.push("Mean reversion condition detected");
  }

  // Si plusieurs conditions existent, bonus de confluence,
  // sans dépasser 15.
  const activeSetups = [
    breakoutRetest?.active,
    pullback?.active,
    meanReversion?.active,
  ].filter(Boolean).length;

  if (activeSetups >= 2) {
    score += 2;
    reasons.push("Multiple entry conditions agree");
  }

  if (activeSetups === 0) {
    score = 3;
    warnings.push("No defined entry setup detected");
  }

  return {
    score: clamp(score, 0, 15),
    max: 15,
    reasons,
    warnings,
  };
}

// ------------------------------------------------------------
// 4. LEVELS / CONFLUENCE SCORE / 15
// ------------------------------------------------------------

function calculateLevelsScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const {
    currentPrice,
    support,
    resistance,
    pivots,
    fibRetracement,
  } = data || {};

  if (
    isFiniteNumber(currentPrice) &&
    isFiniteNumber(support) &&
    isFiniteNumber(resistance) &&
    resistance > support
  ) {
    const range = resistance - support;
    const distanceToSupport = Math.abs(currentPrice - support);
    const distanceToResistance = Math.abs(resistance - currentPrice);

    const proximity = Math.min(
      distanceToSupport / range,
      distanceToResistance / range
    );

    if (proximity <= 0.15) {
      score += 8;
      reasons.push("Price is close to a structural level");
    } else if (proximity <= 0.30) {
      score += 5;
      reasons.push("Price has reasonable proximity to a structural level");
    } else {
      score += 2;
      warnings.push("Price is far from major support/resistance");
    }
  }

  // Pivot disponible
  if (pivots) {
    score += 3;
    reasons.push("Pivot levels available");
  }

  // Fibonacci disponible
  if (fibRetracement) {
    score += 4;
    reasons.push("Fibonacci retracement available");
  }

  return {
    score: clamp(score, 0, 15),
    max: 15,
    reasons,
    warnings,
  };
}

// ------------------------------------------------------------
// 5. MOMENTUM SCORE / 10
// ------------------------------------------------------------

function calculateMomentumScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const {
    rsi,
    macd,
    structure,
  } = data || {};

  const direction = structure?.direction || structure?.regime;

  // RSI
  if (isFiniteNumber(rsi)) {
    if (direction === "haussier") {
      if (rsi >= 50 && rsi <= 70) {
        score += 5;
        reasons.push("RSI supports bullish momentum");
      } else if (rsi > 70) {
        score += 2;
        warnings.push("RSI is overbought");
      } else {
        score += 2;
      }
    } else if (direction === "baissier") {
      if (rsi <= 50 && rsi >= 30) {
        score += 5;
        reasons.push("RSI supports bearish momentum");
      } else if (rsi < 30) {
        score += 2;
        warnings.push("RSI is oversold");
      } else {
        score += 2;
      }
    }
  }

  // MACD
  if (macd) {
    const histogram = macd.histogram;

    if (isFiniteNumber(histogram)) {
      if (
        (direction === "haussier" && histogram > 0) ||
        (direction === "baissier" && histogram < 0)
      ) {
        score += 5;
        reasons.push("MACD momentum confirms direction");
      } else {
        score += 1;
        warnings.push("MACD momentum conflicts with direction");
      }
    }
  }

  return {
    score: clamp(score, 0, 10),
    max: 10,
    reasons,
    warnings,
  };
}

// ------------------------------------------------------------
// 6. VOLATILITY SCORE / 10
// ------------------------------------------------------------

function calculateVolatilityScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const {
    atr,
    atrAvg,
    volatilityRegime,
  } = data || {};

  if (isFiniteNumber(atr) && isFiniteNumber(atrAvg) && atrAvg > 0) {
    const ratio = atr / atrAvg;

    if (ratio >= 0.75 && ratio <= 1.25) {
      score += 7;
      reasons.push("Normal volatility conditions");
    } else if (ratio < 0.75) {
      score += 5;
      reasons.push("Low volatility conditions");
    } else if (ratio <= 1.5) {
      score += 4;
      warnings.push("Elevated volatility");
    } else {
      score += 1;
      warnings.push("Very high volatility");
    }
  }

  if (volatilityRegime) {
    if (
      volatilityRegime === "normal" ||
      volatilityRegime === "modérée"
    ) {
      score += 3;
      reasons.push("Volatility regime is suitable");
    } else if (
      volatilityRegime === "high" ||
      volatilityRegime === "élevée"
    ) {
      score += 1;
      warnings.push("High volatility regime");
    }
  }

  return {
    score: clamp(score, 0, 10),
    max: 10,
    reasons,
    warnings,
  };
}

// ------------------------------------------------------------
// 7. RISK SCORE / 15
// ------------------------------------------------------------

function calculateRiskScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const riskReward = data?.riskReward;

  if (!riskReward) {
    return {
      score: 3,
      max: 15,
      reasons: [],
      warnings: ["Risk/Reward not available"],
    };
  }

  const ratio = riskReward.ratio;

  if (!isFiniteNumber(ratio)) {
    return {
      score: 3,
      max: 15,
      reasons: [],
      warnings: ["Invalid Risk/Reward ratio"],
    };
  }

  if (ratio >= 3) {
    score += 15;
    reasons.push(`Excellent Risk/Reward 1:${ratio.toFixed(1)}`);
  } else if (ratio >= 2) {
    score += 12;
    reasons.push(`Good Risk/Reward 1:${ratio.toFixed(1)}`);
  } else if (ratio >= 1.5) {
    score += 8;
    reasons.push(`Acceptable Risk/Reward 1:${ratio.toFixed(1)}`);
  } else if (ratio >= 1) {
    score += 4;
    warnings.push(`Low Risk/Reward 1:${ratio.toFixed(1)}`);
  } else {
    score += 0;
    warnings.push(`Poor Risk/Reward 1:${ratio.toFixed(1)}`);
  }

  return {
    score: clamp(score, 0, 15),
    max: 15,
    reasons,
    warnings,
  };
}

// ------------------------------------------------------------
// FINAL SENTINEL SCORE
// ------------------------------------------------------------

export function calculateSentinelScore(data = {}) {
  const structure = calculateStructureScore(data);
  const trend = calculateTrendScore(data);
  const entry = calculateEntryScore(data);
  const levels = calculateLevelsScore(data);
  const momentum = calculateMomentumScore(data);
  const volatility = calculateVolatilityScore(data);
  const risk = calculateRiskScore(data);

  const total =
    structure.score +
    trend.score +
    entry.score +
    levels.score +
    momentum.score +
    volatility.score +
    risk.score;

  const score = Math.round(clamp(total, 0, 100));

  // ----------------------------------------------------------
  // Bias
  // ----------------------------------------------------------

  let bias = "neutral";

  if (data?.structure?.direction === "haussier") {
    bias = "bullish";
  } else if (data?.structure?.direction === "baissier") {
    bias = "bearish";
  } else if (data?.verdict === "haussier") {
    bias = "bullish";
  } else if (data?.verdict === "baissier") {
    bias = "bearish";
  }

  // ----------------------------------------------------------
  // Setup
  // ----------------------------------------------------------

  let setup = "none";

  if (bias === "bullish") {
    setup = "long";
  } else if (bias === "bearish") {
    setup = "short";
  }

  // ----------------------------------------------------------
  // Warnings globales
  // ----------------------------------------------------------

  const warnings = [
    ...structure.warnings,
    ...trend.warnings,
    ...entry.warnings,
    ...levels.warnings,
    ...momentum.warnings,
    ...volatility.warnings,
    ...risk.warnings,
  ];

  const reasons = [
    ...structure.reasons,
    ...trend.reasons,
    ...entry.reasons,
    ...levels.reasons,
    ...momentum.reasons,
    ...volatility.reasons,
    ...risk.reasons,
  ];

  // ----------------------------------------------------------
  // Status
  // ----------------------------------------------------------

  let status = "AVOID";

  if (score >= 75 && warnings.length <= 3) {
    status = "VALID";
  } else if (score >= 55) {
    status = "WAIT";
  }

  return {
    score,
    bias,
    setup,
    status,

    breakdown: {
      structure,
      trend,
      entry,
      levels,
      momentum,
      volatility,
      risk,
    },

    reasons,
    warnings,
  };
}

export default calculateSentinelScore;
