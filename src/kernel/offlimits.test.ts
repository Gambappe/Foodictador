import { describe, expect, it } from 'vitest';

import { isBlocked } from './offlimits.js';

describe('K2 isBlocked', () => {
  it('matches a plain topic anywhere in the text', () => {
    expect(isBlocked('I never talk about fasting with anyone', ['fasting'])).toBe(true);
  });

  it('is case-insensitive in both directions', () => {
    expect(isBlocked('FASTING again', ['fasting'])).toBe(true);
    expect(isBlocked('fasting again', ['Fasting'])).toBe(true);
    expect(isBlocked('FaStInG', ['fAsTiNg'])).toBe(true);
  });

  it('is accent-insensitive in both directions', () => {
    expect(isBlocked('the crème brûlée thing', ['creme brulee'])).toBe(true);
    expect(isBlocked('the creme brulee thing', ['crème brûlée'])).toBe(true);
    expect(isBlocked('jalapeño issues', ['jalapeno'])).toBe(true);
  });

  it('over-blocks by substring — "gluten" fires on "glutenous", and that is EXPECTED', () => {
    // The deliberate [E24] trade: substring, not word-boundary. A false negative
    // lets a forbidden topic into memory; a false positive is a reword.
    expect(isBlocked('that glutenous rice dish', ['gluten'])).toBe(true);
  });

  it('does not fire on an absent topic', () => {
    expect(isBlocked('I always order the mild one', ['fasting'])).toBe(false);
  });

  it('an empty topic list never blocks', () => {
    expect(isBlocked('anything at all', [])).toBe(false);
  });

  it('an empty-string topic never blocks (it would otherwise match everything)', () => {
    expect(isBlocked('anything at all', [''])).toBe(false);
    expect(isBlocked('anything at all', ['   '])).toBe(false);
  });

  it('empty text blocks nothing', () => {
    expect(isBlocked('', ['fasting'])).toBe(false);
  });

  it('any one of several topics is enough to block', () => {
    expect(isBlocked('a story about ramen', ['fasting', 'ramen'])).toBe(true);
  });
});
