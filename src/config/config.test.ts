import { describe, expect, it } from 'vitest';

import { DEFAULT_SETTLE_WINDOW_SECONDS, loadConfig } from './env.js';
import { createLogger } from './logger.js';
import { createFlagStore, initialFlags } from './flagStore.js';

const FULL_ENV = {
  XTRACE_BASE_URL: 'https://xtrace.example',
  XTRACE_API_KEY: 'xt-key',
  RELAY_URL: 'https://relay.example',
  RELAY_TOKEN: 'demo-token',
  ANTHROPIC_API_KEY: 'sk-ant-test',
};

function captureLogger() {
  const lines: string[] = [];
  return { lines, logger: createLogger((m) => lines.push(m)) };
}

function omit(env: Record<string, string>, key: string): Record<string, string> {
  const copy: Record<string, string> = { ...env };
  delete copy[key];
  return copy;
}

describe('loadConfig', () => {
  it('a missing XTrace URL is an error naming the variable', () => {
    expect(() => loadConfig(omit(FULL_ENV, 'XTRACE_BASE_URL'))).toThrow(/XTRACE_BASE_URL/);
  });

  it('names every missing required variable at once', () => {
    expect(() => loadConfig({})).toThrow(
      /XTRACE_BASE_URL, XTRACE_API_KEY, RELAY_URL, RELAY_TOKEN/,
    );
  });

  it('an empty string counts as missing', () => {
    expect(() => loadConfig({ ...FULL_ENV, RELAY_TOKEN: '  ' })).toThrow(/RELAY_TOKEN/);
  });

  it('parses a full environment, with the settle-window default applied', () => {
    const config = loadConfig(FULL_ENV);
    expect(config.xtraceBaseUrl).toBe('https://xtrace.example');
    expect(config.anthropicApiKey).toBe('sk-ant-test');
    expect(config.settleWindowSeconds).toBe(DEFAULT_SETTLE_WINDOW_SECONDS);
  });

  it('SETTLE_WINDOW_SECONDS overrides the default and rejects garbage by name', () => {
    expect(loadConfig({ ...FULL_ENV, SETTLE_WINDOW_SECONDS: '312' }).settleWindowSeconds).toBe(312);
    expect(() => loadConfig({ ...FULL_ENV, SETTLE_WINDOW_SECONDS: 'soon' })).toThrow(
      /SETTLE_WINDOW_SECONDS/,
    );
    expect(() => loadConfig({ ...FULL_ENV, SETTLE_WINDOW_SECONDS: '-5' })).toThrow(
      /SETTLE_WINDOW_SECONDS/,
    );
  });

  it('absent ANTHROPIC_API_KEY parses to null without throwing', () => {
    expect(loadConfig(omit(FULL_ENV, 'ANTHROPIC_API_KEY')).anthropicApiKey).toBeNull();
  });
});

describe('initialFlags (the load-bearing optional-key rule)', () => {
  it('no API key → seeded + template, exactly two log lines, no throw', () => {
    const { lines, logger } = captureLogger();
    const flags = initialFlags(loadConfig(omit(FULL_ENV, 'ANTHROPIC_API_KEY')), logger);
    expect(flags.extraction).toBe('seeded');
    expect(flags.narrator).toBe('template');
    expect(flags.pool).toBe('live');
    expect(flags.demoMode).toBe(false);
    expect(lines).toEqual([
      'flag extraction live→seeded reason=no-api-key',
      'flag narrator live→template reason=no-api-key',
    ]);
  });

  it('with an API key → all live, zero log lines', () => {
    const { lines, logger } = captureLogger();
    const flags = initialFlags(loadConfig(FULL_ENV), logger);
    expect(flags).toEqual({ extraction: 'live', narrator: 'live', pool: 'live', demoMode: false });
    expect(lines).toEqual([]);
  });
});

describe('flag store', () => {
  it('setting a flag emits exactly one line', () => {
    const { lines, logger } = captureLogger();
    const store = createFlagStore(
      { extraction: 'live', narrator: 'live', pool: 'live', demoMode: false },
      logger,
    );
    store.set('narrator', 'template');
    expect(lines).toEqual(['flag narrator live→template reason=operator']);
    expect(store.get().narrator).toBe('template');
  });

  it('setting a flag to its current value emits nothing', () => {
    const { lines, logger } = captureLogger();
    const store = createFlagStore(
      { extraction: 'live', narrator: 'live', pool: 'live', demoMode: false },
      logger,
    );
    store.set('pool', 'live');
    expect(lines).toEqual([]);
  });

  it('reasons are carried and demoMode transitions log like any flag', () => {
    const { lines, logger } = captureLogger();
    const store = createFlagStore(
      { extraction: 'live', narrator: 'live', pool: 'live', demoMode: false },
      logger,
    );
    store.set('pool', 'relay-only', 'xtrace-not-settling');
    store.set('demoMode', true);
    expect(lines).toEqual([
      'flag pool live→relay-only reason=xtrace-not-settling',
      'flag demoMode false→true reason=operator',
    ]);
    expect(store.get()).toEqual({
      extraction: 'live',
      narrator: 'live',
      pool: 'relay-only',
      demoMode: true,
    });
  });

  it('get() returns a copy — callers cannot mutate the store', () => {
    const { logger } = captureLogger();
    const store = createFlagStore(
      { extraction: 'live', narrator: 'live', pool: 'live', demoMode: false },
      logger,
    );
    const snapshot = store.get();
    snapshot.pool = 'relay-only';
    expect(store.get().pool).toBe('live');
  });
});
