/**
 * Public entry point for the Confit core.
 *
 * The core is what both front ends consume: the CLI (`src/cli/**`) and, later, the UI
 * (`src/ui/**`). No behaviour lives in a front end — if a screen needs something the CLI
 * cannot do, it belongs in `src/kernel/**` or `src/memory/**` first.
 *
 * P0.2 (contracts freeze) re-exports the public types and module interfaces from here.
 * Until then this file exists to pin the module layout and give the toolchain something
 * to compile.
 */
export {};
