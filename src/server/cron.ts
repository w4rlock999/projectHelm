/**
 * Minimal standard 5-field cron evaluator: `minute hour day-of-month month day-of-week`.
 *
 * Supports per field: star, step (star-slash-n), range (a-b), range+step (a-b/n),
 * comma lists of any of the above, and bare values. Day-of-week: 0-6 (Sun=0);
 * 7 is also accepted as Sunday. Month and dow are numeric only (no JAN/MON names).
 *
 * Matching is to minute granularity — sufficient for heartbeats. Per cron
 * convention, when BOTH day-of-month and day-of-week are restricted (neither is
 * `*`), a tick matches if EITHER matches.
 *
 * Evaluation uses local time, matching the user's wall clock.
 */

const FIELD_RANGES: Array<[min: number, max: number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day of month
  [1, 12], // month
  [0, 7], // day of week (0 and 7 = Sunday)
];

function parseField(raw: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of raw.split(',')) {
    const piece = part.trim();
    if (!piece) throw new Error(`empty cron field segment in "${raw}"`);

    let stepStr: string | undefined;
    let rangeStr = piece;
    const slash = piece.indexOf('/');
    if (slash >= 0) {
      rangeStr = piece.slice(0, slash);
      stepStr = piece.slice(slash + 1);
    }
    const step = stepStr === undefined ? 1 : Number(stepStr);
    if (!Number.isInteger(step) || step < 1) {
      throw new Error(`invalid step "${stepStr}" in "${raw}"`);
    }

    let lo: number;
    let hi: number;
    if (rangeStr === '*') {
      lo = min;
      hi = max;
    } else if (rangeStr.includes('-')) {
      const [a, b] = rangeStr.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = hi = Number(rangeStr);
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi)) {
      throw new Error(`invalid value "${rangeStr}" in "${raw}"`);
    }
    if (lo < min || hi > max || lo > hi) {
      throw new Error(`out-of-range field "${piece}" (allowed ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export interface ParsedCron {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

export function parseCron(expr: string): ParsedCron {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`expected 5 cron fields, got ${fields.length}: "${expr}"`);
  }
  const [minute, hour, dom, month, dow] = fields.map((f, i) =>
    parseField(f, FIELD_RANGES[i][0], FIELD_RANGES[i][1]),
  );
  // Normalize dow=7 to 0 (both mean Sunday).
  if (dow.has(7)) dow.add(0);
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: fields[2].trim() !== '*',
    dowRestricted: fields[4].trim() !== '*',
  };
}

/** Throws if the expression is invalid; returns true otherwise. Useful for input validation. */
export function isValidCron(expr: string): boolean {
  parseCron(expr);
  return true;
}

export function cronMatches(expr: string, date: Date): boolean {
  const p = parseCron(expr);
  if (!p.minute.has(date.getMinutes())) return false;
  if (!p.hour.has(date.getHours())) return false;
  if (!p.month.has(date.getMonth() + 1)) return false;

  const domOk = p.dom.has(date.getDate());
  const dowOk = p.dow.has(date.getDay());
  if (p.domRestricted && p.dowRestricted) {
    // Both restricted → match if either matches (standard cron semantics).
    return domOk || dowOk;
  }
  if (p.domRestricted) return domOk;
  if (p.dowRestricted) return dowOk;
  return true;
}

/** Human-readable summary of common patterns; falls back to the raw expression. */
export function nextDescription(expr: string): string {
  try {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) return expr;
    const [min, hour, dom, month, dow] = fields;
    if (expr.trim() === '* * * * *') return 'every minute';
    if (/^\*\/\d+$/.test(min) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
      return `every ${min.slice(2)} minutes`;
    }
    if (min === '0' && /^\*\/\d+$/.test(hour) && dom === '*' && month === '*' && dow === '*') {
      return `every ${hour.slice(2)} hours`;
    }
    if (/^\d+$/.test(min) && /^\d+$/.test(hour) && dom === '*' && month === '*' && dow === '*') {
      return `daily at ${hour.padStart(2, '0')}:${min.padStart(2, '0')}`;
    }
    return expr;
  } catch {
    return expr;
  }
}
