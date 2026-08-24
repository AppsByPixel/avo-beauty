/**
 * The one thing that can silently un-brand this app, asserted structurally.
 *
 * A React Native `StyleSheet.create` copies its colours when its module is first
 * evaluated. `src/theme/brand.ts` therefore has to write the salon's hex onto the
 * palette BEFORE any module that reads a brand token is evaluated, and `Boot.tsx`
 * arranges that by reaching `App` through a DYNAMIC import (`./sealed` carries the
 * full argument).
 *
 * The failure mode is not subtle in its effect and is invisible in a diff:
 * somebody adds `import { color } from './src/theme'` — or any screen, or any
 * component — to `index.ts` or `Boot.tsx`, that module is evaluated before the
 * hex is resolved, `seal()` fires, and from then on every build renders sage
 * whatever tenant it is for. Nothing throws. No screen looks broken. It is
 * exactly the bug this slice was dispatched to fix, reintroduced.
 *
 * So this walks the entry point's STATIC import graph and asserts it cannot reach
 * the theme. It scans source text rather than importing anything, because
 * importing is the thing being measured.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/** apps/wallet — three levels up from src/theme. */
const APP = resolve(__dirname, '..', '..');

/**
 * STATIC imports only. A dynamic `import('./App')` is deliberately NOT matched:
 * it is the boundary this whole file exists to defend, and treating it as an edge
 * would make the graph reach everything and the test vacuous.
 *
 * `export ... from` counts as a static edge too — a re-export evaluates the
 * module just as an import does.
 */
const STATIC_EDGE = /(?:^|\n)\s*(?:import|export)[^\n;]*?\sfrom\s*['"]([^'"]+)['"]/g;

function resolveModule(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null; // a package, not our source
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, 'index.ts'),
    join(base, 'index.tsx'),
  ]) {
    if (existsSync(candidate) && !candidate.endsWith('/')) {
      try {
        if (readFileSync(candidate).length >= 0) return candidate;
      } catch {
        /* a directory — keep looking */
      }
    }
  }
  return null;
}

/** Every file reachable from `entry` by static imports, as app-relative paths. */
function staticGraph(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    const key = relative(APP, file);
    if (seen.has(key)) continue;
    seen.add(key);
    const src = readFileSync(file, 'utf8');
    for (const match of src.matchAll(STATIC_EDGE)) {
      const next = resolveModule(file, match[1] as string);
      if (next) queue.push(next);
    }
  }
  return seen;
}

const ENTRY = join(APP, 'index.ts');
const fromEntry = staticGraph(ENTRY);

describe('the brand boot order', () => {
  /**
   * KNOWN-POSITIVE FIRST. A graph walker that resolves nothing would pass every
   * exclusion below by finding nothing at all — "a green bought with nothing".
   * These three assert the walker actually walks: through the entry, into Boot,
   * and on into Boot's own imports.
   */
  it('walks the real graph', () => {
    expect(fromEntry).toContain('index.ts');
    expect(fromEntry).toContain('Boot.tsx');
    expect(fromEntry).toContain('src/theme/brand.ts');
    expect(fromEntry).toContain('src/state/brandCache.ts');
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

  it('cannot reach a screen, a component or the theme before the brand is applied', () => {
    const forbidden = [...fromEntry].filter(
      (f) => f.startsWith('src/screens/') || f.startsWith('src/components/') || f === 'src/theme/index.ts',
    );
    expect(forbidden).toEqual([]);
  });

  it('does not reach App statically at all', () => {
    expect(fromEntry).not.toContain('App.tsx');
  });

  /**
   * THE EXCLUSION IS MEANINGFUL, not trivially true. `App` genuinely does pull in
   * the theme at module scope, which is why it has to sit behind the dynamic
   * import. If this ever stopped holding, the test above would be passing for the
   * wrong reason and the whole boot indirection could be deleted unnoticed.
   */
  it('and App itself DOES reach the theme, which is why the boundary exists', () => {
    const fromApp = staticGraph(join(APP, 'App.tsx'));
    expect(fromApp).toContain('src/theme/index.ts');
    expect([...fromApp].some((f) => f.startsWith('src/screens/'))).toBe(true);
  });

  /** And `Boot` is the module that actually reaches it, dynamically. */
  it('reaches App only through a dynamic import in Boot', () => {
    const boot = readFileSync(join(APP, 'Boot.tsx'), 'utf8');
    expect(boot).toMatch(/await import\('\.\/App'\)/);
    expect(boot).not.toMatch(/(?:^|\n)\s*import[^\n;]*from\s*'\.\/App'/);
  });
});

describe('the seal is where it says it is', () => {
  it('src/theme/index.ts calls seal() at module scope', () => {
    const src = readFileSync(join(APP, 'src', 'theme', 'index.ts'), 'utf8');
    // At module scope: a bare `seal();` on its own line, not inside a function.
    expect(src).toMatch(/\nseal\(\);/);
  });

  it('and nothing else calls it', () => {
    const callers = [...fromEntry, 'src/theme/index.ts', 'App.tsx']
      .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
      .filter((f) => f !== 'src/theme/sealed.ts' && f !== 'src/theme/index.ts')
      .filter((f) => /\bseal\(\)/.test(readFileSync(join(APP, f), 'utf8')));
    expect(callers).toEqual([]);
  });
});
