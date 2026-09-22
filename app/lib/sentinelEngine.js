// ============================================================
// SENTINEL ENGINE V2.1
// Trade Quality Engine
//
// IMPORTANT:
// - Ce moteur ne prédit pas le prix.
// - Il ne génère pas de BUY/SELL.
// - Il mesure uniquement la qualité d'un setup existant.
// - Les données proviennent des calculs déjà présents
//   dans TradingApp.jsx.
//
// V2 : regroupe les facteurs qui mesurent tous "est-ce qu'on est
// en tendance ?" (regime de structure, alignement EMA, DMI) en
// UNE seule famille plafonnée, au lieu de les compter comme 3
// preuves indépendantes. L'ADX (force de tendance) et le BOS/CHOCH
// (changement de structure) restent des familles séparées car ils
// apportent une information réellement distincte.
//
// V2.1 : trois familles retombaient quasi systématiquement à leur
// plancher dans des conditions de marché tout à fait normales
// (pas d'événement structurel du jour, ADX modéré, R:R correct
// mais pas excellent), ce qui empêchait mécaniquement d'atteindre
// VALID même sur de bons setups. Ce n'est pas la logique de ces
// familles qui était fausse, juste leur calibrage :
//   - structureChange partait de 0 et ne récompensait que les jours
//     où un BOS/CHOCH se produit — "rien ne s'est passé aujourd'hui"
//     n'est pourtant pas un défaut du setup, c'est l'état normal du
//     marché la plupart du temps.
//   - trendStrength punissait très fort (2/10) tout ADX < 20, sans
//     palier intermédiaire, alors qu'un marché en range mou (ADX
//     15-20) n'est pas forcément un mauvais setup si le reste
//     confirme.
//   - risk tombait à 0 sous un R:R de 1, ce qui est cohérent, mais
//     écrasait aussi tout ce qui se situait entre 1.0 et 1.5 dans
//     une bande trop large (8/15) et ne laissait rien du tout à un
//     setup légèrement sous 1.0 (souvent le résultat d'un stop un
//     peu prudent, pas d'un setup sans intérêt).
// Le seuil VALID est aussi légèrement abaissé (65 → 58) et la
// tolérance aux warnings assouplie (4 → 6), pour refléter qu'un
// "bon" setup, pas "parfait", doit pouvoir passer VALID.
// ============================================================

const clamp = (value, min = 0, max = 100) =>
  Math.max(min, Math.min(max, value));

const isFiniteNumber = (value) =>
  typeof value === "number" && Number.isFinite(value);

// ------------------------------------------------------------
// 1. DIRECTION SCORE / 15
// (fusion : regime de structure + alignement EMA + DMI)
// ------------------------------------------------------------

function calculateDirectionScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const structure = data?.structure;
  const direction = structure?.direction || structure?.regime;

  if (!structure || !direction) {
    return {
      score: 0,
      max: 15,
      reasons: [],
      warnings: ["Market structure unavailable"],
    };
  }

  // Ancre : la direction structurelle donne jusqu'à 10 points.
  if (direction === "haussier") {
    score += 10;
    reasons.push("Bullish market structure");
  } else if (direction === "baissier") {
    score += 10;
    reasons.push("Bearish market structure");
  } else {
    score += 4;
    warnings.push("Market structure is neutral");
  }

  // Confirmations bornées : EMA et DMI ne peuvent qu'ajouter un bonus de
  // confirmation à la direction déjà donnée par la structure, jamais voter
  // une deuxième fois pour la même conclusion à plein poids.
  const { currentPrice, ema20, ema50, plusDI, minusDI } = data || {};
  let confirmations = 0;
  let possibleConfirmations = 0;

  if (isFiniteNumber(currentPrice) && isFiniteNumber(ema20) && isFiniteNumber(ema50)) {
    possibleConfirmations += 1;
    if (direction === "haussier" && currentPrice > ema20 && ema20 > ema50) {
      confirmations += 1;
    } else if (direction === "baissier" && currentPrice < ema20 && ema20 < ema50) {
      confirmations += 1;
    } else if (
      (direction === "haussier" && ema20 > ema50) ||
      (direction === "baissier" && ema20 < ema50)
    ) {
      confirmations += 0.5;
    } else {
      warnings.push("EMA alignment conflicts with structure");
    }
  }

  if (isFiniteNumber(plusDI) && isFiniteNumber(minusDI)) {
    possibleConfirmations += 1;
    if (
      (direction === "haussier" && plusDI > minusDI) ||
      (direction === "baissier" && minusDI > plusDI)
    ) {
      confirmations += 1;
    } else {
      warnings.push("DMI conflicts with market direction");
    }
  }

  if (possibleConfirmations > 0) {
    const confirmationRatio = confirmations / possibleConfirmations;
    const bonus = Math.round(confirmationRatio * 5);
    score += bonus;
    if (confirmationRatio >= 0.75) {
      reasons.push("EMA and DMI confirm structural direction");
    } else if (confirmationRatio > 0) {
      reasons.push("Partial confirmation from EMA/DMI");
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
// 2. TREND STRENGTH SCORE / 10 (ADX seul — force, pas direction)
//
// V2.1 : ajout d'un palier intermédiaire à 15 pour ne pas punir
// aussi durement un marché en range mou (ADX 15-20) qu'un marché
// franchement plat (ADX < 15) — les deux ne se valent pas.
// ------------------------------------------------------------

function calculateTrendStrengthScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const { adx } = data || {};

  if (isFiniteNumber(adx)) {
    if (adx >= 25) {
      score += 10;
      reasons.push(`Strong trend strength (ADX ${adx.toFixed(1)})`);
    } else if (adx >= 20) {
      score += 7;
      reasons.push(`Moderate trend strength (ADX ${adx.toFixed(1)})`);
    } else if (adx >= 15) {
      score += 5;
      warnings.push(`Mild trend strength (ADX ${adx.toFixed(1)})`);
    } else {
      score += 3;
      warnings.push(`Weak trend strength (ADX ${adx.toFixed(1)})`);
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
// 3. STRUCTURE CHANGE SCORE / 10 (BOS / CHOCH)
//
// V2.1 : part d'un plancher neutre de 4/10 au lieu de 0. L'absence
// de BOS/CHOCH le jour de l'analyse est l'état normal du marché la
// plupart du temps — ce n'est pas un défaut du setup en soi, donc
// ça ne doit pas coûter la quasi-totalité des points de la famille.
// La présence d'un BOS ou d'un CHOCH reste un vrai bonus.
// ------------------------------------------------------------

function calculateStructureChangeScore(data) {
  let score = 4;
  const reasons = [];
  const warnings = [];

  const structure = data?.structure;
  if (!structure) {
    return { score: 0, max: 10, reasons: [], warnings: [] };
  }

  if (structure.bos) {
    score += 4;
    reasons.push("Break of Structure detected");
  }
  if (structure.choch || structure.mss) {
    score += 2;
    reasons.push("Structure change detected");
  }
  if (!structure.bos && !structure.choch && !structure.mss) {
    warnings.push("No recent structural break or reversal");
  }

  return {
    score: clamp(score, 0, 10),
    max: 10,
    reasons,
    warnings,
  };
}

// ------------------------------------------------------------
// 4. ENTRY SCORE / 15
// ------------------------------------------------------------

function calculateEntryScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const { breakoutRetest, pullback, meanReversion } = data || {};

  if (breakoutRetest?.active) {
    score += 8;
    reasons.push("Breakout + Retest setup detected");
  }
  if (pullback?.active) {
    score += 6;
    reasons.push("Pullback entry detected");
  }
  if (meanReversion?.active) {
    score += 5;
    reasons.push("Mean reversion condition detected");
  }

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
    // Absence de setup ≠ absence de qualité — les autres familles
    // (direction, structure, R:R...) restent des preuves valables.
    score = Math.min(score, 6);
    warnings.push("No defined entry setup detected");
  }

  return { score: clamp(score, 0, 15), max: 15, reasons, warnings };
}

// ------------------------------------------------------------
// 5. LEVELS / CONFLUENCE SCORE / 15
// ------------------------------------------------------------

function calculateLevelsScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const { currentPrice, support, resistance, pivots, fibRetracement } = data || {};

  if (
    isFiniteNumber(currentPrice) &&
    isFiniteNumber(support) &&
    isFiniteNumber(resistance) &&
    resistance > support
  ) {
    const range = resistance - support;
    const distanceToSupport = Math.abs(currentPrice - support);
    const distanceToResistance = Math.abs(resistance - currentPrice);
    const proximity = Math.min(distanceToSupport / range, distanceToResistance / range);

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

  if (pivots) {
    score += 3;
    reasons.push("Pivot levels available");
  }
  if (fibRetracement) {
    score += 4;
    reasons.push("Fibonacci retracement available");
  }

  return { score: clamp(score, 0, 15), max: 15, reasons, warnings };
}

// ------------------------------------------------------------
// 6. MOMENTUM SCORE / 10
// ------------------------------------------------------------

function calculateMomentumScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const { rsi, macd, structure } = data || {};
  const direction = structure?.direction || structure?.regime;

  if (isFiniteNumber(rsi)) {
    if (direction === "haussier") {
      if (rsi >= 50 && rsi <= 70) { score += 5; reasons.push("RSI supports bullish momentum"); }
      else if (rsi > 70) { score += 2; warnings.push("RSI is overbought"); }
      else { score += 2; }
    } else if (direction === "baissier") {
      if (rsi <= 50 && rsi >= 30) { score += 5; reasons.push("RSI supports bearish momentum"); }
      else if (rsi < 30) { score += 2; warnings.push("RSI is oversold"); }
      else { score += 2; }
    }
  }

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

  return { score: clamp(score, 0, 10), max: 10, reasons, warnings };
}

// ------------------------------------------------------------
// 7. VOLATILITY SCORE / 10
// ------------------------------------------------------------

function calculateVolatilityScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const { atr, atrAvg, volatilityRegime } = data || {};

  if (isFiniteNumber(atr) && isFiniteNumber(atrAvg) && atrAvg > 0) {
    const ratio = atr / atrAvg;
    if (ratio >= 0.75 && ratio <= 1.25) { score += 7; reasons.push("Normal volatility conditions"); }
    else if (ratio < 0.75) { score += 5; reasons.push("Low volatility conditions"); }
    else if (ratio <= 1.5) { score += 4; warnings.push("Elevated volatility"); }
    else { score += 1; warnings.push("Very high volatility"); }
  }

  if (volatilityRegime) {
    if (volatilityRegime === "normal" || volatilityRegime === "modérée") {
      score += 3;
      reasons.push("Volatility regime is suitable");
    } else if (volatilityRegime === "high" || volatilityRegime === "élevée") {
      score += 1;
      warnings.push("High volatility regime");
    }
  }

  return { score: clamp(score, 0, 10), max: 10, reasons, warnings };
}

// ------------------------------------------------------------
// 8. RISK SCORE / 15
//
// V2.1 : ajout de paliers intermédiaires entre 1.0 et 2.0 (au lieu
// d'un seul palier 1.0-1.5 à 8pts), et un plancher de 1pt sous un
// R:R de 1 au lieu de 0 — un setup avec un R:R légèrement sous 1
// (souvent dû à un stop un peu prudent) reste une information,
// pas une disqualification totale de la famille.
// ------------------------------------------------------------

function calculateRiskScore(data) {
  let score = 0;
  const reasons = [];
  const warnings = [];

  const riskReward = data?.riskReward;
  if (!riskReward) {
    return { score: 3, max: 15, reasons: [], warnings: ["Risk/Reward not available"] };
  }

  const ratio = riskReward.ratio;
  if (!isFiniteNumber(ratio)) {
    return { score: 3, max: 15, reasons: [], warnings: ["Invalid Risk/Reward ratio"] };
  }

  if (ratio >= 3) { score += 15; reasons.push(`Excellent Risk/Reward 1:${ratio.toFixed(1)}`); }
  else if (ratio >= 2) { score += 12; reasons.push(`Good Risk/Reward 1:${ratio.toFixed(1)}`); }
  else if (ratio >= 1.5) { score += 10; reasons.push(`Acceptable Risk/Reward 1:${ratio.toFixed(1)}`); }
  else if (ratio >= 1.2) { score += 7; reasons.push(`Modest Risk/Reward 1:${ratio.toFixed(1)}`); }
  else if (ratio >= 1) { score += 4; warnings.push(`Low Risk/Reward 1:${ratio.toFixed(1)}`); }
  else { score += 1; warnings.push(`Poor Risk/Reward 1:${ratio.toFixed(1)}`); }

  return { score: clamp(score, 0, 15), max: 15, reasons, warnings };
}

// ------------------------------------------------------------
// FINAL SENTINEL SCORE
// ------------------------------------------------------------

export function calculateSentinelScore(data = {}) {
  const direction = calculateDirectionScore(data);
  const trendStrength = calculateTrendStrengthScore(data);
  const structureChange = calculateStructureChangeScore(data);
  const entry = calculateEntryScore(data);
  const levels = calculateLevelsScore(data);
  const momentum = calculateMomentumScore(data);
  const volatility = calculateVolatilityScore(data);
  const risk = calculateRiskScore(data);

  const total =
    direction.score +
    trendStrength.score +
    structureChange.score +
    entry.score +
    levels.score +
    momentum.score +
    volatility.score +
    risk.score;

  const score = Math.round(clamp(total, 0, 100));

  let bias = "neutral";
  if (data?.structure?.direction === "haussier") bias = "bullish";
  else if (data?.structure?.direction === "baissier") bias = "bearish";
  else if (data?.verdict === "haussier") bias = "bullish";
  else if (data?.verdict === "baissier") bias = "bearish";

  let setup = "none";
  if (bias === "bullish") setup = "long";
  else if (bias === "bearish") setup = "short";

  const warnings = [
    ...direction.warnings,
    ...trendStrength.warnings,
    ...structureChange.warnings,
    ...entry.warnings,
    ...levels.warnings,
    ...momentum.warnings,
    ...volatility.warnings,
    ...risk.warnings,
  ];

  const reasons = [
    ...direction.reasons,
    ...trendStrength.reasons,
    ...structureChange.reasons,
    ...entry.reasons,
    ...levels.reasons,
    ...momentum.reasons,
    ...volatility.reasons,
    ...risk.reasons,
  ];

  // Seuils assouplis : le marché "parfait" (tous les facteurs alignés à la
  // fois) n'existe quasiment jamais. VALID doit signaler un bon setup, pas
  // un setup exceptionnel.
  // V2.1 : seuil VALID abaissé (65 → 58) et tolérance aux warnings élargie
  // (4 → 6), cohérent avec les paliers assouplis ci-dessus — sans ça, les
  // familles rééquilibrées auraient continué à buter sur un seuil calibré
  // pour l'ancien barème, plus dur.
  let status = "AVOID";
  if (score >= 58 && warnings.length <= 6) status = "VALID";
  else if (score >= 40) status = "WAIT";

  return {
    score,
    bias,
    setup,
    status,
    breakdown: {
      direction,
      trendStrength,
      structureChange,
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
