/**
 * The UI shell (U1): chrome, routing, and nothing else.
 *
 * This file is also the Vite entry (see index.html). It mounts only when a `#root`
 * element exists, so importing `App` from a test renders nothing by itself — that is
 * what lets the shell be the entry without a `main.tsx` no task's Owns list names.
 *
 * No domain logic lives here or anywhere under `src/ui/**` (DAG §7 U1). The screens
 * call the same core the CLI calls; if a screen needs behaviour the CLI cannot do,
 * that behaviour is a kernel or memory task first.
 */

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { HashRouter, NavLink, Navigate, Route, Routes } from 'react-router-dom';

import { DEFAULT_BACKEND, DEFAULT_ROUTE, ROUTES } from './routes.js';
import type { UiBackend } from './backend.js';
import './tokens.css';

function Nav() {
  return (
    <nav aria-label="Screens" className="flex gap-4 border-b border-muted/20 pb-3">
      {ROUTES.map((route) => (
        <NavLink
          key={route.path}
          to={route.path}
          className={({ isActive }) =>
            isActive ? 'font-semibold text-pot' : 'text-muted hover:text-ink'
          }
        >
          {route.title}
        </NavLink>
      ))}
    </nav>
  );
}

/**
 * The routed shell, without a router — tests supply their own.
 *
 * `backend` is a parameter so a test can drive the real screens against a stub, which is
 * what makes "every route renders its screen" mean something beyond "a heading appeared".
 */
export function AppShell({ backend = DEFAULT_BACKEND }: { backend?: UiBackend } = {}) {
  return (
    <div className="mx-auto max-w-2xl p-6">
      <Nav />
      <main className="pt-6">
        <Routes>
          {ROUTES.map((route) => (
            <Route key={route.path} path={route.path} element={route.element(backend)} />
          ))}
          <Route path="*" element={<Navigate to={DEFAULT_ROUTE} replace />} />
        </Routes>
      </main>
    </div>
  );
}

/**
 * HashRouter, not BrowserRouter: the slice deploys as static files and the demo is run
 * from whatever host is to hand, so a deep link must not depend on server-side rewrite
 * rules nobody has configured.
 */
export function App() {
  return (
    <HashRouter>
      <AppShell />
    </HashRouter>
  );
}

const container = typeof document === 'undefined' ? null : document.getElementById('root');
if (container) {
  createRoot(container).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
