/**
 * The cached brand is on the palette before the first stylesheet is built.
 *
 * `Boot.tsx` applies the hex cached on the previous launch and only then
 * reaches `App` through a DYNAMIC import, so every stylesheet is built once,
 * from the salon's palette, and the first frame — sign-in, for a signed-out
 * phone — is already in the salon's colour.
 *
 * THIS USED TO GUARD WHITE-LABELLING ITSELF. The palette was sealed once the
 * first brand-reading module was evaluated, so an innocent static import here
 * that reached the theme would have left every salon in the default green for
 * good. Since `./live` a late hex repaints, so the failure is smaller now — a
 * default frame corrected a moment later, and every brand stylesheet built
 * twice — but it is still the wrong first frame on every launch, and still
 * invisible in a diff. So this still walks the entry point's STATIC import
 * graph and asserts it cannot reach the theme. It scans source text rather than
 * importing anything, because importing is the thing being measured.
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

  /** The claim. If this fails, every launch's first frame is the default palette. */
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
