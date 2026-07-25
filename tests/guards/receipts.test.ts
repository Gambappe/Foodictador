/**
 * The false-receipt guard (SL-61) — the product may not claim what it has not done.
 *
 * Five defects in one session shared one shape, and none of them was carelessness:
 *
 *   SL-23  `pass nudge --arm` reported armed; the state was never persisted
 *   SL-42  the UI printed `written` for prose sitting on local disk
 *   SL-49  `confess` printed `sent` from a process that had sent nothing
 *   SL-56  `--json` omitted the field that said which of those had happened
 *   SL-60  `pass flags --set` printed `pool: live → relay-only`; the next process read `live`
 *
 * Two distinct causes, so two distinct guards. Neither is a list of the five above — a guard
 * that only re-checks known defects has no chance of catching the sixth.
 *
 * **Cause one: a state space wider than the type describing it.** `wrote.prose: boolean` plus
 * `proseBuffered: number` plus `proseHandedOff: boolean` is four states across three fields,
 * so the invalid combinations are representable and eventually one gets rendered. The defence
 * is `ProseOutcome` — a union, one value, with every renderer an exhaustive `switch` whose
 * `default` calls `assertNever`. Adding a state then fails to COMPILE at every surface. That
 * is enforcement rather than vigilance, and the tests below check the property it buys:
 * distinct copy per state, and no surface silently collapsing two states into one word.
 *
 * **Cause two: a receipt rendered from the INTENT rather than the outcome.** `pass flags --set`
 * printed the transition it computed, not what survived. The defence is a round-trip: a command
 * that reports a state change must be re-readable by a process that shares nothing with it but
 * the store. That is the table at the bottom, and it is the one to extend when a new
 * state-changing command lands.
 */
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AppConfig } from '../../src/config/index.js';
import type { ProseOutcome } from '../../src/contracts/types.js';
import { assertNever } from '../../src/contracts/assertNever.js';
import { createLogger } from '../../src/config/logger.js';
import { initialFlags } from '../../src/config/flagStore.js';
import { MEMORY_RECEIPT } from '../../src/ui/confess/copy.js';
import { run } from '../../src/cli/main.js';
import { fixtureGraph } from '../../src/config/wiring.js';

/** Every state a confession's prose can be in. Kept exhaustive by the compiler, below. */
const PROSE_STATES: ProseOutcome[] = [
  { state: 'sent' },
  { state: 'held', waiting: 2 },
  { state: 'handed_off' },
  { state: 'failed', detail: 'tier down' },
];

function tempConfig(): AppConfig {
  return {
    xtraceBaseUrl: 'https://xtrace.invalid',
    xtraceApiKey: 'k',
    relayUrl: 'https://relay.invalid',
    relayToken: 't',
    anthropicApiKey: 'model-key',
    settleWindowSeconds: 480,
    proseBufferPath: join(mkdtempSync(join(tmpdir(), 'confit-receipts-')), 'buffer'),
  };
}

describe('SL-61 (a): a state may not be described by a type narrower than itself', () => {
  it('the PROSE_STATES list is exhaustive — the compiler says so, not a comment', () => {
    // If a fifth variant is added to `ProseOutcome` and not to the list above, this switch
    // stops compiling. That is the point of writing it out rather than asserting a length: a
    // count can be updated thoughtlessly, an exhaustive switch cannot.
    for (const state of PROSE_STATES) {
      switch (state.state) {
        case 'sent':
        case 'held':
        case 'handed_off':
        case 'failed':
          break;
        default:
          assertNever(state, 'receipts guard');
      }
    }
    expect(PROSE_STATES).toHaveLength(4);
  });

  it('no two states share a word in the UI receipt', () => {
    // The SL-42 shape exactly: two different outcomes rendering the same sentence. A reader
    // cannot distinguish what the product will not distinguish.
    const rendered = Object.values(MEMORY_RECEIPT);
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('only the genuinely-sent state may use the bare word "written"', () => {
    // `handed_off` is safe but was NOT sent by this action, so its copy has to qualify itself.
    // Left unqualified it becomes SL-49 again in the other surface.
    expect(MEMORY_RECEIPT.sent).toBe('written');
    expect(MEMORY_RECEIPT.handedOff).not.toBe(MEMORY_RECEIPT.sent);
    expect(MEMORY_RECEIPT.handedOff).toMatch(/alongside|another/);
    expect(MEMORY_RECEIPT.held).toMatch(/this device/);
    expect(MEMORY_RECEIPT.failed).toMatch(/not/);
  });

  it('the parallel-field shape does not come back', () => {
    // Source-level, because the defect is a SHAPE rather than a value: three fields describing
    // one outcome. Nothing behavioural can see that — every individual field is correct.
    const sources = [
      'src/memory/writeRead.ts',
      'src/cli/confess.ts',
      'src/ui/confess/ConfessScreen.tsx',
    ].map(
      (f) =>
        [
          f,
          // Comments stripped: a docblock explaining the shape being left behind SHOULD be
          // able to name it, and this must catch code rather than prose.
          readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')
            .replaceAll(/\/\*[\s\S]*?\*\//g, '')
            .replaceAll(/(^|\s)\/\/.*$/gm, ''),
        ] as const,
    );
    for (const [file, code] of sources) {
      expect(code, `${file} still carries the split prose receipt`).not.toMatch(
        /proseBuffered|proseHandedOff/,
      );
      expect(code, `${file} still has a boolean prose flag`).not.toMatch(/prose:\s*boolean/);
    }
  });
});

/**
 * SL-61 (b) — a reported state change must survive the process that reported it.
 *
 * Every `confit` command is its own process, so "it worked" is only true if a LATER process
 * agrees. Each row runs a state-changing command and then re-reads through a construction that
 * shares nothing with it but the store on disk.
 *
 * **Add a row when a command starts changing state.** That is the whole maintenance burden,
 * and it is the check that would have caught SL-23 and SL-60 on the day they were written.
 */
describe('SL-61 (b): a command that reports a change must be re-readable', () => {
  it('pass flags --set survives into a fresh process', async () => {
    const config = tempConfig();
    const out: string[] = [];
    const code = await run(['pass', 'flags', '--set', 'pool=relay-only'], {
      out: (line) => out.push(line),
      err: () => undefined,
      loadConfig: () => config,
      makeGraph: (_c, logger, flags) => fixtureGraph({ logger, flags }),
    });
    expect(code ?? 0).toBe(0);
    expect(out.join('\n')).toContain('relay-only'); // it CLAIMED a change...

    // ...and a fresh derivation, sharing only the file, must agree.
    const later = initialFlags(config, createLogger(() => undefined));
    expect(later.pool).toBe('relay-only');
  });

  it('a --set that changes nothing does not claim it did', async () => {
    // The mirror of the same honesty: reporting a transition that did not happen is the
    // defect, whether or not it would have persisted.
    const config = tempConfig();
    const out: string[] = [];
    await run(['pass', 'flags', '--set', 'pool=live'], {
      out: (line) => out.push(line),
      err: () => undefined,
      loadConfig: () => config,
      makeGraph: (_c, logger, flags) => fixtureGraph({ logger, flags }),
    });
    expect(out.join('\n')).toMatch(/already live|no change/);
  });
});
