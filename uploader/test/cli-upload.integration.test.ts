import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { envWithoutDatabaseUrl, runCli } from './run-cli.js';

const databaseUrl = process.env.TEST_DATABASE_URL;

describe.skipIf(!databaseUrl)('owned offline image upload', () => {
  it('reads the persisted conversion setting while holding the native and PostgreSQL owners', async () => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), 'owned-imgcli-')));
    try {
      const imagePath = join(dir, 'input.jpg');
      const settingsPath = join(dir, 'settings.json');
      const storageDir = join(dir, 'images');
      await writeFile(imagePath, await sharp({
        create: { width: 800, height: 600, channels: 3, background: '#345' },
      }).jpeg().toBuffer());
      await writeFile(settingsPath, JSON.stringify({ convertJpeg: false }));
      const result = await runCli(
        [imagePath, 'trips/test/from-settings', 'Alt'],
        {
          ...envWithoutDatabaseUrl(),
          DATABASE_URL: databaseUrl,
          STORAGE_DIR: storageDir,
          SETTINGS_PATH: settingsPath,
          PUBLIC_BASE_URL: 'https://img.example',
        },
      );
      expect(result).toMatchObject({ code: 0, stderr: '' });
      expect(result.stdout).toContain("format: 'jpeg'");
      expect((await readdir(join(storageDir, 'trips/test'))).sort()).toEqual([
        expect.stringMatching(/^from-settings-[0-9a-f]{8}-640\.jpeg$/),
        expect.stringMatching(/^from-settings-[0-9a-f]{8}-800\.jpeg$/),
        expect.stringMatching(/^from-settings-[0-9a-f]{8}-orig\.jpg$/),
      ]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
