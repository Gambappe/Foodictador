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
        inducedClaim: 'Hygiene complaints under-predict loyalty here.',
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

  it('under narrator=template it delegates to L1 with zero requests', async () => {
    const { narrator, requests, flags } = harness([]);
    flags.set('narrator', 'template', 'test');
    const copy = await narrator.write(ranked(), facts());
    const template = await new TemplateNarrator().write(ranked(), facts());
    expect(copy).toEqual(template);
    expect(requests).toHaveLength(0);
  });

  it('a transport failure degrades the flag to template with one logged transition', async () => {
    const { narrator, flags, lines } = harness([new Error('connect ECONNREFUSED')]);
    const copy = await narrator.write(ranked(), facts());
    const template = await new TemplateNarrator().write(ranked(), facts());
    expect(copy).toEqual(template);
    expect(flags.get().narrator).toBe('template');
    expect(lines.some((l) => l.includes('flag narrator live→template'))).toBe(true);
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
