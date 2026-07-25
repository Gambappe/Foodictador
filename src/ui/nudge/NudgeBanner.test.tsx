import { cleanup, render, screen } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';

import { createNudge } from '../../nudge/nudge.js';
import { lint } from '../../kernel/copylint.js';
import { NudgeBanner } from './NudgeBanner.js';

afterEach(cleanup);

const EVENING = '2026-07-25T16:00:00-07:00'; // 23:00Z — same local day as below
const LATER_SAME_EVENING = '2026-07-25T23:00:00-07:00'; // 06:00Z NEXT day in UTC
const NEXT_LOCAL_DAY = '2026-07-26T09:00:00-07:00';

function armedOptedIn() {
  const nudge = createNudge();
  nudge.setOptIn(true);
  nudge.arm();
  return nudge;
}

describe('U4: the nudge banner', () => {
  it('does not appear when opted out — opt-in is default off', () => {
    const nudge = createNudge();
    nudge.arm();
    render(<NudgeBanner nudge={nudge} now={EVENING} />);
    expect(screen.queryByTestId('nudge-banner')).toBeNull();
  });

  it('appears once when opted in and armed', () => {
    render(<NudgeBanner nudge={armedOptedIn()} now={EVENING} />);
    expect(screen.getByTestId('nudge-banner')).toBeTruthy();
  });

  it('cannot appear twice in one LOCAL day, even across a UTC midnight', () => {
    const nudge = armedOptedIn();
    render(<NudgeBanner nudge={nudge} now={EVENING} />);
    expect(screen.getByTestId('nudge-banner')).toBeTruthy();
    cleanup();

    // A second showing later the same evening. In UTC the date has already rolled
    // over, so a UTC-based rule would fire again here — the exact bug N1's local day
    // key prevents, asserted at the surface a user would actually see it on.
    nudge.arm();
    render(<NudgeBanner nudge={nudge} now={LATER_SAME_EVENING} />);
    expect(screen.queryByTestId('nudge-banner')).toBeNull();
  });

  it('re-arming on the next local day shows it again', () => {
    const nudge = armedOptedIn();
    render(<NudgeBanner nudge={nudge} now={EVENING} />);
    cleanup();
    nudge.arm();
    render(<NudgeBanner nudge={nudge} now={NEXT_LOCAL_DAY} />);
    expect(screen.getByTestId('nudge-banner')).toBeTruthy();
  });

  it('dismiss hides it without silencing', async () => {
    const nudge = armedOptedIn();
    render(<NudgeBanner nudge={nudge} now={EVENING} />);
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByTestId('nudge-banner')).toBeNull();
    expect(nudge.state().silenced).toBe(false);
  });

  it('never again silences permanently, in one tap from the banner itself', async () => {
    const nudge = armedOptedIn();
    render(<NudgeBanner nudge={nudge} now={EVENING} />);
    await userEvent.click(screen.getByRole('button', { name: 'Never again' }));
    expect(nudge.state().silenced).toBe(true);
    expect(screen.getByTestId('nudge-silenced')).toBeTruthy();
    cleanup();

    // Arming a silenced nudge does nothing, on any later day.
    nudge.arm();
    nudge.setOptIn(true);
    render(<NudgeBanner nudge={nudge} now={NEXT_LOCAL_DAY} />);
    expect(screen.queryByTestId('nudge-banner')).toBeNull();
  });

  it('a re-render does not burn the day’s single allowance', () => {
    const nudge = armedOptedIn();
    const { rerender } = render(<NudgeBanner nudge={nudge} now={EVENING} />);
    rerender(<NudgeBanner nudge={nudge} now={EVENING} />);
    // Still showing: the decision was taken once, not re-asked on every pass.
    expect(screen.getByTestId('nudge-banner')).toBeTruthy();
  });

  it('the opt-in toggle writes through to N1', async () => {
    const nudge = createNudge();
    render(<NudgeBanner nudge={nudge} now={EVENING} />);
    await userEvent.click(screen.getByRole('checkbox'));
    expect(nudge.state().optedIn).toBe(true);
  });

  it('every string on the surface passes the K5 copy linter', () => {
    render(<NudgeBanner nudge={armedOptedIn()} now={EVENING} />);
    // §9: no quantity, weight, calories or progress language anywhere near a nudge.
    expect(lint(document.body.textContent ?? '')).toEqual({ ok: true });
  });
});
