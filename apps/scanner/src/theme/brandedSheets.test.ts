/**
 * Every stylesheet that reads a white-labelled token can be repainted.
 *
 * `./live` and `./branded` make a salon's hex apply while the till is running by rebuilding
 * each `brandedStyles` sheet in place. A plain `StyleSheet.create` that reads
 * `color.brandDeep` is NOT rebuilt: it keeps the colour it was born with, and
 * the app renders two brands at once — the half-themed state `sealed.ts` used to
 * exist to prevent. Nothing throws and the screen does not look broken; it just
 * has one default-green button on a Forest page. So this reads every source
 * file and fails on such a sheet, naming it.
 *
 * It scans source text rather than rendering, because the question is about
 * every sheet in the app, not the handful a render test reaches.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const APP = resolve(__dirname, '..', '..');

/** The tokens `./brand` writes, and the theme values `./index` derives from them. */
const WHITE_LABELLED =
  /\bcolor\.(?:brand|brandDeep|brandTint)\b|\bonBrandFill\b|\bBRAND_BORDER\b|\bFOCUS_RING_LIGHT\b|\bcard\.(?:from|to)\b|\btheme\.card\b/;

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return walk(full);
    return /\.tsx?$/.test(name) && !name.includes('.test.') ? [full] : [];
  });
}

/** The balanced argument list of every `marker(` call in `src`. */
function calls(src: string, marker: string): string[] {
  const out: string[] = [];
  for (let at = src.indexOf(marker); at !== -1; at = src.indexOf(marker, at + 1)) {
    let depth = 0;
    let i = at + marker.length - 1;
    for (; i < src.length; i += 1) {
      if (src[i] === '(') depth += 1;
      else if (src[i] === ')' && --depth === 0) break;
    }
    out.push(src.slice(at + marker.length, i));
  }
  return out;
}

/** Block and line comments out, so a sheet quoted in a header is not a sheet. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function frozenBrandSheets(src: string): number {
  return calls(code(src), 'StyleSheet.create(').filter((body) => WHITE_LABELLED.test(body)).length;
}

/**
 * Every MODULE-SCOPE value that captures a brand colour and is not repainted.
 *
 * A stylesheet is the common case, not the only one: an object like
 * `const PILL = { bg: color.brandTint }` at the top of a file is evaluated once
 * too. A top-level declaration whose initializer reads a white-labelled token is
 * an offender unless it is
 *   - a `brandedStyles(...)` sheet, or
 *   - a function (it reads the palette when called, which is at render), or
 *   - an alias of the live palette object itself (`theme.card`), or
 *   - re-derived by an `onRepaint(...)` in the same file that names it — so the
 *     exemption is proved by the fix being there, not granted by a list.
 */
function frozenBrandValues(src: string, file = 'fixture.tsx'): string[] {
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const repainted = calls(code(src), 'onRepaint(').join('\n');
  const out: string[] = [];
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      const init = decl.initializer;
      if (!init || !ts.isIdentifier(decl.name)) continue;
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) continue;
      if (ts.isCallExpression(init) && init.expression.getText(sf) === 'brandedStyles') continue;
      // An ALIAS of the live palette object (`const card = theme.card`) is not a
      // capture: it is the object `./brand` writes into.
      let bare: ts.Expression = init;
      while (ts.isAsExpression(bare)) bare = bare.expression;
      if (/^theme\.(?:card|color)$/.test(bare.getText(sf))) continue;
      if (!WHITE_LABELLED.test(code(init.getText(sf)))) continue;
      const name = decl.name.text;
      if (new RegExp(`\\b${name}\\b`).test(repainted)) continue;
      out.push(`${file} ${name}`);
    }
  }
  return out;
}

const FILES = [...walk(join(APP, 'src')), join(APP, 'App.tsx'), join(APP, 'Boot.tsx')];
const SOURCES = FILES.map((f) => ({ file: relative(APP, f), src: readFileSync(f, 'utf8') }));

describe('brand stylesheets are repaintable', () => {
  it('catches a plain StyleSheet.create that reads a brand token (fixture)', () => {
    const fixture = `
      const styles = StyleSheet.create({
        btn: { backgroundColor: onBrandFill.backgroundColor },
        edge: { borderColor: BRAND_BORDER },
      });`;
    expect(frozenBrandSheets(fixture)).toBe(1);
    expect(frozenBrandSheets(fixture.replace('StyleSheet.create({', 'brandedStyles(() => ({').replace('});', '}));'))).toBe(0);
    // A sheet that reads no brand token is left alone: it has nothing to repaint.
    expect(frozenBrandSheets('const s = StyleSheet.create({ a: { color: color.ink } });')).toBe(0);
  });

  it('catches a module-scope object that captures a brand colour (fixture)', () => {
    const frozen = `
      export const PILL = { gcal: { bg: color.brandTint, text: color.brandDeep } };
      const styles = StyleSheet.create({ a: { color: color.brandDeep } });
      const sheet = brandedStyles(() => ({ a: { color: color.brandDeep } }));
      const tint = (on: boolean) => (on ? color.brandDeep : color.ink);
      const INK = color.ink;
      export const cardGradient = theme.card;`;
    expect(frozenBrandValues(frozen)).toEqual(['fixture.tsx PILL', 'fixture.tsx styles']);
    const fixed = `${frozen}
      onRepaint(() => {
        PILL.gcal.bg = color.brandTint;
      });`;
    expect(frozenBrandValues(fixed)).toEqual(['fixture.tsx styles']);
  });

  /** Known-positive: the scan reads the real app and finds the sheets it guards. */
  it('finds the brand sheets it is guarding', () => {
    const branded = SOURCES.reduce((n, { src }) => n + calls(code(src), 'brandedStyles(').length, 0);
    expect(branded).toBeGreaterThanOrEqual(12);
  });

  it('no stylesheet in the app freezes a brand colour', () => {
    const offenders = SOURCES.filter(({ src }) => frozenBrandSheets(src) > 0).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });

  /**
   * `./brand` is excluded by name, and only it: it is the palette's WRITER, and
   * its `DEFAULTS` is a deliberate snapshot of the token file's values taken
   * before anything is written — the one module-scope copy that must not follow
   * the palette, because it is what a refused hex returns to.
   */
  it('no module-scope value in the app freezes a brand colour', () => {
    const consumers = SOURCES.filter(({ file }) => file !== 'src/theme/brand.ts');
    expect(consumers.length).toBe(SOURCES.length - 1);
    expect(consumers.flatMap(({ file, src }) => frozenBrandValues(src, file))).toEqual([]);
  });

  /**
   * The re-render half. The sheets are rebuilt in place, but nothing redraws
   * unless the root subscribes: `App` creates every screen's element in its own
   * render, so one subscription there re-renders the tree.
   */
  it('App subscribes to repaints at its root', () => {
    const app = readFileSync(join(APP, 'App.tsx'), 'utf8');
    const root = app.slice(app.indexOf('export default function App()'));
    const body = root.slice(0, root.indexOf('\n}\n'));
    expect(body).toMatch(/\n\s*useBrandRepaint\(\);/);
  });

  /**
   * Nothing below the root can opt out of that re-render. A memoised component
   * would bail out and keep drawing its old `styles` entries.
   */
  it('nothing in the app is memoised out of the root re-render', () => {
    const memo = SOURCES.filter(({ src }) => /\b(?:React\.)?memo\(|PureComponent\b/.test(code(src))).map(
      ({ file }) => file,
    );
    expect(memo).toEqual([]);
  });
});
