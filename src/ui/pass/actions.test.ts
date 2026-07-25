/**
 * U5's acceptance, checked mechanically: **every panel action maps to an existing
 * `confit` operation, and the panel is a view over the CLI rather than a second
 * implementation.**
 *
 * A `.test.ts`, not `.test.tsx`, so it runs under the node project (see vitest.config.ts)
 * — it imports the CLI's real command table, and the CLI reaches the filesystem.
 *
 * The point of testing against `COMMANDS` itself rather than a copied list is drift. A
 * hand-maintained list of "commands that exist" would agree with the panel forever and
 * prove nothing; importing the registry the CLI dispatches on means renaming a
 * subcommand, dropping an option, or adding a required one fails here. Same reasoning
 * drives the flag-value block at the bottom through X7's own `runFlags` instead of
 * comparing two tables of strings.
 *
 * Red-verified by mutating actions.ts:
 *   1. point `census` at `['pass','counts']` → "census names a command the CLI registers"
 *   2. give `seed` `sends: ['profile']`      → "seed sends only options its command accepts"
 *   3. set `reset` to `mutates: false`       → "marks exactly the state-changing actions
 *                                              as mutations", plus two confirm-step tests
 *                                              in PassPanel.test.tsx
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { COMMANDS } from '../../cli/main.js';
import { DEFAULT_FLAGS } from '../../contracts/flags.js';
import { createFlagStore } from '../../config/flagStore.js';
import { createLogger } from '../../config/logger.js';
import { runFlags } from '../../cli/pass-ops.js';
import { EXIT } from '../../cli/render.js';
import { FLAG_CHOICES, PASS_ACTIONS, passAction, type FlagName } from './actions.js';

const specFor = (path: readonly string[]) =>
  COMMANDS.find((spec) => spec.path.join(' ') === path.join(' '));

describe('U5 acceptance: every action is a real CLI invocation', () => {
  it('has actions to check', () => {
    expect(PASS_ACTIONS.length).toBeGreaterThan(0);
  });

  it.each(PASS_ACTIONS.map((action) => [action.id, action] as const))(
    '%s names a command the CLI actually registers',
    (_id, action) => {
      const spec = specFor(action.path);
      // Naming the whole registry in the failure makes a typo obvious rather than
      // sending the reader to grep main.ts.
      expect(
        spec,
        `no CLI command "${action.path.join(' ')}"; registered: ${COMMANDS.map((c) => c.path.join(' ')).join(', ')}`,
      ).toBeDefined();
    },
  );

  it.each(PASS_ACTIONS.map((action) => [action.id, action] as const))(
    '%s sends only options its command accepts',
    (_id, action) => {
      const spec = specFor(action.path);
      const accepted: readonly string[] = spec?.options ?? [];
      const rejected = action.sends.filter((name) => !accepted.includes(name));
      expect(rejected, `${action.path.join(' ')} accepts: ${accepted.join(', ') || '(none)'}`).toEqual([]);
    },
  );

  it.each(PASS_ACTIONS.map((action) => [action.id, action] as const))(
    '%s supplies every option its command requires',
    (_id, action) => {
      const spec = specFor(action.path);
      const required: readonly string[] = spec?.requires ?? [];
      const sends: readonly string[] = action.sends;
      const missing = required.filter((name) => !sends.includes(name));
      expect(missing).toEqual([]);
    },
  );

  it.each(PASS_ACTIONS.map((action) => [action.id, action] as const))(
    '%s does not send two members of a mutually exclusive group',
    (_id, action) => {
      const groups = specFor(action.path)?.exclusive ?? [];
      const sends: readonly string[] = action.sends;
      for (const group of groups) {
        const sent = group.filter((name) => sends.includes(name));
        expect(sent.length, `${action.id} sends ${sent.join(' + ')}, which are exclusive`).toBeLessThan(2);
      }
    },
  );

  it('reaches the operations the U5 spec lists by name', () => {
    // The spec enumerates: census table, near-tie inspector, provision, seed/reset,
    // flag toggles, sweeper status. A panel that quietly dropped one would still pass
    // every check above, because those only constrain the actions that DO exist.
    const ids = PASS_ACTIONS.map((action) => action.id);
    for (const required of ['census', 'neartie', 'provision', 'seed', 'reset', 'flags-set', 'sweeper']) {
      expect(ids).toContain(required);
    }
  });

  it('marks exactly the state-changing actions as mutations', () => {
    // Mis-marking `reset` as read-only would skip the confirm step in front of the
    // one action that empties the relay mid-demo.
    const mutating = PASS_ACTIONS.filter((a) => a.mutates).map((a) => a.id).sort();
    expect(mutating).toEqual(['flags-set', 'provision', 'reset', 'seed', 'sweeper'].sort());
  });

  it('passAction throws on an unknown id rather than returning a blank', () => {
    // @ts-expect-error — the point is the runtime guard behind the literal union.
    expect(() => passAction('not-an-action')).toThrow(/unknown pass action/);
  });
});

describe('U5: the panel is the first src/ui → src/cli import, and it stays type-only', () => {
  // U1's purity test greps `src/ui/**` for literal `node:` specifiers, so it cannot see
  // a *transitive* one. `src/cli/**` reaches the filesystem, so turning the CommandResult
  // import below into a value import would drag node:fs into the browser bundle and
  // break the build — while every existing guard stayed green. This is that guard.
  const panel = readFileSync(new URL('./PassPanel.tsx', import.meta.url), 'utf8');

  it.each(
    panel
      .split('\n')
      .map((line, index) => [index + 1, line] as const)
      .filter(([, line]) => /from\s*['"][^'"]*\/cli\//.test(line)),
  )('line %i imports from src/cli type-only', (_lineNumber, line) => {
    expect(line.trimStart().startsWith('import type ')).toBe(true);
  });

  it('actions.ts imports nothing outside src/ui at all', () => {
    // The registry is data. If it ever needs the CLI it has stopped being a manifest
    // the browser can hold and has started being the CLI.
    const actions = readFileSync(new URL('./actions.ts', import.meta.url), 'utf8');
    expect(actions.split('\n').filter((line) => /^\s*(?:import|export)\b.*\bfrom\b/.test(line))).toEqual(
      [],
    );
  });
});

describe('U5: the flag choices the panel offers are the ones X7 accepts', () => {
  it('offers every flag the contract defines, and no invented one', () => {
    expect(Object.keys(FLAG_CHOICES).sort()).toEqual(Object.keys(DEFAULT_FLAGS).sort());
  });

  const pairs = (Object.keys(FLAG_CHOICES) as FlagName[]).flatMap((flag) =>
    FLAG_CHOICES[flag].map((value) => [flag, value] as const),
  );

  it.each(pairs)('%s=%s is accepted by X7 runFlags', (flag, value) => {
    // Driven through the real validator, so narrowing a flag's values in pass-ops.ts
    // fails here instead of shipping a panel dropdown that produces a usage error.
    const store = createFlagStore(DEFAULT_FLAGS, createLogger(() => {}));
    const result = runFlags(`${flag}=${value}`, store);
    expect(result.exit ?? EXIT.ok, `runFlags said: ${result.lines.join(' ')}`).toBe(EXIT.ok);
  });

  it('a value the panel does NOT offer is rejected, so the check above has teeth', () => {
    // Without this, the block above would pass just as happily if runFlags accepted
    // everything.
    const store = createFlagStore(DEFAULT_FLAGS, createLogger(() => {}));
    expect(runFlags('pool=banana', store).exit).toBe(EXIT.usage);
    expect(runFlags('nonsense=live', store).exit).toBe(EXIT.usage);
  });
});
