/**
 * `confit pass` mutations (X7) — provision, seed, reset, flags, nudge.
 *
 * Operator plumbing, no business logic: provisioning writes S4's committed
 * profiles through UserStore (the only write path for off-limits topics),
 * seeding drives S3's loader, reset clears the relay, flags toggle through
 * P0.3's store (one logged transition per change), and the nudge arms through
 * N1's rules. Every mutation prints exactly what it changed.
 */

import type { Nudge, Relay, UserStore } from '../contracts/modules.js';
import type { Flags } from '../contracts/flags.js';
import type { FlagStore, Logger } from '../config/index.js';
import type { LoadReport } from '../../scripts/seed/load-seeds.js';
import { loadProfiles } from '../../scripts/seed/validate-profiles.js';
import { EXIT, type CommandResult } from './render.js';

const PROFILES = ['A', 'B'] as const;
type ProfileName = (typeof PROFILES)[number];

// ---- provision ----

export interface ProvisionDeps {
  userStore: UserStore;
  logger: Logger;
}

export async function runProvision(
  target: string | undefined,
  deps: ProvisionDeps,
): Promise<CommandResult> {
  const wanted: ProfileName[] =
    target === undefined || target === 'all'
      ? [...PROFILES]
      : PROFILES.includes(target as ProfileName)
        ? [target as ProfileName]
        : [];
  if (wanted.length === 0) {
    return {
      lines: [`Unknown profile "${target ?? ''}" — use A, B, or all.`],
      data: { error: 'unknown_profile', target: target ?? null },
      exit: EXIT.usage,
    };
  }

  const committed = loadProfiles();
  const provisioned: string[] = [];
  for (const name of wanted) {
    const profile = name === 'A' ? committed.a : committed.b;
    await deps.userStore.setUsual(name, profile.usual);
    await deps.userStore.setMealLog(name, profile.mealLog);
    provisioned.push(name);
    deps.logger.line(`pass: provisioned profile ${name} (${profile.mealLog.length} meals)`);
  }
  return {
    lines: provisioned.map(
      (name) => `Provisioned profile ${name}: Usual written, meal log loaded.`,
    ),
    data: { provisioned },
  };
}

// ---- seed / reset ----

export interface SeedOpsDeps {
  relay: Relay;
  loadSeeds: () => Promise<LoadReport>;
}

export async function runSeed(deps: SeedOpsDeps): Promise<CommandResult> {
  const report = await deps.loadSeeds();
  const lines = [
    `Seeded: ${report.poolLoaded}/${report.total} pooled, ${report.relaySeeded} on the relay.`,
    `Induction warm no earlier than ${report.warmAt} — seed hours ahead of a demo.`,
  ];
  if (report.rerunDetected) lines.push('Re-run detected: pool duplicates created; census stays stable via dedup.');
  if (report.failed.length > 0) {
    lines.push(`Failed pool writes (relay copy remains, sweeper recovers): ${report.failed.join(', ')}`);
  }
  return {
    lines,
    data: { report: report },
    exit: report.failed.length === 0 ? EXIT.ok : EXIT.expectedFailure,
  };
}

export async function runReset(deps: { relay: Relay }): Promise<CommandResult> {
  await deps.relay.reset();
  return {
    lines: [
      'Relay cleared.',
      'Pool records remain — the substrate has no bulk delete; the census stays honest via read_id dedup.',
    ],
    data: { relay: 'cleared', pool: 'retained' },
  };
}

// ---- flags ----

const FLAG_VALUES: Record<keyof Flags, readonly string[]> = {
  extraction: ['live', 'seeded'],
  narrator: ['live', 'template'],
  pool: ['live', 'relay-only'],
  demoMode: ['true', 'false'],
};

export function runFlags(setArg: string | undefined, flags: FlagStore): CommandResult {
  if (setArg === undefined) {
    const current = flags.get();
    return {
      lines: Object.entries(current).map(([key, value]) => `${key} = ${String(value)}`),
      data: { flags: current },
    };
  }
  const [key, value, ...rest] = setArg.split('=');
  if (key === undefined || value === undefined || value === '' || rest.length > 0) {
    return {
      lines: [`--set wants key=value, got "${setArg}".`],
      data: { error: 'bad_set', set: setArg },
      exit: EXIT.usage,
    };
  }
  if (!(key in FLAG_VALUES)) {
    return {
      lines: [`Unknown flag "${key}" — one of: ${Object.keys(FLAG_VALUES).join(', ')}.`],
      data: { error: 'unknown_flag', key },
      exit: EXIT.usage,
    };
  }
  const flagKey = key as keyof Flags;
  if (!FLAG_VALUES[flagKey].includes(value)) {
    return {
      lines: [`Flag ${key} takes ${FLAG_VALUES[flagKey].join(' | ')}, got "${value}".`],
      data: { error: 'bad_value', key, value },
      exit: EXIT.usage,
    };
  }
  const before = flags.get()[flagKey];
  // Values were validated against FLAG_VALUES above, so each cast is a fact.
  if (flagKey === 'demoMode') flags.set('demoMode', value === 'true', 'operator');
  else if (flagKey === 'extraction') flags.set('extraction', value as Flags['extraction'], 'operator');
  else if (flagKey === 'narrator') flags.set('narrator', value as Flags['narrator'], 'operator');
  else flags.set('pool', value as Flags['pool'], 'operator');
  const after = flags.get()[flagKey];
  return {
    lines: [
      String(before) === String(after)
        ? `${key} already ${String(after)} — no change.`
        : `${key}: ${String(before)} → ${String(after)}`,
    ],
    data: { key, before, after },
  };
}

// ---- nudge ----

export function runNudgeArm(nudge: Nudge, armed: boolean): CommandResult {
  if (!armed) {
    return {
      lines: ['Nothing to do — pass --arm to arm the nudge.'],
      data: { error: 'missing_arm' },
      exit: EXIT.usage,
    };
  }
  nudge.arm();
  const state = nudge.state();
  return {
    lines: [
      `Nudge armed.${state.optedIn ? '' : ' (Opt-in is off — it will not fire until the profile opts in.)'}`,
    ],
    data: { state: state },
  };
}

// ---- integration wiring (handlers main.ts registers) ----

import { liveGraph } from '../config/wiring.js';
import type { CommandContext, CommandHandler } from './main.js';
import { createNudge } from '../nudge/nudge.js';
import { loadSeeds, readSeedArtifact } from '../../scripts/seed/load-seeds.js';

/** Demo-timer nudge: per-process state, matching design v0.8 §6. */
const processNudge = createNudge();

/** One graph per invocation, from P0.6's single wiring seam. */
function wire(context: CommandContext) {
  const graph = liveGraph(context.config, context.logger, context.flags);
  return { client: graph.client, userStore: graph.user, pool: graph.pool, relay: graph.relay };
}

export const provisionHandler: CommandHandler = (context) => {
  const { userStore } = wire(context);
  return runProvision(context.argv.values['profile'], { userStore, logger: context.logger });
};

export const seedHandler: CommandHandler = (context) => {
  const { pool, relay } = wire(context);
  return runSeed({
    relay,
    loadSeeds: () =>
      loadSeeds(readSeedArtifact(), {
        pool,
        relay,
        logger: context.logger,
        settleWindowSeconds: context.config.settleWindowSeconds,
        now: () => new Date(),
      }),
  });
};

export const resetHandler: CommandHandler = (context) => {
  const { relay } = wire(context);
  return runReset({ relay });
};

export const flagsHandler: CommandHandler = (context) => {
  return Promise.resolve(runFlags(context.argv.values['set'], context.flags));
};

export const nudgeHandler: CommandHandler = (context) => {
  return Promise.resolve(runNudgeArm(processNudge, context.argv.flags.has('arm')));
};
