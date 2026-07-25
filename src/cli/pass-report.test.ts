import { describe, expect, it } from 'vitest';

import { DEFAULT_FLAGS } from '../contracts/flags.js';
import { DRIVERS, type Driver, type Read } from '../contracts/types.js';
import { createFlagStore, createLogger } from '../config/index.js';
import type { AppConfig } from '../config/index.js';
import { KFLOOR } from '../kernel/cohorts.js';
import { loadProfiles } from '../../scripts/seed/validate-profiles.js';
import { fixtureGraph } from '../config/wiring.js';
import { parseArgv } from './args.js';
import type { CommandContext } from './main.js';
import {
  createCensusCommand,
  createNeartieCommand,
  type SeedManifest,
} from './pass-report.js';
import { EXIT } from './render.js';

const CONFIG: AppConfig = {
  xtraceBaseUrl: 'http://localhost:1',
  xtraceApiKey: 'k',
  relayUrl: 'http://localhost:2',
  relayToken: 't',
  anthropicApiKey: null,
  settleWindowSeconds: 480,
};

function context(args: string[]): CommandContext {
  const logger = createLogger(() => {});
  return {
    argv: parseArgv(args),
    config: CONFIG,
    flags: createFlagStore({ ...DEFAULT_FLAGS }, logger),
    logger,
    // These suites inject their own deps into the command factories, so the graph is
    // only here to satisfy CommandContext. Fixture stores, not live ones: a test that
    // constructed a live graph would build HTTP clients against invalid hosts.
    graph: fixtureGraph({ logger }),
  };
}

/** A deterministic uuid-shaped read_id from a driver index and ordinal. */
function id(driverIndex: number, ordinal: number): string {
  const a = String(driverIndex).padStart(8, '0');
  const b = String(ordinal).padStart(12, '0');
  return `${a}-0000-4000-8000-${b}`;
}

function readsFor(driver: Driver, count: number): Read[] {
  const driverIndex = DRIVERS.indexOf(driver);
  return Array.from({ length: count }, (_, i) => ({
    read_id: id(driverIndex, i),
    place: `place_${i % 5}`,
    signal: 'secret_default' as const,
    driver,
    cadence: 'weekly' as const,
    weight: 0.7,
  }));
}

/** Counts per driver: spice cohort citable, solo below floor, rest empty. */
const COUNTS: Partial<Record<Driver, number>> = {
  spice_tolerance_low: 6,
  budget_ceiling: 5,
  solo_comfort: 4,
};

const MANIFEST: SeedManifest = {
  manifest: (Object.entries(COUNTS) as Array<[Driver, number]>).map(([driver, k]) => ({
    driver,
    k,
    places: [],
  })),
};

/** A counting path that truncates at `cap` — a shrunken COUNTING_K, simulated. */
function countingPath(cap?: number) {
  return (driver: Driver) => {
    const full = readsFor(driver, COUNTS[driver] ?? 0);
    return Promise.resolve({
      reads: cap === undefined ? full : full.slice(0, cap),
      degraded: false,
    });
  };
}

describe('X6 confit pass census', () => {
  it('lists every driver with k and citable, and passes a clean cross-check', async () => {
    const handler = createCensusCommand({ readsForDriver: countingPath(), manifest: MANIFEST });
    const result = await handler(context(['pass', 'census']));
    expect(result.exit ?? EXIT.ok).toBe(EXIT.ok);

    const rows = result.data['drivers'] as Array<{ driver: Driver; k: number; citable: boolean }>;
    expect(rows).toHaveLength(DRIVERS.length); // every driver, even empty ones
    const byDriver = new Map(rows.map((r) => [r.driver, r]));
    expect(byDriver.get('spice_tolerance_low')).toMatchObject({ k: 6, citable: true });
    expect(byDriver.get('budget_ceiling')).toMatchObject({ k: 5, citable: true });
    expect(byDriver.get('solo_comfort')).toMatchObject({ k: 4, citable: false });
    expect(byDriver.get('crowd_aversion')).toMatchObject({ k: 0, citable: false });
    expect(result.data['kfloor']).toBe(KFLOOR);
    expect(result.lines.some((l) => l.includes('Cross-check clean'))).toBe(true);
  });

  it('a counting query truncated below the largest cohort reports a MISMATCH — the [E22] guard', async () => {
    const handler = createCensusCommand({ readsForDriver: countingPath(4), manifest: MANIFEST });
    const result = await handler(context(['pass', 'census']));
    expect(result.exit).toBe(EXIT.expectedFailure);
    const mismatches = result.data['mismatches'] as Driver[];
    expect(mismatches).toContain('spice_tolerance_low'); // 6 counted as 4
    expect(mismatches).toContain('budget_ceiling'); // 5 counted as 4
    expect(mismatches).not.toContain('solo_comfort'); // 4 fits under the cap
    expect(result.lines.some((l) => l.includes('Do not start the demo'))).toBe(true);
  });

  it('counting MORE than the manifest is live reads joining, not a mismatch', async () => {
    const overCounts = { ...COUNTS, spice_tolerance_low: 7 };
    const handler = createCensusCommand({
      readsForDriver: (driver) =>
        Promise.resolve({ reads: readsFor(driver, overCounts[driver] ?? 0), degraded: false }),
      manifest: MANIFEST,
    });
    const result = await handler(context(['pass', 'census']));
    expect(result.exit ?? EXIT.ok).toBe(EXIT.ok);
    const rows = result.data['drivers'] as Array<{ driver: Driver; crosscheck: string }>;
    expect(rows.find((r) => r.driver === 'spice_tolerance_low')?.crosscheck).toBe('over');
  });

  it('discloses degradation without telling the operator to distrust the counts', async () => {
    // Under D-7 counts come from the relay whatever the flag says, so they are
    // exact even here. `degraded` means there is no induced claim. Copy that
    // implied the numbers on this screen were approximate would send an operator
    // hunting a seeding problem that does not exist.
    const handler = createCensusCommand({
      readsForDriver: (driver) =>
        Promise.resolve({ reads: readsFor(driver, COUNTS[driver] ?? 0), degraded: true }),
      manifest: MANIFEST,
    });
    const result = await handler(context(['pass', 'census']));
    expect(result.data['degraded']).toBe(true);
    expect(result.lines[0]).toContain('induction unavailable');
    expect(result.lines[0]).toContain('counts still exact');
    // And the cross-check still passes, because nothing was actually missing.
    expect(result.exit ?? EXIT.ok).toBe(EXIT.ok);
  });
});

describe('X6 confit pass neartie', () => {
  it('prints both numbers against the committed seed and holds', async () => {
    const handler = createNeartieCommand();
    const result = await handler(context(['pass', 'neartie']));
    expect(result.exit ?? EXIT.ok).toBe(EXIT.ok);
    // Both acceptance numbers, in lines and in data.
    expect(result.lines[0]).toMatch(/score\(top1\) − score\(top3\) = \d\.\d{4}/);
    expect(result.lines.some((l) => l.includes('Judge read delta'))).toBe(true);
    expect(typeof result.data['spread']).toBe('number');
    expect(result.data['spread'] as number).toBeLessThanOrEqual(0.04);
    const shifts = result.data['shifts'] as Array<{ shift: number }>;
    expect(shifts.length).toBeGreaterThanOrEqual(3);
    for (const s of shifts) expect(s.shift).toBeGreaterThanOrEqual(0.05);
    expect(result.data['ok']).toBe(true);
  });

  it('a profile with no matched drivers has no judge path and exits 1', async () => {
    const { b } = loadProfiles();
    const handler = createNeartieCommand({
      profile: {
        ...b,
        usual: {
          spiceTolerance: 3,
          budgetBand: 4,
          portionPref: 'standard',
          soloComfort: false,
          giConstraint: false,
          offLimits: [],
        },
      },
    });
    const result = await handler(context(['pass', 'neartie']));
    expect(result.exit).toBe(EXIT.expectedFailure);
    expect(result.lines.some((l) => l.includes('no matched driver'))).toBe(true);
    expect(result.data['ok']).toBe(false);
  });
});
