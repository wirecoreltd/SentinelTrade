// ============================================================
// CONFLUENCE ENGINE
// Aligne Liquidity / FVG / Displacement / Order Block sur une
// direction commune. Ne calcule PAS de score arbitraire pondéré :
// il compte les moteurs d'accord et liste les raisons.
// Le poids réel sur le verdict sera décidé plus tard, à partir
// du journal de signaux, pas ici.
// ============================================================

function directionOf(result, kind) {
  if (!result) return null;
  if (kind === "liquidity") {
    if (result.sweep) return result.sweep.direction; // "bullish" | "bearish"
    return null;
  }
  if (kind === "fvg") {
    return result.active ? result.active.type : null; // "bullish" | "bearish"
  }
  if (kind === "displacement") {
    return result.detected ? result.direction : null;
  }
  if (kind === "orderBlock") {
    return result.active ? result.active.type : null;
  }
  return null;
}

export function computeConfluence({ liquidity, fvg, displacement, orderBlock } = {}) {
  const parts = [
    { key: "liquidity", label: "Liquidité", result: liquidity, kind: "liquidity" },
    { key: "fvg", label: "Fair Value Gap", result: fvg, kind: "fvg" },
    { key: "displacement", label: "Displacement", result: displacement, kind: "displacement" },
    { key: "orderBlock", label: "Order Block", result: orderBlock, kind: "orderBlock" },
  ];

  const directions = parts.map((p) => ({ ...p, direction: directionOf(p.result, p.kind) }));

  const bullishVotes = directions.filter((d) => d.direction === "bullish");
  const bearishVotes = directions.filter((d) => d.direction === "bearish");
  const activeVotes = directions.filter((d) => d.direction != null);

  let bias = "neutre";
  if (bullishVotes.length > bearishVotes.length) bias = "haussier";
  else if (bearishVotes.length > bullishVotes.length) bias = "baissier";

  const agreement = activeVotes.length > 0
    ? Math.max(bullishVotes.length, bearishVotes.length) / activeVotes.length
    : 0;

  const reasons = [];
  directions.forEach((d) => {
    if (d.direction) {
      reasons.push(`${d.label} : signal ${d.direction === "bullish" ? "haussier" : "baissier"}`);
    }
  });

  const warnings = [];
  if (activeVotes.length === 0) {
    warnings.push("Aucun des 4 moteurs SMC n'a produit de signal directionnel sur cette fenêtre");
  } else if (bullishVotes.length > 0 && bearishVotes.length > 0) {
    warnings.push("Signaux SMC contradictoires entre moteurs — confluence faible");
  }

  return {
    bias, // "haussier" | "baissier" | "neutre" — INDICATIF, ne pilote rien pour l'instant
    activeCount: activeVotes.length, // sur 4
    bullishCount: bullishVotes.length,
    bearishCount: bearishVotes.length,
    agreementRatio: agreement, // 0 à 1
    details: directions.map((d) => ({ key: d.key, label: d.label, direction: d.direction })),
    reasons,
    warnings,
    raw: { liquidity, fvg, displacement, orderBlock },
  };
}

export default computeConfluence;
