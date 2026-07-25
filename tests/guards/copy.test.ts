/**
 * G3 — copy-linter regression (design v0.8 §9, [C9]).
 *
 * Every string the product can render comes from L1's catalog or the template
 * narrator over it; this suite pushes all of them through the K5 linter, plus
 * one case per banned lexicon entry — so extending the lexicon without fixing
 * the copy fails HERE, in CI, not on a card.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_FLAGS } from '../../src/contracts/flags.js';
import { corpusFixture } from '../../src/contracts/fixtures/index.js';
import type { Driver, NarratorFacts, RankedPlace } from '../../src/contracts/types.js';
import { createFlagStore, createLogger } from '../../src/config/index.js';
import type { AppConfig } from '../../src/config/index.js';
import { fixtureGraph } from '../../src/config/wiring.js';
import { parseArgv } from '../../src/cli/args.js';
import type { CommandContext } from '../../src/cli/main.js';
import { createCensusCommand, createNeartieCommand } from '../../src/cli/pass-report.js';
import { createForgetCommand } from '../../src/cli/forget.js';
import { createSweepCommand } from '../../src/cli/sweep.js';
import { runFlags, runNudgeArm, runProvision, runReset } from '../../src/cli/pass-ops.js';
import { createNudge } from '../../src/nudge/nudge.js';
import type { ForgetReport } from '../../src/memory/forget.js';
import { StubRelay, StubUserStore } from '../../src/contracts/stubs/index.js';
import { lint } from '../../src/kernel/copylint.js';
import { BANNED_LEXICON } from '../../src/kernel/lexicon.js';
import {
  CATALOG,
  DRIVER_PHRASES,
  USUAL_PHRASES,
  renderTemplate,
  type CatalogKey,
} from '../../src/llm/catalog.js';
import { TemplateNarrator } from '../../src/llm/template.js';

/** Benign slot values for rendering every template. */
const SLOTS: Record<string, string> = {
  pick: "Rosa's Taqueria",
  claim: 'Hygiene complaints under-predict loyalty here.',
  k: '6',
  driverPhrase: 'your real spice tolerance',
  dish: 'shoyu ramen',
};

function ranked(): RankedPlace[] {
  return corpusFixture.slice(0, 3).map((place, i) => ({
    place,
    score: 0.8 - i * 0.02,
    parts: { pool: 0.3, usual: 0.2, rotation: 0.2, context: 0.1 },
  }));
}

function baseFacts(): NarratorFacts {
  return { suppressions: [], usualNotes: [], degradedPool: false };
}

/** Every card variant the template narrator can produce — the narrator fixtures. */
const FACT_VARIANTS: Array<[string, NarratorFacts]> = [
  ['plain', baseFacts()],
  ['cited', { ...baseFacts(), citation: { driver: 'spice_tolerance_low', k: 6 } }],
  ['induced', { ...baseFacts(), poolClaim: 'Hygiene complaints under-predict loyalty here.' }],
  [
    'induced + cited',
    {
      ...baseFacts(),
      poolClaim: 'The lunch menu is the honest menu here.',
      citation: { driver: 'budget_ceiling', k: 7 },
    },
  ],
  ['cohort miss', { ...baseFacts(), cohortMiss: { driver: 'crowd_aversion' } }],
  [
    'suppression',
    { ...baseFacts(), suppressions: [{ dishId: 'shoyu_ramen', reasonKey: 'eaten_twice_recently' }] },
  ],
  [
    'unknown suppression key',
    { ...baseFacts(), suppressions: [{ dishId: 'al_pastor', reasonKey: 'some_future_reason' }] },
  ],
  ['degraded pool', { ...baseFacts(), degradedPool: true }],
];

describe('G3: every catalog template is linter-clean', () => {
  for (const key of Object.keys(CATALOG) as CatalogKey[]) {
    it(`template "${key}"`, () => {
      expect(lint(renderTemplate(key, SLOTS))).toEqual({ ok: true });
    });
  }
});

describe('G3: every driver phrase is linter-clean', () => {
  for (const [driver, phrase] of Object.entries(DRIVER_PHRASES)) {
    it(`phrase for ${driver}`, () => {
      expect(lint(phrase)).toEqual({ ok: true });
    });
  }
});

describe('G3: every template-narrator output variant is linter-clean', () => {
  const narrator = new TemplateNarrator();
  for (const [label, facts] of FACT_VARIANTS) {
    it(`variant: ${label}`, async () => {
      const copy = await narrator.write(ranked(), facts);
      for (const line of [copy.reasonLine, copy.rotationLine, copy.usualLine, copy.cohortMissLine]) {
        if (line !== undefined) expect(lint(line)).toEqual({ ok: true });
      }
    });
  }
});

describe('G3: one case per banned lexicon entry', () => {
  // Extending the lexicon adds a case here automatically; a term the linter
  // stops catching (e.g. a regression in inflection handling) fails by name.
  for (const term of BANNED_LEXICON) {
    it(`"${term}" is caught inside a card-shaped sentence`, () => {
      const result = lint(`A quiet pick tonight — about your ${term}, mostly.`);
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unreachable');
      expect(result.hits).toContain(term);
    });
  }
});

describe('G3: the acceptance cases', () => {
  it('a deliberately inserted streak line fails', () => {
    expect(lint("you're on a 3-day streak").ok).toBe(false);
  });

  it('lints every usual-line phrase', () => {
    // Defect SL-21: these ten strings are card copy but live outside CATALOG, so this
    // guard's CATALOG sweep never reached them. The first fix only added a sweep to L1's
    // own suite, which left G3 — the task whose whole job is catching unlinted copy —
    // still blind to them. A budget or portion phrase is exactly where `weight` or
    // `portion control` would appear.
    for (const [key, phrase] of Object.entries(USUAL_PHRASES)) {
      expect(lint(phrase), `${key}: ${phrase}`).toEqual({ ok: true });
    }
  });

  it('a realistic dirty card line names every term that fired', () => {
    const result = lint('Great progress — a guilt-free pick that fits your diet.');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unreachable');
    expect(result.hits).toEqual(expect.arrayContaining(['progress', 'guilt', 'diet']));
  });
});

// ---------------------------------------------------------------------------
// SL-20: exactly one command module (X2's confess.test.ts) linted its own
// output; nothing cross-cutting linted the rest, so `pass-report.ts` shipped
// "weight" and "score" on the operator's screen unnoticed. This sweeps every
// CommandResult.lines[] the other six command modules can produce through the
// same K5 linter G3 already runs over cards, so a future banned-lexicon slip
// in ANY CLI line fails here rather than needing a fresh probe to find it.

const APP_CONFIG: AppConfig = {
  xtraceBaseUrl: 'http://localhost:1',
  xtraceApiKey: 'k',
  relayUrl: 'http://localhost:2',
  relayToken: 't',
  anthropicApiKey: null,
  settleWindowSeconds: 480,
  proseBufferPath: '/tmp/confit-copy-guard-buffer',
};

function cliContext(args: string[]): CommandContext {
  const logger = createLogger(() => {});
  return {
    argv: parseArgv(args),
    config: APP_CONFIG,
    flags: createFlagStore({ ...DEFAULT_FLAGS }, logger),
    logger,
    graph: fixtureGraph({ logger }),
  };
}

function lintLines(lines: string[]): void {
  for (const line of lines) {
    expect(lint(line), line).toEqual({ ok: true });
  }
}

describe('G3: every CLI command line is linter-clean', () => {
  it('pass census', async () => {
    const reads = (driver: Driver) =>
      Promise.resolve({
        reads:
          driver === 'spice_tolerance_low'
            ? [
                {
                  read_id: '00000000-0000-4000-8000-000000000000',
                  place: 'place_0',
                  signal: 'secret_default' as const,
                  driver,
                  cadence: 'weekly' as const,
                  weight: 0.7,
                },
              ]
            : [],
        degraded: false,
      });
    const result = await createCensusCommand({ readsForDriver: reads })(cliContext(['pass', 'census']));
    lintLines(result.lines);
  });

  it('pass neartie', async () => {
    const result = await createNeartieCommand()(cliContext(['pass', 'neartie']));
    lintLines(result.lines);
  });

  it('forget: every target status combination', async () => {
    const combos: Array<ForgetReport> = [
      {
        read_id: 'r1',
        ok: true,
        pool: { status: 'deleted', count: 2 },
        relay: { status: 'deleted', count: 1 },
        user: { status: 'skipped', detail: 'no user-scope handles for this read' },
        buffer: { status: 'nothing_to_delete' },
      },
      {
        read_id: 'r2',
        ok: true,
        pool: { status: 'nothing_to_delete' },
        relay: { status: 'nothing_to_delete' },
        user: { status: 'nothing_to_delete' },
        buffer: { status: 'nothing_to_delete' },
      },
      {
        read_id: 'r3',
        ok: false,
        pool: { status: 'failed', detail: 'relay unreachable' },
        relay: { status: 'deleted', count: 1 },
        user: { status: 'skipped', detail: 'no user-scope handles for this read' },
        buffer: { status: 'deleted', count: 1 },
      },
    ];
    for (const report of combos) {
      const result = await createForgetCommand(() => Promise.resolve(report))(
        cliContext(['forget', report.read_id]),
      );
      lintLines(result.lines);
    }
  });

  it('sweep --once', async () => {
    const result = await createSweepCommand({
      sweep: () =>
        Promise.resolve({ pooled: 3, reingested: 1, pending: 2, ledgered: 4, stored: 6, oldestStoredAgeSeconds: 40 }),
    })(cliContext(['sweep', '--once']));
    lintLines(result.lines);
  });

  it('pass provision, reset, flags, nudge', async () => {
    const logger = createLogger(() => {});
    const userStore = new StubUserStore();
    lintLines((await runProvision('all', { userStore, logger })).lines);
    lintLines((await runProvision('nonsense', { userStore, logger })).lines);

    const relay = new StubRelay();
    lintLines((await runReset({ relay, confirm: () => Promise.resolve(false) })).lines);
    lintLines((await runReset({ relay, yes: true })).lines);

    const flags = createFlagStore({ ...DEFAULT_FLAGS }, logger);
    lintLines(runFlags(undefined, flags).lines);
    lintLines(runFlags('narrator=live', flags).lines);
    lintLines(runFlags('narrator=live', flags).lines); // no-op branch: "already ... — no change"
    lintLines(runFlags('nope=x', flags).lines);
    lintLines(runFlags('narrator=nope', flags).lines);
    lintLines(runFlags('badformat', flags).lines);

    const nudge = createNudge();
    lintLines(runNudgeArm(nudge, false).lines);
    lintLines(runNudgeArm(nudge, true).lines);
  });
});
