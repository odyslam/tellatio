import type { DayInteraction } from "./state";

export type StrengthLevel =
  | "No Connection"
  | "Very Weak"
  | "Weak"
  | "Good"
  | "Strong"
  | "Very Strong";

// Half-life of 30 days: an interaction 30 days ago has half the weight of today
const HALF_LIFE_DAYS = 30;
const LAMBDA = Math.LN2 / HALF_LIFE_DAYS;

/**
 * Compute a raw connection score using exponential time-decay.
 * Each message contributes e^(-lambda * days_ago) to the score.
 */
export function computeScore(interactions: DayInteraction[], now: Date = new Date()): number {
  const nowMs = now.getTime();
  let score = 0;

  for (const day of interactions) {
    const dayMs = new Date(day.date + "T12:00:00Z").getTime(); // noon UTC
    const daysAgo = Math.max(0, (nowMs - dayMs) / (1000 * 60 * 60 * 24));
    const weight = Math.exp(-LAMBDA * daysAgo);
    score += day.count * weight;
  }

  return score;
}

/**
 * Map a raw score to a connection strength label.
 * Thresholds calibrated roughly to match Attio's email-based levels.
 */
export function scoreToLevel(score: number): StrengthLevel {
  if (score < 0.5) return "No Connection";
  if (score < 3) return "Very Weak";
  if (score < 10) return "Weak";
  if (score < 25) return "Good";
  if (score < 50) return "Strong";
  return "Very Strong";
}

export function computeStrength(interactions: DayInteraction[]): StrengthLevel {
  return scoreToLevel(computeScore(interactions));
}
