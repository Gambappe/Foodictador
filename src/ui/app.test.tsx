import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { AppShell } from './app.js';
import { DEFAULT_ROUTE, ROUTES } from './routes.js';

afterEach(cleanup);

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AppShell />
    </MemoryRouter>,
  );
}

describe('U1 shell renders every route', () => {
  // Driven off ROUTES rather than a hand-written list, so a route added without a
  // screen cannot slip past by simply not being in the test.
  for (const route of ROUTES) {
    it(`${route.path} renders its screen`, () => {
      renderAt(route.path);
      expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(route.title);
      // Placeholders name whose job the real screen is; U2–U5 replace them in their
      // own directories, and this assertion goes away with the last placeholder.
      expect(screen.getByText(route.task, { selector: 'code' })).toBeTruthy();
    });
  }

  it('covers the four routes the DAG names', () => {
    expect(ROUTES.map((r) => r.path).sort()).toEqual(['/ask', '/confess', '/pass', '/settings']);
  });

  it('an unknown path lands somewhere usable rather than blank', () => {
    renderAt('/nowhere');
    const landing = ROUTES.find((route) => route.path === DEFAULT_ROUTE);
    expect(landing).toBeDefined();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(landing?.title);
  });

  it('every screen is reachable from the nav', () => {
    renderAt(DEFAULT_ROUTE);
    const nav = screen.getByRole('navigation', { name: 'Screens' });
    for (const route of ROUTES) {
      expect(nav.querySelector(`a[href="#${route.path}"], a[href="${route.path}"]`)).not.toBeNull();
    }
  });
});

describe('U1 shell imports the same core the CLI does', () => {
  it('renders a kernel constant, proving the core is reachable from a browser bundle', async () => {
    const { KFLOOR } = await import('../kernel/cohorts.js');
    renderAt('/pass');
    expect(screen.getByText(new RegExp(`k ≥ ${KFLOOR}`))).toBeTruthy();
  });
});
