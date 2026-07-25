import { describe, expect, it } from 'vitest';

import { DEFAULT_FLAGS } from '../contracts/flags.js';
import { cannedConfessions } from '../contracts/fixtures/index.js';
import { createFlagStore, initialFlags } from '../config/flagStore.js';
import { createLogger } from '../config/logger.js';
import type { AppConfig } from '../config/env.js';
import {
  EXTRACTOR_MODEL,
  PROPOSED_READ_SCHEMA,
  createLiveExtractor,
} from './extractor.js';
import type { ModelRequest, ModelResponse } from './narrator.js';

function textResponse(payload: unknown): ModelResponse {
  return { stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

const VALID_PROPOSAL = {
  chips: {
    place: 'rosas_taqueria',
    signal: 'pretends_preference',
    driver: 'spice_tolerance_low',
    cadence: 'monthly',
    weight: 0.8,
  },
  confidence: 0.9,
};

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
  const extractor = createLiveExtractor({ client, flags, logger });
  return { extractor, requests, flags, lines };
}

describe('L2 chip preview', () => {
  it('valid output parses into a five-chip proposal', async () => {
    const { extractor, requests } = harness([textResponse(VALID_PROPOSAL)]);
    const result = await extractor.propose('I always order mild and pretend.', []);
    expect(result).toEqual(VALID_PROPOSAL);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.model).toBe(EXTRACTOR_MODEL);
    expect(requests[0]?.output_config.format.schema).toBe(PROPOSED_READ_SCHEMA);
    expect(requests[0]?.thinking).toBeUndefined();
  });

  it('schema-invalid output retries exactly once then degrades with one log line', async () => {
    const { extractor, requests, flags, lines } = harness([
      textResponse({ chips: { ...VALID_PROPOSAL.chips, driver: 'spice_tolerance_high' }, confidence: 0.9 }),
      { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }] },
    ]);
    const result = await extractor.propose('The spicy one defeats me every time.', []);
    expect(requests).toHaveLength(2); // one retry, never a third call
    expect(flags.get().extraction).toBe('seeded');
    expect(lines.filter((l) => l.startsWith('flag extraction'))).toEqual([
      'flag extraction live→seeded reason=schema-invalid',
    ]);
    // Serves the canned proposal (keyword "spicy" matches the canned set).
    if ('blocked' in result) throw new Error('expected a proposal');
    expect(result.chips.driver).toBe('spice_tolerance_low');
  });

  it('an invalid first attempt followed by a valid retry succeeds without degrading', async () => {
    const { extractor, requests, flags } = harness([
      { stop_reason: 'end_turn', content: [{ type: 'text', text: '{broken' }] },
      textResponse(VALID_PROPOSAL),
    ]);
    const result = await extractor.propose('mild by choice', []);
    expect(result).toEqual(VALID_PROPOSAL);
    expect(requests).toHaveLength(2);
    expect(flags.get().extraction).toBe('live');
  });

  it('a blocked topic returns {blocked: true} with zero model calls', async () => {
    const { extractor, requests } = harness([]);
    const result = await extractor.propose('never write about the crème brûlée thing', ['creme brulee']);
    expect(result).toEqual({ blocked: true });
    expect(requests).toHaveLength(0);
  });

  it('with no API key it serves the canned proposal without attempting a request', async () => {
    const lines: string[] = [];
    const logger = createLogger((m) => lines.push(m));
    const config: AppConfig = {
      xtraceBaseUrl: 'http://localhost:1',
      xtraceApiKey: 'k',
      relayUrl: 'http://localhost:2',
      relayToken: 't',
      anthropicApiKey: null,
      settleWindowSeconds: 480,
    };
    const flags = createFlagStore(initialFlags(config, logger), logger);
    const { requests, client } = mockClient([]);
    const extractor = createLiveExtractor({ client, flags, logger });

    const result = await extractor.propose('I eat alone at the counter and love it.', []);
    if ('blocked' in result) throw new Error('expected a proposal');
    expect(result.chips.driver).toBe('solo_comfort'); // keyword "alone"
    expect(requests).toHaveLength(0);
  });

  it('re-checks the model output against off-limits after the call', async () => {
    const { extractor, requests } = harness([textResponse(VALID_PROPOSAL)]);
    // The confession slips past the pre-check, but the proposed chips carry the topic.
    const result = await extractor.propose('a story about the corner place', ['taqueria']);
    expect(result).toEqual({ blocked: true });
    expect(requests).toHaveLength(1);
  });

  it('a transport failure degrades the flag and serves the canned proposal', async () => {
    const { extractor, requests, flags, lines } = harness([new Error('ECONNREFUSED')]);
    const result = await extractor.propose('my stomach never forgives the bun bo hue', []);
    if ('blocked' in result) throw new Error('expected a proposal');
    expect(result.chips.driver).toBe('gi_constraint'); // keyword "stomach"
    expect(requests).toHaveLength(1); // no retry on transport failure
    expect(flags.get().extraction).toBe('seeded');
    expect(lines.some((l) => l === 'flag extraction live→seeded reason=model-unavailable')).toBe(true);
  });

  it('the canned fallback is itself subject to the off-limits check', async () => {
    const lines: string[] = [];
    const logger = createLogger((m) => lines.push(m));
    const flags = createFlagStore({ ...DEFAULT_FLAGS, extraction: 'seeded' as const }, logger);
    const { requests, client } = mockClient([]);
    const extractor = createLiveExtractor({ client, flags, logger });
    // "alone" maps to the quiet_counter canned entry; blocking "counter" catches it.
    const result = await extractor.propose('I eat alone most weeks.', ['counter']);
    expect(result).toEqual({ blocked: true });
    expect(requests).toHaveLength(0);
  });

  it('an unmatched confession falls back to the first canned entry under seeded', async () => {
    const lines: string[] = [];
    const logger = createLogger((m) => lines.push(m));
    const flags = createFlagStore({ ...DEFAULT_FLAGS, extraction: 'seeded' as const }, logger);
    const { client } = mockClient([]);
    const extractor = createLiveExtractor({ client, flags, logger });
    const result = await extractor.propose('nothing that matches any keyword', []);
    if ('blocked' in result) throw new Error('expected a proposal');
    const first = cannedConfessions[0];
    expect(result.chips).toEqual(first?.chips);
  });

  it('weight outside [0,1] in model output is schema-invalid', async () => {
    const { extractor, requests, flags } = harness([
      textResponse({ chips: { ...VALID_PROPOSAL.chips, weight: 1.5 }, confidence: 0.9 }),
      textResponse({ chips: VALID_PROPOSAL.chips, confidence: 2 }),
    ]);
    await extractor.propose('the spicy thing again', []);
    expect(requests).toHaveLength(2);
    expect(flags.get().extraction).toBe('seeded');
  });
});
