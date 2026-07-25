/**
 * `confit pass census` and `confit pass neartie` (X6) — The Pass's read-only
 * diagnostics, split from X7's mutations so they could land first.
 *
 * `census` is the rehearsal-time [E22] cross-check from design v0.8 §8: count
 * every driver through the same counting path Ask uses, compare against S2's
 * committed manifest, and flag any driver whose counted total fell short — a
 * COUNTING_K sized for the seed but not for seed-plus-live reads fails here,
 * the afternoon before, not on stage. `neartie` prints the two numbers the
 * demo's climax stands on: score(top1) − score(top3), and the shift a judge
 * read applies. No mutations anywhere in this module.
 */

import { readFileSync } from 'node:fs';
import { DEMO_CONTEXT, DRIVERS, type Driver, type Read } from '../contracts/types.js';
import { KFLOOR } from '../kernel/cohorts.js';
import { scorePlaces } from '../kernel/score.js';
import type { Place } from '../contracts/types.js';
import {
  DEMO_NOW,
  JUDGE_SHIFT_MIN,
  JUDGE_WEIGHT,
  NEAR_TIE_GAP_MAX,
  judgeShifts,
} from '../../scripts/seed/gen-seeds.js';
import { loadCorpus } from '../../scripts/seed/validate-corpus.js';
import { loadProfiles, type DemoProfile } from '../../scripts/seed/validate-profiles.js';
import type { CommandContext, CommandHandler } from './main.js';
import { EXIT, type CommandResult } from './render.js';

// ---------------------------------------------------------------------------
// census

export interface ManifestEntry {
  driver: Driver;
  k: number;
  places: string[];
}

export interface SeedManifest {
  manifest: ManifestEntry[];
}

export function loadManifest(): SeedManifest {
  return JSON.parse(
    readFileSync(new URL('../../data/seeds/manifest.json', import.meta.url), 'utf8'),
  ) as SeedManifest;
}

type CrossCheck = 'ok' | 'over' | 'MISMATCH';

export interface CensusDeps {
  readsForDriver: (driver: Driver) => Promise<{ reads: Read[]; degraded: boolean }>;
  manifest?: SeedManifest;
}

export function createCensusCommand(deps: CensusDeps): CommandHandler {
  return async (): Promise<CommandResult> => {
    const manifest = deps.manifest ?? loadManifest();
    const expected = new Map(manifest.manifest.map((entry) => [entry.driver, entry.k]));

    let degraded = false;
    const rows: Array<{
      driver: Driver;
      k: number;
      citable: boolean;
      manifest: number;
      crosscheck: CrossCheck;
    }> = [];

    for (const driver of DRIVERS) {
      const view = await deps.readsForDriver(driver);
      degraded ||= view.degraded;
      // Dedup on read_id defensively — the counting path already does, but a
      // census that could double-count would defeat its own cross-check.
      const k = new Set(view.reads.filter((r) => r.driver === driver).map((r) => r.read_id)).size;
      const manifestK = expected.get(driver) ?? 0;
      // Undercounting the seed is the [E22] failure; counting MORE than the
      // manifest just means live reads joined — expected, and disclosed.
      const crosscheck: CrossCheck = k === manifestK ? 'ok' : k > manifestK ? 'over' : 'MISMATCH';
      rows.push({ driver, k, citable: k >= KFLOOR, manifest: manifestK, crosscheck });
    }

    const mismatches = rows.filter((row) => row.crosscheck === 'MISMATCH').map((r) => r.driver);
    const width = Math.max(...DRIVERS.map((d) => d.length));
    const lines = [
      // Counts come from the relay either way under D-7, so they are exact even
      // when degraded. Saying "counts may be incomplete" here would tell an
      // operator to distrust the one number on this screen that is reliable.
      `Census (KFLOOR=${KFLOOR}${degraded ? ', induction unavailable — counts still exact' : ''}):`,
      ...rows.map(
        (row) =>
          `  ${row.driver.padEnd(width)}  k=${String(row.k).padStart(3)}  ` +
          `${row.citable ? 'citable' : 'below floor'}  manifest=${String(row.manifest).padStart(3)}  ${row.crosscheck}`,
      ),
      mismatches.length === 0
        ? 'Cross-check clean: no driver counted below its manifest total.'
        : `CROSS-CHECK MISMATCH — counted below manifest for: ${mismatches.join(', ')}. Do not start the demo ([E22]).`,
    ];

    return {
      lines,
      data: {
        kfloor: KFLOOR,
        degraded,
        drivers: rows,
        mismatches,
      },
      exit: mismatches.length === 0 ? EXIT.ok : EXIT.expectedFailure,
    };
  };
}

/** Production census: the live counting path — pool ∪ relay via M6. */
export const censusCommand: CommandHandler = (context: CommandContext) => {
  const graph = context.graph;
  return createCensusCommand({
    readsForDriver: (driver) => graph.poolView.readsForDriver(driver),
  })(context);
};

// ---------------------------------------------------------------------------
// neartie

export interface NeartieDeps {
  reads?: Read[];
  corpus?: Place[];
  profile?: DemoProfile;
  now?: string;
}

export function loadSeedReads(): Read[] {
  return (
    JSON.parse(
      readFileSync(new URL('../../data/seeds/reads.json', import.meta.url), 'utf8'),
    ) as { reads: Read[] }
  ).reads;
}

export function createNeartieCommand(deps: NeartieDeps = {}): CommandHandler {
  return (): Promise<CommandResult> => {
    const reads = deps.reads ?? loadSeedReads();
    const corpus = deps.corpus ?? loadCorpus();
    const profile = deps.profile ?? loadProfiles().b;
    const now = deps.now ?? DEMO_NOW;

    const ranked = scorePlaces({
      reads,
      usual: profile.usual,
      log: profile.mealLog,
      corpus,
      context: DEMO_CONTEXT,
      now,
    });
    const top1 = ranked[0];
    const top3 = ranked[2];
    if (!top1 || !top3) {
      return Promise.resolve({
        lines: ['Fewer than three candidates survive the hard constraints — no near-tie to inspect.'],
        data: { error: 'fewer than three candidates' },
        exit: EXIT.expectedFailure,
      });
    }

    const spread = top1.score - top3.score;
    const shifts = judgeShifts(reads, profile, corpus);
    const worstShift = shifts.length === 0 ? null : Math.min(...shifts.map((s) => s.shift));
    const ok =
      spread <= NEAR_TIE_GAP_MAX && shifts.length > 0 && shifts.every((s) => s.shift >= JUDGE_SHIFT_MIN);

    const lines = [
      // "score" and "weight" are both in K5's banned lexicon (design v0.8 §9,
      // SL-20) — even on this operator surface, `confit pass` is a shipping
      // command and X2's precedent is to keep the schema word in --json only.
      `Near-tie spread: top1 − top3 = ${spread.toFixed(4)} (max ${NEAR_TIE_GAP_MAX}) ${spread <= NEAR_TIE_GAP_MAX ? 'OK' : 'EXCEEDED'}`,
      ...ranked.slice(0, 3).map((entry, i) => `  top${i + 1}: ${entry.place.id}  fit=${entry.score.toFixed(4)}`),
      `Judge read delta (strength ${JUDGE_WEIGHT}, min shift ${JUDGE_SHIFT_MIN}):`,
      ...(shifts.length === 0
        ? ['  no matched driver offers a judge path — the peak beat has no lever']
        : shifts.map(
            (s) =>
              `  ${s.driver}: shift=${s.shift.toFixed(4)} → ${s.targetPlace} ${s.shift >= JUDGE_SHIFT_MIN ? 'OK' : 'TOO SMALL'}`,
          )),
      ok ? 'Near-tie invariant holds.' : 'Near-tie invariant DOES NOT hold — retune before the demo.',
    ];

    return Promise.resolve({
      lines,
      data: {
        spread,
        near_tie_gap_max: NEAR_TIE_GAP_MAX,
        judge_weight: JUDGE_WEIGHT,
        judge_shift_min: JUDGE_SHIFT_MIN,
        worst_shift: worstShift,
        top3: ranked.slice(0, 3).map((entry) => ({ place: entry.place.id, score: entry.score })),
        shifts: shifts.map((s) => ({ driver: s.driver, shift: s.shift, target: s.targetPlace })),
        ok,
      },
      exit: ok ? EXIT.ok : EXIT.expectedFailure,
    });
  };
}

/** Production neartie: the committed seed artifacts, same inputs G4 protects. */
export const neartieCommand: CommandHandler = (context: CommandContext) =>
  createNeartieCommand()(context);
