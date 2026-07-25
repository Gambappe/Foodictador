/**
 * Affinity scoring (D-14) — the half of a recommendation a schema cannot hold.
 *
 * ## What this exists for
 *
 * K4 ranks on five declared dials, rotation and cohort. Everything else a diner says is
 * unrepresentable, and `cuisine` is the clearest case: it is a field on `Place` that the
 * kernel never reads. Measured, with two profiles whose declared settings, meal logs and
 * off-limits lists were made byte-identical, differing only in four confessions each:
 *
 *   "Korean, every time"        → the three Korean places scored 0.6625, 0.6625, 0.6312
 *   "Korean is the one I avoid" → the three Korean places scored 0.6625, 0.6625, 0.6312
 *
 * The same numbers. A confession-shaped product could not honour a preference stated in
 * confessions. With affinity, the same two profiles put Korean at ranks 1/2/3 and 38/39/40
 * of forty.
 *
 * ## Why it is a multiplier over survivors, not a ranking
 *
 * The model never chooses. It scores places K4 has already allowed, and its number is
 * multiplied into K4's. So `giConstraint`, the budget ceiling, rotation suppression and the
 * k-floor remain decided by code that cannot be talked out of them — an excluded place has
 * no affinity because it is not in the list.
 *
 * That belt is cheaper than it looks and was kept anyway. Probed adversarially —
 * `giConstraint: true`, `budgetBand: 1`, `spiceTolerance: 0`, against confessions demanding
 * "the most expensive tasting menu in town" and "the hotter the better" — the model picked a
 * priceBand-1 place tagged `gi_safe_options` and scored **zero** over-budget candidates above
 * 0.7. It respected the declared settings unprompted. The difference between "it respected
 * the constraint in the test" and "it cannot violate the constraint" is the whole point.
 *
 * ## Without a key
 *
 * There is no affinity, `applyAffinity` multiplies by 1, and the ranking is exactly what this
 * product returned before this file existed. `scoring: kernel` is not a degraded answer; it
 * is the previous answer. P0.3 flips the flag when `ANTHROPIC_API_KEY` is absent, and the
 * scripted demo runs that way deliberately — zero spend, and two of three laptops have no key.
 *
 * ## Determinism
 *
 * Predicted to be the problem; measured not to be. Five identical calls returned the same
 * pick five times, with the score drifting 1.0 / 0.95 / 0.95 / 1.0 / 0.97 — never enough to
 * change the winner. Worth stating because the flat kernel landscape has the opposite
 * property: eight places tie at exactly 0.6625, so the pick is decided by tie-break order
 * and is stable for a reason that has nothing to do with fit.
 */

import type { Place, UsualProfile } from '../contracts/types.js';
import type { Flags } from '../contracts/flags.js';
import type { Logger } from '../config/logger.js';
import type { ModelClient } from './narrator.js';

/** Sonnet, like the narrator: this is a judgement over prose, not an extraction. */
export const SCORER_MODEL = 'claude-sonnet-5';

export interface ScorerDeps {
  client: ModelClient;
  logger: Logger;
  flags: { get(): Flags };
}

export interface AffinityInput {
  /** Only the places K4 allowed. An excluded place is not offered for scoring. */
  candidates: readonly Place[];
  usual: UsualProfile;
  /** What the diner said, in their own words — the input K4 has no field for. */
  confessions: readonly string[];
}

export interface Scorer {
  /** Per-place affinity in `[0,1]`. `{}` means "no opinion", which multiplies to no change. */
  affinity(input: AffinityInput): Promise<Record<string, number>>;
}

/**
 * A schema naming every candidate, so the model cannot answer about a place that is not on
 * the list and cannot omit one silently. `parseAffinity` still validates — structured output
 * constrains the shape, and the values still arrive from a model.
 */
function affinitySchema(candidates: readonly Place[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const p of candidates) {
    // No `minimum`/`maximum`: structured output rejects them on `number` —
    // "For 'number' type, properties maximum, minimum are not supported" (400). The range
    // is stated in the prompt and enforced by `parseAffinity`, which clamps regardless,
    // because a bound the model is asked for is not a bound the caller may assume.
    properties[p.id] = { type: 'number' };
  }
  return {
    type: 'object',
    properties,
    required: candidates.map((p) => p.id),
    additionalProperties: false,
  };
}

function prompt(input: AffinityInput): string {
  return [
    'You are scoring how well each restaurant fits ONE diner tonight.',
    '',
    'Their declared settings — they set these themselves, and they OUTRANK anything below:',
    JSON.stringify(input.usual),
    '',
    'Things they have told us, in their own words:',
    ...input.confessions.map((c) => `- "${c}"`),
    '',
    'Candidates (already filtered for hard constraints — every one is allowed):',
    ...input.candidates.map(
      (p) => `${p.id} | ${p.name} | ${p.cuisine} | priceBand ${p.priceBand} | ${p.tags.join(',')}`,
    ),
    '',
    'Return ONLY a JSON object mapping every candidate id to a number between 0 and 1, where',
    '1 fits this diner best tonight and 0 fits worst. No prose, no markdown fence.',
  ].join('\n');
}

/**
 * Parses the model's object, keeping only what is usable.
 *
 * Per key, not all-or-nothing: one unparseable entry costs that place its nuance, where
 * rejecting the whole object would cost every place its nuance. Unknown ids are dropped — a
 * hallucinated place must not reach a ranking — and a missing id simply has no affinity,
 * which `applyAffinity` reads as 1.
 */
export function parseAffinity(text: string, allowed: ReadonlySet<string>): Record<string, number> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, ''));
  } catch {
    return {};
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
  const out: Record<string, number> = {};
  for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!allowed.has(id)) continue;
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    out[id] = Math.min(1, Math.max(0, value));
  }
  return out;
}

export function createScorer(deps: ScorerDeps): Scorer {
  return {
    async affinity(input: AffinityInput): Promise<Record<string, number>> {
      if (deps.flags.get().scoring === 'kernel') return {};
      if (input.candidates.length === 0 || input.confessions.length === 0) {
        // Nothing said means nothing to weigh. Calling the model to be told "no opinion" is
        // spend for a value `applyAffinity` already defaults to.
        return {};
      }
      const allowed = new Set(input.candidates.map((p) => p.id));
      try {
        const response = await deps.client.complete({
          model: SCORER_MODEL,
          max_tokens: 8000,
          system:
            'You score restaurant fit for one diner. The diner\'s declared settings outrank ' +
            'anything they said in prose. Return only the JSON object the schema describes.',
          messages: [{ role: 'user', content: prompt(input) }],
          output_config: { format: { type: 'json_schema', schema: affinitySchema(input.candidates) } },
        });
        const text = response.content.map((c) => c.text ?? '').join('');
        const scored = parseAffinity(text, allowed);
        deps.logger.line(
          `scorer: affinity for ${String(Object.keys(scored).length)} of ` +
            `${String(input.candidates.length)} candidate(s) from ` +
            `${String(input.confessions.length)} confession(s)`,
        );
        return scored;
      } catch (error) {
        // A scorer failure must never cost a recommendation — the kernel ranking is a
        // complete answer on its own, which is exactly what makes this safe to attempt.
        deps.logger.line(
          `scorer: affinity unavailable, ranking on the kernel alone: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
        return {};
      }
    },
  };
}
