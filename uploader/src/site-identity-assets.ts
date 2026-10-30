import { createHash } from 'node:crypto';
import sharp from 'sharp';
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
    if (meta.format !== 'png' || (meta.pages ?? 1) !== 1 || meta.width !== row.width || meta.height !== row.height
      || meta.exif || meta.xmp || meta.iptc || meta.icc) throw new IdentityError('assets.png');
    // Header-only metadata can accept truncated IDAT data: decode every pixel.
    await image.raw().toBuffer();
  } catch {
    throw new IdentityError('assets.png');
  }
}
