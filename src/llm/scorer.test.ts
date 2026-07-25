import { describe, expect, it } from 'vitest';

import type { Flags } from '../contracts/flags.js';
import type { Place, RankedPlace, UsualProfile } from '../contracts/types.js';
import { DEFAULT_FLAGS } from '../contracts/flags.js';
import { sampleUsual } from '../contracts/fixtures/index.js';
import { createLogger } from '../config/logger.js';
import { applyAffinity } from '../kernel/askEngine.js';
import { createScorer, parseAffinity } from './scorer.js';
import type { ModelClient, ModelResponse } from './narrator.js';

function place(id: string, cuisine = 'korean'): Place {
  return { id, name: id, cuisine, priceBand: 2, tags: [], signatureDishes: [] };
}
function ranked(entries: Array<[string, number]>): RankedPlace[] {
  return entries.map(([id, score]) => ({ place: place(id), score, fit: {} }) as unknown as RankedPlace);
}
function client(text: string, fail = false): ModelClient {
  return {
    complete: (): Promise<ModelResponse> =>
      fail
        ? Promise.reject(new Error('model 503'))
        : Promise.resolve({ stop_reason: 'end_turn', content: [{ type: 'text', text }] }),
  };
}
const flags = (over: Partial<Flags> = {}) => ({ get: () => ({ ...DEFAULT_FLAGS, ...over }) });
const quiet = createLogger(() => undefined);
const usual: UsualProfile = sampleUsual;

/**
 * D-14 — the no-key path must be the OLD path, not a lesser one.
 *
 * Affinity multiplies a kernel score, so "no model" is `1` for every candidate and the
 * ranking is arithmetically what this product returned before affinity existed. That is the
 * property that makes shipping this safe for a demo that deliberately runs without a key on
 * two of three laptops — and it is asserted here rather than assumed.
 */
describe('D-14 without a model, the ranking is unchanged', () => {
  it('no affinity leaves order and scores exactly as the kernel produced them', () => {
    const kernel = ranked([['a', 0.9], ['b', 0.7], ['c', 0.5]]);
    expect(applyAffinity(kernel, undefined)).toEqual(kernel);
    expect(applyAffinity(kernel, {})).toEqual(kernel);
  });

  it('a place the model said nothing about keeps its kernel score', () => {
    const out = applyAffinity(ranked([['a', 0.8], ['b', 0.6]]), { a: 0.5 });
    expect(out.find((e) => e.place.id === 'b')?.score).toBe(0.6);
  });

  it('the scorer makes NO model call under scoring: kernel', async () => {
    let called = false;
    const scorer = createScorer({
      client: { complete: () => { called = true; return Promise.reject(new Error('must not be called')); } },
      logger: quiet,
      flags: flags({ scoring: 'kernel' }),
    });
    expect(await scorer.affinity({ candidates: [place('a')], usual, confessions: ['x'] })).toEqual({});
    expect(called).toBe(false); // no key means no spend, not a failed call
  });

  it('nothing confessed means no call either — there is nothing to weigh', async () => {
    let called = false;
    const scorer = createScorer({
      client: { complete: () => { called = true; return Promise.reject(new Error('nope')); } },
      logger: quiet,
      flags: flags(),
    });
    expect(await scorer.affinity({ candidates: [place('a')], usual, confessions: [] })).toEqual({});
    expect(called).toBe(false);
  });

  it('a model failure costs nuance, never the card', async () => {
    const lines: string[] = [];
    const scorer = createScorer({
      client: client('', true),
      logger: createLogger((l) => lines.push(l)),
      flags: flags(),
    });
    expect(await scorer.affinity({ candidates: [place('a')], usual, confessions: ['x'] })).toEqual({});
    expect(lines.join('\n')).toMatch(/ranking on the kernel alone/);
  });
});

/**
 * The safety belt: affinity reorders survivors and can do nothing else.
 *
 * Measured, the model respected `giConstraint`, the budget ceiling and spice tolerance
 * unprompted even against confessions pulling the other way. This is the difference between
 * "it respected the constraint in the test" and "it cannot violate the constraint."
 */
describe('D-14 affinity cannot override the kernel', () => {
  it('an out-of-range score is clamped, not trusted', () => {
    // A `4` would silently outrank every constraint-respecting place.
    const out = applyAffinity(ranked([['a', 0.5], ['b', 0.9]]), { a: 4, b: -2 });
    expect(out.find((e) => e.place.id === 'a')?.score).toBe(0.5); // clamped to 1
    expect(out.find((e) => e.place.id === 'b')?.score).toBe(0); // clamped to 0
  });

  it('a place the kernel excluded cannot be resurrected — it is not in the list', () => {
    // The excluded place never reaches `applyAffinity`, so a perfect affinity for it is inert.
    const out = applyAffinity(ranked([['allowed', 0.4]]), { allowed: 1, excluded_place: 1 });
    expect(out.map((e) => e.place.id)).toEqual(['allowed']);
  });

  it('affinity can only ever LOWER a score, so it cannot beat a hard constraint', () => {
    // A multiplier in [0,1] is a partial order the kernel still dominates: nothing the model
    // says can lift a place above where the kernel put it.
    const kernel = ranked([['a', 0.8], ['b', 0.6]]);
    for (const factor of [0, 0.25, 0.5, 1]) {
      const out = applyAffinity(kernel, { a: factor, b: factor });
      for (const entry of out) {
        const before = kernel.find((k) => k.place.id === entry.place.id)?.score ?? 0;
        expect(entry.score).toBeLessThanOrEqual(before);
      }
    }
  });

  it('reorders survivors when the diner said something the kernel cannot represent', () => {
    // The whole point: identical kernel scores, different order once words are read.
    const kernel = ranked([['seoul_static', 0.6625], ['polenta_house', 0.6625]]);
    const loves = applyAffinity(kernel, { seoul_static: 1, polenta_house: 0.1 });
    const avoids = applyAffinity(kernel, { seoul_static: 0.05, polenta_house: 1 });
    expect(loves[0]?.place.id).toBe('seoul_static');
    expect(avoids[0]?.place.id).toBe('polenta_house');
  });
});

describe('D-14 parsing what a model returned', () => {
  const allowed = new Set(['a', 'b']);

  it('keeps valid entries and drops ids that were never offered', () => {
    // A hallucinated place must not reach a ranking.
    expect(parseAffinity('{"a":0.9,"ghost":1,"b":0.2}', allowed)).toEqual({ a: 0.9, b: 0.2 });
  });

  it('drops one bad value rather than the whole answer', () => {
    // Per key, not all-or-nothing: one unusable entry costs that place its nuance.
    expect(parseAffinity('{"a":"high","b":0.4}', allowed)).toEqual({ b: 0.4 });
  });

  it('unparseable output is no opinion, never a throw', () => {
    expect(parseAffinity('sorry, I cannot do that', allowed)).toEqual({});
    expect(parseAffinity('[1,2,3]', allowed)).toEqual({});
  });

  it('survives a markdown fence, which models add unbidden', () => {
    expect(parseAffinity('```json\n{"a":0.5}\n```', allowed)).toEqual({ a: 0.5 });
  });

  it('clamps values the schema should have prevented', () => {
    expect(parseAffinity('{"a":7,"b":-3}', allowed)).toEqual({ a: 1, b: 0 });
  });
});
