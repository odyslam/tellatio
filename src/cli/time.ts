import { die } from "./runtime";

/**
 * Parse a --since or --date value into a unix timestamp.
 * Supports: "yesterday", "today", "Nd" (N days ago), "Nh" (N hours ago), "YYYY-MM-DD"
 */
export function parseTimeFilter(value: string): number {
  const now = Date.now();
  const v = value.toLowerCase().trim();

  if (v === "yesterday") {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }
  if (v === "today") {
    const d = new Date(now);
    d.setUTCHours(0, 0, 0, 0);
    return Math.floor(d.getTime() / 1000);
  }

  // Relative: "2d", "3h", "30m"
  const relMatch = v.match(/^(\d+)([dhm])$/);
  if (relMatch) {
    const n = parseInt(relMatch[1], 10);
    const unit = relMatch[2];
    const ms = unit === "d" ? n * 86400000 : unit === "h" ? n * 3600000 : n * 60000;
    return Math.floor((now - ms) / 1000);
  }

  // Absolute date: YYYY-MM-DD
  const dateMatch = v.match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) {
    return Math.floor(new Date(v + "T00:00:00Z").getTime() / 1000);
  }

  die(`Cannot parse time: "${value}". Use: yesterday, today, Nd, Nh, Nm, or YYYY-MM-DD`);
}

export function parseUntilFilter(value: string): number {
  const v = value.toLowerCase().trim();

  // For a date, set to end of that day
  const dateMatch = v.match(/^\d{4}-\d{2}-\d{2}$/);
  if (dateMatch) {
    return Math.floor(new Date(v + "T23:59:59Z").getTime() / 1000);
  }
  if (v === "yesterday") {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - 1);
    d.setUTCHours(23, 59, 59, 0);
    return Math.floor(d.getTime() / 1000);
  }
  if (v === "today") {
    return Math.floor(Date.now() / 1000);
  }

  // Otherwise same as since
  return parseTimeFilter(value);
}
