/**
 * Minimal line logger (P0.3). Logs go to stderr so CLI results own stdout; tests
 * inject a sink. One line per event — degrade transitions are grep-able by design.
 */

export interface Logger {
  line(message: string): void;
}

export function createLogger(sink: (message: string) => void = defaultSink): Logger {
  return { line: sink };
}

function defaultSink(message: string): void {
  process.stderr.write(`${message}\n`);
}
