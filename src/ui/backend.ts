/**
 * The composition root for the UI (U1) — where the screens get their ports.
 *
 * Every screen takes its I/O as an injected port, because the browser holds no XTrace
 * credentials and the CLI is a Node process. Something has to construct those ports, and
 * until this file existed the answer was "nobody", which is how four finished screens
 * ended up unreachable behind placeholders (SL-27).
 *
 * `NOT_CONNECTED` is the default: it renders every real screen and makes each *action*
 * fail loudly and specifically. That is deliberately not the same thing as a placeholder.
 * A placeholder runs none of the screen's code, so the consent copy, the off-limits list,
 * the census table and the citation floor are all untested against a real browser and
 * invisible to anyone clicking through. This runs all of it, and tells the truth at the
 * one point where the truth is "there is no backend here yet".
 *
 * Wiring a real backend means replacing `NOT_CONNECTED` with an implementation of
 * `UiBackend` — an HTTP client against a host that owns the credentials. That host is not
 * this task's to build; what is this task's is making sure the seam has a name, one
 * place, and a screen behind it rather than a placeholder in front of it.
 */

import type { Card, ProposedRead, Read, UsualProfile } from '../contracts/types.js';
import type { CommandResult } from '../cli/render.js';
import type { ConfessOutcome } from './confess/ConfessScreen.js';
import type { PassAction } from './pass/actions.js';

/** Everything the four screens need from the outside world, in one place. */
export interface UiBackend {
  /** L2's chip preview for the confess screen. */
  propose: (text: string, offLimits: string[]) => Promise<ProposedRead | { blocked: true }>;
  /** M5's writeRead — the only writer. */
  submit: (chips: Omit<Read, 'read_id'>, text: string) => Promise<ConfessOutcome>;
  /** K7/X3's card for the ask screen. */
  card: () => Promise<Card>;
  /** The profile the settings screen edits. */
  usual: () => Promise<UsualProfile>;
  /** M3's setUsual. */
  saveUsual: (usual: UsualProfile) => Promise<void>;
  /** Runs one `confit` command for The Pass. */
  runPass: (action: PassAction, values: Readonly<Record<string, string>>) => Promise<CommandResult>;
}

export class BackendUnavailable extends Error {
  constructor(what: string) {
    super(
      `No backend is configured, so ${what} cannot run here. The browser holds no XTrace ` +
        `credentials — this screen needs a host that does.`,
    );
    this.name = 'BackendUnavailable';
  }
}

const reject = (what: string) => () => Promise.reject(new BackendUnavailable(what));

/**
 * The default backend: every screen renders, every action refuses with a reason.
 *
 * Reads reject too rather than returning empty data. An empty card or a blank off-limits
 * list would be indistinguishable from a real one, and a demo operator would read it as
 * "the pool is empty" rather than "nothing is connected".
 */
export const NOT_CONNECTED: UiBackend = {
  propose: reject('reading a confession'),
  submit: reject('adding to the pot'),
  card: reject('building a card'),
  usual: reject('loading your profile'),
  saveUsual: reject('saving your profile'),
  runPass: reject('this pass operation'),
};
