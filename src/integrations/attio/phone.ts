/**
 * Normalize a phone number for matching: strip all non-digit chars except leading +.
 * Returns null if the input doesn't look like a phone number.
 */
export function normalizePhone(raw: string | undefined | null): string | null {
  if (!raw) return null;

  // Strip everything except digits and leading +
  const stripped = raw.replace(/[^\d+]/g, "");

  // Must have a + prefix and at least 7 digits
  if (!stripped.startsWith("+") || stripped.length < 8) {
    // Try prepending + if it's all digits and long enough
    if (/^\d{7,15}$/.test(stripped)) {
      return `+${stripped}`;
    }
    return null;
  }

  return stripped;
}

/**
 * Check if two phone numbers match after normalization.
 */
export function phonesMatch(a: string | undefined | null, b: string | undefined | null): boolean {
  const na = normalizePhone(a);
  const nb = normalizePhone(b);
  if (!na || !nb) return false;
  return na === nb;
}
