import { describe, expect, it } from 'vitest';

import { CORPUS_SIZE, loadCorpus, validateCorpus } from './validate-corpus.js';

function corpusFixture(overrides?: (places: unknown[]) => void): { places: unknown[] } {
  const places = loadCorpus().map((p) => ({
    ...p,
    tags: [...p.tags],
    signatureDishes: p.signatureDishes.map((d) => ({ ...d })),
  })) as unknown[];
  overrides?.(places);
  return { places };
}

describe('S1 corpus', () => {
  it('the committed corpus validates: exactly 40 places, unique slugs and dish ids', () => {
    const places = loadCorpus();
    expect(places).toHaveLength(CORPUS_SIZE);
    expect(new Set(places.map((p) => p.id)).size).toBe(CORPUS_SIZE);
    const dishes = places.flatMap((p) => p.signatureDishes.map((d) => d.dishId));
    expect(new Set(dishes).size).toBe(dishes.length);
  });

  it('the corpus gives scoring room to every axis K4 reads', () => {
    const places = loadCorpus();
    for (const band of [1, 2, 3, 4]) {
      expect(places.some((p) => p.priceBand === band), `priceBand ${band}`).toBe(true);
    }
    for (const tag of ['late_night', 'quiet', 'solo_friendly', 'gi_safe_options'] as const) {
      expect(places.filter((p) => p.tags.includes(tag)).length, tag).toBeGreaterThanOrEqual(5);
    }
    const spiceLevels = new Set(
      places.flatMap((p) => p.signatureDishes.map((d) => d.spiceLevel)),
    );
    expect([...spiceLevels].sort()).toEqual([0, 1, 2, 3]);
  });

  it('rejects a duplicate slug', () => {
    const broken = corpusFixture((places) => {
      (places[1] as { id: string }).id = (places[0] as { id: string }).id;
    });
    expect(() => validateCorpus(broken)).toThrow(/duplicate slug/);
  });

  it('rejects a dish id claimed by two places', () => {
    const broken = corpusFixture((places) => {
      const first = places[0] as { signatureDishes: Array<{ dishId: string }> };
      const second = places[1] as { signatureDishes: Array<{ dishId: string }> };
      const dish = second.signatureDishes[0];
      const stolen = first.signatureDishes[0];
      if (dish && stolen) dish.dishId = stolen.dishId;
    });
    expect(() => validateCorpus(broken)).toThrow(/claimed by both/);
  });

  it('rejects schema violations naming the place', () => {
    const badTag = corpusFixture((places) => {
      (places[2] as { tags: string[] }).tags = ['romantic'];
    });
    expect(() => validateCorpus(badTag)).toThrow(/closed tag set/);

    const badSpice = corpusFixture((places) => {
      const p = places[3] as { signatureDishes: Array<{ spiceLevel: number }> };
      const dish = p.signatureDishes[0];
      if (dish) dish.spiceLevel = 9;
    });
    expect(() => validateCorpus(badSpice)).toThrow(/spiceLevel must be 0\.\.3/);

    const badBand = corpusFixture((places) => {
      (places[4] as { priceBand: number }).priceBand = 7;
    });
    expect(() => validateCorpus(badBand)).toThrow(/priceBand must be 1\.\.4/);
  });

  it('rejects a wrong count', () => {
    const broken = corpusFixture((places) => {
      places.pop();
    });
    expect(() => validateCorpus(broken)).toThrow(/expected exactly 40 places, found 39/);
  });
});
