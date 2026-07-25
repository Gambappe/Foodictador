import { describe, expect, it, vi } from 'vitest';
import type { Extractor, PoolStore, Relay, UserStore } from '../contracts/modules.js';
import type { MealLogEntry, Read, UsualProfile } from '../contracts/types.js';
import { createLogger } from '../config/logger.js';
import { lint } from '../kernel/copylint.js';
import { EXIT } from './render.js';
import {
  CONSENT_LINES,
  chipLines,
  confess,
  createConfessHandler,
  type ConfessDeps,
} from './confess.js';
import type { CommandContext } from './main.js';
import { fixtureGraph } from '../config/wiring.js';
import { parseArgv } from './args.js';

const chips: Omit<Read, 'read_id'> = {
  place: 'rosas_taqueria',
  signal: 'returns_despite_incident',
  driver: 'companion_constraint',
  cadence: 'weekly',
  weight: 0.81,
};

const usual: UsualProfile = {
  spiceTolerance: 1,
  budgetBand: 2,
  portionPref: 'small',
  soloComfort: true,
  giConstraint: false,
  offLimits: [],
};

/** Fixture stores that record what was asked of them. */
function harness(options: {
  offLimits?: string[];
  proposal?: Awaited<ReturnType<Extractor['propose']>>;
  relayFails?: boolean;
  poolFails?: boolean;
  noProfile?: boolean;
  confirmed?: boolean;
} = {}) {
  const calls = { relayPut: 0, poolWrite: 0, prose: 0, propose: 0, confirm: 0 };

  const relay: Relay = {
    put: vi.fn(async () => {
      calls.relayPut += 1;
      if (options.relayFails === true) throw new Error('relay down');
      return Promise.resolve();
    }),
    setJob: vi.fn(() => Promise.resolve()),
    list: vi.fn(() => Promise.resolve([])),
    drop: vi.fn(() => Promise.resolve()),
    stats: vi.fn(() => Promise.resolve({ count: 0, oldest_entry_age_seconds: 0 })),
    seed: vi.fn(() => Promise.resolve(0)),
    reset: vi.fn(() => Promise.resolve()),
  };

  const pool: PoolStore = {
    writeRead: vi.fn(async () => {
      calls.poolWrite += 1;
      if (options.poolFails === true) throw new Error('pool down');
      return Promise.resolve({ jobId: 'job-pool' });
    }),
    // A live confession is one read, so confess must NOT batch — batching exists for the
    // seed path, where many reads share a conversation (M12).
    writeReads: vi.fn(() => Promise.reject(new Error('confess writes one read'))),
    inducedClaim: vi.fn(() => Promise.resolve('')),
  };

  const user: UserStore = {
    writeProse: vi.fn(() => {
      calls.prose += 1;
      return Promise.resolve({ jobId: 'job-prose' });
    }),
    // Returns null for an unprovisioned profile, exactly as the contract declares. The
    // first version of this harness threw instead, which let the command's own null
    // handling go untested while the test still passed.
    usual: vi.fn(() =>
      Promise.resolve(
        options.noProfile === true ? null : { ...usual, offLimits: options.offLimits ?? [] },
      ),
    ),
    setUsual: vi.fn(() => Promise.resolve()),
    mealLog: vi.fn(() => Promise.resolve([] as MealLogEntry[])),
    setMealLog: vi.fn(() => Promise.resolve()),
  };

  const extractor: Extractor = {
    propose: vi.fn(() => {
      calls.propose += 1;
      return Promise.resolve(options.proposal ?? { chips, confidence: 0.9 });
    }),
  };

  const deps: ConfessDeps = {
    extractor,
    write: { relay, pool, user, logger: createLogger(() => undefined) },
    confirm: vi.fn(() => {
      calls.confirm += 1;
      return Promise.resolve(options.confirmed ?? true);
    }),
  };

  return { deps, calls };
}

const input = { profile: 'A', text: 'I only go because my sister likes it.', assumeYes: true };

describe('the happy path', () => {
  it('prints the five chips, the read_id and per-target status', async () => {
    const { deps } = harness();
    const result = await confess(deps, input);
    const text = result.lines.join('\n');

    expect(result.exit).toBe(EXIT.ok);
    expect(text).toContain('rosas_taqueria');
    expect(text).toContain('returns despite incident');
    expect(text).toContain('companion constraint');
    expect(text).toContain('weekly');
    expect(text).toMatch(/Added to the pot as [0-9a-f-]{36}\./);
    expect(text).toContain('relay          ok');
    expect(text).toContain('your memory    ok');
    expect(result.data).toMatchObject({ blocked: false, approved: true, pooled: true });
  });

  it('writes to all three targets', async () => {
    const { deps, calls } = harness();
    await confess(deps, input);
    expect(calls).toMatchObject({ relayPut: 1, poolWrite: 1, prose: 1 });
  });
});

describe('consent copy — design v0.8 [E27]', () => {
  it('states both halves before anything is written', async () => {
    const { deps } = harness();
    const result = await confess(deps, input);
    const text = result.lines.join('\n');
    for (const line of CONSENT_LINES) expect(text).toContain(line);
    // Asserted on the strings so the sentence cannot be dropped silently — the chip
    // screen implying five fields are all that leave the device is the thing [E27] fixes.
    expect(text).toMatch(/your private Confit memory/i);
    expect(text).toMatch(/only the five fields/i);
  });

  it('appears before the pot confirmation, not after', async () => {
    const { deps } = harness({ confirmed: false });
    const result = await confess(deps, { ...input, assumeYes: false });
    const text = result.lines.join('\n');
    // Declined, so nothing was written — and the consent copy was still shown.
    for (const line of CONSENT_LINES) expect(text).toContain(line);
  });
});

describe('the word "weight" never reaches the author', () => {
  it('renders no banned term in the chip preview', () => {
    // `Read.weight` is a schema field, and `weight` is in K5's banned lexicon because
    // design v0.8 §9 forbids the product commenting on it. A diner reading "weight: 0.81"
    // beside a description of their eating is precisely what §9 exists to prevent.
    for (const line of chipLines(chips)) {
      expect(lint(line)).toEqual({ ok: true });
    }
    expect(chipLines(chips).join('\n')).toContain('strength');
  });

  it('renders no banned term anywhere in the output', async () => {
    const { deps } = harness();
    const result = await confess(deps, input);
    for (const line of result.lines) expect(lint(line)).toEqual({ ok: true });
  });

  it('keeps the schema name in the machine payload, where no diner reads it', async () => {
    const { deps } = harness();
    const result = await confess(deps, input);
    expect(result.data.chips).toMatchObject({ weight: 0.81 });
  });
});

describe('a blocked topic', () => {
  it('exits 1 and writes nothing at all', async () => {
    const { deps, calls } = harness({ proposal: { blocked: true }, offLimits: ['sister'] });
    const result = await confess(deps, input);
    expect(result.exit).toBe(EXIT.expectedFailure);
    expect(calls).toMatchObject({ relayPut: 0, poolWrite: 0, prose: 0 });
    expect(result.data).toMatchObject({ blocked: true, wrote: null });
  });

  it('gives the same refusal whichever layer caught it', async () => {
    // L2 blocks early as an optimisation; M5's check is authoritative. The author must
    // not be able to tell which one fired.
    const early = await confess(harness({ proposal: { blocked: true } }).deps, input);
    const late = await confess(harness({ offLimits: ['sister'] }).deps, input);
    expect(late.exit).toBe(EXIT.expectedFailure);
    expect(late.lines).toEqual(early.lines);
  });

  it('writes nothing when only M5 catches it', async () => {
    // L2 waved it through; K2 via M5 must still stop every write.
    const { deps, calls } = harness({ offLimits: ['sister'] });
    await confess(deps, input);
    expect(calls).toMatchObject({ relayPut: 0, poolWrite: 0, prose: 0 });
  });

  it('says the topic is off-limits without repeating the topic back', async () => {
    const { deps } = harness({ proposal: { blocked: true }, offLimits: ['sister'] });
    const result = await confess(deps, input);
    expect(result.lines.join('\n')).not.toContain('sister');
  });
});

describe('confirmation', () => {
  it('asks when --yes was not passed', async () => {
    const { deps, calls } = harness();
    await confess(deps, { ...input, assumeYes: false });
    expect(calls.confirm).toBe(1);
  });

  it('does not ask when --yes was passed', async () => {
    const { deps, calls } = harness();
    await confess(deps, input);
    expect(calls.confirm).toBe(0);
  });

  it('writes nothing and exits 0 when the author declines', async () => {
    // Declining is the gate working as designed, not a failure of the command.
    const { deps, calls } = harness({ confirmed: false });
    const result = await confess(deps, { ...input, assumeYes: false });
    expect(result.exit).toBe(EXIT.ok);
    expect(calls).toMatchObject({ relayPut: 0, poolWrite: 0, prose: 0 });
    expect(result.data).toMatchObject({ approved: false, wrote: null });
  });
});

describe('partial failures', () => {
  it('exits 1 when the relay write fails, because the read is not pooled', async () => {
    const { deps } = harness({ relayFails: true });
    const result = await confess(deps, input);
    expect(result.exit).toBe(EXIT.expectedFailure);
    expect(result.lines.join('\n')).toContain('NOT pooled');
    expect(result.data).toMatchObject({ pooled: false });
  });

  it('exits 0 when only the pool write fails, since the sweeper recovers it', async () => {
    // M5 writes the relay first precisely so this case is recoverable.
    const { deps } = harness({ poolFails: true });
    const result = await confess(deps, input);
    expect(result.exit).toBe(EXIT.ok);
    expect(result.data).toMatchObject({ pooled: true });
    expect((result.data.warnings as string[]).join(' ')).toMatch(/pool/i);
  });

  it('surfaces every warning M5 reported', async () => {
    const { deps } = harness({ poolFails: true });
    const result = await confess(deps, input);
    const warnings = result.data.warnings as string[];
    expect(warnings.length).toBeGreaterThan(0);
    for (const warning of warnings) expect(result.lines.join('\n')).toContain(warning);
  });
});

describe('an unprovisioned profile', () => {
  it('says what to run instead of crashing on the null', async () => {
    const { deps, calls } = harness({ noProfile: true });
    const result = await confess(deps, { ...input, profile: 'B' });
    expect(result.exit).toBe(EXIT.expectedFailure);
    expect(result.lines.join('\n')).toContain('confit pass provision --profile B');
    expect(calls).toMatchObject({ propose: 0, relayPut: 0, prose: 0 });
  });
});

describe('the CommandHandler adapter', () => {
  /** A context shaped the way X1 hands one over. */
  function context(argvWords: string[]): CommandContext {
    return {
      argv: parseArgv(argvWords),
      config: {
        xtraceBaseUrl: 'x',
        xtraceApiKey: 'k',
        relayUrl: 'r',
        relayToken: 't',
        anthropicApiKey: null,
        settleWindowSeconds: 480,
      },
      flags: {
        get: () => ({
          extraction: 'seeded',
          narrator: 'template',
          pool: 'live',
          demoMode: true,
        }),
        set: () => undefined,
      },
      logger: createLogger(() => undefined),
      // Present only to satisfy CommandContext; this suite injects its own deps into
      // createConfessHandler. Fixture stores, never a live graph.
      graph: fixtureGraph({ logger: createLogger(() => undefined) }),
    };
  }

  it('reads profile, text and --yes off the parsed argv', async () => {
    const { deps, calls } = harness();
    const handler = createConfessHandler(deps);
    const argv = ['confess', '--profile', 'A', '--text', 'a thing', '--yes'];
    const result = await handler(context(argv));
    expect(result.exit).toBe(EXIT.ok);
    expect(calls.confirm).toBe(0); // --yes was honoured
    expect(calls.relayPut).toBe(1);
  });

  it('asks for confirmation when --yes is absent', async () => {
    const { deps, calls } = harness({ confirmed: false });
    const handler = createConfessHandler(deps);
    const result = await handler(context(['confess', '--profile', 'A', '--text', 'a thing']));
    expect(calls.confirm).toBe(1);
    expect(result.data).toMatchObject({ approved: false });
  });
});

describe('X2 confess — what off-limits does NOT do (D-9)', () => {
  it('the refusal says off-limits gates recording, not recommendations', async () => {
    // Option (c): Confit does not screen allergens, and the corpus carries no allergen data
    // to screen with — six place tags, none of them an allergen. "Off-limits" plus a
    // free-text box reads as "keep me away from this", so the refusal is the moment to say
    // what it actually covers. A safety-shaped silence is a promise the user makes to
    // themselves on our behalf.
    for (const h of [
      harness({ proposal: { blocked: true } }), // caught early, by L2
      harness({ offLimits: ['sister'] }), // caught late, by M5
    ]) {
      const result = await confess(h.deps, input);
      const printed = result.lines.join('\n');
      expect(result.data['blocked']).toBe(true);
      expect(printed).toMatch(/not where it sends you/);
      expect(printed).toMatch(/does not check menus for allergens/i);
    }
  });
});
