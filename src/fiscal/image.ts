import { ApiError } from '../errors.js';

export type ReceiptImage = { bytes: Buffer; mime: 'image/jpeg' | 'image/png' | 'image/webp' };

const MAX_SIDE = 8000;
const MIN_SIDE = 300;

function dimensions(mime: ReceiptImage['mime'], b: Buffer): { w: number; h: number } | null {
  if (mime === 'image/png') return b.length >= 24 ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20) } : null;
  if (mime === 'image/webp') {
    const kind = b.toString('ascii', 12, 16);
    if (kind === 'VP8X' && b.length >= 30) return { w: 1 + b.readUIntLE(24, 3), h: 1 + b.readUIntLE(27, 3) };
    if (kind === 'VP8 ' && b.length >= 30) return { w: b.readUInt16LE(26) & 0x3fff, h: b.readUInt16LE(28) & 0x3fff };
    if (kind === 'VP8L' && b.length >= 25) {
      const bits = b.readUInt32LE(21);
      return { w: (bits & 0x3fff) + 1, h: ((bits >> 14) & 0x3fff) + 1 };
    }
    return null;
  }
  // JPEG: walk segments to the first start-of-frame marker.
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const marker = b[i + 1]!;
    const size = b.readUInt16BE(i + 2);
    if ((marker >= 0xc0 && marker <= 0xcf) && ![0xc4, 0xc8, 0xcc].includes(marker))
      return { h: b.readUInt16BE(i + 5), w: b.readUInt16BE(i + 7) };
    i += 2 + size;
  }
  return null;
}

/**
 * Validates an uploaded receipt photo WITHOUT decoding pixels: declared MIME must
 * match the magic bytes, size and dimensions are bounded. The image is only ever
 * held in memory (never written to disk or logged), so there is no temp file to
 * clean up and EXIF/GPS metadata is never retained: only extracted text is stored.
 */
export function validateImage(base64: string, mime: string, maxBytes: number): ReceiptImage {
  if (mime !== 'image/jpeg' && mime !== 'image/png' && mime !== 'image/webp')
    throw new ApiError(422, 'VALIDATION_FAILED', 'Unsupported image type');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new ApiError(422, 'VALIDATION_FAILED', 'Malformed image');
  if (base64.length > Math.ceil((maxBytes * 4) / 3) + 8) throw new ApiError(413, 'VALIDATION_FAILED', 'Image too large');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > maxBytes) throw new ApiError(413, 'VALIDATION_FAILED', 'Image too large');
  const magic =
    (mime === 'image/jpeg' && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) ||
    (mime === 'image/webp' && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
  if (!magic) throw new ApiError(422, 'VALIDATION_FAILED', 'Image content does not match its type');
  const size = dimensions(mime, bytes);
  if (!size || size.w < MIN_SIDE || size.h < MIN_SIDE || size.w > MAX_SIDE || size.h > MAX_SIDE)
    throw new ApiError(422, 'VALIDATION_FAILED', 'Image dimensions not accepted');
  return { bytes, mime };
}
