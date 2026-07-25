import type { Nudge } from '../modules.js';
import type { NudgeState } from '../types.js';

/** Stub nudge: carries state faithfully but never fires (plan-v1.0 stub tradition). */
export class StubNudge implements Nudge {
  private current: NudgeState = { optedIn: false, silenced: false, armed: false, lastFiredDay: null };

  setOptIn(on: boolean): void {
    this.current = { ...this.current, optedIn: on };
  }

  arm(): void {
    this.current = { ...this.current, armed: true };
  }

  maybeFire(_now: string): boolean {
    return false;
  }

  silenceForever(): void {
    this.current = { ...this.current, silenced: true, armed: false };
  }

  state(): NudgeState {
    return { ...this.current };
  }
}
