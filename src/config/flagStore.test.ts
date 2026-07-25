import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { AppConfig } from './env.js';
import { createLogger } from './logger.js';
import { DEFAULT_FLAGS } from '../contracts/flags.js';
import { flagsPath, initialFlags, saveFlags } from './flagStore.js';
import { describe, expect, it } from 'vitest';

/**
 * SL-60 — `pass flags --set` printed a transition that did not survive the process.
 *
 * Found by driving the CLI: `--set pool=relay-only` reported `pool: live → relay-only`, and
 * the very next invocation read `pool = live`. Every `confit` command is its own process, so
 * mutating an in-memory store alone made the command a no-op with a receipt — the same shape
 * as SL-23's nudge state and SL-49's confession receipt.
 *
 * Red-verified: dropping `storedOverrides` from `initialFlags` reds the first two; letting a
 * stored override win over the no-key degradation reds the third.
 */
describe('P0.3 degrade flags are remembered across processes (SL-60)', () => {
  function tempConfig(): AppConfig {
    return {
      xtraceBaseUrl: 'https://xtrace.invalid',
      xtraceApiKey: 'k',
      relayUrl: 'https://relay.invalid',
      relayToken: 't',
      anthropicApiKey: 'model-key',
      settleWindowSeconds: 480,
      proseBufferPath: join(mkdtempSync(join(tmpdir(), 'confit-flags-')), 'buffer'),
    };
  }
  const quiet = createLogger(() => undefined);

  it('a saved override is read back by a later process', () => {
    const config = tempConfig();
    saveFlags(config, { extraction: 'live', narrator: 'live', pool: 'relay-only', demoMode: true });
    // A FRESH initialFlags call stands in for the next `confit` invocation exactly: nothing is
    // shared between them but the file.
    const flags = initialFlags(config, quiet);
    expect(flags.pool).toBe('relay-only');
    expect(flags.demoMode).toBe(true);
  });

  it('no saved file means the environment default, not an error', () => {
    expect(initialFlags(tempConfig(), quiet).pool).toBe('live');
  });

  it('the environment still forces degradation over a stored override', () => {
    // Without a model key there is no live narrator to have. Reporting one because a file says
    // so would describe a path nothing is running — `liveGraph` hands back the template
    // narrator regardless, so the flag would be the only thing lying.
    const config = { ...tempConfig(), anthropicApiKey: null };
    saveFlags(config, { extraction: 'live', narrator: 'live', pool: 'live', demoMode: false });
    const flags = initialFlags(config, quiet);
    expect(flags.narrator).toBe('template');
    expect(flags.extraction).toBe('seeded');
  });

  it('a corrupt file is no overrides, never a crash', () => {
    // A broken preference must not stop `confit ask` from running.
    const config = tempConfig();
    saveFlags(config, { ...DEFAULT_FLAGS });
    writeFileSync(flagsPath(config), 'not json at all');
    expect(() => initialFlags(config, quiet)).not.toThrow();
    expect(initialFlags(config, quiet).pool).toBe('live');
  });

  it('a value from an older vocabulary is ignored, not laundered into the type', () => {
    const config = tempConfig();
    saveFlags(config, { ...DEFAULT_FLAGS });
    writeFileSync(flagsPath(config), JSON.stringify({ pool: 'degraded', narrator: 42 }));
    const flags = initialFlags(config, quiet);
    expect(flags.pool).toBe('live'); // the stale value did not survive validation
    expect(flags.narrator).toBe('live');
  });
});
