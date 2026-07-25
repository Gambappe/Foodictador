/**
 * U5 render tests.
 *
 * The load-bearing one is "renders the census's own verdict, not its own arithmetic".
 * It feeds the panel a **deliberately self-inconsistent** payload — k=2 marked citable,
 * k=90 marked below floor, a clean-looking table that exits 1 — and asserts the panel
 * repeats every one of those claims. A panel that recomputed `citable` from `k >= KFLOOR`
 * would "correct" the fixture and fail. That is the only way to distinguish a view from
 * a second implementation by observation: agreeing with a *correct* payload proves
 * nothing, because a reimplementation would agree too.
 *
 * The mechanical half of the acceptance — that each button is a real `confit` command —
 * lives in actions.test.ts, which checks against the CLI's own registry.
 *
 * Red-verified: rewriting the census cell as `row.k >= 5 ? 'citable' : 'below floor'` —
 * the exact reimplementation this task must not contain — fails "renders the census's
 * own verdict, not its own arithmetic" and nothing else. Marking `reset` as read-only in
 * actions.ts fails the two confirm-step tests below.
 */

import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import type { CommandResult } from '../../cli/render.js';
import { PASS_ACTIONS, type PassAction } from './actions.js';
import { PassPanel } from './PassPanel.js';

afterEach(cleanup);

interface Call {
  path: string;
  values: Record<string, string>;
}

/** Records every invocation, and answers with whatever the test staged. */
function harness(replies: Partial<Record<string, CommandResult>> = {}) {
  const calls: Call[] = [];
  const run = (action: PassAction, values: Readonly<Record<string, string>>) => {
    calls.push({ path: action.path.join(' '), values: { ...values } });
    return Promise.resolve(
      replies[action.id] ?? { lines: [`ran ${action.path.join(' ')}`], data: {} },
    );
  };
  render(<PassPanel run={run} />);
  return { calls };
}

/** Presses a button, going through the confirm step when the action mutates. */
async function press(label: string) {
  await userEvent.click(screen.getByRole('button', { name: new RegExp(`^${label}$`) }));
  const confirm = screen.queryByRole('button', { name: `Confirm: ${label}` });
  if (confirm) await userEvent.click(confirm);
}

const CENSUS_OK: CommandResult = {
  lines: ['Census (KFLOOR=5):'],
  data: {
    kfloor: 5,
    degraded: false,
    drivers: [
      { driver: 'spice_tolerance_low', k: 12, citable: true, manifest: 12, crosscheck: 'ok' },
      { driver: 'noise_sensitivity', k: 7, citable: true, manifest: 7, crosscheck: 'ok' },
    ],
    mismatches: [],
  },
};

describe('U5: the census table', () => {
  it('runs the command and renders a row per driver', async () => {
    const h = harness({ census: CENSUS_OK });
    await press('Run census');
    await waitFor(() => expect(screen.getByTestId('census-table')).toBeTruthy());
    expect(h.calls).toEqual([{ path: 'pass census', values: {} }]);
    const cells = within(screen.getByTestId('census-row-spice_tolerance_low'))
      .getAllByRole('cell')
      .map((cell) => cell.textContent);
    expect(cells).toEqual(['spice_tolerance_low', '12', 'citable', '12', 'ok']);
  });

  it('renders the census’s own verdict, not its own arithmetic', async () => {
    // Every claim below contradicts what recomputation would produce.
    harness({
      census: {
        lines: ['Census (KFLOOR=5):'],
        data: {
          kfloor: 5,
          degraded: false,
          drivers: [
            // k=2 is under the floor of 5, but the command says citable.
            { driver: 'a_driver', k: 2, citable: true, manifest: 2, crosscheck: 'ok' },
            // k=90 is way over, but the command says below floor…
            { driver: 'b_driver', k: 90, citable: false, manifest: 90, crosscheck: 'MISMATCH' },
          ],
          mismatches: ['b_driver'],
        },
        exit: 1,
      },
    });
    await press('Run census');
    await waitFor(() => expect(screen.getByTestId('census-table')).toBeTruthy());

    const a = screen.getByTestId('census-row-a_driver');
    expect(within(a).getByText('citable')).toBeTruthy();
    expect(within(a).queryByText('below floor')).toBeNull();

    const b = screen.getByTestId('census-row-b_driver');
    expect(within(b).getByText('below floor')).toBeTruthy();
    expect(within(b).getByText('MISMATCH')).toBeTruthy();
  });

  it('surfaces a non-zero exit instead of showing a table and calling it fine', async () => {
    harness({ census: { ...CENSUS_OK, exit: 1 } });
    await press('Run census');
    await waitFor(() => expect(screen.getByTestId('census-verdict')).toBeTruthy());
    expect(screen.getByTestId('census-verdict').textContent).toContain('exit 1');
    expect(screen.getByTestId('census-verdict').textContent).toMatch(/do not start the demo/i);
  });

  it('discloses a degraded pool', async () => {
    harness({ census: { ...CENSUS_OK, data: { ...CENSUS_OK.data, degraded: true } } });
    await press('Run census');
    await waitFor(() => expect(screen.getByTestId('census-degraded')).toBeTruthy());
  });

  it('falls back to the command’s own lines when the payload is not the shape it knows', async () => {
    harness({
      census: { lines: ['Census (KFLOOR=5):', '  something new'], data: { drivers: 'not-an-array' } },
    });
    await press('Run census');
    await waitFor(() => expect(screen.getByTestId('census-lines')).toBeTruthy());
    // Degraded to CLI output — never a blank panel, and never an invented number.
    expect(screen.getByTestId('census-lines').textContent).toContain('something new');
    expect(screen.queryByTestId('census-table')).toBeNull();
  });
});

describe('U5: the near-tie inspector', () => {
  it('reports the spread and top three the command returned', async () => {
    const h = harness({
      neartie: {
        lines: ['Near-tie spread: …'],
        data: {
          spread: 0.0142,
          near_tie_gap_max: 0.05,
          judge_shift_min: 0.02,
          worst_shift: 0.031,
          top3: [
            { place: 'rosas_taqueria', score: 0.82 },
            { place: 'pham_cafe', score: 0.81 },
            { place: 'the_larder', score: 0.806 },
          ],
          ok: true,
        },
      },
    });
    await press('Inspect near-tie');
    await waitFor(() => expect(screen.getByTestId('neartie-top3')).toBeTruthy());
    expect(h.calls).toEqual([{ path: 'pass neartie', values: {} }]);
    expect(screen.getByTestId('neartie-spread').textContent).toContain('0.0142');
    expect(screen.getByTestId('neartie-top3').textContent).toContain('rosas_taqueria');
    expect(screen.getByTestId('neartie-top3').textContent).toContain('the_larder');
  });
});

describe('U5: sweeper status', () => {
  it('shows oldest_entry_age_seconds, which is the number [E21] turns on', async () => {
    const h = harness({
      sweeper: {
        lines: ['swept'],
        data: { verified: 4, reingested: 1, retained: 2, oldest_entry_age_seconds: 914 },
      },
    });
    await press('Sweeper status');
    await waitFor(() => expect(screen.getByTestId('sweeper-status')).toBeTruthy());
    expect(h.calls).toEqual([{ path: 'sweep', values: { once: 'true' } }]);
    expect(screen.getByTestId('oldest-entry-age').textContent).toBe('914');
  });
});

describe('U5: flags', () => {
  it('sets a flag as key=value, the form pass-ops parses', async () => {
    const h = harness();
    await userEvent.selectOptions(screen.getByLabelText('flag'), 'narrator');
    await userEvent.selectOptions(screen.getByLabelText('value'), 'template');
    await press('Set flag');
    await waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0]).toEqual({ path: 'pass flags', values: { set: 'narrator=template' } });
  });

  it('changing the flag resets the value to one that flag accepts', async () => {
    const h = harness();
    // pool accepts relay-only; narrator does not. Carrying the old value over would
    // send `narrator=relay-only` and earn a usage error.
    await userEvent.selectOptions(screen.getByLabelText('flag'), 'pool');
    await userEvent.selectOptions(screen.getByLabelText('value'), 'relay-only');
    await userEvent.selectOptions(screen.getByLabelText('flag'), 'narrator');
    await press('Set flag');
    await waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0]?.values['set']).toBe('narrator=live');
  });

  it('reading flags sends no options', async () => {
    const h = harness();
    await press('Read flags');
    await waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0]).toEqual({ path: 'pass flags', values: {} });
  });
});

describe('U5: mutations are confirmed, reads are not', () => {
  it('a read runs on the first press', async () => {
    const h = harness();
    await userEvent.click(screen.getByRole('button', { name: 'Run census' }));
    await waitFor(() => expect(h.calls).toHaveLength(1));
  });

  it('clearing the relay takes two presses', async () => {
    const h = harness();
    await userEvent.click(screen.getByRole('button', { name: 'Clear relay' }));
    expect(h.calls).toHaveLength(0); // armed, not fired
    await userEvent.click(screen.getByRole('button', { name: 'Confirm: Clear relay' }));
    await waitFor(() => expect(h.calls).toEqual([{ path: 'pass reset', values: {} }]));
  });

  it('cancelling an armed mutation runs nothing', async () => {
    const h = harness();
    await userEvent.click(screen.getByRole('button', { name: 'Clear relay' }));
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(h.calls).toHaveLength(0);
    // And the button is back to its unarmed label, not stuck mid-confirm.
    expect(screen.getByRole('button', { name: 'Clear relay' })).toBeTruthy();
  });

  it('provision sends the chosen profile', async () => {
    const h = harness();
    await userEvent.selectOptions(screen.getByLabelText('profile'), 'B');
    await press('Provision profiles');
    await waitFor(() => expect(h.calls).toHaveLength(1));
    expect(h.calls[0]).toEqual({ path: 'pass provision', values: { profile: 'B' } });
  });
});

describe('U5: a command that throws does not leave a stale result on screen', () => {
  it('says the command did not run', async () => {
    const failing = () => Promise.reject(new Error('relay unreachable'));
    render(<PassPanel run={failing} />);
    await userEvent.click(screen.getByRole('button', { name: 'Run census' }));
    await waitFor(() => expect(screen.getByTestId('failure-census')).toBeTruthy());
    expect(screen.getByTestId('failure-census').textContent).toContain('relay unreachable');
    expect(screen.queryByTestId('census-table')).toBeNull();
  });
});

describe('U5: the panel offers exactly the registry’s actions', () => {
  it('every action has a button, and the CLI path is shown next to it', () => {
    harness();
    for (const action of PASS_ACTIONS) {
      expect(
        screen.getByRole('button', { name: new RegExp(`^${action.label}$`) }),
        `no button for ${action.id}`,
      ).toBeTruthy();
    }
    // Showing the command is what makes the panel auditable: an operator can see
    // which invocation a button stands for before pressing it.
    expect(screen.getAllByText('confit pass census').length).toBeGreaterThan(0);
    expect(screen.getAllByText('confit sweep').length).toBeGreaterThan(0);
  });
});
