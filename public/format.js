// Shared by the Mini App (browser) and the engine (server, tests).
const UNITS = ['', 'ألف', 'مليون', 'مليار', 'تريليون', 'كوادريليون', 'كوينتيليون', 'سكستيليون', 'سبتيليون'];
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

/** @param {string} s */
export function toArabicDigits(s) {
  return s.replace(/[0-9]/g, (d) => ARABIC_DIGITS[Number(d)]).replace(/\./g, '٫');
}

/**
 * 1500 -> "١٫٥ ألف", 24800 -> "٢٤٫٨ ألف", 1e6 -> "١ مليون".
 * Values above the last unit fall back to scientific notation.
 * @param {number} n
 * @param {boolean} [arabicDigits]
 * @returns {string}
 */
export function formatNumber(n, arabicDigits = true) {
  const out = (/** @type {string} */ s) => (arabicDigits ? toArabicDigits(s) : s);
  if (!Number.isFinite(n)) return out('0');
  if (n < 0) return '-' + formatNumber(-n, arabicDigits);
  if (n < 1000) return out(String(Math.floor(n)));

  let idx = Math.floor(Math.log10(n) / 3);
  if (idx >= UNITS.length) return out(n.toExponential(2));

  let rounded = Math.round((n / 1000 ** idx) * 10) / 10;
  if (rounded >= 1000 && idx < UNITS.length - 1) {
    idx += 1;
    rounded = Math.round((n / 1000 ** idx) * 10) / 10;
  }
  return `${out(String(rounded))} ${UNITS[idx]}`;
}

/**
 * For income rates: shows one decimal below 10 (0.1 -> "٠٫١"), otherwise same as formatNumber.
 * @param {number} n
 * @param {boolean} [arabicDigits]
 * @returns {string}
 */
export function formatRate(n, arabicDigits = true) {
  if (!Number.isFinite(n) || n >= 10) return formatNumber(n, arabicDigits);
  const s = String(Math.round(Math.max(0, n) * 10) / 10);
  return arabicDigits ? toArabicDigits(s) : s;
}
