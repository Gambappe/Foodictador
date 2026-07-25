/**
 * U2 acceptance, driven through the REAL write path.
 *
 * `realHarness` wires the screen to M5's `writeRead` over M2/M3 on an in-memory
 * substrate, so "issues no writes" is checked by counting rows in the substrate and
 * entries in the relay, not by asserting a mock was not called. A mock would pass even
 * if the screen wrote through some other door.
 *
 * Red-verified by mutating ConfessScreen.tsx — each mutation fails exactly one test:
 *   1. `setPhase({kind:'done'})` unconditionally (ignore M5's blocked verdict)
 *        → "M5 refuses even when the extractor let it through"
 *   2. drop `<p>{CONSENT.fields}</p>`
 *        → "states both halves"
 *   3. `disabled={phase.kind === 'saving'}` (strike no longer blocks the press)
 *        → "a struck chip disables the pot button"
 *   4. move the consent block below the button
 *        → "is rendered before the button in document order"
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { MemoryClient, Relay } from '../../contracts/modules.js';
import type { MemoryRow, ProposedRead, Read } from '../../contracts/types.js';
import { sampleUsual } from '../../contracts/fixtures/index.js';
import { StubSettingsStore, StubProseBuffer } from '../../contracts/stubs/index.js';
import { createLogger } from '../../config/logger.js';
import { createPoolStore, POOL_SCOPE } from '../../memory/pool.js';
import { createUserStore } from '../../memory/user.js';
import { writeRead } from '../../memory/writeRead.js';
import { ConfessScreen } from './ConfessScreen.js';
import { CHIP_LABELS, CONSENT, MEMORY_RECEIPT, REFUSAL } from './copy.js';

afterEach(cleanup);

const CHIPS: Omit<Read, 'read_id'> = {
  place: 'rosas_taqueria',
  signal: 'pretends_preference',
  driver: 'spice_tolerance_low',
  cadence: 'monthly',
  weight: 0.8,
};

const PROPOSAL: ProposedRead = { chips: CHIPS, confidence: 0.9 };
const CONFESSION = 'I order the spicy one because everyone expects me to.';

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
    remove: () => Promise.resolve(),
    jobStatus: () => Promise.resolve('complete' as const),
    // M10's ledger is not what this suite is about; no handles is a valid job result.
    jobResult: () => Promise.resolve([]),
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
    setPoolMemories: () => Promise.resolve(),
    list: () => Promise.resolve([]),
    drop: () => Promise.resolve(),
    stats: () => Promise.resolve({ count: 0, oldest_entry_age_seconds: 0 }),
    seed: () => Promise.resolve(0),
    reset: () => Promise.resolve(),
  };
  return { relay, entries };
}

/** The screen wired to the real M5 write path, the way production wires it. */
function realHarness(offLimits: string[]) {
  const s = substrate();
  const logger = createLogger(() => {});
  const user = createUserStore({
    client: s.client,
    settings: new StubSettingsStore(),
    buffer: new StubProseBuffer(),
    logger,
  });
  const pool = createPoolStore({ client: s.client, logger, placeName: (id: string) => id.replaceAll('_', ' ') });
  const { relay, entries } = recordingRelay();

  const view = render(
    <ConfessScreen
      offLimits={offLimits}
      // L2 stands in as a pass-through: its correctness is explicitly not what
      // protects the user (§6) — M5 is — so the test drives M5, not the model.
      propose={() => Promise.resolve(PROPOSAL)}
      submit={(chips, text) =>
        writeRead({ relay, pool, user, logger }, { profile: 'A', text, chips, offLimits })
      }
    />,
  );
  return { view, relayEntries: entries, poolCount: () => s.count(POOL_SCOPE), userCount: () => s.count('A') };
}

async function reachChips() {
  await userEvent.type(screen.getByLabelText('Your confession'), CONFESSION);
  await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
  await waitFor(() => expect(screen.getByTestId('chips')).toBeTruthy());
}

describe('U2: the two beats', () => {
  it('textarea → chips, each editable', async () => {
    realHarness([]);
    await reachChips();
    expect(screen.getByLabelText<HTMLInputElement>('place').value).toBe(CHIPS.place);
    expect(screen.getByLabelText<HTMLSelectElement>('signal').value).toBe(CHIPS.signal);
    // Labelled "strength", never "weight" (SL-28): the schema field keeps its name, the
    // diner never reads a word design v0.8 §9 forbids the product using.
    expect(screen.getByLabelText<HTMLInputElement>(CHIP_LABELS.weight).value).toBe(
      String(CHIPS.weight),
    );
    expect(CHIP_LABELS.weight).toBe('strength');

    await userEvent.selectOptions(screen.getByLabelText('cadence'), 'weekly');
    expect(screen.getByLabelText<HTMLSelectElement>('cadence').value).toBe('weekly');
  });

  it('an empty confession does not call the extractor', async () => {
    let calls = 0;
    render(
      <ConfessScreen
        offLimits={[]}
        propose={() => {
          calls += 1;
          return Promise.resolve(PROPOSAL);
        }}
        submit={() => Promise.resolve({})}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(calls).toBe(0);
  });
});

describe('U2 acceptance: the [E27] consent copy is above the button', () => {
  it('states both halves — the words and the five fields', async () => {
    realHarness([]);
    await reachChips();
    const consent = screen.getByTestId('consent').textContent ?? '';
    // Asserted as two promises rather than one string: §5 asks for "something in the
    // shape of" both halves, so the wording may differ per surface but neither half
    // may vanish. Matching the meaning, not the constant — asserting the constant is
    // rendered would only prove the constant is rendered.
    expect(consent).toMatch(/your words/i); // half one: the prose leaves the device…
    expect(consent).toMatch(/memory/i); // …to the user's own Confit memory
    expect(consent).toMatch(/five fields/i); // half two: only the chips…
    expect(consent).toMatch(/pot/i); // …enter the pot
    // And the strings the screen actually ships are the ones under test.
    expect(consent).toContain(CONSENT.words);
    expect(consent).toContain(CONSENT.fields);
  });

  it('is rendered before the button in document order, not after it', async () => {
    realHarness([]);
    await reachChips();
    const consent = screen.getByTestId('consent');
    const button = screen.getByRole('button', { name: 'Add to the pot' });
    // Node.DOCUMENT_POSITION_FOLLOWING: the button comes after the consent copy.
    expect(consent.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('U2 acceptance: a blocked topic shows the refusal and issues no writes', () => {
  it('M5 refuses even when the extractor let it through — zero writes anywhere', async () => {
    const h = realHarness(['spicy']);
    await reachChips(); // the stand-in extractor proposes regardless; M5 is the gate
    await userEvent.click(screen.getByRole('button', { name: 'Add to the pot' }));

    await waitFor(() => expect(screen.getByTestId('refusal')).toBeTruthy());
    expect(screen.getByTestId('refusal').textContent).toBe(REFUSAL);
    expect(h.relayEntries).toHaveLength(0);
    expect(h.poolCount()).toBe(0);
    expect(h.userCount()).toBe(0); // not the pot, not the relay, not their own memory
  });

  it('the refusal names all three destinations, per [E24]', () => {
    render(<ConfessScreen offLimits={[]} propose={() => Promise.resolve({ blocked: true })} submit={() => Promise.resolve({})} />);
    // A refusal that only mentioned the pot would restate the bug §9 fixed.
    for (const destination of ['pot', 'relay', 'your own memory']) {
      expect(REFUSAL).toContain(destination);
    }
  });

  it('an off-limits topic caught by the extractor never reaches the write path', async () => {
    let submits = 0;
    render(
      <ConfessScreen
        offLimits={['spicy']}
        propose={() => Promise.resolve({ blocked: true })}
        submit={() => {
          submits += 1;
          return Promise.resolve({});
        }}
      />,
    );
    await userEvent.type(screen.getByLabelText('Your confession'), CONFESSION);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByTestId('refusal')).toBeTruthy());
    expect(submits).toBe(0);
    expect(screen.queryByRole('button', { name: 'Add to the pot' })).toBeNull();
  });
});

describe('U2: nothing is pooled without the press', () => {
  it('reaching the chip screen writes nothing on its own', async () => {
    const h = realHarness([]);
    await reachChips();
    expect(h.relayEntries).toHaveLength(0);
    expect(h.poolCount()).toBe(0);
  });

  it('pressing writes through M5 and reports per target', async () => {
    const h = realHarness([]);
    await reachChips();
    await userEvent.click(screen.getByRole('button', { name: 'Add to the pot' }));

    await waitFor(() => expect(screen.getByTestId('write-report')).toBeTruthy());
    expect(h.relayEntries).toHaveLength(1);
    expect(h.poolCount()).toBe(1);
    const report = screen.getByTestId('write-report').textContent ?? '';
    expect(report).toContain('pot: written');
    expect(report).toContain('relay: written');
    expect(screen.getByTestId('read-id').textContent).toMatch(/[0-9a-f-]{36}/);
  });

  it('a BUFFERED confession is not reported as written (SL-42)', async () => {
    // D-10's one named consequence, and it was fixed in the CLI receipt only. `wrote.prose`
    // is `true` for a buffered confession as much as a sent one, so rendering it as "written"
    // told the diner their words were in XTrace while they sat on local disk. The same defect
    // as `forget` printing "Deleted from Confit" over two skipped targets.
    realHarness([]);
    await reachChips();
    await userEvent.click(screen.getByRole('button', { name: 'Add to the pot' }));
    await waitFor(() => expect(screen.getByTestId('write-report')).toBeTruthy());

    const report = screen.getByTestId('write-report').textContent ?? '';
    expect(report).toContain(`your memory: ${MEMORY_RECEIPT.held}`);
    expect(report).not.toContain(`your memory: ${MEMORY_RECEIPT.sent}`);
    // And the held wording says where the words actually are, not merely that they are late.
    expect(MEMORY_RECEIPT.held).toMatch(/this device/);
  });

  it('a SENT confession is reported as written — the buffered case is not blanket wording', async () => {
    render(
      <ConfessScreen
        offLimits={[]}
        propose={() => Promise.resolve(PROPOSAL)}
        submit={() =>
          Promise.resolve({
            read_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            wrote: { relay: true, pool: true, job: true, prose: true },
            proseBuffered: 0,
          })
        }
      />,
    );
    await reachChips();
    await userEvent.click(screen.getByRole('button', { name: 'Add to the pot' }));
    await waitFor(() => expect(screen.getByTestId('write-report')).toBeTruthy());
    expect(screen.getByTestId('write-report').textContent ?? '').toContain(
      `your memory: ${MEMORY_RECEIPT.sent}`,
    );
  });

  it('a FAILED prose write is reported as not written', async () => {
    render(
      <ConfessScreen
        offLimits={[]}
        propose={() => Promise.resolve(PROPOSAL)}
        submit={() =>
          Promise.resolve({
            read_id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
            wrote: { relay: true, pool: true, job: true, prose: false },
            proseBuffered: 0,
          })
        }
      />,
    );
    await reachChips();
    await userEvent.click(screen.getByRole('button', { name: 'Add to the pot' }));
    await waitFor(() => expect(screen.getByTestId('write-report')).toBeTruthy());
    expect(screen.getByTestId('write-report').textContent ?? '').toContain(
      `your memory: ${MEMORY_RECEIPT.failed}`,
    );
  });

  it('an edited chip is what gets pooled — the author is the last word', async () => {
    const h = realHarness([]);
    await reachChips();
    await userEvent.selectOptions(screen.getByLabelText('cadence'), 'daily');
    await userEvent.click(screen.getByRole('button', { name: 'Add to the pot' }));
    await waitFor(() => expect(h.relayEntries).toHaveLength(1));
    expect(h.relayEntries[0]?.cadence).toBe('daily');
  });

  it('a struck chip disables the pot button and explains why', async () => {
    const h = realHarness([]);
    await reachChips();
    await userEvent.click(screen.getByRole('button', { name: 'strike driver' }));

    expect(screen.getByTestId('struck-notice')).toBeTruthy();
    const pot = screen.getByRole<HTMLButtonElement>('button', { name: 'Add to the pot' });
    expect(pot.disabled).toBe(true);
    await userEvent.click(pot);
    expect(h.relayEntries).toHaveLength(0);

    // Un-striking restores it: the read is whole again.
    await userEvent.click(screen.getByRole('button', { name: 'strike driver' }));
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Add to the pot' }).disabled).toBe(false);
  });
});

describe('U2: the profile it writes as is the caller’s to decide', () => {
  it('renders with a provisioned profile’s off-limits list without inventing one', async () => {
    const h = realHarness([...sampleUsual.offLimits]);
    await reachChips();
    expect(screen.getByTestId('chips')).toBeTruthy();
    expect(h.poolCount()).toBe(0);
  });
});

describe('U2 confess — the refusal carries its scope (D-9)', () => {
  it('renders what off-limits does not do, beside what it did', async () => {
    // Driven through the flow rather than asserted against the exported constant, because a
    // constant can be correct while the element that shows it is missing — which is exactly
    // what happened here on the first attempt at this test.
    render(
      <ConfessScreen
        offLimits={['spicy']}
        propose={() => Promise.resolve({ blocked: true })}
        submit={() => Promise.resolve({})}
      />,
    );
    await userEvent.type(screen.getByLabelText('Your confession'), CONFESSION);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(screen.getByTestId('refusal')).toBeTruthy());
    const scope = screen.getByTestId('refusal-scope');
    expect(scope.textContent).toMatch(/not where it sends you/);
    expect(scope.textContent).toMatch(/allergens/i);
  });
});
