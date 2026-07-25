import { describe, expect, it } from 'vitest';

import { createNudge, localDayKey } from './nudge.js';

const EVENING_LOCAL = '2026-07-25T16:00:00-07:00'; // UTC: 2026-07-25T23:00Z
const LATER_SAME_EVENING = '2026-07-25T23:00:00-07:00'; // UTC: 2026-07-26T06:00Z — day rolls in UTC, not locally
const NEXT_LOCAL_DAY = '2026-07-26T09:00:00-07:00';

function armedOptedIn() {
  const nudge = createNudge();
  nudge.setOptIn(true);
  nudge.arm();
  return nudge;
}

describe('N1 nudge rules', () => {
  it('never fires when opted out — opt-in is default OFF', () => {
    const nudge = createNudge();
    nudge.arm();
    expect(nudge.maybeFire(EVENING_LOCAL)).toBe(false);
    expect(nudge.state().optedIn).toBe(false);
  });

  it('never fires unarmed, even opted in', () => {
    const nudge = createNudge();
    nudge.setOptIn(true);
    expect(nudge.maybeFire(EVENING_LOCAL)).toBe(false);
  });

  it('fires once, then not again the same LOCAL day even across a UTC midnight', () => {
    const nudge = armedOptedIn();
    expect(nudge.maybeFire(EVENING_LOCAL)).toBe(true);
    nudge.arm();
    // A UTC implementation sees a new day here (06:00Z next day) and fires a
    // second time in one evening — the exact bug the local day key prevents.
    expect(nudge.maybeFire(LATER_SAME_EVENING)).toBe(false);
    expect(nudge.state().lastFiredDay).toBe('2026-07-25');
  });

  it('fires again on the next local day once re-armed', () => {
    const nudge = armedOptedIn();
    expect(nudge.maybeFire(EVENING_LOCAL)).toBe(true);
    nudge.arm();
    expect(nudge.maybeFire(NEXT_LOCAL_DAY)).toBe(true);
  });

  it('an arm is consumed by the fire it triggers', () => {
    const nudge = armedOptedIn();
    expect(nudge.maybeFire(EVENING_LOCAL)).toBe(true);
    expect(nudge.state().armed).toBe(false);
    expect(nudge.maybeFire(NEXT_LOCAL_DAY)).toBe(false); // new day, not re-armed
  });

  it('arming twice in the same day does not double-fire', () => {
    const nudge = armedOptedIn();
    expect(nudge.maybeFire(EVENING_LOCAL)).toBe(true);
    nudge.arm();
    nudge.arm();
    expect(nudge.maybeFire(LATER_SAME_EVENING)).toBe(false);
  });

  it('silenceForever is permanent and takes one call — arm cannot revive it', () => {
    const nudge = armedOptedIn();
    nudge.silenceForever();
    nudge.arm();
    nudge.setOptIn(true);
    expect(nudge.maybeFire(EVENING_LOCAL)).toBe(false);
    expect(nudge.maybeFire(NEXT_LOCAL_DAY)).toBe(false);
    expect(nudge.state().silenced).toBe(true);
  });

  it('persisted state round-trips through createNudge', () => {
    const first = armedOptedIn();
    first.maybeFire(EVENING_LOCAL);
    const revived = createNudge(first.state());
    revived.arm();
    expect(revived.maybeFire(LATER_SAME_EVENING)).toBe(false); // same local day survives restarts
    expect(revived.maybeFire(NEXT_LOCAL_DAY)).toBe(true);
  });

  it('state() returns a copy, not a live reference', () => {
    const nudge = createNudge();
    const snapshot = nudge.state();
    snapshot.optedIn = true;
    expect(nudge.state().optedIn).toBe(false);
  });

  it('throws on an unparseable timestamp rather than guessing a day', () => {
    const nudge = armedOptedIn();
    expect(() => nudge.maybeFire('yesterday-ish')).toThrow(/unparseable timestamp/);
  });

  it('localDayKey takes the wall-clock date literally — no UTC conversion, no Date', () => {
    expect(localDayKey('2026-07-25T23:59:59-07:00')).toBe('2026-07-25');
    expect(localDayKey('2026-07-25T00:00:01+13:00')).toBe('2026-07-25');
    expect(localDayKey('2026-07-25')).toBe('2026-07-25');
  });
});
