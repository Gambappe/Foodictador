import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { KFLOOR } from '../../kernel/cohorts.js';
import { CATALOG } from '../../llm/catalog.js';
import { AskCard } from './AskCard.js';
import { CITED_CARD, DEGRADED_CARD, MISS_CARD, PLAIN_CARD, cardFixture } from './fixtures.js';

afterEach(cleanup);

describe('U3: each variant renders from a fixture card', () => {
  it('cited: pick, reason, citation chip, rotation and usual lines, runners-up', () => {
    render(<AskCard card={CITED_CARD} />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe(CITED_CARD.pick.name);
    expect(screen.getByTestId('reason-line').textContent).toBe(CITED_CARD.reasonLine);

    const citation = screen.getByTestId('cohort-citation').textContent ?? '';
    expect(citation).toContain('6');
    // The driver is named as a phrase; the enum token is an identifier, not copy.
    expect(citation).toContain('your real spice tolerance');
    expect(citation).not.toContain('spice_tolerance_low');

    expect(screen.getByTestId('rotation-line').textContent).toBe(CITED_CARD.rotationLine);
    expect(screen.getByTestId('usual-line').textContent).toBe(CITED_CARD.usualLine);
    expect(screen.queryByTestId('cohort-miss')).toBeNull();

    const runners = screen.getByTestId('runners-up').textContent ?? '';
    for (const runner of CITED_CARD.runnersUp) {
      expect(runners).toContain(runner.place.name);
      expect(runners).toContain(runner.score.toFixed(3));
    }
  });

  it('cohort miss: the first-teller line stands in, and no count is drawn', () => {
    render(<AskCard card={MISS_CARD} />);
    expect(screen.getByTestId('cohort-miss').textContent).toBe(CATALOG.cohort_miss);
    expect(screen.queryByTestId('cohort-citation')).toBeNull();
  });

  it('degraded pool: the disclosure renders and the live count still does', () => {
    render(<AskCard card={DEGRADED_CARD} />);
    expect(screen.getByTestId('degraded-disclosure').textContent).toBe(CATALOG.degraded_pool);
    expect(screen.getByTestId('cohort-citation')).toBeTruthy();
  });

  it('plain: no citation, no miss, no disclosure — the pick carries itself', () => {
    render(<AskCard card={PLAIN_CARD} />);
    expect(screen.queryByTestId('cohort-citation')).toBeNull();
    expect(screen.queryByTestId('cohort-miss')).toBeNull();
    expect(screen.queryByTestId('degraded-disclosure')).toBeNull();
    expect(screen.getByTestId('reason-line').textContent).toBe(PLAIN_CARD.reasonLine);
  });

  it('a card with no runners-up omits the section rather than rendering an empty list', () => {
    render(<AskCard card={cardFixture({ runnersUp: [] })} />);
    expect(screen.queryByTestId('runners-up')).toBeNull();
  });
});

describe('U3: no confession text can reach the DOM', () => {
  // The contract makes this structural: `Card` carries no prose field, the citation is
  // {driver, k}, and the component accepts no children or free text. These assertions
  // are what would fail if someone widened either.
  const SENTINEL = 'I pretended to like the spice because everyone was watching';

  it('the citation path renders only a driver phrase and a count', () => {
    render(<AskCard card={CITED_CARD} />);
    const dom = document.body.textContent ?? '';
    expect(dom).not.toContain(SENTINEL);
    // Nothing sentence-shaped comes out of the pool: the chip is a phrase and a
    // number, so it carries no sentence punctuation for prose to hide behind.
    const citation = screen.getByTestId('cohort-citation').textContent ?? '';
    expect(citation).not.toMatch(/[.!?]/);
  });

  it('the cohort-miss path renders the catalog line verbatim and nothing else', () => {
    render(<AskCard card={MISS_CARD} />);
    expect(document.body.textContent ?? '').not.toContain(SENTINEL);
    expect(screen.getByTestId('cohort-miss').textContent).toBe(CATALOG.cohort_miss);
  });

  it('prose smuggled into a Card field is still only ever rendered as text, never markup', () => {
    // A hostile or buggy narrator is L3's problem to reject; the screen's job is to
    // guarantee it cannot become DOM. innerHTML would make a confession executable.
    render(<AskCard card={cardFixture({ reasonLine: `<img src=x onerror="alert(1)"> ${SENTINEL}` })} />);
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByTestId('reason-line').textContent).toContain(SENTINEL);
  });
});

describe('U3: the citation floor holds at the last place a number is drawn', () => {
  it(`a sub-floor citation renders the miss line instead of a smaller count`, () => {
    render(<AskCard card={cardFixture({ poolCitation: { driver: 'budget_ceiling', k: KFLOOR - 1 } })} />);
    expect(screen.queryByTestId('cohort-citation')).toBeNull();
    expect(screen.getByTestId('cohort-miss')).toBeTruthy();
    expect(document.body.textContent ?? '').not.toContain(`${KFLOOR - 1} of them`);
  });

  it('exactly KFLOOR is citable — the floor is inclusive', () => {
    render(<AskCard card={cardFixture({ poolCitation: { driver: 'budget_ceiling', k: KFLOOR } })} />);
    expect(screen.getByTestId('cohort-citation').textContent).toContain(String(KFLOOR));
  });
});
