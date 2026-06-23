import { describe, expect, it } from 'vitest';
import { transformBodyImages } from '../src/lib/body-images';

const images = { 'https://img/x/y': { width: 1600, height: 1067 } };

describe('transformBodyImages', () => {
  it('replaces a known <img> with a responsive <picture> inside a figure', () => {
    const out = transformBodyImages('<p><img src="https://img/x/y" alt="A caption"></p>', images);
    expect(out).toContain('<figure class="my-8">');
    expect(out).toContain('<source type="image/avif"');
    expect(out).toContain('<source type="image/webp"');
    expect(out).toContain('https://img/x/y-1280.webp'); // fallback src
    expect(out).toContain('width="1600"');
    expect(out).toContain('height="1067"');
    expect(out).toContain('alt="A caption"');
    expect(out).toContain('class="block w-full rounded-lg"');
  });
  it('leaves an unknown image untouched', () => {
    const out = transformBodyImages('<img src="https://other/z" alt="z">', {});
    expect(out).toContain('<img src="https://other/z"');
    expect(out).not.toContain('<picture>');
  });
});
