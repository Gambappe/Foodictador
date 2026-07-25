/**
 * Copy catalog (L1). Data only — every user-facing string the template
 * narrator can emit lives here, keyed so G3 can iterate the whole catalog
 * through the K5 linter. Rotation templates are keyed by the reason keys K3
 * emits; prose never comes from a model in this module.
 *
 * Slots use {name} placeholders, filled by renderTemplate. A template must
 * never mention quantity, weight, calories, progress, streaks, scores or
 * daily totals — the linter test enforces it, one case per string.
 */

import type { UsualNoteKey } from '../kernel/askEngine.js';
import type { Driver } from '../contracts/types.js';

export const CATALOG = {
  /** Reason line when a cohort citation and an induced pool claim both exist. */
  reason_induced_cited:
    '{claim} {pick} is where that leads tonight — {k} people with {driverPhrase} say so.',
  /** Reason line from a cohort citation alone. */
  reason_cohort_cited:
    '{pick} — people with {driverPhrase} keep steering the same way. {k} of them now.',
  /** Reason line from an induced pool claim alone. */
  reason_induced: '{claim} {pick} is where that leads tonight.',
  /** Reason line with neither — The Usual and Rotation carry the pick. */
  reason_plain: '{pick} — a quiet fit for how you actually eat.',
  /** The first-teller line (design v0.8 §5) — rehearsed, not feared. */
  cohort_miss:
    "You're the first person to tell us this — it'll shape recommendations once a few more people do.",
  /** Rotation line for K3's eaten_twice_recently reason key (design v0.8 §5). */
  rotation_eaten_twice_recently:
    'Not {dish} — twice this week already, and you turn on it by the third.',
  /** Fallback rotation line for a reason key this catalog does not know yet. */
  rotation_generic: 'Not {dish} — too soon, by your own pattern.',
  /** Appended to the reason line when the pool is degraded (flags table, §6). */
  degraded_pool:
    'The pool is answering from its cached patterns tonight; the counts are live.',
} as const;

export type CatalogKey = keyof typeof CATALOG;

/**
 * Prose for K7's usual-note keys.
 *
 * `Record<UsualNoteKey, string>` on purpose: the engine's vocabulary is closed and
 * exported, so adding a note key without adding a phrase here fails to compile. Before
 * this existed, `TemplateNarrator` put the raw key on the card — a user on the default
 * `narrator: template` path was shown `spice_tolerance_low`.
 */
export const USUAL_PHRASES: Record<UsualNoteKey, string> = {
  spice_tolerance_low: 'nothing that fights back',
  budget_band_1: 'kept cheap',
  budget_band_2: 'kept reasonable',
  budget_band_3: 'room to spend a little',
  budget_band_4: 'no ceiling tonight',
  portion_small: 'small plates',
  portion_large: 'a proper plateful',
  solo_comfortable: 'fine to eat alone',
  gi_constraint: 'gentle on you',
  has_default_order: 'and your usual is there if you want it',
};

/** The usual line: the diner's own constraints, in their own register. */
export function usualLineFor(notes: readonly string[]): string | undefined {
  const phrases = notes
    .filter((note): note is UsualNoteKey => note in USUAL_PHRASES)
    .map((note) => USUAL_PHRASES[note]);
  if (phrases.length === 0) return undefined;
  const [first, ...rest] = phrases;
  if (first === undefined) return undefined;
  const sentence = rest.length === 0 ? first : `${[first, ...rest.slice(0, -1)].join(', ')} and ${rest[rest.length - 1] ?? ''}`;
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.`;
}

/**
 * How a cohort is named on the card — a human phrase per driver, never the
 * enum token. Curated (not derived) so each one reads plainly and lints clean.
 */
export const DRIVER_PHRASES: Record<Driver, string> = {
  spice_tolerance_low: 'your real spice tolerance',
  budget_ceiling: 'a quiet budget ceiling',
  portion_small: 'a taste for smaller plates',
  solo_comfort: 'a seat for one by choice',
  gi_constraint: 'a stomach that sets the menu',
  allergy_constraint: 'a real allergy',
  sensory_shift: 'tastes that have shifted',
  companion_constraint: 'company that shapes the order',
  emotional_exclusion: 'a place that holds a memory',
  acclaim_skeptic: 'doubts about the hype',
  crowd_aversion: 'no appetite for a crowd',
};

/**
 * Fill {slot} placeholders. Throws on a slot the caller did not supply —
 * a half-rendered card is a bug, not a degrade path.
 */
export function renderTemplate(key: CatalogKey, slots: Record<string, string>): string {
  return CATALOG[key].replace(/\{(\w+)\}/g, (_match, name: string) => {
    const value = slots[name];
    if (value === undefined) {
      throw new Error(`catalog: template "${key}" is missing slot "${name}"`);
    }
    return value;
  });
}
