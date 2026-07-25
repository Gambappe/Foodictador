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
import { KFLOOR } from '../kernel/cohorts.js';
import { lint } from '../kernel/copylint.js';
import { DRIVER_PHRASES, renderTemplate } from './catalog.js';
import { TemplateNarrator } from './template.js';

export const NARRATOR_MODEL = 'claude-sonnet-5';

/**
 * The personal line is NOT model-generated, in either narrator (M16).
 *
 * It is a fixed catalog frame around text XTrace already synthesised, so handing it to a model
 * would add a third layer of paraphrase — extraction, then synthesis, then rewriting — to a
 * claim being made about the reader, which is the one place on the card where drift matters
 * most. Both narrators therefore produce it identically, from `CATALOG.personal_pattern`.
 */
function withPersonalLine(copy: CardCopy, facts: NarratorFacts): CardCopy {
  const claim = facts.personalClaim;
  if (claim === undefined || claim.trim() === '') return copy;
  return { ...copy, personalLine: renderTemplate('personal_pattern', { claim }) };
}

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
  /** Omitted on models whose thinking config differs (L2's claude-haiku-4-5). */
  thinking?: { type: 'disabled' };
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
      ...(facts.poolClaim !== undefined ? { inducedClaim: facts.poolClaim } : {}),
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
 * A capitalised multi-word run — the shape of a venue or dish name appearing
 * mid-copy. Single capitalised words are indistinguishable from sentence
 * starts, so the net is two-or-more; that is the reviewed trade (SL-05): a
 * missed single-word hallucination degrades to template copy elsewhere, while
 * a false positive costs one regenerate.
 */
const NAME_RUN = /[A-Z][\w'’]*(?:\s+[A-Z][\w'’]*)+/g;

/** Every name the model was given and may therefore echo. */
function allowedNames(ranked: RankedPlace[]): string[] {
  return ranked.flatMap((entry) => [
    entry.place.name,
    ...entry.place.signatureDishes.map((dish) => dish.name),
  ]);
}

/**
 * The first name-shaped run in `line` that matches nothing the model was given.
 *
 * `name.includes(run)` only — a run may be a fragment of a real candidate ("Rosa's" for
 * "Rosa's Taqueria"), but a run that merely *contains* one is a different venue. That
 * second disjunct used to be here and it was a hole (SL-32): the pick's name is always
 * allowed, so "Rosa's Taqueria Downtown Annex" passed as grounded while naming a place
 * that does not exist. Extending a real name is precisely how a plausible invention
 * looks.
 */
function offCorpusRun(line: string, allowed: string[]): string | null {
  for (const match of line.matchAll(NAME_RUN)) {
    const run = match[0];
    if (!allowed.some((name) => name.includes(run))) return run;
  }
  return null;
}

/**
 * Reject copy that fails the linter or breaks the choose-from-corpus contract.
 * Grounding is enforced on EVERY line (SL-05 — it used to cover only the
 * reason line, so an invented venue in the rotation or usual line sailed
 * through): the reason line must name the assigned pick, and no line may
 * carry a name-shaped run outside the provided candidates and their dishes.
 */
function violation(copy: CardCopy, ranked: RankedPlace[]): string | null {
  const pick = ranked[0];
  if (pick && !copy.reasonLine.includes(pick.place.name)) {
    return `reason line does not name the pick "${pick.place.name}"`;
  }
  const allowed = allowedNames(ranked);
  const lines: Array<[string, string | undefined]> = [
    ['reason', copy.reasonLine],
    ['rotation', copy.rotationLine],
    ['usual', copy.usualLine],
    ['cohort-miss', copy.cohortMissLine],
  ];
  for (const [label, line] of lines) {
    if (line === undefined) continue;
    const stray = offCorpusRun(line, allowed);
    if (stray !== null) return `${label} line names off-corpus "${stray}"`;
    const result = lint(line);
    if (!result.ok) return `banned term(s): ${result.hits.join(', ')}`;
  }
  return null;
}

/** Transport failures in a row before the narrator flag flips (D2 on PR #14):
 * one 429 is a bad moment, not an unavailable service — a single blip must not
 * silently degrade every later card. */
export const FLIP_AFTER_CONSECUTIVE_FAILURES = 3;

export interface LiveNarratorDeps {
  client: ModelClient;
  flags: FlagStore;
  logger: Logger;
}

export function createLiveNarrator(deps: LiveNarratorDeps): Narrator {
  const template = new TemplateNarrator();
  // D2: template THIS call on a transport error; flip the flag only after
  // FLIP_AFTER_CONSECUTIVE_FAILURES in a row; any success resets the count.
  let consecutiveFailures = 0;

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
          consecutiveFailures = 0;
        } catch (error) {
          consecutiveFailures += 1;
          deps.logger.line(
            `narrator transport error (${consecutiveFailures}/${FLIP_AFTER_CONSECUTIVE_FAILURES}), templating this card: ${error instanceof Error ? error.message : String(error)}`,
          );
          if (consecutiveFailures >= FLIP_AFTER_CONSECUTIVE_FAILURES) {
            deps.flags.set('narrator', 'template', 'model-unavailable');
          }
          return template.write(ranked, facts);
        }

        const copy = parseCopy(response);
        const problem = copy === null ? 'unparseable model output' : violation(copy, ranked);
        if (copy !== null && problem === null) return withPersonalLine(copy, facts);
        deps.logger.line(
          `narrator rejected ${strict ? 'regenerated' : 'first'} attempt: ${problem ?? 'unknown'}`,
        );
      }

      // One regenerate spent — this call templates; the flag stays live.
      return template.write(ranked, facts);
    },
  };
}
