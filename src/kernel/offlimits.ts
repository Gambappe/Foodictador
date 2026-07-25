/**
 * Off-limits topic matcher (K2). Pure kernel: no I/O, no clock.
 *
 * This is the gate that stops a flagged confession being ingested ANYWHERE —
 * pool, relay and user-scope prose alike (design v0.8 [E24]). M5 runs it as the
 * authoritative check before any write; L2 runs it earlier as an optimisation.
 *
 * Substring matching, deliberately NOT word-boundary: a topic of "gluten" must
 * fire on "glutenous". Over-blocking is the intended trade — a false negative
 * here is a duty-of-care failure (a forbidden topic entering memory), while a
 * false positive is an annoyance the user can fix by rewording. Do not
 * "improve" this into word-boundary matching.
 */

/**
 * Case- and accent-insensitive fold: NFD-normalise, strip combining marks,
 * lowercase — so "crème" matches "creme" in either direction.
 */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

export function isBlocked(text: string, topics: string[]): boolean {
  const haystack = fold(text);
  return topics.some((topic) => {
    const needle = fold(topic.trim());
    // An empty topic must never block: ''.includes() matches everything.
    if (needle.length === 0) return false;
    return haystack.includes(needle);
  });
}
