// ============================================================
// ORDER BLOCK ENGINE
// Détection des blocs d'ordres (dernière bougie opposée avant
// un déplacement fort) — fraîcheur, invalidation, force de zone
// ============================================================

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

export function detectOrderBlocks(history = [], options = {}) {
  const lookback = options.lookback ?? 40;
  const minDisplacementATR = options.minDisplacementATR ?? 1.2;
  const atr = options.atr ?? null;

  if (!Array.isArray(history) || history.length < 6) {
    return {
      bullish: [],
      bearish: [],
      active: null,
      score: 0,
      reasons: [],
      warnings: ["Pas assez de bougies pour l'analyse des Order Blocks"],
    };
  }

  const candles = history.slice(-lookback);
  const n = candles.length;
  const bullishOBs = [];
  const bearishOBs = [];

  for (let i = 1; i < n - 1; i++) {
    const obCandle = candles[i - 1];
    const moveCandle = candles[i];

    if (!isNum(obCandle.open) || !isNum(obCandle.close) || !isNum(moveCandle.open) || !isNum(moveCandle.close)) continue;

    const moveRange = Math.abs(moveCandle.close - moveCandle.open);
    const refAtr = atr ?? moveRange; // fallback si pas d'ATR fourni au moteur
    const isDisplacement = refAtr > 0 && moveRange / refAtr >= minDisplacementATR;

    // Bullish OB : dernière bougie baissière avant un mouvement haussier fort
    const obIsBearishCandle = obCandle.close < obCandle.open;
    const moveIsBullish = moveCandle.close > moveCandle.open;
    if (obIsBearishCandle && moveIsBullish && isDisplacement) {
      bullishOBs.push({
        index: i - 1,
        top: obCandle.open,
        bottom: obCandle.close,
        displacementRatio: refAtr > 0 ? moveRange / refAtr : null,
      });
    }

    // Bearish OB : dernière bougie haussière avant un mouvement baissier fort
    const obIsBullishCandle = obCandle.close > obCandle.open;
    const moveIsBearish = moveCandle.close < moveCandle.open;
    if (obIsBullishCandle && moveIsBearish && isDisplacement) {
      bearishOBs.push({
        index: i - 1,
        top: obCandle.close,
        bottom: obCandle.open,
        displacementRatio: refAtr > 0 ? moveRange / refAtr : null,
      });
    }
  }

  // Un OB est invalidé si le prix a clôturé au-delà de sa zone opposée après coup
  function isInvalidated(ob, direction) {
    for (let j = ob.index + 2; j < n; j++) {
      const c = candles[j];
      if (!isNum(c.close)) continue;
      if (direction === "bullish" && c.close < ob.bottom) return true;
      if (direction === "bearish" && c.close > ob.top) return true;
    }
    return false;
  }

  const freshBullish = bullishOBs
    .map((ob) => ({ ...ob, invalidated: isInvalidated(ob, "bullish"), freshness: n - 1 - ob.index }))
    .filter((ob) => !ob.invalidated);

  const freshBearish = bearishOBs
    .map((ob) => ({ ...ob, invalidated: isInvalidated(ob, "bearish"), freshness: n - 1 - ob.index }))
    .filter((ob) => !ob.invalidated);

  const lastPrice = candles[n - 1].close;

  function closest(list) {
    if (list.length === 0) return null;
    return list.reduce((best, ob) => {
      const mid = (ob.top + ob.bottom) / 2;
      const dist = Math.abs(lastPrice - mid);
      const bestMid = (best.top + best.bottom) / 2;
      const bestDist = Math.abs(lastPrice - bestMid);
      return dist < bestDist ? ob : best;
    });
  }

  const activeBullish = closest(freshBullish);
  const activeBearish = closest(freshBearish);

  let active = null;
  if (activeBullish && activeBearish) {
    const distBull = Math.abs(lastPrice - (activeBullish.top + activeBullish.bottom) / 2);
    const distBear = Math.abs(lastPrice - (activeBearish.top + activeBearish.bottom) / 2);
    active = distBull <= distBear ? { type: "bullish", ...activeBullish } : { type: "bearish", ...activeBearish };
  } else if (activeBullish) {
    active = { type: "bullish", ...activeBullish };
  } else if (activeBearish) {
    active = { type: "bearish", ...activeBearish };
  }

  let score = 0;
  const reasons = [];

  if (active) {
    score += 40;
    reasons.push(`Order Block ${active.type === "bullish" ? "haussier" : "baissier"} frais détecté`);
    if (active.displacementRatio != null && active.displacementRatio >= 2) {
      score += 30;
      reasons.push("Déplacement fort à l'origine du bloc (zone forte)");
    } else {
      score += 15;
    }
    if (active.freshness <= 5) {
      score += 30;
      reasons.push("Zone récente, non retestée");
    } else if (active.freshness <= 15) {
      score += 15;
    }
  }

  return {
    bullish: freshBullish,
    bearish: freshBearish,
    active,
    score: Math.min(score, 100),
    reasons,
    warnings: [],
  };
}

export default detectOrderBlocks;
