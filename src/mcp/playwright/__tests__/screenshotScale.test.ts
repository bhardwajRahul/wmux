import { beforeEach, describe, expect, it } from 'vitest';
import { readImageSize } from '../imageSize';
import {
  coordinateBasis,
  fitScreenshot,
  screenshotGeometry,
  SHRINK_LADDER,
  type ShrinkRung,
} from '../screenshotScale';
import {
  clearScreenshotScaleState,
  recallShrinkRung,
  rememberShrinkRung,
} from '../screenshotRefs';

/** A PNG header with the given dimensions — enough for the IHDR reader. */
function pngOf(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12, 'latin1');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** A JPEG with a JFIF APP0 segment ahead of the SOF0 frame header. */
function jpegOf(width: number, height: number): Buffer {
  const app0 = Buffer.alloc(4 + 14);
  app0.writeUInt16BE(0xffe0, 0);
  app0.writeUInt16BE(16, 2);
  app0.write('JFIF\0', 4, 'latin1');
  const sof = Buffer.alloc(2 + 2 + 6);
  sof.writeUInt16BE(0xffc0, 0);
  sof.writeUInt16BE(8, 2);
  sof.writeUInt8(8, 4);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

describe('readImageSize (#1358)', () => {
  it('reads a PNG IHDR', () => {
    expect(readImageSize(pngOf(900, 1690))).toEqual({ width: 900, height: 1690 });
  });

  it('reads a JPEG SOF past an APP0 segment', () => {
    expect(readImageSize(jpegOf(675, 1268))).toEqual({ width: 675, height: 1268 });
  });

  it('reads base64 as readily as bytes — that is how the lanes carry images', () => {
    expect(readImageSize(pngOf(390, 844).toString('base64'))).toEqual({ width: 390, height: 844 });
    expect(readImageSize(jpegOf(390, 844).toString('base64'))).toEqual({ width: 390, height: 844 });
  });

  it('returns null for anything else, rather than guessing a size', () => {
    expect(readImageSize(Buffer.from('not an image'))).toBeNull();
    expect(readImageSize(pngOf(10, 10).subarray(0, 12))).toBeNull();
  });
});

describe('the coordinate note states ONE factor (#1358)', () => {
  it('folds a devicePixelRatio of 3 and a 0.75 rung into a single scale', () => {
    // 400 CSS px wide, captured at dpr 3 (1200 px), downscaled to 0.75 (900).
    const geometry = screenshotGeometry(jpegOf(900, 1800), { width: 400, height: 800 });
    expect(geometry).toEqual({
      imageWidth: 900,
      imageHeight: 1800,
      viewportWidth: 400,
      viewportHeight: 800,
      scale: 2.25,
    });

    const text = coordinateBasis('viewport', geometry);
    expect(text).toContain('browser_click x = image_x / 2.25, y = image_y / 2.25');
    // Exactly one factor, and no trace of the two old sentences.
    expect(text.match(/2\.25/g)).toHaveLength(3); // x, y, and the JSON field
    expect(text).not.toContain('devicePixelRatio');
    expect(text).not.toContain('Divide image pixels by');
    expect(text).toContain(
      'screenshotScale: {"imageWidth":900,"imageHeight":1800,"viewportWidth":400,"viewportHeight":800,"scale":2.25}',
    );
  });

  it('says the scale is unknown once when the viewport cannot be read', () => {
    expect(screenshotGeometry(pngOf(900, 1800), null)).toBeNull();
    const text = coordinateBasis('viewport', null);
    expect(text.match(/unknown/g)).toHaveLength(1);
    expect(text).not.toContain('devicePixelRatio');
    expect(text).not.toContain('image_x /');
  });

  it('keeps the RPC lane and the non-viewport captures out of click space', () => {
    for (const kind of ['unsupported', 'fullPage', 'element'] as const) {
      const text = coordinateBasis(kind, null);
      expect(text).not.toContain('image_x /');
      expect(text).not.toContain('devicePixelRatio');
    }
    expect(coordinateBasis('unsupported', null)).toContain('does not support coordinate clicks');
  });
});

describe('the downscale ladder is deterministic per surface (#1358)', () => {
  const big = 'x'.repeat(1000);
  const payloads = new Map<number, string>([
    [1, 'x'.repeat(900)],
    [0.75, 'x'.repeat(400)],
    [0.5, 'x'.repeat(200)],
    [0.35, 'x'.repeat(100)],
    [0.25, 'x'.repeat(50)],
  ]);
  const shrink = async (rung: ShrinkRung) => payloads.get(rung.scale) ?? null;

  beforeEach(() => clearScreenshotScaleState());

  it('reuses the remembered rung even when the raw capture would now fit', async () => {
    const first = await fitScreenshot(big, { maxBytes: 500 }, shrink);
    expect(first.scale).toBe(0.75);
    expect(first.mimeType).toBe('image/jpeg');

    // A smaller page: the raw PNG is now under the ceiling. Without the memo
    // the factor would jump back to 1 and every coordinate would be wrong.
    const second = await fitScreenshot(
      'x'.repeat(100),
      { maxBytes: 500, rememberedScale: first.scale },
      shrink,
    );
    expect(second.scale).toBe(0.75);
  });

  it('goes smaller, never back up, when the remembered rung no longer fits', async () => {
    const fitted = await fitScreenshot(big, { maxBytes: 150, rememberedScale: 0.75 }, shrink);
    expect(fitted.scale).toBe(0.35);
  });

  it('remembers a rung per viewport and ceiling, and forgets it when either changes', () => {
    rememberShrinkRung('ws|s1', '400x800', 2048, 0.75);
    expect(recallShrinkRung('ws|s1', '400x800', 2048)).toBe(0.75);
    expect(recallShrinkRung('ws|s1', '800x600', 2048)).toBeNull();
    expect(recallShrinkRung('ws|s1', '400x800', 4096)).toBeNull();
    expect(recallShrinkRung('ws|s2', '400x800', 2048)).toBeNull();
  });

  it('states the rung without telling the caller to divide by it twice', async () => {
    const fitted = await fitScreenshot(big, { maxBytes: 500 }, shrink);
    expect(fitted.note).toContain('scaled to 0.75');
    expect(fitted.note).not.toContain('Divide image pixels');
  });

  it('returns the untouched PNG when it already fits and nothing is remembered', async () => {
    const fitted = await fitScreenshot('x'.repeat(10), { maxBytes: 500 }, shrink);
    expect(fitted).toMatchObject({ mimeType: 'image/png', note: '', scale: 1 });
  });

  it('keeps the ladder monotonically smaller', () => {
    const scales = SHRINK_LADDER.map((rung) => rung.scale);
    expect([...scales].sort((a, b) => b - a)).toEqual(scales);
  });
});
