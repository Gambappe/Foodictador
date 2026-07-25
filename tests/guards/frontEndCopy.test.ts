/**
 * Every exported copy constant in the CLI and the UI passes K5's linter (SL-20, SL-28).
 *
 * `SL-20` asked for a guard over every front-end line. It was not built, and `SL-28`
 * is what that cost: `CHIP_LABELS.weight = 'weight'` shipped on the diner's confess
 * screen — the one word design v0.8 §9 singles out as non-negotiable — in the PR after
 * the log recorded that nobody lints CLI or UI copy.
 *
 * Two properties make this catch what the existing checks did not:
 *
 *   1. **Every string individually, not a concatenated blob.** `NudgeBanner.test.tsx`
 *      lints `document.body.textContent`, which only covers strings that happen to be
 *      rendered by that one test's props. A constant behind a branch nobody exercised
 *      is invisible to it.
 *   2. **Discovered, not listed.** The modules are imported and their exports walked, so
 *      a new copy constant is covered the moment it is exported. A hand-written list
 *      would have to be remembered, and the entire point of `SL-20` is that it was not.
 *
 * Scope is deliberately "copy modules", not "all strings in src". Enum tokens
 * (`spice_tolerance_low`) and testids are identifiers, not prose; linting them would
 * force a suppression list, and a guard with a suppression list is a guard people edit
 * instead of obeying.
 */

import { describe, expect, it } from 'vitest';

import { lint } from '../../src/kernel/copylint.js';
import { CATALOG } from '../../src/llm/catalog.js';
import * as confessCopy from '../../src/ui/confess/copy.js';

/** Flattens a module's exports to (path, string) pairs, walking nested objects. */
function strings(namespace: Record<string, unknown>, prefix: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  const walk = (value: unknown, path: string): void => {
    if (typeof value === 'string') {
      out.push([path, value]);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (typeof value === 'object' && value !== null) {
      for (const [key, inner] of Object.entries(value)) walk(inner, `${path}.${key}`);
    }
  };
  for (const [key, value] of Object.entries(namespace)) walk(value, `${prefix}.${key}`);
  return out;
}

const SOURCES: Array<[string, Record<string, unknown>]> = [
  ['ui/confess/copy', confessCopy],
  ['llm/catalog', { CATALOG }],
];

describe('front-end copy passes the K5 linter', () => {
  const all = SOURCES.flatMap(([name, namespace]) => strings(namespace, name));

  it('found copy to lint — an empty sweep would pass silently', () => {
    expect(all.length).toBeGreaterThan(5);
  });

  it.each(all)('%s', (_path, text) => {
    expect(lint(text)).toEqual({ ok: true });
  });

  it('the linter still rejects the word this guard exists for', () => {
    // Without this, every case above would pass just as happily if lint() were a stub —
    // which is the failure mode that let SL-28 through in the first place.
    expect(lint('weight').ok).toBe(false);
    expect(lint('calories').ok).toBe(false);
  });

  it('no chip label is a banned word, stated separately because SL-28 was exactly that', () => {
    for (const label of Object.values(confessCopy.CHIP_LABELS)) {
      expect(lint(label), `chip label "${label}"`).toEqual({ ok: true });
    }
    // The schema field is still `weight`; only what the diner reads changed.
    expect(confessCopy.CHIP_LABELS.weight).toBe('strength');
  });
});
