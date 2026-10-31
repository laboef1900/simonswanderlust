import { crc32 } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import sharp from 'sharp';
import { normalizeIdentityUpload, validateIdentityAsset, validateIdentityAssetGroup } from '../src/site-identity-assets.js';
import { readExif } from '../src/exif.js';
import { memorySiteIdentityStore } from '../src/site-identity.js';

const raster = (width = 360, height = 180) => sharp({ create: { width, height, channels: 4, background: '#12345680' } });

describe('identity raster normalization', () => {
  it.each(['png', 'jpeg', 'webp'] as const)('decodes %s and produces bounded, hashed PNG only', async (format) => {
    const source = await raster().toFormat(format).toBuffer();
    const [logo] = await normalizeIdentityUpload(source, 'logo');
    expect(logo).toMatchObject({ role: 'logo', width: 360, height: 180 });
    expect(logo!.sha256).toBe(createHash('sha256').update(logo!.bytes).digest('hex'));
    expect(logo!.bytes.length).toBeLessThanOrEqual(262144);
    await expect(validateIdentityAsset(logo!)).resolves.toBeUndefined();
  });

  it('applies orientation, fits a logo without enlargement and strips actual GPS, EXIF and ICC', async () => {
    const source = await raster(480, 1920).withMetadata({ orientation: 6 }).withIccProfile('srgb')
      .withExifMerge({ IFD0: { Make: 'Camera' }, IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '63/1 4/1 3312/100', GPSLongitudeRef: 'E', GPSLongitude: '10/1 23/1 1944/100' } })
      .jpeg().toBuffer();
    const original = await sharp(source).metadata();
    expect(readExif(original.exif)?.GPSInfo).toBeDefined();
    expect(original.icc).toBeDefined();
    const [logo] = await normalizeIdentityUpload(source, 'logo');
    expect(logo).toMatchObject({ width: 960, height: 240 });
    const output = await sharp(logo!.bytes).metadata();
    expect(readExif(output.exif)).toBeNull();
    for (const key of ['exif', 'icc', 'xmp', 'iptc', 'orientation'] as const) expect(output[key]).toBeUndefined();
  });

  it('contains the favicon without cropping and flattens the apple icon onto canvas', async () => {
    const outputs = await normalizeIdentityUpload(await raster().png().toBuffer(), 'favicon');
    expect(outputs.map(({ role, width, height }) => [role, width, height])).toEqual([
      ['favicon-32', 32, 32], ['favicon-192', 192, 192], ['apple-touch-180', 180, 180],
    ]);
    for (const output of outputs) {
      await validateIdentityAsset(output);
      const { data, info } = await sharp(output.bytes).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
      expect([...data.subarray(0, 4)]).toEqual(output.role === 'apple-touch-180' ? [251, 251, 253, 255] : [0, 0, 0, 0]);
      const center = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
      expect(data[center + 3]).toBe(output.role === 'apple-touch-180' ? 255 : 128);
    }
  });

  it.each([
    Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><image href="file:///etc/passwd" onload="alert(2)"/></svg>'),
    Buffer.from('not an image'), Buffer.from('GIF89a'), Buffer.from('II*\0'),
  ])('refuses non-raster and unsupported formats before decode', async (source) => {
    await expect(normalizeIdentityUpload(source, 'logo')).rejects.toMatchObject({ code: 'unsupported_image_type', status: 415 });
  });

  it('rejects an oversized file, decoder bomb, truncated PNG and undersized sources', async () => {
    await expect(normalizeIdentityUpload(Buffer.alloc(2 * 1024 * 1024 + 1), 'logo')).rejects.toMatchObject({ code: 'asset_too_large', status: 413 });
    const bomb = await raster(4097, 4097).png().toBuffer();
    await expect(normalizeIdentityUpload(bomb, 'logo')).rejects.toMatchObject({ code: 'image_too_large', status: 400 });
    const png = await raster().png().toBuffer();
    await expect(normalizeIdentityUpload(png.subarray(0, 40), 'logo')).rejects.toMatchObject({ code: 'image_invalid', status: 400 });
    await expect(normalizeIdentityUpload(await raster(100, 31).png().toBuffer(), 'logo')).rejects.toMatchObject({ code: 'image_too_small' });
    await expect(normalizeIdentityUpload(await raster(179, 180).png().toBuffer(), 'favicon')).rejects.toMatchObject({ code: 'image_too_small' });
    await expect(normalizeIdentityUpload(await raster(180, 179).png().toBuffer(), 'favicon')).rejects.toMatchObject({ code: 'image_too_small' });
  });

  it('refuses genuine animated WebP instead of retaining its first frame', async () => {
    const pixels = Buffer.concat([Buffer.alloc(180 * 180 * 3, 30), Buffer.alloc(180 * 180 * 3, 200)]);
    const source = await sharp(pixels, { raw: { width: 180, height: 360, channels: 3, pageHeight: 180 } }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
    expect((await sharp(source).metadata()).pages).toBe(2);
    await expect(normalizeIdentityUpload(source, 'favicon')).rejects.toMatchObject({ code: 'animated_image', status: 400 });
  });

  it('refuses APNG even when the PNG decoder exposes only the default frame', async () => {
    const png = await raster(180, 180).png().toBuffer();
    function chunk(type: string, data: Buffer) {
      const bytes = Buffer.alloc(data.length + 12);
      bytes.writeUInt32BE(data.length);
      bytes.write(type, 4, 'ascii');
      data.copy(bytes, 8);
      bytes.writeUInt32BE(crc32(bytes.subarray(4, -4)), bytes.length - 4);
      return bytes;
    }
    const compressed: Buffer[] = [];
    for (let offset = 8; offset < png.length;) {
      const size = png.readUInt32BE(offset);
      if (png.toString('ascii', offset + 4, offset + 8) === 'IDAT') compressed.push(png.subarray(offset + 8, offset + 8 + size));
      offset += size + 12;
    }
    const control = Buffer.alloc(8);
    control.writeUInt32BE(2);
    const frame = Buffer.alloc(26);
    frame.writeUInt32BE(180, 4);
    frame.writeUInt32BE(180, 8);
    frame.writeUInt16BE(1, 20);
    frame.writeUInt16BE(10, 22);
    const secondFrame = Buffer.from(frame);
    secondFrame.writeUInt32BE(1);
    const sequence = Buffer.alloc(4);
    sequence.writeUInt32BE(2);
    const pixels = Buffer.concat(compressed);
    const animated = Buffer.concat([png.subarray(0, 33), chunk('acTL', control), chunk('fcTL', frame),
      chunk('IDAT', pixels), chunk('fcTL', secondFrame), chunk('fdAT', Buffer.concat([sequence, pixels])), chunk('IEND', Buffer.alloc(0))]);
    expect((await sharp(animated).metadata()).format).toBe('png');
    await expect(normalizeIdentityUpload(animated, 'favicon')).rejects.toMatchObject({ code: 'animated_image' });
    await expect(validateIdentityAsset({ role: 'apple-touch-180', width: 180, height: 180, bytes: animated,
      sha256: createHash('sha256').update(animated).digest('hex') })).rejects.toMatchObject({ field: 'assets.png' });
  });

  it('drops appended HTML/polyglot bytes instead of preserving the uploaded container', async () => {
    const png = await raster().png().toBuffer();
    const source = Buffer.concat([png, Buffer.from('<script>identity-polyglot</script>')]);
    const [logo] = await normalizeIdentityUpload(source, 'logo');
    expect(logo!.bytes.includes(Buffer.from('identity-polyglot'))).toBe(false);
    await validateIdentityAsset(logo!);
  });

  it('refuses outputs over 256 KiB rather than trusting the input cap', async () => {
    const source = await sharp(randomBytes(960 * 240 * 3), { raw: { width: 960, height: 240, channels: 3 } }).png().toBuffer();
    expect(source.length).toBeLessThan(2 * 1024 * 1024);
    await expect(normalizeIdentityUpload(source, 'logo')).rejects.toMatchObject({ code: 'asset_too_large', status: 400 });
  });

  it('validates complete role groups before changing the revision or defaults', async () => {
    const outputs = await normalizeIdentityUpload(await raster().png().toBuffer(), 'favicon');
    const store = memorySiteIdentityStore();
    await expect(store.replaceAssets(1, 'favicon', outputs.slice(1))).rejects.toMatchObject({ code: 'invalid_identity' });
    await expect(validateIdentityAssetGroup('logo', outputs)).rejects.toMatchObject({ code: 'invalid_identity' });
    expect(store.get().revision).toBe(1);
    expect(store.getAssetState()).toEqual({ logo: false, favicon: false });
    await store.replaceAssets(1, 'favicon', outputs);
    expect(store.get().savedAt).toBeNull();
    await expect(store.replaceAssets(1, 'favicon', [])).rejects.toMatchObject({ code: 'identity_conflict' });
    expect(store.getAssetState()).toEqual({ logo: false, favicon: true });
    await store.replaceAssets(2, 'favicon', []);
    expect(store.getAssetState()).toEqual({ logo: false, favicon: false });
  });
});
