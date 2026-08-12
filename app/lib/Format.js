// Décimales adaptatives selon l'ordre de grandeur : un prix fixe à 2
// décimales écrase le mouvement réel sur les actifs sous $1 (JPY/USD,
// DOGE, etc.) où tout se joue à la 4e/5e décimale.
export function formatPrice(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const abs = Math.abs(value);
  let decimals;
  if (abs === 0) decimals = 2;
  else if (abs < 0.01) decimals = 6;
  else if (abs < 1) decimals = 4;
  else if (abs < 10) decimals = 3;
  else decimals = 2;
  return value.toLocaleString(undefined, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}
