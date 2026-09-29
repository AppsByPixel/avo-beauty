/**
 * Non-negotiable #9, audited against what this app ACTUALLY USES — and an honest
 * account of the part of go-live row 413 this cannot reach.
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * WHY THIS EXISTS SEPARATELY FROM `packages/tokens`' OWN AUDIT
 * ─────────────────────────────────────────────────────────────────────────────
 * `auditTokenContrast()` audits the TOKEN FILE: every pairing the JSON declares.
 * That is the right check for the palette and it is Lane C's evidence for the
 * dashboard. It says nothing about which pairs a given app puts on screen — a
 * palette can be entirely sound while one screen still puts white on `brand`.
 *
 * Lane C scanned the live DOM. React Native has no DOM, so that method does not
 * transfer, and the honest replacement is not "the same scan, weaker" — it is a
 * DIFFERENT and in one respect STRONGER check: the token maths applied to every
 * pairing that appears in this app's source, computed rather than eyeballed, and
 * exhaustive over the source rather than over whatever a run happened to render.
 *
 * WHAT IT CANNOT REACH, STATED PLAINLY AND MEASURED
 * ─────────────────────────────────────────────────────────────────────────────
 * A `Text`'s colour and the background it sits on are almost never in the same
 * style object: the background is on an ancestor `View`. Measured on this tree at
 * the time of writing — 569 style entries mention a colour and only 5 carry BOTH
 * a foreground and a background. So a same-object pair scan covers under 1% of
 * the surface, and pairing the rest needs the component tree resolved, which
 * means rendering.
 *
 * Therefore this file does NOT claim row 413. It claims the one thing inside the
 * row that IS a non-negotiable and IS soundly decidable from source: white text
 * never sits on `--avo-brand`. That claim is exhaustive here, because the rule is
 * about a specific pair and this app funnels the only legitimate white-on-brand
 * through `onBrandFill`.
 * ═════════════════════════════════════════════════════════════════════════════
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { AA_NORMAL_TEXT, brandPresets, contrastRatio, deriveBrandSet } from '@avo/tokens';
import { color, onBrandFill, brandTextColor, WHITE } from './index';

// --------------------------------------------------------------- the source --

const SRC = join(__dirname, '..');

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) return walk(full);
    return full.endsWith('.tsx') && !full.includes('.test.') ? [full] : [];
  });
}

/**
 * Top-level entries of every stylesheet in a file — `StyleSheet.create({...})`
 * and `brandedStyles(() => ({...}))`, the re-evaluable form every sheet that
 * reads a brand token now takes (`./live`). Both markers, or the scan silently
 * loses exactly the entries a rebrand touches.
 *
 * Brace-matched rather than regexed across the whole object, because a nested
 * object (a shadow, a transform) would otherwise split an entry in half and the
 * scan would silently under-report — an audit that misses pairs is worse than no
 * audit, since it reports success.
 */
function styleEntries(src: string): string[] {
  const out: string[] = [];
  const MARKERS = ['StyleSheet.create({', 'brandedStyles(() => ({'];
  let from = 0;
  for (;;) {
    const hits = MARKERS.map((m) => [src.indexOf(m, from), m] as const).filter(([i]) => i !== -1);
    if (hits.length === 0) break;
    const [start, marker] = hits.reduce((a, b) => (b[0] < a[0] ? b : a));
    let depth = 0;
    let end = start + marker.length - 1;
    for (let i = end; i < src.length; i += 1) {
      if (src[i] === '{') depth += 1;
      else if (src[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    const body = src.slice(start + marker.length, end);
    let d = 0;
    let cur = '';
    for (const ch of body) {
      if (ch === '{') d += 1;
      if (ch === '}') d -= 1;
      if (ch === ',' && d === 0) {
        out.push(cur);
        cur = '';
      } else cur += ch;
    }
    out.push(cur);
    from = end + 1;
  }
  return out;
}

const FILES = walk(SRC);
const ENTRIES = FILES.flatMap((f) =>
  styleEntries(readFileSync(f, 'utf8')).map((e) => ({ file: f.replace(SRC, ''), entry: e })),
);

const FG = /(?<!background)\bcolor\s*:\s*([^,\n]+)/;
const BG = /backgroundColor\s*:\s*([^,\n]+)/;

// ------------------------------------------------ #9, the decidable version --

describe('non-negotiable #9 — white text never on --avo-brand', () => {
  it('routes the only legitimate white-on-brand through brandDeep', () => {
    expect(onBrandFill.backgroundColor).toBe(color.brandDeep);
    expect(onBrandFill.backgroundColor).not.toBe(color.brand);
    expect(onBrandFill.color).toBe(WHITE);
  });

  it('and that pairing clears AA, computed rather than asserted', () => {
    const ratio = contrastRatio(WHITE, onBrandFill.backgroundColor);
    expect(ratio).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * THE RULE'S OWN JUSTIFICATION, as a number. If `brand` ever became a legal
   * text background this test would fail and somebody would have to say why —
   * which is the point. A non-negotiable whose reason is only in prose invites
   * "surely brand is fine".
   */
  it('fails AA against white, which is WHY the rule exists', () => {
    expect(contrastRatio(WHITE, color.brand)).toBeLessThan(AA_NORMAL_TEXT);
  });

  it('uses brandDeep for brand-coloured text on a light surface too', () => {
    expect(brandTextColor).toBe(color.brandDeep);
    expect(contrastRatio(brandTextColor, color.surface)).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
  });

  /**
   * THE EXHAUSTIVE HALF. `brand` is a SURFACE colour — "gradients, tints, dots,
   * progress fills" — so any style entry that fills with `color.brand` must not
   * also set a text colour. Every current use is a dot, a track or a
   * progress fill, and this is what keeps it that way.
   */
  it('never sets a text colour in the same entry as a brand fill', () => {
    const offenders = ENTRIES.filter(
      ({ entry }) => /backgroundColor\s*:\s*color\.brand\b/.test(entry) && FG.test(entry),
    ).map(({ file, entry }) => `${file}: ${entry.trim().slice(0, 70)}`);
    expect(offenders).toEqual([]);
  });

  it('never pairs a white foreground with any brand-family background', () => {
    const offenders = ENTRIES.filter(({ entry }) => {
      const fg = FG.exec(entry)?.[1] ?? '';
      const bg = BG.exec(entry)?.[1] ?? '';
      const fgWhite = /WHITE|color\.white|#fff/i.test(fg);
      return fgWhite && /color\.brand\b/.test(bg);
    }).map(({ file }) => file);
    expect(offenders).toEqual([]);
  });
});

// ------------------------- #9 across style entries: the split-entry pairing --

/**
 * WHITE ON `brand` WHEN THE FILL AND THE TEXT LIVE IN DIFFERENT STYLE ENTRIES.
 *
 * The two scans above read one entry at a time, so they cannot see the shape the
 * booking tick actually had: the fill on the `View` (`tickOn`), the white on the
 * `Text` inside it (`tickMark`). Each entry was innocent alone and the pair was a
 * #9 violation at ~3.5:1. The measured header above says why that shape is the
 * norm rather than the exception — a text colour and its background are almost
 * never in the same entry.
 *
 * So this resolves the JSX, not the style table. It parses every `.tsx` with the
 * TypeScript compiler, maps each `StyleSheet.create` entry to its fill and its
 * text colour, and for every element whose `style` can resolve to a `color.brand`
 * fill — unconditionally or behind a `selected &&` — it walks that element and
 * its JSX descendants for anything painted white: a style entry whose `color` is
 * white, an inline `{ color: WHITE }`, or an icon prop (`color`, `tintColor`,
 * `fill`, `stroke`). A descendant that paints its own non-brand background ends
 * the walk, because what sits inside it sits on that instead.
 *
 * WHAT IT STILL CANNOT SEE: a fill in one component and the white text in a
 * CHILD COMPONENT defined elsewhere (`<Fill><Badge /></Fill>`, where `Badge`
 * sets the white). Resolving that is rendering. Every current brand fill is a
 * leaf or holds its content inline — read by hand for this change, not proved
 * by the scan. The floor test below only proves the scan is finding fills.
 */

const WHITE_RAW = /^(WHITE|color\.white|dark\.text|onBrandFill\.color|'#fff(fff)?'|"#fff(fff)?"|'white'|"white")$/i;
const BRAND_FILL_RAW = /^color\.brand$/;
const ICON_COLOUR_PROPS = new Set(['color', 'tintColor', 'fill', 'stroke']);

type Paint = { bg?: string; fg?: string };

/**
 * The object literal a stylesheet is built from: the argument of
 * `StyleSheet.create({...})`, or the body of `brandedStyles(() => ({...}))`.
 */
function sheetLiteral(call: ts.CallExpression, sf: ts.SourceFile): ts.ObjectLiteralExpression | null {
  const callee = call.expression.getText(sf);
  const arg = call.arguments[0];
  if (!arg) return null;
  if (callee === 'StyleSheet.create') return ts.isObjectLiteralExpression(arg) ? arg : null;
  if (callee === 'brandedStyles' && ts.isArrowFunction(arg)) {
    let body: ts.Node = arg.body;
    while (ts.isParenthesizedExpression(body)) body = body.expression;
    return ts.isObjectLiteralExpression(body) ? body : null;
  }
  return null;
}

/** `styles.tickOn` → `{ bg: 'color.brand' }`, for every stylesheet in the file. */
function styleTable(sf: ts.SourceFile): Map<string, Paint> {
  const table = new Map<string, Paint>();
  const visit = (node: ts.Node): void => {
    const sheet =
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer &&
      ts.isCallExpression(node.initializer)
        ? sheetLiteral(node.initializer, sf)
        : null;
    if (sheet && ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
      for (const prop of sheet.properties) {
        if (!ts.isPropertyAssignment(prop) || !ts.isObjectLiteralExpression(prop.initializer)) continue;
        table.set(`${node.name.text}.${prop.name.getText(sf)}`, paintOf(prop.initializer, sf));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return table;
}

function paintOf(obj: ts.ObjectLiteralExpression, sf: ts.SourceFile): Paint {
  const paint: Paint = {};
  for (const p of obj.properties) {
    if (!ts.isPropertyAssignment(p)) continue;
    const key = p.name.getText(sf);
    if (key === 'backgroundColor') paint.bg = p.initializer.getText(sf).trim();
    if (key === 'color') paint.fg = p.initializer.getText(sf).trim();
  }
  return paint;
}

/** Every paint a `style={...}` expression can resolve to, across arrays, `&&` and ternaries. */
function stylePaints(el: ts.JsxOpeningLikeElement, table: Map<string, Paint>, sf: ts.SourceFile) {
  const found: Array<{ ref: string; paint: Paint }> = [];
  for (const attr of el.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== 'style') continue;
    const walkExpr = (n: ts.Node): void => {
      if (ts.isPropertyAccessExpression(n)) {
        const ref = n.getText(sf);
        const paint = table.get(ref);
        if (paint) found.push({ ref, paint });
      } else if (ts.isObjectLiteralExpression(n)) {
        found.push({ ref: 'inline', paint: paintOf(n, sf) });
        return;
      }
      ts.forEachChild(n, walkExpr);
    };
    if (attr.initializer) walkExpr(attr.initializer);
  }
  return found;
}

function paintsWhite(el: ts.JsxOpeningLikeElement, table: Map<string, Paint>, sf: ts.SourceFile): string | null {
  const viaStyle = stylePaints(el, table, sf).find(({ paint }) => paint.fg && WHITE_RAW.test(paint.fg));
  if (viaStyle) return viaStyle.ref;
  for (const attr of el.attributes.properties) {
    if (!ts.isJsxAttribute(attr) || !attr.initializer) continue;
    const name = attr.name.getText(sf);
    if (!ICON_COLOUR_PROPS.has(name)) continue;
    const raw = ts.isJsxExpression(attr.initializer)
      ? (attr.initializer.expression?.getText(sf).trim() ?? '')
      : attr.initializer.getText(sf).trim();
    if (WHITE_RAW.test(raw)) return `${name}=${raw}`;
  }
  return null;
}

const opening = (n: ts.Node): ts.JsxOpeningLikeElement | null =>
  ts.isJsxElement(n) ? n.openingElement : ts.isJsxSelfClosingElement(n) ? n : null;

/** Every white glyph, icon or text that can sit on a `color.brand` fill, in one file's source. */
function whiteOnBrandFill(source: string, file = 'fixture.tsx') {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const table = styleTable(sf);
  const fills: string[] = [];
  const offenders: string[] = [];
  const at = (n: ts.Node) => `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`;

  const underFill = (n: ts.Node, fillRef: string): void => {
    const el = opening(n);
    if (el) {
      const paints = stylePaints(el, table, sf);
      const ownGround = paints.find(
        ({ paint }) => paint.bg && !BRAND_FILL_RAW.test(paint.bg) && paint.bg !== "'transparent'",
      );
      if (ownGround) return;
      const white = paintsWhite(el, table, sf);
      if (white) offenders.push(`${at(n)} ${white} on ${fillRef}`);
    }
    ts.forEachChild(n, (c) => underFill(c, fillRef));
  };

  const visit = (n: ts.Node): void => {
    const el = opening(n);
    const fill = el && stylePaints(el, table, sf).find(({ paint }) => paint.bg && BRAND_FILL_RAW.test(paint.bg));
    if (el && fill) {
      fills.push(`${at(n)} ${fill.ref}`);
      const self = paintsWhite(el, table, sf);
      if (self) offenders.push(`${at(n)} ${self} on ${fill.ref}`);
      if (ts.isJsxElement(n)) for (const c of n.children) underFill(c, fill.ref);
      return;
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return { fills, offenders };
}

/**
 * The old booking tick, verbatim in shape: fill on the `View`, white on the
 * `Text` inside it, each in its own entry, the fill behind `selected &&`. Kept as
 * a fixture so the scan is proved able to fail on the thing it was written for,
 * rather than trusted to.
 */
const OLD_TICK = `
  const styles = StyleSheet.create({
    tick: { width: 22, borderColor: color.borderControl },
    tickOn: { backgroundColor: color.brand, borderColor: color.brand },
    tickMark: { color: WHITE, fontSize: 12 },
    deep: { backgroundColor: color.brandDeep },
  });
  export const Tick = ({ selected }) => (
    <View style={[styles.tick, selected && styles.tickOn]}>
      {selected ? <Text style={[text('bodyS'), styles.tickMark]}>✓</Text> : null}
    </View>
  );
  export const Icon = () => <View style={styles.tickOn}><Check color={WHITE} /></View>;
  export const Grounded = () => (
    <View style={styles.tickOn}><View style={styles.deep}><Text style={styles.tickMark}>ok</Text></View></View>
  );
`;

describe('non-negotiable #9 across style entries — white never inside a brand fill', () => {
  it('catches the split shape the booking tick had, and a white icon prop', () => {
    const { offenders } = whiteOnBrandFill(OLD_TICK);
    expect(offenders).toEqual([
      'fixture.tsx:10 styles.tickMark on styles.tickOn',
      'fixture.tsx:13 color=WHITE on styles.tickOn',
    ]);
  });

  /**
   * The same fixture as a `brandedStyles` sheet — the form every brand sheet in
   * this app now takes (`./live`). The scan missed every one of them the moment
   * they were converted: `found brand fills … at all` went from 20+ to 0.
   */
  it('reads a brandedStyles sheet exactly as it reads StyleSheet.create', () => {
    const branded = OLD_TICK.replace('StyleSheet.create({', 'brandedStyles(() => ({').replace(
      '  });\n  export const Tick',
      '  }));\n  export const Tick',
    );
    expect(branded).toContain('brandedStyles(() => ({');
    expect(branded).not.toContain('StyleSheet.create');
    expect(whiteOnBrandFill(branded).offenders).toEqual(whiteOnBrandFill(OLD_TICK).offenders);
  });

  it('does not flag white that sits on its own non-brand ground inside the fill', () => {
    const { fills, offenders } = whiteOnBrandFill(OLD_TICK);
    expect(fills).toHaveLength(3);
    expect(offenders.some((o) => o.startsWith('fixture.tsx:15'))).toBe(false);
  });

  const SCANNED = FILES.map((f) => whiteOnBrandFill(readFileSync(f, 'utf8'), f.replace(SRC, '')));

  /** A green bought with nothing: if the JSX stops resolving, this goes red first. */
  it('found brand fills in the JSX to check at all', () => {
    expect(SCANNED.flatMap((s) => s.fills).length).toBeGreaterThanOrEqual(20);
  });

  it('puts no white glyph, icon or text on a `color.brand` fill anywhere in the app', () => {
    expect(SCANNED.flatMap((s) => s.offenders)).toEqual([]);
  });
});

// ------------------------------------- every pair the source actually states --

/**
 * Resolve the app's colour identifiers against a PALETTE, rather than against
 * the module's own `color`.
 *
 * The palette is a parameter because it is no longer a constant. A salon's
 * `brandColor` is applied onto `theme.color` at boot (`./brand`), so the values
 * these entries resolve to at runtime depend on the tenant — and a scan that only
 * ever checked the sage defaults would be checking one of an unbounded number of
 * palettes and reporting success for all of them.
 */
function resolvePairs(palette: Record<string, string>) {
  return ENTRIES.flatMap(({ file, entry }) => {
    const fgRaw = FG.exec(entry)?.[1]?.trim();
    const bgRaw = BG.exec(entry)?.[1]?.trim();
    if (!fgRaw || !bgRaw) return [];
    const lookup = (raw: string): string | null => {
      if (raw === 'WHITE') return WHITE;
      const named = /^color\.([A-Za-z0-9_]+)$/.exec(raw);
      if (named) {
        const v = palette[named[1] as string];
        return typeof v === 'string' ? v : null;
      }
      return /^'#[0-9a-fA-F]{3,8}'$/.test(raw) ? raw.slice(1, -1) : null;
    };
    const fg = lookup(fgRaw);
    const bg = lookup(bgRaw);
    return fg && bg ? [{ file, fgRaw, bgRaw, fg, bg }] : [];
  });
}

/** The palette as it stands for this build — the sage the token file ships. */
const DEFAULT_PALETTE = color as unknown as Record<string, string>;

/**
 * The palette a rebranded salon actually gets: the three white-labelled entries
 * replaced by `deriveBrandSet`'s output, everything else left alone — which is
 * exactly what `./brand` writes and exactly what `generate.ts:42` white-labels.
 * `brandDeeper` and `brandTint2` deliberately stay sage here, so the cross-hue
 * pairs a rebrand creates are inside the scan rather than excluded from it.
 */
function rebranded(hex: string): Record<string, string> {
  const result = deriveBrandSet(hex);
  if (!result.ok) throw new Error(`${hex} is not viable: ${result.reason}`);
  return {
    ...DEFAULT_PALETTE,
    brand: result.set.brand,
    brandDeep: result.set.deep,
    brandTint: result.set.tint,
  };
}

/**
 * The three shipped demo salons, by the hex a salon row carries — read off
 * `brandPresets` rather than re-typed. The Amara entry was the literal `#6E7F6C`
 * and silently became a hex the product no longer ships when trunk revised the
 * brand ramp: the suite stayed green while one of its four tenants was fictional,
 * which is a worse outcome than going red.
 */
/**
 * The presets dark enough that white passes on their brand, scoped by NAME as
 * `packages/tokens/src/derive.test.ts` scopes them.
 */
const DARK_PRESETS = new Set(['forest']);
const isDarkTenant = (label: string) => DARK_PRESETS.has(label.split(' ')[0] ?? '');

const TENANTS: Array<[string, Record<string, string>]> = [
  ['the shipped default', DEFAULT_PALETTE],
  ...Object.entries(brandPresets).map(
    ([name, p]) =>
      [`${name} ${p.brand}, derived`, rebranded(p.brand)] as [string, Record<string, string>],
  ),
];

describe('every foreground/background pair stated in one style entry clears AA', () => {
  /**
   * Guards the scan itself. If a refactor moves every colour out of StyleSheet
   * objects this suite would pass by finding nothing — the failure mode
   * `chargeStates.test.ts` calls "a green bought with nothing". The count is
   * asserted as a floor, not an equality, so adding pairs does not fail it.
   */
  it('found pairs to check at all', () => {
    expect(resolvePairs(DEFAULT_PALETTE).length).toBeGreaterThanOrEqual(3);
  });

  /**
   * AND IT CLEARS AA FOR EVERY TENANT, not just for the build's own colour.
   * White-labelling means the same source resolves to a different palette per
   * salon, so #9's guarantee has to be a property of the SOURCE under any viable
   * hex — and the only reason it can be checked exhaustively at all is that the
   * shared package refuses a hex whose derived set cannot carry white.
   */
  for (const [label, palette] of TENANTS) {
    it(`and all of them clear AA under ${label}`, () => {
      const failures = resolvePairs(palette)
        .filter(({ fg, bg }) => contrastRatio(fg, bg) < AA_NORMAL_TEXT)
        .map(({ file, fgRaw, bgRaw, fg, bg }) => `${file}: ${fgRaw} on ${bgRaw} = ${contrastRatio(fg, bg).toFixed(2)}:1`);
      expect(failures).toEqual([]);
    });
  }

  /**
   * The two source scans above — "never sets a text colour in the same entry as a
   * brand fill" and "never pairs a white foreground with any brand-family
   * background" — are palette-INDEPENDENT: they match identifiers, not values, so
   * they already hold for every tenant. This asserts why the rule can never
   * become optional, per tenant, rather than leaving it as a claim in a comment.
   *
   * RESCOPED 2026-09-29, the way trunk rescoped `packages/tokens/src/derive.test.ts`.
   * This used to say "no viable brand hex ever makes white legible on `brand`",
   * and that was never true of every hex `deriveBrandSet` accepts: the dark
   * `forest` preset (#1F5A36) is one, and a merchant could always have typed it.
   * It is harmless, and this is the reason: #9 says white goes on `deep`, and a
   * dark brand's deep IS its brand. So the light tenants keep "white fails on
   * brand" — the rule's justification — and the dark ones assert the identity
   * that makes their white-on-deep the same pixels, with white clearing the brand
   * and both card stops. The #9 scans themselves are untouched.
   */
  it('and every light tenant fails white on `brand`, which is why the rule exists', () => {
    const legible = TENANTS.filter(([label]) => !isDarkTenant(label))
      .filter(([, palette]) => contrastRatio(WHITE, palette.brand as string) >= AA_NORMAL_TEXT)
      .map(([label]) => label);
    expect(legible).toEqual([]);
  });

  it('and every dark tenant is its own deep, with white clearing brand and both card stops', () => {
    const dark = Object.entries(brandPresets).filter(([name]) => DARK_PRESETS.has(name));
    expect(dark.length).toBeGreaterThan(0);
    for (const [name, p] of dark) {
      const palette = rebranded(p.brand);
      const derived = deriveBrandSet(p.brand);
      if (!derived.ok) throw new Error(`${name} was refused`);
      expect(palette.brandDeep, name).toBe(palette.brand);
      expect(contrastRatio(WHITE, palette.brand as string), name).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      expect(contrastRatio(WHITE, derived.set.cardFrom), name).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
      expect(contrastRatio(WHITE, derived.set.cardTo), name).toBeGreaterThanOrEqual(AA_NORMAL_TEXT);
    }
  });
});
