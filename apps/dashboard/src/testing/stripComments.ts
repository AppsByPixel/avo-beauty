/**
 * Blank every comment in a TS/TSX source and leave everything else — including line
 * breaks — exactly where it was, so a reported line number is the line in the real file.
 *
 * String literals are tracked because a `//` inside one is not a comment. The method is
 * `e2e/support/perm-census.ts`'s; it is reimplemented rather than imported because `e2e/`
 * is another lane's column and a cross-column import would make these tests fail whenever
 * that package is mid-edit.
 *
 * WHY IT LIVES HERE RATHER THAN INSIDE THE TEST THAT NEEDED IT FIRST.
 *
 * `consoleNavGates.test.ts` wrote it, and its reason generalises: this codebase's comments
 * discuss the very identifiers its source-scanning tests search for, at a ratio that makes
 * a naive `includes()` wrong in the direction that reads as passing. `requirePlatform`
 * appears in prose there about 2:1 over real calls. The same trap is live one file over —
 * `Settings.tsx § ModulesPanel` now carries a comment QUOTING the notice it deleted and
 * NAMING the column spellings the API refuses, so a scan for either that did not blank
 * comments would find the corrected history and report it as the uncorrected code.
 *
 * Two copies of a scanner is how the second copy stops matching the first. One copy, in
 * `src/testing/` and inside this lane's column, imported by both.
 *
 * SCOPE, STATED: it handles line comments, block comments, and the three string quotes.
 * It does NOT understand regex literals — `/foo/.test(s)` reads as the start of a comment.
 * No caller passes a source containing one, and a caller that does should fix this rather
 * than work around it.
 */
export function stripComments(src: string): string {
  const out = src.split('');
  let i = 0;
  const n = src.length;
  type State = 'code' | 'single' | 'double' | 'template';
  let state: State = 'code';

  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (state === 'code') {
      if (c === '/' && d === '/') {
        const start = i;
        while (i < n && src[i] !== '\n') i++;
        blank(start, i);
        continue;
      }
      if (c === '/' && d === '*') {
        const start = i;
        i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = Math.min(i + 2, n);
        blank(start, i);
        continue;
      }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      i++;
      continue;
    }

    if (c === '\\') {
      i += 2;
      continue;
    }
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code';
    }
    i++;
  }
  return out.join('');
}
