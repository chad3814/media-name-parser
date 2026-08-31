const DATE = /^(\d{4}|\d{2})[.\-_](\d{2})[.\-_](\d{2})(?![\d])[.\-_ ]?/;

/**
 * The leading date of a scene name, or null.
 *
 * Pure by contract: `YY` always becomes `20YY` and no value is checked
 * against today. Sanity-checking a year against the current date would make
 * the parse non-deterministic, and `normalized_key` is derived from it.
 */
export function parseSceneDate(text: string): { readonly iso: string; readonly rest: string } | null {
  const m = DATE.exec(text);
  if (m === null) return null;
  const [, rawYear = '', rawMonth = '', rawDay = ''] = m;
  const month = Number(rawMonth);
  const day = Number(rawDay);
  // 1.6% of date-shaped triples in the corpus are not dates.
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const year = rawYear.length === 4 ? Number(rawYear) : 2000 + Number(rawYear);
  const iso = `${String(year).padStart(4, '0')}-${rawMonth}-${rawDay}`;
  return { iso, rest: text.slice(m[0].length) };
}
