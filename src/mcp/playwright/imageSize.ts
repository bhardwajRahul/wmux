// ---------------------------------------------------------------------------
// Encoded image dimensions, read from the bytes themselves.
//
// browser_screenshot states the factor between image pixels and viewport CSS
// pixels. That factor is only trustworthy when it is measured on the image the
// caller actually received — after the device pixel ratio, after any downscale
// rung, after a re-encode the lane performed on its own. So the width is read
// out of the encoded payload rather than reconstructed from the knobs that
// were asked for.
//
// Two formats are produced by the screenshot lanes (PNG and JPEG), so two
// header readers, no new dependency.
// ---------------------------------------------------------------------------

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** PNG: the IHDR chunk is always first, so width/height sit at a fixed offset. */
function readPngSize(bytes: Buffer): ImageSize | null {
  // 8 signature + 4 length + 4 type + 4 width + 4 height
  if (bytes.length < 24) return null;
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return null;
  if (bytes.subarray(12, 16).toString('latin1') !== 'IHDR') return null;
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * JPEG: walk the segment chain until a start-of-frame marker, whose payload
 * carries the real dimensions. SOF4 (0xC4, Huffman tables), SOF8 (0xC8) and
 * SOF12 (0xCC) share the 0xCn range but are not frame headers.
 */
function readJpegSize(bytes: Buffer): ImageSize | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      // Not on a marker boundary: the chain is unreadable, so say nothing
      // rather than guess from whatever the next 0xff happens to be.
      return null;
    }
    const marker = bytes[offset + 1];
    // Padding bytes between segments are legal.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Standalone markers carry no length field.
    if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      offset += 2;
      continue;
    }
    const length = bytes.readUInt16BE(offset + 2);
    if (length < 2) return null;
    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      // length(2) precision(1) height(2) width(2)
      if (offset + 9 >= bytes.length) return null;
      const height = bytes.readUInt16BE(offset + 5);
      const width = bytes.readUInt16BE(offset + 7);
      return width > 0 && height > 0 ? { width, height } : null;
    }
    offset += 2 + length;
  }
  return null;
}

/**
 * The encoded dimensions of a PNG or JPEG, or null when the bytes are neither
 * (or are truncated). `image` may be a Buffer or its base64 text — the
 * screenshot lanes hand around base64.
 */
export function readImageSize(image: Buffer | string): ImageSize | null {
  let bytes: Buffer;
  try {
    // Only the header is needed; a base64 prefix decodes to the same bytes, so
    // large payloads do not have to be decoded whole.
    // 65536 is a multiple of 4, so the base64 prefix decodes cleanly.
    bytes =
      typeof image === 'string'
        ? Buffer.from(image.slice(0, 65536), 'base64')
        : image.subarray(0, 65536);
  } catch {
    return null;
  }
  return readPngSize(bytes) ?? readJpegSize(bytes);
}
