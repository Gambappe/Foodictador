import { describe, expect, it } from 'vitest';

import { DEFAULT_FLAGS } from '../contracts/flags.js';
import { corpusFixture } from '../contracts/fixtures/index.js';
import type { NarratorFacts, RankedPlace } from '../contracts/types.js';
import { createFlagStore } from '../config/flagStore.js';
import { createLogger } from '../config/logger.js';
import {
  CARD_COPY_SCHEMA,
  NARRATOR_MODEL,
  createLiveNarrator,
  FLIP_AFTER_CONSECUTIVE_FAILURES,
  type ModelRequest,
  type ModelResponse,
} from './narrator.js';
import { TemplateNarrator } from './template.js';

function ranked(): RankedPlace[] {
  return corpusFixture.slice(0, 3).map((place, i) => ({
    place,
    score: 0.8 - i * 0.02,
    parts: { pool: 0.3, usual: 0.2, rotation: 0.2, context: 0.1 },
  }));
}

function facts(overrides: Partial<NarratorFacts> = {}): NarratorFacts {
  return { suppressions: [], usualNotes: [], degradedPool: false, ...overrides };
}

function textResponse(payload: unknown): ModelResponse {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

/** Test double: serves queued responses (or throws) and records every request. */
function mockClient(outcomes: Array<ModelResponse | Error>) {
  const requests: ModelRequest[] = [];
  return {
    requests,
    client: {
      complete(req: ModelRequest): Promise<ModelResponse> {
        requests.push(req);
        const next = outcomes.shift();
        if (next === undefined) throw new Error('mock exhausted');
        if (next instanceof Error) return Promise.reject(next);
        return Promise.resolve(next);
      },
    },
  };
}

function harness(outcomes: Array<ModelResponse | Error>) {
  const lines: string[] = [];
  const logger = createLogger((m) => lines.push(m));
  const flags = createFlagStore({ ...DEFAULT_FLAGS }, logger);
  const { requests, client } = mockClient(outcomes);
  const narrator = createLiveNarrator({ client, flags, logger });
  return { narrator, requests, flags, lines };
}

describe('L3 live narrator', () => {
  const pickName = () => {
    const first = corpusFixture[0];
    if (!first) throw new Error('corpus fixture empty');
    return first.name;
  };

  it('returns valid grounded copy from one call', async () => {
    const { narrator, requests } = harness([
      textResponse({ reasonLine: `${pickName()} — the quiet consensus tonight.` }),
    ]);
    const copy = await narrator.write(ranked(), facts());
    expect(copy.reasonLine).toContain(pickName());
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(NARRATOR_MODEL);
  });

  it('rejects a response naming an off-corpus venue, regenerates once, then accepts', async () => {
    const { narrator, requests, lines } = harness([
      textResponse({ reasonLine: "Louie's Chophouse — a place I just invented." }),
      textResponse({ reasonLine: `${pickName()} — steady, familiar, right for tonight.` }),
    ]);
    const copy = await narrator.write(ranked(), facts());
    expect(copy.reasonLine).toContain(pickName());
    expect(requests).toHaveLength(2);
    expect(requests[1]?.system).toContain('previous attempt was rejected');
    expect(lines.some((l) => l.includes('does not name the pick'))).toBe(true);
  });

  it('an off-corpus venue in a NON-reason line is rejected too (SL-05)', async () => {
    const { narrator, requests, lines } = harness([
      textResponse({
        reasonLine: `${pickName()} — the quiet consensus tonight.`,
        rotationLine: 'Not the invented Wagyu Palace special — too soon.',
        usualLine: "Same as your usual at Louie's Chophouse.",
      }),
      textResponse({ reasonLine: `${pickName()} — steady and familiar.` }),
    ]);
    const copy = await narrator.write(ranked(), facts());
    expect(copy.reasonLine).toContain(pickName());
    expect(copy.rotationLine).toBeUndefined(); // the hallucinated copy never survives
    expect(requests).toHaveLength(2);
    expect(lines.some((l) => l.includes('off-corpus'))).toBe(true);
  });

  it('candidate and dish names in secondary lines are allowed', async () => {
    const second = ranked()[1];
    if (!second) throw new Error('need a runner-up');
    const { narrator, requests } = harness([
      textResponse({
        reasonLine: `${pickName()} — the quiet consensus tonight.`,
        usualLine: `${second.place.name} is there if you change your mind.`,
      }),
    ]);
    const copy = await narrator.write(ranked(), facts());
    expect(copy.usualLine).toContain(second.place.name);
    expect(requests).toHaveLength(1); // no regenerate — this copy is grounded
  });

  it('an invented venue that EXTENDS a real name is rejected (SL-32)', async () => {
    // The pick's name is always allowed, because the reason line is required to contain
    // it. So a check that accepted any run *containing* an allowed name accepted
    // "<pick> Downtown Annex" — a venue that does not exist, wearing a real one's name.
    // Extending a real name is what a plausible invention looks like.
    const { narrator, requests, lines } = harness([
      textResponse({
        reasonLine: `${pickName()} — the quiet consensus tonight.`,
        rotationLine: `Not the ${pickName()} Downtown Annex tonight.`,
      }),
      textResponse({ reasonLine: `${pickName()} — the quiet consensus tonight.` }),
    ]);
    await narrator.write(ranked(), facts());
    expect(requests).toHaveLength(2); // regenerated rather than shipped
    expect(lines.some((l) => l.includes('off-corpus'))).toBe(true);
  });

  it('a fragment of a real name is still allowed, so the fix did not overshoot', async () => {
    // "Rosa's" for "Rosa's Taqueria" is the model referring to a candidate it was given,
    // not inventing one. Rejecting that would make every natural second reference a
    // regenerate.
    const full = pickName();
    const fragment = full.split(' ')[0] ?? full;
    const { narrator, requests } = harness([
      textResponse({
        reasonLine: `${full} — the quiet consensus tonight.`,
        usualLine: `${fragment} does not miss.`,
      }),
    ]);
    await narrator.write(ranked(), facts());
    expect(requests).toHaveLength(1);
  });

  it('a banned term regenerates once then falls back to the template', async () => {
    const { narrator, requests, flags } = harness([
      textResponse({ reasonLine: `${pickName()} — you're on a 3-day streak of good picks.` }),
      textResponse({ reasonLine: `${pickName()} — burn it off with a walk after.` }),
    ]);
    const copy = await narrator.write(ranked(), facts());
    const template = await new TemplateNarrator().write(ranked(), facts());
    expect(copy).toEqual(template);
    expect(requests).toHaveLength(2); // exactly one regenerate, never a third call
    expect(flags.get().narrator).toBe('live'); // per-call fallback, no flag flip
  });

  it('unparseable output counts as a rejected attempt', async () => {
    const { narrator, requests } = harness([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json at all' }] },
      textResponse({ reasonLine: `${pickName()} — plain and true.` }),
    ]);
    const copy = await narrator.write(ranked(), facts());
    expect(copy.reasonLine).toContain(pickName());
    expect(requests).toHaveLength(2);
  });

  it('the prompt payload contains no prose field and no confession text', async () => {
    const { narrator, requests } = harness([
      textResponse({ reasonLine: `${pickName()} — grounded in facts alone.` }),
    ]);
    await narrator.write(
      ranked(),
      facts({
        poolClaim: 'Hygiene complaints under-predict loyalty here.',
        citation: { driver: 'spice_tolerance_low', k: 6 },
        suppressions: [{ dishId: 'shoyu_ramen', reasonKey: 'eaten_twice_recently' }],
        usualNotes: ['A counter seat, early evening.'],
      }),
    );
    const serialized = JSON.stringify(requests[0]);
    expect(serialized).not.toContain('prose');
    expect(serialized).not.toContain('confession');
    const body = requests[0]?.messages[0]?.content ?? '';
    expect(JSON.parse(body)).toHaveProperty('facts');
    expect(JSON.parse(body)).not.toHaveProperty('facts.prose');
  });

  it('never sends a cohort below KFLOOR to the model', async () => {
    const { narrator, requests } = harness([
      textResponse({ reasonLine: `${pickName()} — no cohort worth citing yet.` }),
    ]);
    await narrator.write(ranked(), facts({ citation: { driver: 'solo_comfort', k: 4 } }));
    const body = requests[0]?.messages[0]?.content ?? '';
    expect(body).not.toContain('citation');
    expect(body).not.toContain('"k":4');
  });

  it('a sub-floor citation is not cited on the template-delegation path either', async () => {
    const { narrator, flags } = harness([]);
    flags.set('narrator', 'template', 'test');
    const copy = await narrator.write(ranked(), facts({ citation: { driver: 'budget_ceiling', k: 2 } }));
    expect(copy.reasonLine).not.toContain('2 of them');
    expect(copy.reasonLine).not.toContain('budget ceiling');
  });

  it('a sub-floor citation is not cited after a transport-failure fallback', async () => {
    const { narrator } = harness([new Error('ECONNREFUSED')]);
    const copy = await narrator.write(ranked(), facts({ citation: { driver: 'solo_comfort', k: 3 } }));
    expect(copy.reasonLine).not.toContain('3 of them');
  });

  it('under narrator=template it delegates to L1 with zero requests', async () => {
    const { narrator, requests, flags } = harness([]);
    flags.set('narrator', 'template', 'test');
    const copy = await narrator.write(ranked(), facts());
    const template = await new TemplateNarrator().write(ranked(), facts());
    expect(copy).toEqual(template);
    expect(requests).toHaveLength(0);
  });

  it('ONE transport failure templates this card only — the flag stays live (D2)', async () => {
    // A single 429 is a bad moment, not an unavailable service. The old behaviour
    // (flip on the first error) silently degraded every later card off one blip.
    const { narrator, flags, lines } = harness([
      new Error('connect ECONNREFUSED'),
      textResponse({ reasonLine: `${pickName()} — back on the next call.` }),
    ]);
    const copy = await narrator.write(ranked(), facts());
    const template = await new TemplateNarrator().write(ranked(), facts());
    expect(copy).toEqual(template);
    expect(flags.get().narrator).toBe('live'); // NOT flipped
    expect(lines.some((l) => l.includes('transport error (1/'))).toBe(true);
    const next = await narrator.write(ranked(), facts()); // and the next call goes live
    expect(next.reasonLine).toContain(pickName());
  });

  it(`${FLIP_AFTER_CONSECUTIVE_FAILURES} consecutive transport failures flip the flag exactly once`, async () => {
    const { narrator, flags, lines } = harness([
      new Error('boom 1'),
      new Error('boom 2'),
      new Error('boom 3'),
    ]);
    await narrator.write(ranked(), facts());
    await narrator.write(ranked(), facts());
    expect(flags.get().narrator).toBe('live'); // two in a row: still live
    await narrator.write(ranked(), facts());
    expect(flags.get().narrator).toBe('template'); // third flips
    expect(lines.filter((l) => l.includes('flag narrator live→template'))).toHaveLength(1);
  });

  it('a success between failures resets the counter (D2)', async () => {
    const { narrator, flags } = harness([
      new Error('boom 1'),
      new Error('boom 2'),
      textResponse({ reasonLine: `${pickName()} — recovered.` }),
      new Error('boom 3'),
    ]);
    await narrator.write(ranked(), facts());
    await narrator.write(ranked(), facts());
    await narrator.write(ranked(), facts()); // success resets the count
    await narrator.write(ranked(), facts()); // failure is 1-of-3 again
    expect(flags.get().narrator).toBe('live');
  });

  it('sends structured output config and the strict schema on every attempt', async () => {
    const { narrator, requests } = harness([
      textResponse({ reasonLine: `${pickName()} — schema-shaped copy.` }),
    ]);
    await narrator.write(ranked(), facts());
    expect(requests[0]?.output_config.format.type).toBe('json_schema');
    expect(requests[0]?.output_config.format.schema).toBe(CARD_COPY_SCHEMA);
    expect(requests[0]?.thinking).toEqual({ type: 'disabled' });
  });
});
