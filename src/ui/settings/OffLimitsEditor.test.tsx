import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { MemoryClient, PoolStore, Relay } from '../../contracts/modules.js';
import type { MemoryRow, Read, UsualProfile } from '../../contracts/types.js';
import { sampleUsual } from '../../contracts/fixtures/index.js';
import { StubSettingsStore } from '../../contracts/stubs/index.js';
import { createLogger } from '../../config/logger.js';
import { createPoolStore } from '../../memory/pool.js';
import { createUserStore } from '../../memory/user.js';
import { writeRead } from '../../memory/writeRead.js';
import { OffLimitsEditor } from './OffLimitsEditor.js';

afterEach(cleanup);

/** Minimal in-memory substrate — the same shape M3's own tests drive. */
function substrate() {
  const rows = new Map<string, MemoryRow[]>();
  let seq = 0;
  const client: MemoryClient = {
    ingest(scope, payload) {
      rows.set(scope, [...(rows.get(scope) ?? []), { memoryId: `m${++seq}`, kind: 'fact', content: payload }]);
      return Promise.resolve({ jobId: `j${seq}` });
    },
    search: (scope, query) =>
      Promise.resolve((rows.get(scope) ?? []).filter((r) => r.content.includes(query))),
    ingestBatch: () => Promise.reject(new Error('unused — single ingests only in this suite')),
    remove(scope, memoryId) {
      rows.set(scope, (rows.get(scope) ?? []).filter((r) => r.memoryId !== memoryId));
      return Promise.resolve();
    },
    jobStatus: () => Promise.resolve('complete' as const),
  };
  return { client, count: (scope: string) => (rows.get(scope) ?? []).length };
}

function recordingRelay() {
  const entries: Read[] = [];
  const relay: Relay = {
    put: (read) => {
      entries.push(read);
      return Promise.resolve();
    },
    setJob: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    drop: () => Promise.resolve(),
    stats: () => Promise.resolve({ count: 0, oldest_entry_age_seconds: 0 }),
    seed: () => Promise.resolve(0),
    reset: () => Promise.resolve(),
  };
  return { relay, entries };
}

const CHIPS: Omit<Read, 'read_id'> = {
  place: 'rosas_taqueria',
  signal: 'pretends_preference',
  driver: 'spice_tolerance_low',
  cadence: 'monthly',
  weight: 0.8,
};

describe('U4: the off-limits editor', () => {
  it('renders existing topics and the [E24] consequence', () => {
    render(<OffLimitsEditor usual={{ ...sampleUsual, offLimits: ['fasting'] }} onSave={() => Promise.resolve()} />);
    expect(screen.getByTestId('off-limits-list').textContent).toContain('fasting');
    // "nowhere", not "not shared" — the distinction [E24] exists to make.
    expect(screen.getByText(/not in your own memory/)).toBeTruthy();
  });

  it('adding a topic writes the whole profile through the save port', async () => {
    const saved: UsualProfile[] = [];
    render(
      <OffLimitsEditor usual={{ ...sampleUsual, offLimits: [] }} onSave={(u) => {
        saved.push(u);
        return Promise.resolve();
      }} />,
    );
    await userEvent.type(screen.getByLabelText('Add a topic'), 'fasting');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.offLimits).toEqual(['fasting']);
    // The rest of the profile rides along untouched — setUsual replaces it whole.
    expect(saved[0]?.spiceTolerance).toBe(sampleUsual.spiceTolerance);
  });

  it('removing a topic saves the shorter list', async () => {
    const saved: UsualProfile[] = [];
    render(
      <OffLimitsEditor usual={{ ...sampleUsual, offLimits: ['fasting', 'gluten'] }} onSave={(u) => {
        saved.push(u);
        return Promise.resolve();
      }} />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove fasting' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0]?.offLimits).toEqual(['gluten']);
  });

  it('folds case-duplicates and blank input rather than storing noise', async () => {
    const saved: UsualProfile[] = [];
    render(
      <OffLimitsEditor usual={{ ...sampleUsual, offLimits: ['Fasting'] }} onSave={(u) => {
        saved.push(u);
        return Promise.resolve();
      }} />,
    );
    const input = screen.getByLabelText('Add a topic');
    await userEvent.type(input, '   ');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(saved).toHaveLength(0); // whitespace is not a topic

    await userEvent.clear(input);
    await userEvent.type(input, 'fasting');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(saved).toHaveLength(1));
    // K2 matches case-insensitively, so a second casing is the same rule twice.
    expect(saved[0]?.offLimits).toEqual(['Fasting']);
  });
});

describe('U4 acceptance: a topic added here blocks a later confess', () => {
  it('editor → real setUsual → real writeRead → nothing written anywhere', async () => {
    const s = substrate();
    const logger = createLogger(() => {});
    const user = createUserStore({ client: s.client, settings: new StubSettingsStore(), logger });
    const pool: PoolStore = createPoolStore({ client: s.client, logger, placeName: (id: string) => id.replaceAll('_', ' ') });
    const { relay, entries } = recordingRelay();

    // The screen saves through the real store, the way U4's port is wired in production.
    render(
      <OffLimitsEditor
        usual={{ ...sampleUsual, offLimits: [] }}
        onSave={(next) => user.setUsual('A', next)}
      />,
    );
    await userEvent.type(screen.getByLabelText('Add a topic'), 'fasting');
    await userEvent.click(screen.getByRole('button', { name: 'Add' }));
    await waitFor(() => expect(screen.getByText('Saved.')).toBeTruthy());

    // A later confess reads the profile back and runs the authoritative gate.
    const stored = await user.usual('A');
    expect(stored?.offLimits).toEqual(['fasting']);
    const result = await writeRead(
      { relay, pool, user, logger },
      {
        profile: 'A',
        text: 'I have been fasting before dinners out.',
        chips: CHIPS,
        offLimits: stored?.offLimits ?? [],
      },
    );

    expect(result).toEqual({ blocked: true });
    expect(entries).toHaveLength(0);
    expect(s.count('confit:pool')).toBe(0);
  });

  it('control: an unrelated confession still writes, so the block is the topic', async () => {
    const s = substrate();
    const logger = createLogger(() => {});
    const user = createUserStore({ client: s.client, settings: new StubSettingsStore(), logger });
    const pool = createPoolStore({ client: s.client, logger, placeName: (id: string) => id.replaceAll('_', ' ') });
    const { relay, entries } = recordingRelay();
    await user.setUsual('A', { ...sampleUsual, offLimits: ['fasting'] });

    const result = await writeRead(
      { relay, pool, user, logger },
      {
        profile: 'A',
        text: 'I always order the mild one and call it a preference.',
        chips: CHIPS,
        offLimits: (await user.usual('A'))?.offLimits ?? [],
      },
    );
    expect('blocked' in result).toBe(false);
    expect(entries).toHaveLength(1);
  });
});

describe('U4 off-limits — the scope disclaimer (D-9)', () => {
  it('says off-limits gates recording, not recommendations', () => {
    // THIS is the screen where someone types "shellfish". The heading invites the reading
    // "keep me away from shellfish", and Confit cannot do that — the corpus has six place
    // tags and none is an allergen. Saying so is the difference between a limitation and a
    // false promise.
    render(<OffLimitsEditor usual={{ ...sampleUsual, offLimits: ['shellfish'] }} onSave={() => Promise.resolve()} />);
    const scope = screen.getByTestId('off-limits-scope');
    expect(scope.textContent).toMatch(/not where it sends you/);
    expect(scope.textContent).toMatch(/does not check menus for allergens/i);
  });
});
