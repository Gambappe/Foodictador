/**
 * Runtime flag store (P0.3). Flags are readable and settable at runtime; every
 * transition is logged as exactly one line:
 *
 *   flag narrator live→template reason=no-api-key
 *
 * The absence of ANTHROPIC_API_KEY is handled here, not in env parsing: the model
 * calls have degrade paths (design v0.8 §6/§10), so a missing key starts the app in
 * `extraction: seeded` + `narrator: template` rather than failing — G5's no-key
 * acceptance run depends on this.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { DEFAULT_FLAGS, type Flags } from '../contracts/flags.js';
import type { AppConfig } from './env.js';
import type { Logger } from './logger.js';

export interface FlagStore {
  get(): Flags;
  set<K extends keyof Flags>(key: K, value: Flags[K], reason?: string): void;
}

function logTransition(
  logger: Logger,
  key: keyof Flags,
  from: Flags[keyof Flags],
  to: Flags[keyof Flags],
  reason: string,
): void {
  logger.line(`flag ${key} ${String(from)}→${String(to)} reason=${reason}`);
}

export function createFlagStore(initial: Flags, logger: Logger): FlagStore {
  let current: Flags = { ...initial };
  return {
    get: () => ({ ...current }),
    set(key, value, reason = 'operator') {
      const from = current[key];
      if (from === value) return; // no transition, no line
      current = { ...current, [key]: value };
      logTransition(logger, key, from, value, reason);
    },
  };
}

/**
 * Overrides an operator set with `pass flags --set`, remembered across processes (SL-60).
 *
 * Every `confit` invocation is its own process, so a FlagStore mutation died with the command
 * that made it: `pass flags --set pool=relay-only` printed `pool: live → relay-only` and the
 * very next process read `pool = live`. The command reported a change that never existed —
 * the same false-receipt shape as SL-23's nudge state and SL-49's confession receipt.
 *
 * LOCAL, not on the relay, and not because it is easier. A degrade flag is machine state: the
 * defaults are DERIVED from this machine's environment (no `ANTHROPIC_API_KEY` here means
 * template copy here), and the demo deliberately runs three laptops in different degrade
 * states — one with the model key, two without. Sharing them would make one operator's local
 * choice everybody's. It also keeps a network round-trip and a failure mode off every command.
 *
 * A missing or damaged file is no overrides, never an error: a broken preference must not stop
 * `confit ask` from running.
 */
function storedOverrides(path: string): Partial<Flags> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null) return {};
    const record = parsed as Record<string, unknown>;
    const out: Partial<Flags> = {};
    // Validated key by key against the live vocabulary rather than cast: a stale file from an
    // older build must not put `pool: "degraded"` into the type system (SL-04's lesson).
    if (record['extraction'] === 'live' || record['extraction'] === 'seeded')
      out.extraction = record['extraction'];
    if (record['narrator'] === 'live' || record['narrator'] === 'template')
      out.narrator = record['narrator'];
    if (record['pool'] === 'live' || record['pool'] === 'relay-only') out.pool = record['pool'];
    if (record['scoring'] === 'live' || record['scoring'] === 'kernel') out.scoring = record['scoring'];
    if (typeof record['demoMode'] === 'boolean') out.demoMode = record['demoMode'];
    return out;
  } catch {
    return {};
  }
}

/** Where the overrides live: beside the confession buffer, which is already git-ignored. */
export function flagsPath(config: AppConfig): string {
  return join(dirname(config.proseBufferPath), 'flags.json');
}

export function saveFlags(config: AppConfig, flags: Flags): void {
  const path = flagsPath(config);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(flags));
}

/**
 * Starting flags: the environment's verdict, then the operator's remembered overrides, then
 * the environment again for anything it FORCES.
 *
 * That last pass is the important one. Without a model key there is no live narrator to have,
 * so a stored `narrator: live` must not be reported as live — `liveGraph` would hand back the
 * template one anyway and `pass flags` would be describing a path nothing is running.
 */
export function initialFlags(config: AppConfig, logger: Logger): Flags {
  const flags: Flags = { ...DEFAULT_FLAGS, ...storedOverrides(flagsPath(config)) };
  if (config.anthropicApiKey === null) {
    if (flags.extraction !== 'seeded') {
      logTransition(logger, 'extraction', flags.extraction, 'seeded', 'no-api-key');
      flags.extraction = 'seeded';
    }
    if (flags.narrator !== 'template') {
      logTransition(logger, 'narrator', flags.narrator, 'template', 'no-api-key');
      flags.narrator = 'template';
    }
    if (flags.scoring !== 'kernel') {
      logTransition(logger, 'scoring', flags.scoring, 'kernel', 'no-api-key');
      flags.scoring = 'kernel';
    }
  }
  return flags;
}
