/**
 * Route containers (U1) — the four screens, connected.
 *
 * The screens themselves are pure views over injected ports (that is `U2`–`U5`'s design
 * and it is why they are testable). These containers are the other half: they hold the
 * loading and failure states that come with actually fetching something, so no screen
 * has to grow an `isLoading` branch it cannot test without a network.
 *
 * They live here rather than in the screens' own subdirectories because a container is
 * a composition decision — which backend, which profile — and composition is the shell's
 * job. `U2`–`U5` own `src/ui/<screen>/**`; this file and `backend.ts` are `U1`'s.
 */

import { useCallback, useEffect, useState } from 'react';

import type { Card, UsualProfile } from '../contracts/types.js';
import { createNudge } from '../nudge/nudge.js';
import { AskCard } from './ask/AskCard.js';
import { ConfessScreen } from './confess/ConfessScreen.js';
import { NudgeBanner } from './nudge/NudgeBanner.js';
import { OffLimitsEditor } from './settings/OffLimitsEditor.js';
import { PassPanel } from './pass/PassPanel.js';
import type { UiBackend } from './backend.js';

type Async<T> = { state: 'loading' } | { state: 'ready'; value: T } | { state: 'failed'; error: string };

function useAsync<T>(load: () => Promise<T>): Async<T> {
  const [result, setResult] = useState<Async<T>>({ state: 'loading' });
  useEffect(() => {
    let live = true;
    load().then(
      (value) => live && setResult({ state: 'ready', value }),
      (error: unknown) =>
        live &&
        setResult({ state: 'failed', error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      live = false;
    };
  }, [load]);
  return result;
}

/**
 * The failure state, shown instead of the screen.
 *
 * It says what did not load and why, rather than rendering an empty version of the
 * screen — a blank card or an empty off-limits list reads as "you have none", which
 * during a demo is a much more expensive misunderstanding than "this is not connected".
 */
function Unavailable({ what, error }: { what: string; error: string }) {
  return (
    <section aria-labelledby="screen-heading">
      <h1 id="screen-heading" className="text-2xl font-semibold">
        {what}
      </h1>
      <p data-testid="screen-unavailable" className="mt-3 rounded border border-refusal/40 p-3 text-refusal">
        {error}
      </p>
    </section>
  );
}

function Loading({ what }: { what: string }) {
  return (
    <section aria-labelledby="screen-heading">
      <h1 id="screen-heading" className="text-2xl font-semibold">
        {what}
      </h1>
      <p className="mt-3 text-muted">Loading…</p>
    </section>
  );
}

export function ConfessRoute({ backend }: { backend: UiBackend }) {
  const load = useCallback(() => backend.usual(), [backend]);
  const usual = useAsync<UsualProfile>(load);

  if (usual.state === 'loading') return <Loading what="Confess" />;
  // The off-limits list gates RECORDING, not recommendations (D-9) — but it is still not
  // decoration: guessing `[]` because the profile did not load would offer to pool a topic
  // the author had forbidden.
  if (usual.state === 'failed') return <Unavailable what="Confess" error={usual.error} />;

  return (
    <ConfessScreen
      offLimits={usual.value.offLimits}
      propose={(text, offLimits) => backend.propose(text, offLimits)}
      submit={(chips, text) => backend.submit(chips, text)}
    />
  );
}

export function AskRoute({ backend }: { backend: UiBackend }) {
  const load = useCallback(() => backend.card(), [backend]);
  const card = useAsync<Card>(load);

  if (card.state === 'loading') return <Loading what="Ask" />;
  if (card.state === 'failed') return <Unavailable what="Ask" error={card.error} />;
  return <AskCard card={card.value} />;
}

/**
 * Settings holds two independent things, so it must not have one failure path.
 *
 * The nudge lives entirely in N1's in-memory state — `createNudge()` here, no profile,
 * no network. The off-limits editor needs the profile. The first version returned
 * `<Unavailable>` for the whole route when the profile failed to load, which took the
 * nudge opt-in down with it: a control that cannot fail was hidden by an unrelated
 * failure. Caught by screenshotting the built app, where Settings rendered nothing but
 * an error while the toggle beside it would have worked fine.
 */
export function SettingsRoute({ backend }: { backend: UiBackend }) {
  const load = useCallback(() => backend.usual(), [backend]);
  const usual = useAsync<UsualProfile>(load);
  // One nudge per mount, not per render: N1 holds the day's allowance in it.
  const [nudge] = useState(() => createNudge());
  const [now] = useState(() => new Date().toISOString());

  return (
    <section aria-labelledby="screen-heading">
      <h1 id="screen-heading" className="text-2xl font-semibold">
        Settings
      </h1>
      <NudgeBanner nudge={nudge} now={now} />
      {usual.state === 'loading' ? (
        <p className="mt-3 text-muted">Loading your profile…</p>
      ) : usual.state === 'failed' ? (
        <p
          data-testid="screen-unavailable"
          className="mt-3 rounded border border-refusal/40 p-3 text-refusal"
        >
          {usual.error}
        </p>
      ) : (
        <OffLimitsEditor usual={usual.value} onSave={(next) => backend.saveUsual(next)} />
      )}
    </section>
  );
}

export function PassRoute({ backend }: { backend: UiBackend }) {
  // No fetch on mount: The Pass runs nothing until an operator presses something, which
  // is the property U5's confirm step exists to protect.
  return <PassPanel run={(action, values) => backend.runPass(action, values)} />;
}
