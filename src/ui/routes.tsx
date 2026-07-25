/**
 * The route table (U1).
 *
 * Every route points at the real screen. It used to point at a `Placeholder` on the
 * theory that "the integrator swaps the import when U2–U5 merge" — but `routes.tsx` is
 * U1's file and U1 is the same task as U2–U5, so the integrator was nobody, and four
 * finished screens sat unreachable behind placeholders (SL-27). DAG §2's within-a-lane
 * rule exists to stop two agents editing one file at once; it does not license one agent
 * holding both tasks to leave the seam unbuilt.
 *
 * The screens take their I/O as injected ports, so the wiring goes through `backend.ts`
 * (the one place a real host gets plugged in) and `screens.tsx` (the loading and failure
 * states that come with fetching). `task` stays on each spec because the registry cross-
 * check in `app.test.tsx` reads it — that test now asserts the opposite of what it used
 * to: no route may say "not built yet" for a task the registry calls done.
 *
 * The UI adds no domain logic (DAG §7 U1). It imports the same core the CLI imports;
 * `KFLOOR` below is a live demonstration of that rather than decoration — it proves
 * the kernel is reachable from a browser bundle.
 */

import { KFLOOR } from '../kernel/cohorts.js';
import { NOT_CONNECTED, type UiBackend } from './backend.js';
import { AskRoute, ConfessRoute, PassRoute, SettingsRoute } from './screens.js';

export interface RouteSpec {
  path: string;
  /** Shown in the shell's nav and as the screen heading. */
  title: string;
  /** The task that owns this screen. Cross-checked against the lock registry. */
  task: string;
  blurb: string;
  element: (backend: UiBackend) => JSX.Element;
}

export const ROUTES: readonly RouteSpec[] = [
  {
    path: '/confess',
    title: 'Confess',
    task: 'U2',
    blurb: 'One true thing you would never put in a review.',
    element: (backend) => <ConfessRoute backend={backend} />,
  },
  {
    path: '/ask',
    title: 'Ask',
    task: 'U3',
    blurb: 'Where should I eat tonight?',
    element: (backend) => <AskRoute backend={backend} />,
  },
  {
    path: '/settings',
    title: 'Settings',
    task: 'U4',
    blurb: 'Off-limits topics and the nudge.',
    element: (backend) => <SettingsRoute backend={backend} />,
  },
  {
    path: '/pass',
    title: 'The Pass',
    task: 'U5',
    blurb: `Census, near-tie inspector, seeding. Cohorts cite at k ≥ ${KFLOOR}.`,
    element: (backend) => <PassRoute backend={backend} />,
  },
];

/** Until a host with credentials is wired, every action fails with a reason. */
export const DEFAULT_BACKEND: UiBackend = NOT_CONNECTED;

/** Landing on `/` should not be a dead end during a demo. */
export const DEFAULT_ROUTE = '/ask';
