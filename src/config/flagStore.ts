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

/** Starting flags for a parsed config: all-live unless the model key is absent. */
export function initialFlags(config: AppConfig, logger: Logger): Flags {
  const flags: Flags = { ...DEFAULT_FLAGS };
  if (config.anthropicApiKey === null) {
    logTransition(logger, 'extraction', flags.extraction, 'seeded', 'no-api-key');
    flags.extraction = 'seeded';
    logTransition(logger, 'narrator', flags.narrator, 'template', 'no-api-key');
    flags.narrator = 'template';
  }
  return flags;
}
