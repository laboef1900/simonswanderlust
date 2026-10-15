import type { ShikiTransformer, ThemeRegistration } from 'shiki';
import type { Element } from 'hast';
import { visit } from 'unist-util-visit';
import githubDark from '@shikijs/themes/github-dark';

/**
 * Shiki without inline `style`: the transformer below rewrites every
 * `style="color:#…"` Shiki emits into a class, and `SHIKI_CSS` is the matching
 * stylesheet, generated from the SAME theme object so the two cannot drift.
 *
 * @ai-context Issue #124. Body HTML is rendered by Astro's Markdown pipeline
 * (which passes raw HTML through) and then sanitized by `body-images.ts`. The
 * sanitizer cannot tell a Shiki `<span style>` from an author-typed one, so as
 * long as Shiki needed `style` the schema had to allow it — and an author could
 * then ship `position:fixed; background:url(https://evil/…)` to every reader.
 * Moving the colours into classes lets the schema drop `style` entirely.
 *
 * @ai-warning Single-theme only. With `shikiConfig.themes` (dual light/dark)
 * Shiki emits `--shiki-light:#…` custom properties instead of `color`, which
 * `classesFor` deliberately does not map — the colours would silently vanish
 * (render-markdown.test.ts catches that). Extend the mapping AND the CSS
 * generator together before switching.
 */

/** The theme both `astro.config.mjs` and `MARKDOWN_OPTIONS` highlight with. */
export const SHIKI_THEME = 'github-dark';

const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;

const hexClass = (prefix: string, hex: string) => `${prefix}-${hex.slice(1).toLowerCase()}`;

/** Colours a theme can put on a token, on an ANSI cell, or on the block. */
interface Palette { fg: Set<string>; bg: Set<string> }

/**
 * Every colour `theme` can emit: the editor foreground/background (the block
 * and un-scoped tokens), every `tokenColors` setting, and every `terminal.*`
 * colour — a ```ansi fence paints with the 16 ANSI slots, as foreground OR
 * background. ANSI truecolor escapes (`38;2;r;g;b`) are unbounded and get no
 * rule; `classesFor` drops them so that text inherits the block colour.
 */
function themePalette(theme: ThemeRegistration): Palette {
  const fg = new Set<string>();
  const bg = new Set<string>();
  const add = (set: Set<string>, value: unknown) => {
    if (typeof value === 'string' && HEX.test(value)) set.add(value.toLowerCase());
  };
  add(fg, theme.colors?.['editor.foreground']);
  add(bg, theme.colors?.['editor.background']);
  for (const [key, value] of Object.entries(theme.colors ?? {})) {
    if (!key.startsWith('terminal.')) continue;
    add(fg, value);
    add(bg, value);
  }
  for (const rule of theme.tokenColors ?? []) {
    add(fg, rule.settings?.foreground);
    add(bg, rule.settings?.background);
  }
  return { fg, bg };
}

const PALETTE = themePalette(githubDark);

/**
 * Classes standing in for one inline `style` value. Only the declarations
 * Shiki (and Astro's own `pre` transformer) produce are mapped, and a colour
 * only if `SHIKI_CSS` has a rule for it; anything else is dropped rather than
 * passed through, because "unknown → keep as style" is exactly the hole this
 * module closes. Invariant: every class returned here has a rule in SHIKI_CSS.
 */
export function classesFor(style: string, palette: Palette = PALETTE): string[] {
  const out: string[] = [];
  for (const decl of style.split(';')) {
    const colon = decl.indexOf(':');
    if (colon === -1) continue;
    const prop = decl.slice(0, colon).trim().toLowerCase();
    const value = decl.slice(colon + 1).trim().toLowerCase();
    if (prop === 'color' && palette.fg.has(value)) out.push(hexClass('sh-c', value));
    else if (prop === 'background-color' && palette.bg.has(value)) out.push(hexClass('sh-bg', value));
    else if (prop === 'font-style' && value === 'italic') out.push('sh-italic');
    else if (prop === 'font-weight' && value === 'bold') out.push('sh-bold');
    else if (prop === 'text-decoration') {
      if (value.includes('underline')) out.push('sh-underline');
      if (value.includes('line-through')) out.push('sh-strike');
    } else if (prop === 'user-select' && value === 'none') out.push('sh-nosel');
    // `overflow-x: auto` (Astro's pre transformer) lives in the `.astro-code`
    // rule of SHIKI_CSS; everything else is intentionally dropped.
  }
  return out;
}

function classList(node: Element): string[] {
  const raw = node.properties.className ?? node.properties.class;
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw === 'string') return raw.split(/\s+/).filter((c) => c !== '');
  return [];
}

/**
 * Runs in the `root` hook, i.e. after every `pre`/`line`/`span` hook including
 * Astro's own (which appends `overflow-x: auto` to the `<pre>` style), so it
 * sees the final inline styles and no later hook can reintroduce one.
 */
export const shikiStyleToClass: ShikiTransformer = {
  name: 'simonswanderlust:style-to-class',
  root(root) {
    visit(root, 'element', (node) => {
      const style = node.properties.style;
      if (typeof style !== 'string') return;
      const classes = [...classList(node), ...classesFor(style)];
      delete node.properties.style;
      delete node.properties.className;
      if (classes.length === 0) delete node.properties.class;
      else node.properties.class = classes.join(' ');
    });
  },
};

/** Stylesheet for the classes `shikiStyleToClass` emits under `theme`. */
export function shikiCss(theme: ThemeRegistration): string {
  const { fg, bg } = themePalette(theme);
  const rules = [
    '.astro-code{overflow-x:auto}',
    ...[...fg].sort().map((hex) => `.${hexClass('sh-c', hex)}{color:${hex}}`),
    ...[...bg].sort().map((hex) => `.${hexClass('sh-bg', hex)}{background-color:${hex}}`),
    '.sh-italic{font-style:italic}',
    '.sh-bold{font-weight:bold}',
    '.sh-underline{text-decoration:underline}',
    '.sh-strike{text-decoration:line-through}',
    '.sh-nosel{user-select:none}',
  ];
  return rules.join('\n');
}

/**
 * The stylesheet for `SHIKI_THEME`. Inlined by `layouts/Base.astro` for the
 * live site and by `uploader/src/preview.ts` for draft previews — one source,
 * so highlighting can't disagree between the two.
 */
export const SHIKI_CSS = shikiCss(githubDark);
