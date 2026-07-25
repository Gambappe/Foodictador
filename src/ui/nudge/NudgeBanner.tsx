/**
 * The nudge surface (U4): opt-in control and the quiet banner.
 *
 * Every rule lives in N1 (`src/nudge/**`) — opt-in defaults off, at most once per LOCAL
 * calendar day, permanent silence in one call. This file decides nothing; it asks
 * `maybeFire(now)` once per render pass and draws the answer. `now` is injected for the
 * same reason N1 takes it as a parameter: a component that reads its own clock cannot be
 * tested across the timezone boundary the rule exists for.
 *
 * Duty of care (design v0.8 §9) is visible in the markup: silence-forever is one tap
 * from the banner itself, and no string here mentions quantity, weight or progress —
 * the copy is L1 catalog text, which G3 lints.
 */

import { useState } from 'react';

import type { Nudge } from '../../contracts/modules.js';

export interface NudgeBannerProps {
  nudge: Nudge;
  /** The device's local wall-clock time, injected (N1 takes `now`, never reads it). */
  now: string;
}

export function NudgeBanner({ nudge, now }: NudgeBannerProps) {
  // The fire decision is consumed once and held: maybeFire() has a side effect (it
  // records the day), so calling it during render on every pass would burn the day's
  // single allowance on a re-render rather than on a showing.
  const [decision] = useState(() => nudge.maybeFire(now));
  const [dismissed, setDismissed] = useState(false);
  const [state, setState] = useState(() => nudge.state());

  function silence() {
    nudge.silenceForever();
    setState(nudge.state());
    setDismissed(true);
  }

  return (
    <div>
      <section aria-labelledby="nudge-heading">
        <h2 id="nudge-heading" className="text-lg font-semibold">
          The nudge
        </h2>
        <label className="mt-2 flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={state.optedIn}
            disabled={state.silenced}
            onChange={(event) => {
              nudge.setOptIn(event.target.checked);
              setState(nudge.state());
            }}
          />
          <span>Let Confit nudge me, at most once a day.</span>
        </label>
        {state.silenced ? (
          <p data-testid="nudge-silenced" className="mt-2 text-sm text-muted">
            Silenced for good. Confit will not nudge you again.
          </p>
        ) : null}
      </section>

      {decision && !dismissed ? (
        <aside
          data-testid="nudge-banner"
          role="status"
          className="mt-4 rounded border border-muted/30 bg-ground p-3 text-sm"
        >
          <p>A quiet moment to think about dinner, if you want one.</p>
          <div className="mt-2 flex gap-3">
            <button type="button" onClick={() => setDismissed(true)} className="text-muted">
              Dismiss
            </button>
            {/* One tap, from the nudge itself — design v0.8 §9, non-negotiable. */}
            <button type="button" onClick={silence} className="text-refusal">
              Never again
            </button>
          </div>
        </aside>
      ) : null}
    </div>
  );
}
