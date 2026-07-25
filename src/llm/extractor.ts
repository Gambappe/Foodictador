/**
 * Chip preview (L2) — the five-chip proposal on `claude-haiku-4-5` (design v0.8
 * §10 [E13]). UI-only by design (§6): nothing downstream depends on this output
 * being correct, only schema-valid — M5's write guard is what guarantees
 * blocking and shape at the boundary.
 *
 * Off-limits runs BEFORE the call, so a flagged confession is never sent
 * anywhere, and the result is re-checked after ([E24]; this check is the cheap
 * early one — M5's is authoritative). Schema-invalid output gets exactly one
 * retry, then the extraction flag degrades to `seeded` and the canned proposal
 * is served. With no API key P0.3 starts the flag at `seeded`, so this module
 * never attempts a request.
 */

import type { Extractor } from '../contracts/modules.js';
import type { ProposedRead } from '../contracts/types.js';
import { CADENCES, DRIVERS, SIGNALS } from '../contracts/types.js';
import { cannedConfessions } from '../contracts/fixtures/index.js';
import type { FlagStore } from '../config/flagStore.js';
import type { Logger } from '../config/logger.js';
import { isBlocked } from '../kernel/offlimits.js';
import { parseRead } from '../kernel/read.js';
import type { ModelClient, ModelRequest, ModelResponse } from './narrator.js';

export const EXTRACTOR_MODEL = 'claude-haiku-4-5';

/** Structured-output schema for the five chips plus confidence — closed. */
export const PROPOSED_READ_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    chips: {
      type: 'object',
      properties: {
        place: { type: 'string' },
        signal: { type: 'string', enum: [...SIGNALS] },
        driver: { type: 'string', enum: [...DRIVERS] },
        cadence: { type: 'string', enum: [...CADENCES] },
        weight: { type: 'number' },
      },
      required: ['place', 'signal', 'driver', 'cadence', 'weight'],
      additionalProperties: false,
    },
    confidence: { type: 'number' },
  },
  required: ['chips', 'confidence'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = [
  'You turn one confession about eating into exactly five fields: place (a short',
  'slug), signal, driver, cadence (from the given vocabularies) and weight (how',
  'strongly the confession supports the claim, 0 to 1). Map, never invent — pick',
  'the closest vocabulary value; do not editorialise. Respond with JSON only,',
  'matching the schema.',
].join(' ');

/** Seeded fallback: keyword-match the canned set, else the first canned entry. */
function cannedProposal(text: string): ProposedRead {
  const lower = text.toLowerCase();
  const match = cannedConfessions.find((c) => lower.includes(c.keyword.toLowerCase()));
  const chosen = match ?? cannedConfessions[0];
  if (!chosen) throw new Error('extractor: canned confession fixture is empty');
  return { chips: { ...chosen.chips }, confidence: chosen.confidence };
}

/** Validate through K1's parser (with a placeholder id) so the five chip fields
 *  get exactly the boundary rules a real read gets. */
function parseProposal(response: ModelResponse): ProposedRead | null {
  const text = response.content.find((block) => block.type === 'text')?.text;
  if (text === undefined || text === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null; // schema-invalid output is a rejected attempt, not a crash
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const chips = record['chips'];
  const confidence = record['confidence'];
  if (typeof chips !== 'object' || chips === null) return null;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence)) return null;
  if (confidence < 0 || confidence > 1) return null;
  try {
    const read = parseRead({ read_id: '00000000-0000-4000-8000-000000000000', ...chips });
    return {
      chips: {
        place: read.place,
        signal: read.signal,
        driver: read.driver,
        cadence: read.cadence,
        weight: read.weight,
      },
      confidence,
    };
  } catch {
    return null; // a named-field violation from parseRead = schema-invalid output
  }
}

/** The post-call re-check scans everything user-facing about the proposal. */
function chipsText(proposal: ProposedRead): string {
  const { place, signal, driver, cadence } = proposal.chips;
  return [place, signal, driver, cadence].join(' ').replaceAll('_', ' ');
}

export interface LiveExtractorDeps {
  client: ModelClient;
  flags: FlagStore;
  logger: Logger;
}

export function createLiveExtractor(deps: LiveExtractorDeps): Extractor {
  return {
    async propose(text: string, offLimits: string[]): Promise<ProposedRead | { blocked: true }> {
      // [E24]: a flagged confession is never sent anywhere — zero model calls.
      if (isBlocked(text, offLimits)) return { blocked: true };

      if (deps.flags.get().extraction !== 'seeded') {
        for (const attempt of ['first', 'retry'] as const) {
          const request: ModelRequest = {
            model: EXTRACTOR_MODEL,
            max_tokens: 1024,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: text }],
            output_config: { format: { type: 'json_schema', schema: PROPOSED_READ_SCHEMA } },
          };

          let response: ModelResponse;
          try {
            response = await deps.client.complete(request);
          } catch (error) {
            // Chip-preview call unavailable — degrade the flag (one logged line).
            deps.flags.set('extraction', 'seeded', 'model-unavailable');
            deps.logger.line(
              `extractor degraded to seeded: ${error instanceof Error ? error.message : String(error)}`,
            );
            break;
          }

          const proposal = parseProposal(response);
          if (proposal !== null) {
            // Re-check after the call ([E24]) — the model's output could carry
            // the flagged topic even when the confession slipped past mapping.
            if (isBlocked(chipsText(proposal), offLimits)) return { blocked: true };
            return proposal;
          }
          if (attempt === 'retry') {
            // Two schema-invalid outputs: flip the flag (exactly one logged line).
            deps.flags.set('extraction', 'seeded', 'schema-invalid');
          }
        }
      }

      const canned = cannedProposal(text);
      if (isBlocked(chipsText(canned), offLimits)) return { blocked: true };
      return canned;
    },
  };
}
