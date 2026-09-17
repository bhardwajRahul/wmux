// ---------------------------------------------------------------------------
// One number between a screenshot's pixels and browser_click's coordinates.
//
// The result used to state two independent factors in two sentences — the
// device pixel ratio, and the downscale rung the payload ceiling forced — and
// left the caller to multiply them. Under a phone preset (dpr 3) that had
// already been scaled to 0.75, both sentences were individually true and the
// division either one described was wrong (#1358).
//
// There is only one honest number, and it is measurable: the width of the
// image that was actually returned, over the width of the live viewport in CSS
// pixels. It absorbs the ratio, the rung, and anything a lane did on its own.
// ---------------------------------------------------------------------------

import { readImageSize } from './imageSize';
import { MAX_SCREENSHOT_MAXBYTES } from '../resultCap';

export interface ScreenshotGeometry {
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
  /** image px per viewport CSS px: browser_click x = image_x / scale. */
  readonly scale: number;
}

export interface Viewport {
  readonly width: number;
  readonly height: number;
}

/** Enough precision to click accurately, not enough to print float noise. */
export function roundScale(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/**
 * The geometry of a returned viewport capture, or null when either side of the
 * ratio is unknown — a lane that cannot report its viewport, or bytes that are
 * neither PNG nor JPEG. Null is stated to the caller, never papered over with
 * a guess.
 */
export function screenshotGeometry(
  image: Buffer | string,
  viewport: Viewport | null,
): ScreenshotGeometry | null {
  const size = readImageSize(image);
  if (!size || !viewport || viewport.width <= 0 || viewport.height <= 0) return null;
  return {
    imageWidth: size.width,
    imageHeight: size.height,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    scale: roundScale(size.width / viewport.width),
  };
}

export type CaptureKind = 'viewport' | 'fullPage' | 'element' | 'unsupported';

/**
 * The coordinate basis of a screenshot, stated in the result.
 *
 * Exactly one coordinate sentence for a viewport capture, and a machine-
 * readable line beside it. fullPage and element captures are not in viewport
 * space at all, so they say that clicking by x/y does not apply.
 */
export function coordinateBasis(
  kind: CaptureKind,
  geometry: ScreenshotGeometry | null,
): string {
  if (kind === 'fullPage') {
    return 'Coordinates in this image are DOCUMENT coordinates — NOT usable for browser_click x/y (which are viewport CSS px). Take a viewport screenshot (omit fullPage) if you need to click by coordinate.';
  }
  if (kind === 'element') {
    return 'Coordinates in this image are ELEMENT-relative — NOT usable for browser_click x/y (which are viewport CSS px).';
  }
  if (kind === 'unsupported') {
    return 'This backend does not support coordinate clicks (browser_click resolves elements by ref here), so no coordinate can be read off this image.';
  }
  if (!geometry) {
    return (
      'This is a viewport capture, but the image size or the viewport size could not be read here, ' +
      'so the image-to-CSS scale is unknown — click by ref from browser_snapshot instead of by coordinate.'
    );
  }
  return (
    `This is a viewport capture. Coordinates: browser_click x = image_x / ${geometry.scale}, ` +
    `y = image_y / ${geometry.scale} (or pass imageX/imageY and let browser_click divide).\n` +
    `screenshotScale: ${JSON.stringify(geometry)}`
  );
}

// ---------------------------------------------------------------------------
// The downscale ladder.
// ---------------------------------------------------------------------------

/**
 * One rung of the downscale ladder: a re-encode the lane can actually perform.
 * `scale` is relative to the ORIGINAL capture.
 */
export interface ShrinkRung {
  readonly scale: number;
  readonly quality: number;
}

/**
 * Owner decision: browser_screenshot NEVER refuses. Over the base64 ceiling
 * the image is re-encoded smaller — JPEG first, then progressively scaled —
 * and the result SAYS what was applied.
 */
export const SHRINK_LADDER: readonly ShrinkRung[] = Object.freeze([
  { scale: 1, quality: 80 },
  { scale: 0.75, quality: 80 },
  { scale: 0.5, quality: 75 },
  { scale: 0.35, quality: 70 },
  { scale: 0.25, quality: 60 },
]);

/** What a shrink produced, plus the sentence describing it. */
export interface FittedImage {
  readonly data: string;
  readonly mimeType: string;
  /** Empty when the original PNG was already within the ceiling. */
  readonly note: string;
  /** The rung that was applied; 1 when the original was returned as captured. */
  readonly scale: number;
}

export interface FitOptions {
  /**
   * The rung this surface settled on for the same viewport and ceiling. It is
   * reused even when the raw capture would now fit, so the scale the caller
   * reads does not drift between calls as the page grows and shrinks (#1358).
   */
  readonly rememberedScale?: number | null;
  readonly maxBytes: number;
}

/**
 * Walk the ladder until a rung fits under `maxBytes`. A rung that a lane cannot
 * perform returns null and ends the walk; the smallest payload seen is returned
 * either way, because handing back a too-large image with an honest note still
 * beats refusing.
 */
export async function fitScreenshot(
  original: string,
  options: FitOptions,
  shrink: (rung: ShrinkRung) => Promise<string | null>,
): Promise<FittedImage> {
  const ceiling = options.maxBytes;
  const remembered = options.rememberedScale ?? null;
  const pinned = remembered !== null && remembered < 1;
  // Pinned: start at the remembered rung and only ever go smaller from there.
  const ladder = pinned ? SHRINK_LADDER.filter((rung) => rung.scale <= remembered) : SHRINK_LADDER;
  if (!pinned && original.length <= ceiling) {
    return { data: original, mimeType: 'image/png', note: '', scale: 1 };
  }
  let best = { data: original, mimeType: 'image/png', scale: 1, quality: 0 };
  for (const [index, rung] of ladder.entries()) {
    const data = await shrink(rung).catch(() => null);
    if (data === null) break;
    // The pinned rung is taken as-is even when the raw PNG is smaller: a stable
    // factor is worth more than a few kilobytes.
    if ((pinned && index === 0) || data.length < best.data.length) {
      best = { data, mimeType: 'image/jpeg', scale: rung.scale, quality: rung.quality };
    }
    if (data.length <= ceiling) break;
  }
  if (best.mimeType === 'image/png') {
    // No lane knob produced anything smaller. Say so rather than pretending.
    return {
      data: best.data,
      mimeType: 'image/png',
      scale: 1,
      note:
        `This image is ${(best.data.length / (1024 * 1024)).toFixed(1)} MiB of base64, over the ` +
        `${(ceiling / (1024 * 1024)).toFixed(1)} MiB ceiling, and this capture path offers no ` +
        'downscale. Narrow the capture (omit fullPage, or scope to an element with ref).',
    };
  }
  const fits = best.data.length <= ceiling ? '' : ' It is still over the ceiling — narrow the capture.';
  return {
    data: best.data,
    mimeType: best.mimeType,
    scale: best.scale,
    // No division is stated here any more: the coordinate sentence above is
    // measured on these very bytes and already includes this rung.
    note:
      `Downscaled to fit the ${(ceiling / (1024 * 1024)).toFixed(1)} MiB ceiling: JPEG q${best.quality}` +
      `${best.scale === 1 ? ' at full size' : `, scaled to ${best.scale}`}.${fits}` +
      ` Pass maxBytes (up to ${MAX_SCREENSHOT_MAXBYTES / (1024 * 1024)} MiB) for the original.`,
  };
}
