/**
 * M15 — every XTrace scope carries the generation marker, and no call site invents one.
 *
 * The failure this guards is silent. A polluted scope does not error, return nothing, or look
 * degraded: the substrate ranks two eras of ingest against each other and the older era wins
 * on volume, so the card fills with a claim that was correct for an ingest shape the product
 * no longer uses. Measured twice —
 *
 *  - `confit:pool`: pre-M12 per-read episodes ("a regret-after-order signal at Bao Bar
 *    Micro… moderate weight") outranked the batched-prose episodes that replaced them.
 *  - the personal scope: a pre-M20 per-confession paraphrase outranked the episode
 *    synthesising four confessions, with `4 episode(s) over 7 fact(s)` in the log and no
 *    indication anything was wrong.
 *
 * So the thing to protect is not "the constant exists" but "nothing reaches the substrate
 * outside it". One call site that builds a scope by hand puts an unescapable era back, and
 * the symptom would be a slightly worse card that nobody can attribute.
 *
 * Red-verification, performed before this merged: reverting `POOL_SCOPE` to the literal
 * `'confit:pool'` reds the generation assertions; passing the bare profile to
 * `client.search` in `personalClaim` reds "the personal tier never uses the bare profile
 * id"; reintroducing the literal in `pool.ts` reds the source-level check.
 */
import { globSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { MemoryClient } from '../../src/contracts/modules.js';
import type { MemoryRow } from '../../src/contracts/types.js';
import { StubProseBuffer, StubSettingsStore } from '../../src/contracts/stubs/index.js';
import { createLogger } from '../../src/config/logger.js';
import { POOL_SCOPE } from '../../src/memory/pool.js';
import { SCOPE_GENERATION, personalScope } from '../../src/memory/scopes.js';
import { createUserStore } from '../../src/memory/user.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** Records the scope of every call, which is the only thing this suite cares about. */
function scopeSpy() {
  const scopes: string[] = [];
  const client: MemoryClient = {
    ingest(scope) {
      scopes.push(scope);
      return Promise.resolve({ jobId: 'j' });
    },
    ingestBatch(scope) {
      scopes.push(scope);
      return Promise.resolve({ jobId: 'j' });
    },
    search(scope): Promise<MemoryRow[]> {
      scopes.push(scope);
      return Promise.resolve([]);
    },
    remove(scope) {
      scopes.push(scope);
      return Promise.resolve();
    },
    jobStatus: () => Promise.resolve('complete' as const),
  };
  return { client, scopes };
}

describe('M15: both scopes carry the generation, so a bad era is escapable', () => {
  it('POOL_SCOPE and the personal scope both embed SCOPE_GENERATION', () => {
    // Both, because a bump that moved only one would leave the other era competing while
    // looking like the cut had been made.
    expect(POOL_SCOPE).toContain(SCOPE_GENERATION);
    expect(personalScope('A')).toContain(SCOPE_GENERATION);
  });

  it('neither is the pre-M15 name', () => {
    // The exact strings the polluted eras live under. If either comes back, the product is
    // reading the scope it was moved out of.
    expect(POOL_SCOPE).not.toBe('confit:pool');
    expect(personalScope('A')).not.toBe('A');
  });

  it('the personal scope is namespaced AND per-profile — one diner is not another', () => {
    expect(personalScope('A')).not.toBe(personalScope('B'));
    expect(personalScope('A')).toContain('A');
    // And it is not the pool: a personal claim leaking into the collective scope would put
    // one diner's confessions behind a cohort citation.
    expect(personalScope('A')).not.toBe(POOL_SCOPE);
  });
});

describe('M15: nothing reaches the substrate outside the generation', () => {
  it('the personal tier never uses the bare profile id as a scope', async () => {
    const spy = scopeSpy();
    const store = createUserStore({
      client: spy.client,
      settings: new StubSettingsStore(),
      buffer: new StubProseBuffer(),
      logger: createLogger(() => undefined),
    });
    await store.personalClaim('A', 'what do they order');
    await store.writeProse('A', 'a confession');
    await store.flushProse();

    expect(spy.scopes.length).toBeGreaterThan(0);
    for (const scope of spy.scopes) {
      expect(scope).toBe(personalScope('A'));
      expect(scope).toContain(SCOPE_GENERATION);
    }
  });

  it('no module builds a scope from the pre-M15 literal', () => {
    // Source-level, because a call site that hardcodes `'confit:pool'` is invisible to every
    // behavioural test that imports the constant — both would agree, and both would be wrong.
    // `scopes.ts` is exempt: it is where the old names are documented as the thing being left.
    // Globbed, not listed: a hardcoded list cannot catch the module that does not exist yet,
    // which is the one most likely to reintroduce this. `scopes.ts` is exempt — it is where
    // the abandoned names are documented as the thing being left behind.
    const files = globSync('src/**/*.{ts,tsx}', { cwd: ROOT }).filter(
      (f) => !f.endsWith('scopes.ts') && !f.endsWith('.test.ts') && !f.endsWith('.test.tsx'),
    );
    expect(files.length).toBeGreaterThan(20); // the glob found the tree, not nothing
    for (const file of files) {
      // Comments are stripped first: a docblock explaining which era is being left behind
      // SHOULD be able to name it, and this must catch code rather than prose.
      const code = readFileSync(join(ROOT, file), 'utf8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/(^|\s)\/\/.*$/gm, '');
      expect(code, `${file} builds the pre-M15 pool scope by hand`).not.toMatch(
        /['"`]confit:pool['"`]/,
      );
    }
  });

  it('the conv_id of a pooled conversation carries the generation too', async () => {
    // A conv_id groups an ingest into one conversation. Two generations sharing conv_ids
    // would let the substrate associate old and new material even with the scopes split,
    // which is the pollution arriving by the other door.
    const { createPoolStore } = await import('../../src/memory/pool.js');
    const convIds: string[] = [];
    const client: MemoryClient = {
      ingest: () => Promise.resolve({ jobId: 'j' }),
      ingestBatch(_scope, _payloads, convId) {
        convIds.push(convId);
        return Promise.resolve({ jobId: 'j' });
      },
      search: () => Promise.resolve([]),
      remove: () => Promise.resolve(),
      jobStatus: () => Promise.resolve('complete' as const),
    };
    const pool = createPoolStore({
      client,
      logger: createLogger(() => undefined),
      placeName: (id: string) => id.replaceAll('_', ' '),
    });
    await pool.writeReads([
      {
        read_id: '11111111-1111-4111-8111-111111111111',
        place: 'rosas_taqueria',
        signal: 'pretends_preference',
        driver: 'spice_tolerance_low',
        cadence: 'monthly',
        weight: 0.8,
      },
    ]);
    expect(convIds).toHaveLength(1);
    expect(convIds[0]).toContain(SCOPE_GENERATION);
  });
});
