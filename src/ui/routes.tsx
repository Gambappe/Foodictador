/**
 * The route table (U1).
 *
 * Every route points at a placeholder that `U2`–`U5` replace **inside their own
 * directories** — each of those tasks owns one subdirectory of `src/ui/**` and none
 * of them owns this file, so the swap is a one-line import change here at merge, the
 * same shape the CLI used for its command registry.
 *
 * The UI adds no domain logic (DAG §7 U1). It imports the same core the CLI imports;
 * `KFLOOR` below is a live demonstration of that rather than decoration — it proves
 * the kernel is reachable from a browser bundle, which is the constraint that would
 * otherwise only be discovered by U3 when it tries to render a citation.
 */

import { KFLOOR } from '../kernel/cohorts.js';

export interface RouteSpec {
  path: string;
  /** Shown in the shell's nav and as the placeholder heading. */
  title: string;
  /** The task that replaces this placeholder with the real screen. */
  task: string;
  blurb: string;
  element: () => JSX.Element;
}

function Placeholder({ title, task, blurb }: { title: string; task: string; blurb: string }) {
  return (
    <section aria-labelledby="screen-heading">
      <h1 id="screen-heading" className="text-2xl font-semibold">
        {title}
      </h1>
      <p className="mt-2 text-muted">{blurb}</p>
      <p className="mt-4 text-sm text-muted">
        Not built yet — task <code>{task}</code> owns this screen.
      </p>
    </section>
  );
}

export const ROUTES: readonly RouteSpec[] = [
  {
    path: '/confess',
    title: 'Confess',
    task: 'U2',
    blurb: 'One true thing you would never put in a review.',
    element: () => (
      <Placeholder
        title="Confess"
        task="U2"
        blurb="One true thing you would never put in a review."
      />
    ),
  },
  {
    path: '/ask',
    title: 'Ask',
    task: 'U3',
    blurb: 'Where should I eat tonight?',
    element: () => <Placeholder title="Ask" task="U3" blurb="Where should I eat tonight?" />,
  },
  {
    path: '/settings',
    title: 'Settings',
    task: 'U4',
    blurb: 'Off-limits topics and the nudge.',
    element: () => (
      <Placeholder title="Settings" task="U4" blurb="Off-limits topics and the nudge." />
    ),
  },
  {
    path: '/pass',
    title: 'The Pass',
    task: 'U5',
    blurb: `Census, near-tie inspector, seeding. Cohorts cite at k ≥ ${KFLOOR}.`,
    element: () => (
      <Placeholder
        title="The Pass"
        task="U5"
        blurb={`Census, near-tie inspector, seeding. Cohorts cite at k ≥ ${KFLOOR}.`}
      />
    ),
  },
];

/** Landing on `/` should not be a dead end during a demo. */
export const DEFAULT_ROUTE = '/ask';
