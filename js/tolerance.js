// tolerance.js — pure helpers mapping a user "strictness" setting (0–100) to the
// accuracy thresholds used to classify pitch (cents) and timing (ms) errors as
// accurate (good) / close (warn) / way off (bad).

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/**
 * Pitch tolerance in cents. Lenient (strictness 0) is forgiving; strict (100)
 * demands near-perfect intonation.
 * Returns { good, warn } — |cents| <= good is accurate, <= warn is close.
 */
export function pitchTolerance(strictness) {
  const t = clamp01(strictness / 100);
  return { good: lerp(25, 5, t), warn: lerp(50, 15, t) };
}

/**
 * Rhythm tolerance in milliseconds.
 * Returns { good, warn } — |ms| <= good is accurate, <= warn is close.
 */
export function rhythmTolerance(strictness) {
  const t = clamp01(strictness / 100);
  return { good: lerp(60, 20, t), warn: lerp(150, 50, t) };
}

/** Classify an absolute error against a { good, warn } tolerance. */
export function classify(absValue, tol) {
  if (absValue <= tol.good) return "good";
  if (absValue <= tol.warn) return "warn";
  return "bad";
}

/** A short human label for a strictness value, for UI display. */
export function strictnessLabel(strictness) {
  if (strictness < 25) return "lenient";
  if (strictness < 60) return "medium";
  if (strictness < 85) return "strict";
  return "very strict";
}

/** Rank classes so "worst of two" can be computed (bad > warn > good). */
export function worseClass(a, b) {
  const rank = { good: 0, warn: 1, bad: 2 };
  return rank[a] >= rank[b] ? a : b;
}

function clamp01(x) {
  return Math.max(0, Math.min(1, x));
}
