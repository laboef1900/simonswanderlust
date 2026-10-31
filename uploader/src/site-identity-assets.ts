import { createHash } from 'node:crypto';
import sharp, { type Metadata, type OutputInfo } from 'sharp';
import { IdentityError } from '../../site/src/lib/site-identity.js';

export interface StoredIdentityAsset {
  role: string;
  sha256: string;
  width: number;
  height: number;
  bytes: Buffer;
}
export const IDENTITY_ASSET_ROLES = ['logo', 'favicon-32', 'favicon-192', 'apple-touch-180'] as const;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

export type IdentityAssetGroup = 'logo' | 'favicon';
export const IDENTITY_UPLOAD_BYTES = 2 * 1024 * 1024;
const INPUT_PIXELS = 4096 * 4096;
export class IdentityAssetError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

export function identityAssetRoles(group: IdentityAssetGroup): readonly string[] {
  return group === 'logo' ? ['logo'] : ['favicon-32', 'favicon-192', 'apple-touch-180'];
}

// libvips reports pages for WebP, but not APNG. Inspect PNG's bounded chunk
// structure as well; decoding only its default image would silently drop frames.
function pngFrames(bytes: Buffer): number {
  if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE)) return 1;
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.length - offset - 12) return 1; // the decoder rejects truncation
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    if (type === 'acTL' && length === 8) return bytes.readUInt32BE(offset + 8);
    if (type === 'IEND') break;
    offset += length + 12;
  }
  return 1;
}

/** Caller holds the process-wide shared work lock for probing AND encoding.
 * Originals never reach a filesystem, database, response or backup.
 */
export async function normalizeIdentityUpload(bytes: Buffer, group: IdentityAssetGroup): Promise<StoredIdentityAsset[]> {
  if (bytes.length > IDENTITY_UPLOAD_BYTES) throw new IdentityAssetError('asset_too_large', 413);
  // Never hand document/vector formats to a decoder. Metadata below remains
  // authoritative for the admitted raster containers, not the filename/MIME.
  const raster = bytes.subarray(0, 8).equals(PNG_SIGNATURE)
    || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    || (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP');
  if (!raster) throw new IdentityAssetError('unsupported_image_type', 415);
  const image = sharp(bytes, { limitInputPixels: INPUT_PIXELS, failOn: 'warning' });
  let meta: Metadata;
  try { meta = await image.metadata(); }
  catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/pixel limit/i.test(message)) throw new IdentityAssetError('image_too_large', 400);
    throw new IdentityAssetError('image_invalid', 400);
  }
  if (!['png', 'jpeg', 'webp'].includes(meta.format)) throw new IdentityAssetError('unsupported_image_type', 415);
  if ((meta.pages ?? 1) > 1 || pngFrames(bytes) > 1) throw new IdentityAssetError('animated_image', 400);
  const { width, height } = meta.autoOrient;
  if (!width || !height) throw new IdentityAssetError('image_invalid', 400);
  if (width * height > INPUT_PIXELS) throw new IdentityAssetError('image_too_large', 400);
  if (group === 'logo' ? height < 32 : width < 180 || height < 180) throw new IdentityAssetError('image_too_small', 400);
  const outputs: StoredIdentityAsset[] = [];
  for (const role of identityAssetRoles(group)) {
    const size = role === 'favicon-32' ? 32 : role === 'favicon-192' ? 192 : 180;
    let pipeline = image.clone().rotate().toColourspace('srgb');
    pipeline = role === 'logo'
      ? pipeline.resize({ width: 960, height: 240, fit: 'inside', withoutEnlargement: true })
      : pipeline.resize(size, size, { fit: 'contain', background: role === 'apple-touch-180' ? '#fbfbfd' : { r: 0, g: 0, b: 0, alpha: 0 } });
    if (role === 'apple-touch-180') pipeline = pipeline.flatten({ background: '#fbfbfd' });
    let encoded: { data: Buffer; info: OutputInfo };
    try { encoded = await pipeline.png({ compressionLevel: 9 }).toBuffer({ resolveWithObject: true }); }
    catch { throw new IdentityAssetError('image_invalid', 400); }
    if (encoded.data.length > 262144) throw new IdentityAssetError('asset_too_large', 400);
    outputs.push({ role, sha256: createHash('sha256').update(encoded.data).digest('hex'),
      width: encoded.info.width, height: encoded.info.height, bytes: encoded.data });
  }
  return outputs;
}

export async function validateIdentityAssetGroup(group: IdentityAssetGroup, assets: readonly StoredIdentityAsset[]): Promise<void> {
  const roles = identityAssetRoles(group);
  if (assets.length !== 0 && (assets.length !== roles.length
    || roles.some((role) => assets.filter((asset) => asset.role === role).length !== 1))) throw new IdentityError('assets.role');
  for (const asset of assets) await validateIdentityAsset(asset);
}

/** Synchronous row/hash checks also used by the dump reader. */
export function validateIdentityAssetMetadata(row: StoredIdentityAsset): void {
  if (!IDENTITY_ASSET_ROLES.includes(row.role as typeof IDENTITY_ASSET_ROLES[number])) throw new IdentityError('assets.role');
  if (!Number.isInteger(row.width) || !Number.isInteger(row.height) || row.width < 1 || row.height < 1
    || row.width > 1024 || row.height > 1024) throw new IdentityError('assets.dimensions');
  const square = row.role === 'favicon-32' ? 32 : row.role === 'favicon-192' ? 192 : 180;
  if (row.role === 'logo' ? row.width > 960 || row.height > 240 : row.width !== square || row.height !== square) {
    throw new IdentityError('assets.dimensions');
  }
  if (!Buffer.isBuffer(row.bytes) || !row.bytes.length || row.bytes.length > 262144) throw new IdentityError('assets.bytes');
  if (!/^[0-9a-f]{64}$/.test(row.sha256) || createHash('sha256').update(row.bytes).digest('hex') !== row.sha256) {
    throw new IdentityError('assets.sha256');
  }
  if (!row.bytes.subarray(0, 8).equals(PNG_SIGNATURE)) throw new IdentityError('assets.format');
}

/** Shared restore/build trust boundary. This does not accept uploads or fetch URLs. */
export async function validateIdentityAsset(row: StoredIdentityAsset): Promise<void> {
  validateIdentityAssetMetadata(row);
  try {
    const image = sharp(row.bytes, { limitInputPixels: 1024 * 1024, failOn: 'warning' });
    const meta = await image.metadata();
    if (meta.format !== 'png' || (meta.pages ?? 1) !== 1 || pngFrames(row.bytes) !== 1 || meta.width !== row.width || meta.height !== row.height
      || meta.exif || meta.xmp || meta.iptc || meta.icc) throw new IdentityError('assets.png');
    // Header-only metadata can accept truncated IDAT data: decode every pixel.
    await image.raw().toBuffer();
  } catch {
    throw new IdentityError('assets.png');
  }
}
