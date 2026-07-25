import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { sampleUsual } from '../contracts/fixtures/index.js';
import { AppShell } from './app.js';
import { CITED_CARD } from './ask/fixtures.js';
import { NOT_CONNECTED, type UiBackend } from './backend.js';
import { DEFAULT_ROUTE, ROUTES } from './routes.js';

afterEach(cleanup);

/** A backend that answers, so the routes render their screens rather than an error. */
const CONNECTED: UiBackend = {
  ...NOT_CONNECTED,
  card: () => Promise.resolve(CITED_CARD),
  usual: () => Promise.resolve(sampleUsual),
};

function renderAt(path: string, backend: UiBackend = CONNECTED) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell backend={backend} />
    </MemoryRouter>,
  );
}

describe('U1 shell renders every route', () => {
  // Driven off ROUTES rather than a hand-written list, so a route added without a
  // screen cannot slip past by simply not being in the test.
  for (const route of ROUTES) {
    it(`${route.path} renders its screen`, async () => {
      renderAt(route.path);
      await waitFor(() =>
        expect(screen.getByRole('heading', { level: 1 }).textContent).not.toBe(''),
      );
    });
  }

  it('covers the four routes the DAG names', () => {
    expect(ROUTES.map((r) => r.path).sort()).toEqual(['/ask', '/confess', '/pass', '/settings']);
  });

  it('an unknown path lands somewhere usable rather than blank', async () => {
    renderAt('/nowhere');
    const landing = ROUTES.find((route) => route.path === DEFAULT_ROUTE);
    expect(landing).toBeDefined();
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
  });

  it('every screen is reachable from the nav', () => {
    renderAt(DEFAULT_ROUTE);
    const nav = screen.getByRole('navigation', { name: 'Screens' });
    for (const route of ROUTES) {
      expect(nav.querySelector(`a[href="#${route.path}"], a[href="${route.path}"]`)).not.toBeNull();
    }
  });
});

/**
 * SL-27. This replaces an assertion that did the opposite.
 *
 * The old smoke test asserted `getByText(route.task, {selector: 'code'})` — and the only
 * place `'U2'`…`'U5'` appeared in the DOM was inside the placeholder. So the test that
 * was supposed to prove the routes worked *required the placeholders to still be there*,
 * and wiring a real screen would have turned it red. A guard built backwards.
 *
 * These two assert the property that was actually wanted: a route whose task the registry
 * calls `done` must render that task's screen, and must not say "not built yet".
 */
describe('SL-27: a finished task’s route renders its screen, not a placeholder', () => {
  it.each(ROUTES.map((route) => [route.path, route] as const))(
    '%s renders no "not built yet" text',
    async (_path, route) => {
      renderAt(route.path);
      await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toBeTruthy());
      expect(screen.queryByText(/not built yet/i)).toBeNull();
      // The task id used to be rendered only by the placeholder. Its absence is the
      // specific thing that was wrong, so it is asserted specifically.
      expect(screen.queryByText(route.task, { selector: 'code' })).toBeNull();
    },
  );

  it('each route renders a marker only its real screen produces', async () => {
    // Headings alone would not catch a regression to placeholders — a placeholder has a
    // heading too. These are elements only the merged screens render.
    const markers: Record<string, string> = {
      '/confess': 'confession', // ConfessScreen's textarea, id="confession"
      '/ask': 'reason-line', // only AskCard renders it
      '/settings': 'off-limits-list',
      '/pass': 'section-census',
    };
    for (const [path, marker] of Object.entries(markers)) {
      cleanup();
      renderAt(path);
      await waitFor(() =>
        expect(
          document.querySelector(`[data-testid="${marker}"], #${marker}`),
          `${path} did not render ${marker}`,
        ).not.toBeNull(),
      );
    }
  });
});

describe('U1: an unreachable backend is reported, not rendered as emptiness', () => {
  it('says why rather than showing a blank card', async () => {
    // A blank card reads as "the pool is empty", which during a demo is a much more
    // expensive misunderstanding than "nothing is connected".
    renderAt('/ask', NOT_CONNECTED);
    await waitFor(() => expect(screen.getByTestId('screen-unavailable')).toBeTruthy());
    expect(screen.getByTestId('screen-unavailable').textContent).toMatch(/no backend is configured/i);
    expect(screen.queryByTestId('ask-card')).toBeNull();
  });

  it('confess refuses rather than guessing an empty off-limits list', async () => {
    // Guessing `[]` would offer to pool a topic the author had forbidden.
    renderAt('/confess', NOT_CONNECTED);
    await waitFor(() => expect(screen.getByTestId('screen-unavailable')).toBeTruthy());
    expect(screen.queryByLabelText('Your confession')).toBeNull();
  });
});

describe('U1 shell imports the same core the CLI does', () => {
  it('renders a kernel constant, proving the core is reachable from a browser bundle', async () => {
    const { KFLOOR } = await import('../kernel/cohorts.js');
    // The blurb carrying it lives on the route spec, which the nav and the shell share.
    expect(ROUTES.find((r) => r.path === '/pass')?.blurb).toContain(`k ≥ ${KFLOOR}`);
  });
});
