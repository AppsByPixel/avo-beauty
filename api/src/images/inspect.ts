/**
 * What a byte string actually is, decided from the bytes and nothing else.
 *
 * ============================================================================
 * THIS IS A SECURITY BOUNDARY, NOT A CONVENIENCE
 * ============================================================================
 * Every byte inspected here was uploaded by a merchant and will be served back
 * to her customers by AVO, from an origin the wallet and the dashboard already
 * trust. That is the textbook stored-XSS delivery path, and the only thing
 * standing in it is this file plus the response headers in routes/images.ts.
 *
 * So three rules, and each one exists because the obvious alternative is wrong:
 *
 * 1. THE CLAIMED CONTENT TYPE IS AN ASSERTION BY THE ATTACKER. A header saying
 *    `image/png` costs nothing to type. It is checked against the magic bytes
 *    and a disagreement is a refusal — not a correction. Silently believing the
 *    bytes over the header would let `Content-Type: image/png` be the thing we
 *    store and serve for a file that is really something else; silently
 *    believing the header over the bytes is the classic upload bypass. Refusing
 *    is the only answer that cannot be turned into a primitive.
 *
 * 2. NOTHING HERE DECODES AN IMAGE. Width and height are read out of the
 *    container header — PNG's IHDR, JPEG's SOF, WebP's VP8/VP8L/VP8X — which
 *    means a decompression bomb never gets decompressed. The whole class of
 *    ImageMagick/libvips/libwebp memory-corruption CVEs is not mitigated here,
 *    it is ABSENT: this API has no image decoder linked into it and does not
 *    re-encode, resize or thumbnail. The cost of that is stated plainly in
 *    routes/images.ts § WHAT THIS DOES NOT DO.
 *
 * 3. AN ERROR MESSAGE NEVER ECHOES THE CONTENT. `familyOf` returns a fixed
 *    label from a closed list so a refusal can say "that looks like an SVG"
 *    without putting a single attacker-controlled byte into a response body.
 *
 * ============================================================================
 * SVG IS REFUSED. THE DESIGN ASKS FOR IT AND IT IS STILL REFUSED.
 * ============================================================================
 * `design/AVO Merchant Dashboard.dc.html` draws an `image-slot` for "App icon &
 * logo" captioned "square SVG or PNG, at least 1024px". That slot is the SALON
 * LOGO, which is not this slice — but the answer is written down here because
 * the next slice will ask.
 *
 * An SVG is not an image, it is an XML document with a script host in it:
 * `<script>`, `<foreignObject>`, `<a xlink:href="javascript:…">`, `<use>` with
 * an external reference, `<image href>` pulling a remote asset, and XXE through
 * a DOCTYPE. Served inline from AVO's origin with a member's session cookie or
 * bearer in scope, any one of those is stored XSS against a customer's wallet.
 * There is no known-complete SVG sanitiser; every published one has a bypass
 * history, and "we strip <script>" has never been the whole attack.
 *
 * The mitigations in routes/images.ts (`nosniff`, `Content-Security-Policy:
 * sandbox`, `default-src 'none'`) are real and are applied to every response —
 * but they are DEFENCE IN DEPTH, not the decision. A control whose failure mode
 * is "arbitrary script in the customer's wallet" should not be the only control.
 *
 * WHAT THE LOGO SLICE SHOULD DO INSTEAD, so nobody has to re-derive it:
 *   - accept PNG at >= 1024px, which is the other half of the design's own
 *     caption and loses nothing a salon logo needs; or
 *   - accept SVG at the boundary and RASTERISE it server-side to PNG at ingest,
 *     storing only the raster — the vector never reaches a browser; or
 *   - serve SVG from a separate, cookie-less origin with
 *     `Content-Disposition: attachment`, which is what the large hosts do and
 *     which is an infrastructure decision, not a code one.
 * Escalated rather than chosen, because it is the logo's decision and the logo
 * is deferred (services/salonOnboarding.ts § NOT BUILT).
 */

/** The three the product accepts. Ordered as they are checked. */
export const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;
export type AcceptedImageType = (typeof ACCEPTED_IMAGE_TYPES)[number];

export function isAcceptedImageType(v: unknown): v is AcceptedImageType {
  return typeof v === 'string' && (ACCEPTED_IMAGE_TYPES as readonly string[]).includes(v);
}

/** What the bytes are, once they have been believed. */
export interface ImageFacts {
  format: AcceptedImageType;
  width: number;
  height: number;
}

/**
 * A fixed label for what a rejected upload LOOKS like, from a closed list.
 *
 * Only ever used to write a sentence a merchant can act on ("that looks like an
 * SVG; PNG, JPEG or WebP please"). Never derived from the file's own text — see
 * rule 3 above.
 */
export type ImageFamily =
  | 'png'
  | 'jpeg'
  | 'webp'
  | 'gif'
  | 'svg'
  | 'avif'
  | 'heic'
  | 'bmp'
  | 'tiff'
  | 'pdf'
  | 'html'
  | 'zip'
  | 'unknown';

const startsWith = (b: Buffer, sig: readonly number[], at = 0): boolean => {
  if (b.length < at + sig.length) return false;
  for (let i = 0; i < sig.length; i += 1) if (b[at + i] !== sig[i]) return false;
  return true;
};

const ascii = (b: Buffer, at: number, len: number): string =>
  b.length < at + len ? '' : b.toString('latin1', at, at + len);

/**
 * A best-effort family label. Deliberately loose — this decides COPY, never
 * whether an upload is accepted. `inspectImage` below decides that, and it is
 * strict.
 */
export function familyOf(b: Buffer): ImageFamily {
  if (startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (startsWith(b, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return 'webp';
  if (ascii(b, 0, 6) === 'GIF87a' || ascii(b, 0, 6) === 'GIF89a') return 'gif';
  if (startsWith(b, [0x42, 0x4d])) return 'bmp';
  if (startsWith(b, [0x49, 0x49, 0x2a, 0x00]) || startsWith(b, [0x4d, 0x4d, 0x00, 0x2a]))
    return 'tiff';
  if (ascii(b, 0, 5) === '%PDF-') return 'pdf';
  if (startsWith(b, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  // ISO-BMFF: `....ftypXXXX`. AVIF and HEIC are the two that arrive from a phone.
  if (ascii(b, 4, 4) === 'ftyp') {
    const brand = ascii(b, 8, 4);
    if (brand === 'avif' || brand === 'avis') return 'avif';
    if (brand.startsWith('hei') || brand.startsWith('mif') || brand.startsWith('msf'))
      return 'heic';
  }
  /**
   * TEXT SNIFFING, AND ONLY FOR THE TWO THAT MATTER. An SVG may open with a
   * BOM, whitespace, an XML declaration, a DOCTYPE or a comment before `<svg`,
   * and an HTML file that a browser would render as HTML is the same threat by
   * a different name. 512 bytes is further than any of those preambles reach,
   * and the search is case-insensitive on a lower-cased copy so `<SVG` and
   * `<!DocType Html` do not walk past.
   */
  const head = b.subarray(0, 512).toString('latin1').toLowerCase();
  if (head.includes('<svg')) return 'svg';
  if (head.includes('<!doctype html') || head.includes('<html') || head.includes('<script'))
    return 'html';
  return 'unknown';
}

// ------------------------------------------------------------------- PNG ---

/**
 * IHDR is mandatory and must be the FIRST chunk (PNG spec, 11.2.2), so its
 * position is fixed: 8 bytes of signature, then a 4-byte length that must be 13,
 * then the type. Anything else is not a PNG this will serve.
 */
function pngDimensions(b: Buffer): { width: number; height: number } | null {
  if (b.length < 24) return null;
  if (b.readUInt32BE(8) !== 13) return null;
  if (ascii(b, 12, 4) !== 'IHDR') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

// ------------------------------------------------------------------ JPEG ---

/**
 * Walk the marker segments to the first Start Of Frame, which is where the
 * dimensions live. There is no fixed offset in JPEG: EXIF, ICC profiles and
 * comment segments come first and vary in size.
 *
 * The loop is bounded by the buffer, advances by the segment's own declared
 * length, and refuses a zero or negative advance — a malformed length field
 * must not be able to spin this forever on a request thread.
 */
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function jpegDimensions(b: Buffer): { width: number; height: number } | null {
  let i = 2; // past SOI
  while (i + 3 < b.length) {
    if (b[i] !== 0xff) return null; // not sitting on a marker: give up rather than guess
    let marker = b[i + 1] as number;
    // Fill bytes: any number of 0xFF may pad before the marker id.
    let j = i + 1;
    while (marker === 0xff && j + 1 < b.length) {
      j += 1;
      marker = b[j] as number;
    }
    // Standalone markers carry no length payload.
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i = j + 1;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return null; // EOI / start of scan, no SOF seen
    const lengthAt = j + 1;
    if (lengthAt + 1 >= b.length) return null;
    const segmentLength = b.readUInt16BE(lengthAt);
    if (segmentLength < 2) return null; // malformed; refuse rather than loop
    if (SOF_MARKERS.has(marker)) {
      // length(2) precision(1) height(2) width(2)
      if (lengthAt + 7 >= b.length) return null;
      const height = b.readUInt16BE(lengthAt + 3);
      const width = b.readUInt16BE(lengthAt + 5);
      return { width, height };
    }
    i = lengthAt + segmentLength;
  }
  return null;
}

// ------------------------------------------------------------------ WebP ---

/**
 * Three containers wear one extension. All three are handled because all three
 * come out of a real phone or a real design tool:
 *
 *   'VP8 '  lossy      — dimensions after the 3-byte start code 9d 01 2a
 *   'VP8L'  lossless   — 14 bits of (width-1) then 14 bits of (height-1)
 *   'VP8X'  extended   — a 24-bit canvas width-1 / height-1, little endian
 *
 * A WebP whose fourth chunk id is none of those is refused rather than assumed.
 */
function webpDimensions(b: Buffer): { width: number; height: number } | null {
  if (b.length < 30) return null;
  const chunk = ascii(b, 12, 4);
  if (chunk === 'VP8 ') {
    if (b.length < 30) return null;
    if (!(b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a)) return null;
    return {
      width: b.readUInt16LE(26) & 0x3fff,
      height: b.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    if (b.length < 25) return null;
    if (b[20] !== 0x2f) return null; // VP8L signature byte
    const bits = b.readUInt32LE(21);
    return {
      width: (bits & 0x3fff) + 1,
      height: ((bits >> 14) & 0x3fff) + 1,
    };
  }
  if (chunk === 'VP8X') {
    if (b.length < 30) return null;
    const w = (b[24] as number) | ((b[25] as number) << 8) | ((b[26] as number) << 16);
    const h = (b[27] as number) | ((b[28] as number) << 8) | ((b[29] as number) << 16);
    return { width: w + 1, height: h + 1 };
  }
  return null;
}

/**
 * The one entry point. Returns what the bytes ARE, or null if they are not one
 * of the three accepted formats or their header cannot be read.
 *
 * A zero dimension is null rather than `{width: 0}`: a 0x0 PNG is structurally
 * legal, carries no pixels, and would render as a broken tile in a shop list.
 */
export function inspectImage(bytes: Buffer): ImageFacts | null {
  const family = familyOf(bytes);
  let dims: { width: number; height: number } | null = null;
  let format: AcceptedImageType;

  if (family === 'png') {
    dims = pngDimensions(bytes);
    format = 'image/png';
  } else if (family === 'jpeg') {
    dims = jpegDimensions(bytes);
    format = 'image/jpeg';
  } else if (family === 'webp') {
    dims = webpDimensions(bytes);
    format = 'image/webp';
  } else {
    return null;
  }

  if (!dims) return null;
  if (!Number.isInteger(dims.width) || !Number.isInteger(dims.height)) return null;
  if (dims.width <= 0 || dims.height <= 0) return null;
  return { format, width: dims.width, height: dims.height };
}

/**
 * Copy for a refused family, WITH ITS INDEFINITE ARTICLE, because English does
 * not take one rule here: "a PNG" but "an SVG", "a HEIC" but "an AVIF" — the
 * article follows the sound of the initialism, not its letter. Templating `a
 * ${label}` produced "It looks like a SVG" in a real refusal, which is the kind
 * of thing a merchant reads as "this software was not finished". A table, not a
 * regex over vowels.
 */
export const FAMILY_COPY: Record<ImageFamily, string> = {
  png: 'PNG',
  jpeg: 'JPEG',
  webp: 'WebP',
  gif: 'GIF',
  svg: 'SVG',
  avif: 'AVIF',
  heic: 'HEIC',
  bmp: 'BMP',
  tiff: 'TIFF',
  pdf: 'PDF',
  html: 'HTML',
  zip: 'ZIP',
  unknown: 'not an image',
};

const FAMILY_ARTICLE: Record<ImageFamily, string> = {
  png: 'a',
  jpeg: 'a',
  webp: 'a',
  gif: 'a',
  svg: 'an',
  avif: 'an',
  heic: 'a',
  bmp: 'a',
  tiff: 'a',
  pdf: 'a',
  html: 'an',
  zip: 'a',
  unknown: '',
};

/** "an SVG", "a PNG", or "something else" when there is nothing to name. */
export function familyWithArticle(family: ImageFamily): string {
  if (family === 'unknown') return 'something else';
  return `${FAMILY_ARTICLE[family]} ${FAMILY_COPY[family]}`;
}
