/**
 * Nudge rules (N1). Pure rules over an injected `now` plus a small persisted
 * state — NO timers in this module; the caller owns scheduling, and copy comes
 * from L1's catalog, never a model (design v0.8 §9: opt-in, at most once a
 * day, permanently silenceable in one tap).
 *
 * The day key is the DEVICE'S LOCAL calendar date: the wall-clock date as
 * written in the injected timestamp, taken literally. Converting to UTC first
 * would give a 23:00 nudge a fresh "day" at local midnight-minus-offset, so it
 * could fire twice in one evening for anyone west of Greenwich — which is why
 * this never constructs a Date at all.
 */

import type { Nudge } from '../contracts/modules.js';
import type { NudgeState } from '../contracts/types.js';

const DAY_KEY = /^(\d{4}-\d{2}-\d{2})/;

/** The wall-clock date exactly as the device wrote it — no UTC conversion. */
export function localDayKey(now: string): string {
  const match = DAY_KEY.exec(now);
  if (!match || match[1] === undefined) {
    throw new Error(`nudge: unparseable timestamp ${JSON.stringify(now)}`);
  }
  return match[1];
}

const DEFAULT_STATE: NudgeState = {
  optedIn: false, // opt-in, default OFF — §9 is non-negotiable
  silenced: false,
  armed: false,
  lastFiredDay: null,
};

export function createNudge(initial: Partial<NudgeState> = {}): Nudge {
  const state: NudgeState = { ...DEFAULT_STATE, ...initial };

  return {
    setOptIn(on: boolean): void {
      state.optedIn = on;
    },

    arm(): void {
      state.armed = true;
    },

    maybeFire(now: string): boolean {
      const day = localDayKey(now);
      if (state.silenced) return false; // permanent, one call, no way back
      if (!state.optedIn) return false; // never when opted out
      if (!state.armed) return false; // demo control: nothing fires unarmed
      if (state.lastFiredDay === day) return false; // at most once per local day
      state.lastFiredDay = day;
      state.armed = false; // an arm is consumed by the fire it triggers
      return true;
    },

    silenceForever(): void {
      state.silenced = true;
    },

    state(): NudgeState {
      return { ...state };
    },
  };
}

/**
 * Parse a persisted NudgeState at the boundary (N2, closing SL-23).
 *
 * The stored value comes back `unknown` from the SettingsStore on purpose — a store that
 * round-trips garbage must not launder it into a type (§1). `null` means "do not trust
 * this": the caller starts fresh and says so. Strict on shape and types, because a nudge
 * that half-parses `silenced` could fire at someone who said never.
 */
export function parseNudgeState(value: unknown): NudgeState | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { optedIn, silenced, armed, lastFiredDay } = record;
  if (typeof optedIn !== 'boolean') return null;
  if (typeof silenced !== 'boolean') return null;
  if (typeof armed !== 'boolean') return null;
  if (lastFiredDay !== null && typeof lastFiredDay !== 'string') return null;
  return { optedIn, silenced, armed, lastFiredDay };
}
