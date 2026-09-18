import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { STAMP_INKS } from '../lib/stamp';

/**
 * WCAG 2.2 contrast guard on the brand tokens themselves.
 *
 * @ai-warning These pairings clear AA by 0.11 to 0.26 of a point — brand-red on
 * canvas measures 4.61:1 against a 4.5 requirement — so a "slightly warmer red"
 * or a "slightly softer canvas" breaks AA on the primary CTA, the nav links,
 * and every N° label, with nothing in the build to say so. Measured values are
 * recorded next to each pairing; if one of these fails after a token change,
 * the token is wrong, not the threshold.
 *
 * Deliberately reads global.css rather than restating the hex values: a test
 * that carried its own copy of the palette would still pass after someone
 * edited the palette.
 */
const CSS = readFileSync(fileURLToPath(new URL('./global.css', import.meta.url)), 'utf8');

function token(name: string): string {
  const m = new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})`).exec(CSS);
  if (!m) throw new Error(`--color-${name} missing from global.css`);
  return m[1] as string;
}

/** Relative luminance per WCAG 2.x, from an opaque #rrggbb. */
function luminance(hex: string): number {
  const channel = (i: number) => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/**
 * Alpha compositing of an `oklab(c / a)` utility over an opaque backdrop —
 * which is the only number that counts, for a border or for text.
 */
const over = (hex: string, alpha: number, bg: string): string => {
  const ch = (s: string, i: number) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  const mix = (i: number) => Math.round(alpha * ch(hex, i) + (1 - alpha) * ch(bg, i));
  return `#${[0, 1, 2].map((i) => mix(i).toString(16).padStart(2, '0')).join('')}`;
};

const canvas = token('canvas');
const navy = token('navy');
const ink = token('ink');
const brandRed = token('brand-red');
const brandRedLight = token('brand-red-light');

describe('brand token contrast', () => {
  /**
   * The three pairings with no headroom. Measured against the real rendered
   * output as part of the 2026-09-18 home page review; pinned to three
   * decimals because the whole point is that there is nothing to spare.
   */
  it.each([
    [brandRed, canvas, 'brand-red on canvas (nav active, About link, region chip hover)', 4.609],
    [brandRedLight, navy, 'brand-red-light on navy (N° labels, footer logline, map stats)', 4.741],
    ['#ffffff', brandRed, 'white on brand-red (the hero CTA button)', 4.763],
  ])('$2 still clears 4.5:1', (fg, bg, name, measured) => {
    const ratio = contrast(fg as string, bg as string);
    expect(ratio, name as string).toBeGreaterThanOrEqual(4.5);
    expect(
      Number(ratio.toFixed(3)),
      `${name as string} moved off its recorded ${measured as number}:1 — check AA before accepting`,
    ).toBe(measured);
  });

  it.each([
    [ink, canvas, 'ink on canvas (body copy)'],
    [canvas, navy, 'canvas on navy (dark bands)'],
  ])('$2 clears 4.5:1 with room to spare', (fg, bg, name) => {
    expect(contrast(fg as string, bg as string), name as string).toBeGreaterThanOrEqual(7);
  });

  it('records why brand-red is never used for text on navy', () => {
    // 3.1:1 — below AA for text, which is why every dark band switches to
    // brand-red-light. Asserted so nobody "simplifies" the two accents into one.
    expect(contrast(brandRed, navy)).toBeLessThan(4.5);
    expect(contrast(brandRedLight, navy)).toBeGreaterThanOrEqual(4.5);
  });
});

/**
 * Non-text contrast, WCAG 2.2 SC 1.4.11 (3:1). These two borders ARE the
 * controls they outline — an idle region chip and the map band's ghost link
 * have no fill and no underline, so a visitor who cannot see the hairline sees
 * floating text. Both shipped below threshold (1.49:1 and 2.64:1).
 *
 * @ai-warning Token alpha is not contrast. `border-navy/45` reads like it
 * ought to clear 3:1 and composites to 2.67:1; only the composite counts.
 */
describe('non-text contrast of alpha borders', () => {
  it('the idle region chip border clears 3:1 on canvas', () => {
    // RegionFilter.astro: border-navy/55, matching the admin's --line-control.
    expect(contrast(over(navy, 0.55, canvas), canvas)).toBeGreaterThanOrEqual(3);
    // The two values it replaced, recorded so neither comes back.
    expect(contrast(over(navy, 0.2, canvas), canvas)).toBeLessThan(3);
    expect(contrast(over(navy, 0.45, canvas), canvas)).toBeLessThan(3);
  });

  it("the map band's ghost link border clears 3:1 on navy", () => {
    // MapTeaser.astro: border-white/50.
    expect(contrast(over('#ffffff', 0.5, navy), navy)).toBeGreaterThanOrEqual(3);
    expect(contrast(over('#ffffff', 0.3, navy), navy)).toBeLessThan(3);
  });
});

/**
 * Text contrast of the alpha colour utilities, WCAG 2.2 SC 1.4.3 (4.5:1). The
 * borders above are the same trap one layer out; these are the glyphs.
 *
 * @ai-warning Alphas MULTIPLY, and nothing in the class list says so. The
 * region chip's count carried `opacity-70` on top of the chip's own
 * `text-ink/70`: α 0.49, not 0.70, and 3.14:1 on canvas. It hid for a release
 * because the ACTIVE chip's count was white/70 on navy (7.85:1), so the pair
 * looked deliberate. Never stack an opacity utility on an alpha text colour —
 * change the colour, or de-emphasise by size and face as the count now does.
 */
describe('text contrast of alpha text utilities', () => {
  it('ink/70 clears AA on canvas — the chip count and the inactive locale link', () => {
    // RegionFilter.astro (count, inheriting the chip) and LangSwitcher.astro.
    expect(contrast(over(ink, 0.7, canvas), canvas)).toBeGreaterThanOrEqual(4.5);
  });

  it('records the two alphas that shipped below AA', () => {
    // text-ink/70 × opacity-70 → α 0.49 → 3.14:1 on the three idle chips.
    expect(contrast(over(ink, 0.7 * 0.7, canvas), canvas)).toBeLessThan(4.5);
    // text-ink/60 → 4.33:1 on the control a non-German visitor needs most.
    expect(contrast(over(ink, 0.6, canvas), canvas)).toBeLessThan(4.5);
  });
});

describe('stamp inks', () => {
  /**
   * The arrival stamp's per-country inks, from lib/stamp.ts. They are declared
   * decorative (`aria-hidden`, `role="presentation"`) so they are formally
   * exempt from SC 1.4.3 — but they measured 1.28:1 to 2.58:1 while the stamp
   * sat on a translucent navy plate over a photograph, i.e. the site's most
   * distinctive mark rendered as a smudge. The plate is opaque canvas now;
   * this pins the consequence so a new ink cannot be added blind.
   */
  const INKS = [...new Set(STAMP_INKS)];

  it('every ink reads on the canvas chip it is stamped onto', () => {
    for (const ink of INKS) {
      expect(contrast(ink, canvas), `${ink} on canvas`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('and would NOT read on the navy plate it used to sit on', () => {
    // The regression this replaced: dark ink multiplied into a dark panel.
    expect(contrast('#1e3a6e', navy)).toBeLessThan(3);
  });
});
