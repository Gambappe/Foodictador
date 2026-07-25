/**
 * Live narrator (L3) — card copy on `claude-sonnet-5` (design v0.8 §10 [E13]).
 *
 * Facts only, strict choose-from-corpus contract: the model writes about the
 * top-ranked candidate and may never introduce a venue or dish outside the
 * provided list. Output is gated by the K5 linter; a hit (or an ungrounded
 * response) triggers exactly one stricter regenerate, then the call falls back
 * to L1's template copy. The prompt never contains confession prose, and a
 * cohort below the floor is never sent to the model or cited.
 *
 * The model call goes through an injectable transport (house pattern, see
 * src/memory/client.ts) so the whole suite runs with no network and no key.
 */

import type { Narrator } from '../contracts/modules.js';
import type { CardCopy, NarratorFacts, RankedPlace } from '../contracts/types.js';
import type { FlagStore } from '../config/flagStore.js';
import type { Logger } from '../config/logger.js';
import { lint } from '../kernel/copylint.js';
import { DRIVER_PHRASES } from './catalog.js';
import { TemplateNarrator } from './template.js';

/**
 * The [C4] slice floor. K4's constants.ts is this value's eventual single home;
 * it has not landed yet, so the narrator carries its own guard — reconcile when
 * lane K ships src/kernel/constants.ts.
 */
const KFLOOR = 5;

export const NARRATOR_MODEL = 'claude-sonnet-5';

/** Structured-output schema for the card copy — closed, reasonLine required. */
export const CARD_COPY_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    reasonLine: { type: 'string' },
    rotationLine: { type: 'string' },
    usualLine: { type: 'string' },
    cohortMissLine: { type: 'string' },
  },
  required: ['reasonLine'],
  additionalProperties: false,
};

export interface ModelRequest {
  model: string;
  max_tokens: number;
  system: string;
  messages: Array<{ role: 'user'; content: string }>;
  output_config: { format: { type: 'json_schema'; schema: Record<string, unknown> } };
  thinking: { type: 'disabled' };
}

export interface ModelResponse {
  stop_reason: string;
  content: Array<{ type: string; text?: string }>;
}

/** Injectable model transport so the whole suite runs with no network (DAG §1). */
export interface ModelClient {
  complete(req: ModelRequest): Promise<ModelResponse>;
}

/** Live transport against the Anthropic Messages API. */
export function createFetchModelClient(
  apiKey: string,
  baseUrl = 'https://api.anthropic.com',
): ModelClient {
  return {
    async complete(req: ModelRequest): Promise<ModelResponse> {
      const res = await fetch(new URL('/v1/messages', baseUrl), {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`narrator: model call failed with status ${res.status}`);
      const json = (await res.json()) as ModelResponse;
      return json;
    },
  };
}

const SYSTEM_PROMPT = [
  'You write the copy for a food recommendation card.',
  'You are given ranked candidates and a set of facts. The ranking is already decided:',
  'write about the FIRST candidate and name it in the reason line.',
  'Every clause must trace to a provided fact. Never introduce a venue or dish that',
  'is not in the candidates list. Never mention how much anyone ate or should eat,',
  'body measurements, energy counts, dieting, streaks, points, or daily totals.',
  'Cite the cohort only with the provided count and phrase — never quote or invent',
  'what any person said.',
  'Respond with JSON only, matching the schema.',
].join(' ');

const STRICT_ADDENDUM = [
  'Your previous attempt was rejected: it named a venue outside the candidates list',
  'or used forbidden vocabulary. Write plainer copy, mention the first candidate by',
  'its exact name, and use only the provided facts.',
].join(' ');

/**
 * The prompt payload. Built exclusively from NarratorFacts and RankedPlace —
 * neither carries confession prose, and this function adds none. A citation
 * below KFLOOR is dropped here so the model can never see or cite it.
 */
function buildUserPayload(ranked: RankedPlace[], facts: NarratorFacts): string {
  const payload: Record<string, unknown> = {
    candidates: ranked.map((entry) => ({
      id: entry.place.id,
      name: entry.place.name,
      cuisine: entry.place.cuisine,
      priceBand: entry.place.priceBand,
      tags: entry.place.tags,
      dishes: entry.place.signatureDishes.map((dish) => dish.name),
      score: entry.score,
    })),
    facts: {
      ...(facts.inducedClaim !== undefined ? { inducedClaim: facts.inducedClaim } : {}),
      ...(facts.citation && facts.citation.k >= KFLOOR
        ? {
            citation: {
              driverPhrase: DRIVER_PHRASES[facts.citation.driver],
              k: facts.citation.k,
            },
          }
        : {}),
      ...(facts.cohortMiss
        ? { cohortMiss: { driverPhrase: DRIVER_PHRASES[facts.cohortMiss.driver] } }
        : {}),
      suppressions: facts.suppressions.map((s) => ({
        dish: s.dishId.replaceAll('_', ' '),
        reasonKey: s.reasonKey,
      })),
      usualNotes: facts.usualNotes,
      degradedPool: facts.degradedPool,
    },
  };
  return JSON.stringify(payload);
}

function parseCopy(response: ModelResponse): CardCopy | null {
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
  const reasonLine = record['reasonLine'];
  if (typeof reasonLine !== 'string' || reasonLine === '') return null;
  const copy: CardCopy = { reasonLine };
  for (const key of ['rotationLine', 'usualLine', 'cohortMissLine'] as const) {
    const value = record[key];
    if (value !== undefined) {
      if (typeof value !== 'string') return null;
      copy[key] = value;
    }
  }
  return copy;
}

/**
 * Reject copy that fails the linter or is not grounded in the assigned pick.
 * The grounding check is the enforceable half of choose-from-corpus: copy that
 * names some other venue cannot contain the pick it was told to write about.
 */
function violation(copy: CardCopy, ranked: RankedPlace[]): string | null {
  const pick = ranked[0];
  if (pick && !copy.reasonLine.includes(pick.place.name)) {
    return `reason line does not name the pick "${pick.place.name}"`;
  }
  const lines = [copy.reasonLine, copy.rotationLine, copy.usualLine, copy.cohortMissLine];
  for (const line of lines) {
    if (line === undefined) continue;
    const result = lint(line);
    if (!result.ok) return `banned term(s): ${result.hits.join(', ')}`;
  }
  return null;
}

export interface LiveNarratorDeps {
  client: ModelClient;
  flags: FlagStore;
  logger: Logger;
}

export function createLiveNarrator(deps: LiveNarratorDeps): Narrator {
  const template = new TemplateNarrator();

  return {
    async write(ranked: RankedPlace[], facts: NarratorFacts): Promise<CardCopy> {
      // Under narrator=template, delegate without a request (degrade table, §6).
      if (deps.flags.get().narrator === 'template') {
        return template.write(ranked, facts);
      }

      const userPayload = buildUserPayload(ranked, facts);
      for (const strict of [false, true]) {
        const request: ModelRequest = {
          model: NARRATOR_MODEL,
          max_tokens: 1024,
          system: strict ? `${SYSTEM_PROMPT} ${STRICT_ADDENDUM}` : SYSTEM_PROMPT,
          messages: [{ role: 'user', content: userPayload }],
          output_config: { format: { type: 'json_schema', schema: CARD_COPY_SCHEMA } },
          thinking: { type: 'disabled' },
        };

        let response: ModelResponse;
        try {
          response = await deps.client.complete(request);
        } catch (error) {
          // Ask assembly unavailable — flip the flag (one logged line) and degrade.
          deps.flags.set('narrator', 'template', 'model-unavailable');
          deps.logger.line(
            `narrator degraded to template: ${error instanceof Error ? error.message : String(error)}`,
          );
          return template.write(ranked, facts);
        }

        const copy = parseCopy(response);
        const problem = copy === null ? 'unparseable model output' : violation(copy, ranked);
        if (copy !== null && problem === null) return copy;
        deps.logger.line(
          `narrator rejected ${strict ? 'regenerated' : 'first'} attempt: ${problem ?? 'unknown'}`,
        );
      }

      // One regenerate spent — this call templates; the flag stays live.
      return template.write(ranked, facts);
    },
  };
}
