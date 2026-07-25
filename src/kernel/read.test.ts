import { describe, expect, it } from 'vitest';

import { sampleRead } from '../contracts/fixtures/index.js';
import { mintReadId, parseRead } from './read.js';

describe('K1 parseRead', () => {
  it('a valid read round-trips unchanged', () => {
    expect(parseRead({ ...sampleRead })).toEqual(sampleRead);
  });

  it.each([
    ['signal', 'shouted_from_rooftop'],
    ['driver', 'spice_tolerance_high'],
    ['cadence', 'hourly'],
  ])('rejects a bad %s naming the field', (field, bad) => {
    expect(() => parseRead({ ...sampleRead, [field]: bad })).toThrow(new RegExp(`read\\.${field}`));
  });

  it('rejects an extra key — the schema is closed', () => {
    expect(() => parseRead({ ...sampleRead, received_at: '2026-07-25' })).toThrow(
      /unexpected field\(s\): received_at/,
    );
    expect(() => parseRead({ ...sampleRead, ingest_job_id: 'job-1' })).toThrow(
      /unexpected field\(s\): ingest_job_id/,
    );
  });

  it('rejects a missing key by name', () => {
    const partial: Record<string, unknown> = { ...sampleRead };
    delete partial['cadence'];
    expect(() => parseRead(partial)).toThrow(/missing "cadence"/);
  });

  it.each([
    ['1.0000001', 1.0000001],
    ['-0.1', -0.1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string "0.5"', '0.5'],
  ])('rejects weight %s', (_label, weight) => {
    expect(() => parseRead({ ...sampleRead, weight })).toThrow(/read\.weight/);
  });

  it('accepts the weight boundaries 0 and 1', () => {
    expect(parseRead({ ...sampleRead, weight: 0 }).weight).toBe(0);
    expect(parseRead({ ...sampleRead, weight: 1 }).weight).toBe(1);
  });

  it('rejects non-objects and empty identity fields', () => {
    expect(() => parseRead(null)).toThrow(/plain object/);
    expect(() => parseRead([sampleRead])).toThrow(/plain object/);
    expect(() => parseRead('read')).toThrow(/plain object/);
    expect(() => parseRead({ ...sampleRead, read_id: '' })).toThrow(/read\.read_id/);
    expect(() => parseRead({ ...sampleRead, place: '' })).toThrow(/read\.place/);
  });
});

describe('K1 mintReadId', () => {
  it('mints distinct uuid-v4-shaped ids', () => {
    const ids = new Set(Array.from({ length: 64 }, () => mintReadId()));
    expect(ids.size).toBe(64);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});
