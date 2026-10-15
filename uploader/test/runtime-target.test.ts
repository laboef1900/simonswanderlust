import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The type-checker's assumed standard library must actually exist in the
 * runtime this ships on.
 *
 * @ai-warning This is the one drift nothing else catches. Nothing in either
 * tree emits JavaScript — `typecheck` is `tsc --noEmit`, `start` is
 * `tsx src/main.ts`, and the Dockerfile runs `node --import tsx` — so
 * `target` governs only which globals TypeScript believes in. Set it above
 * what V8 ships and the code type-checks cleanly and throws at runtime, in
 * production, with no build step in between to notice. Set it below and
 * working APIs are invisible: that is how `Promise.withResolvers` came to be
 * written as `new Promise(...)` with a comment explaining the absence, under
 * an ES2022 floor on a Node 26 runtime, four years out of date.
 *
 * Raising the target fails here until a probe for the new edition is added.
 * That is deliberate — the probe IS the evidence that the claim is true.
 *
 * Deliberately reads tsconfig.json rather than restating its value: a test
 * carrying its own copy of the target would still pass after someone edited
 * the real one. Same reason `styles/tokens.test.ts` parses `global.css`.
 *
 * Not applied to `site/`, which inherits `target: "ESNext"` from
 * `astro/tsconfigs/base`. That is the framework's call for code Vite
 * transpiles for browsers, where `build.target` governs output instead;
 * overriding it would be meddling, and the asymmetry is intentional.
 */
const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const TSCONFIG = read('../tsconfig.json');
const PACKAGE = read('../package.json');

/**
 * One or more globals introduced by each edition, newest last. Cumulative:
 * a target of ES2025 asserts every era up to and including it.
 */
const ERAS: ReadonlyArray<readonly [string, ReadonlyArray<readonly [string, () => unknown]>]> = [
  ['ES2022', [
    ['Array.prototype.at', () => [].at],
    ['Object.hasOwn', () => Object.hasOwn],
  ]],
  ['ES2023', [
    ['Array.prototype.findLast', () => [].findLast],
    ['Array.prototype.toSorted', () => [].toSorted],
  ]],
  ['ES2024', [
    ['Promise.withResolvers', () => Promise.withResolvers],
    ['Object.groupBy', () => Object.groupBy],
  ]],
  // @ai-note Probes must be globals TYPESCRIPT also places at or below the
  // target — that is the whole invariant: everything the checker believes in
  // exists at runtime. `Array.fromAsync` is ES2024 in the spec but sits in
  // TypeScript's `esnext` lib, so referencing it here fails to compile under
  // an ES2025 target and proves nothing about it. Leave such APIs out.
  ['ES2025', [
    ['Set.prototype.union', () => Set.prototype.union],
    ['Promise.try', () => Promise.try],
    ['RegExp.escape', () => RegExp.escape],
    ['Iterator.prototype.take', () => Iterator.prototype.take],
  ]],
];

describe('tsconfig target vs the runtime', () => {
  const target = /"target"\s*:\s*"([^"]+)"/.exec(TSCONFIG)?.[1]?.toUpperCase();

  it('declares a target this file has probes for', () => {
    expect(target, 'no "target" in uploader/tsconfig.json').toBeDefined();
    expect(
      ERAS.map(([era]) => era),
      `target ${target} is unknown here. If it is a real edition, add its globals to ERAS ` +
        'and prove Node ships them; if it is "ESNext", see the @ai-warning above — it tracks ' +
        'the compiler, not V8.',
    ).toContain(target);
  });

  it('runs on a Node that provides every edition up to that target', () => {
    const upTo = ERAS.slice(0, ERAS.findIndex(([era]) => era === target) + 1);
    const missing = upTo.flatMap(([era, probes]) =>
      probes
        .filter(([, get]) => {
          try {
            return !get();
          } catch {
            return true;
          }
        })
        .map(([name]) => `${era}: ${name}`),
    );
    expect(missing, `${process.version} does not provide what target ${target} promises`).toEqual([]);
  });

  /*
   * The probe above only proves the machine running the suite is new enough.
   * The DECLARED floor is what a deployment is held to, and it is the thing
   * that justifies the target in the first place.
   */
  it('declares an engines floor new enough to justify that target', () => {
    const engines = /"node"\s*:\s*">=\s*(\d+)/.exec(PACKAGE)?.[1];
    expect(engines, 'no engines.node ">=N" in uploader/package.json').toBeDefined();
    // Iterator helpers and Set methods (ES2025) land in Node 22, Float16Array
    // in 24; 26 is the floor this project actually ships and tests on.
    expect(Number(engines)).toBeGreaterThanOrEqual(26);
  });
});
