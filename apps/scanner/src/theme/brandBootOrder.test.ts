/**
 * The one thing that can silently un-brand this app, asserted structurally.
 * Same subject and same method as the wallet's `brandBootOrder.test.ts`; the
 * argument is in `./sealed`.
 *
 * A React Native `StyleSheet.create` copies its colours when its module is first
 * evaluated, so `./brand` has to write the salon's hex before any module that
 * reads a brand token is evaluated, and `Boot.tsx` arranges that by reaching `App`
 * through a DYNAMIC import. The failure mode is somebody adding an eager import to
 * `index.ts` or `Boot.tsx`: nothing throws, no screen looks broken, and every
 * scanner renders sage forever. So the entry's static import graph is walked and
 * asserted not to reach the theme.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** apps/scanner — two levels up from src/theme. */
const APP = resolve(__dirname, '..', '..');

/**
 * STATIC imports only. A dynamic `import('./App')` is deliberately NOT matched:
 * it is the boundary this file exists to defend, and treating it as an edge would
 * make the graph reach everything and the test vacuous. `export ... from` IS an
 * edge — a re-export evaluates its module just as an import does.
 */
const STATIC_EDGE = /(?:^|\n)\s*(?:import|export)[^\n;]*?\sfrom\s*['"]([^'"]+)['"]/g;

function resolveModule(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // a package, not our source
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), join(base, 'index.tsx')]) {
    if (!existsSync(candidate)) continue;
    try {
      readFileSync(candidate);
      return candidate;
    } catch {
      /* a directory — keep looking */
    }
  }
  return null;
}

function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const key = relative(APP, file);
    if (seen.has(key)) continue;
    seen.add(key);
    for (const match of readFileSync(file, 'utf8').matchAll(STATIC_EDGE)) {
      const next = resolveModule(file, match[1] as string);
      if (next) queue.push(next);
    }
  }
  return seen;
}

const ENTRY = join(APP, 'index.ts');
const fromEntry = staticGraph(ENTRY);

describe('the brand boot order', () => {
  /** KNOWN-POSITIVE FIRST: a walker that resolves nothing passes every exclusion. */
  it('walks the real graph', () => {
    expect(fromEntry).toContain('index.ts');
    expect(fromEntry).toContain('Boot.tsx');
    expect(fromEntry).toContain('src/theme/brand.ts');
    expect(fromEntry).toContain('src/state/salonIdentity.ts');
    expect(fromEntry).toContain('src/config/brand.ts');
  });

  it('registers Boot, not App', () => {
    const entrySrc = readFileSync(ENTRY, 'utf8');
    expect(entrySrc).toMatch(/registerRootComponent\(\s*Boot\s*\)/);
    expect(entrySrc).not.toMatch(/registerRootComponent\(\s*App\s*\)/);
  });

  /** The claim. If this fails, white-labelling is off for every salon. */
  it('cannot reach src/theme/index.ts before the brand is applied', () => {
    expect([...fromEntry].filter((f) => f === 'src/theme/index.ts')).toEqual([]);
  });

  it('cannot reach a screen or a component before the brand is applied', () => {
    const forbidden = [...fromEntry].filter(
      (f) => f.startsWith('src/screens/') || f.startsWith('src/components/'),
    );
    expect(forbidden).toEqual([]);
  });

  it('does not reach App statically at all', () => {
    expect(fromEntry).not.toContain('App.tsx');
  });

  /**
   * THE EXCLUSION IS MEANINGFUL, not trivially true: `App` genuinely does pull in
   * the theme at module scope, which is why it sits behind the dynamic import.
   */
  it('and App itself DOES reach the theme, which is why the boundary exists', () => {
    const fromApp = staticGraph(join(APP, 'App.tsx'));
    expect(fromApp).toContain('src/theme/index.ts');
    expect([...fromApp].some((f) => f.startsWith('src/screens/'))).toBe(true);
  });

  it('reaches App only through a dynamic import in Boot', () => {
    const boot = readFileSync(join(APP, 'Boot.tsx'), 'utf8');
    expect(boot).toMatch(/await import\('\.\/App'\)/);
    expect(boot).not.toMatch(/(?:^|\n)\s*import[^\n;]*from\s*'\.\/App'/);
  });

  /**
   * `config/brand.ts` is reachable eagerly and MUST be: the salon name is adopted
   * before App loads so the PIN screen's first frame carries it. That is safe only
   * because the module holds no colour — it must never import the theme.
   */
  it('keeps config/brand.ts free of the theme, since Boot imports it eagerly', () => {
    const src = readFileSync(join(APP, 'src', 'config', 'brand.ts'), 'utf8');
    expect(src).not.toMatch(/from\s*'\.\.\/theme'/);
    expect(src).not.toMatch(/@avo\/tokens/);
  });
});

describe('the seal is where it says it is', () => {
  it('src/theme/index.ts calls seal() at module scope', () => {
    const src = readFileSync(join(APP, 'src', 'theme', 'index.ts'), 'utf8');
    expect(src).toMatch(/\nseal\(\);/);
  });
});
