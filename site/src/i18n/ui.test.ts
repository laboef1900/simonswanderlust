import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { defaultLocale, locales, ui, useTranslations, type UIKey } from './ui';

describe('ui dictionaries', () => {
  it('defines every key in every other locale (no leak like the old WP footer)', () => {
    // @ai-warning Comparing `de` against ITSELF is a tautology — the old version of
    // this test looped over every locale including the default one, so one
    // iteration always passed for free. Only the non-default locales are news.
    const baseKeys = Object.keys(ui[defaultLocale]).sort();
    const others = locales.filter((locale) => locale !== defaultLocale);
    expect(others.length, 'nothing is being compared').toBeGreaterThan(0);
    for (const locale of others) {
      expect(Object.keys(ui[locale]).sort(), `locale ${locale}`).toEqual(baseKeys);
    }
  });

  it('returns locale-specific strings', () => {
    expect(useTranslations('de')('nav.about')).toBe('Über mich');
    expect(useTranslations('en')('nav.about')).toBe('About me');
    expect(useTranslations('en')('footer.latest')).toBe('Latest stories');
  });

  it('no key has an empty-string value in any locale', () => {
    for (const locale of locales) {
      for (const [key, val] of Object.entries(ui[locale])) {
        expect(val, `${locale}.${key}`).not.toBe('');
      }
    }
  });

  /**
   * Keys whose DE and EN values are legitimately identical — brand names and
   * other proper nouns that must NOT be translated. Everything else that is
   * byte-identical in both locales is almost certainly an untranslated copy/paste.
   */
  const IDENTICAL_ON_PURPOSE: readonly UIKey[] = ['site.title'];

  it('flags untranslated values (identical in DE and EN) outside the allow-list', () => {
    const identical = (Object.keys(ui[defaultLocale]) as UIKey[]).filter(
      (key) => ui.de[key] === ui.en[key] && !IDENTICAL_ON_PURPOSE.includes(key),
    );
    expect(identical, 'add a translation, or allow-list the key if intentional').toEqual([]);
  });
});

/*
 * @ai-warning The dictionary tests above can only see copy that REACHES ui.ts.
 * Copy typed straight into a template is invisible to them — that is exactly how
 * German strings shipped onto English pages. Two independent guards below close
 * that hole; they overlap on purpose, because neither sees what the other does.
 *
 *   1. `no locale ternary …` — catches the bilingual form,
 *      `{locale === 'en' ? 'Equipment' : 'Ausrüstung'}`, ANYWHERE in the file,
 *      including inside the frontmatter fence (which guard 2 cannot look at,
 *      because frontmatter is code, not rendered markup).
 *   2. `no hardcoded prose in rendered markup` — catches the shape the original
 *      StoryGrid bug actually had, which contains no ternary at all: a plain
 *      `<p>Keine Beiträge gefunden</p>` sitting in the template body.
 *
 * Either way the fix is the same: put the copy in ui.ts and render it with `t(...)`.
 */
const SRC_DIR = new URL('../', import.meta.url);
const SCANNED = ['components/', 'layouts/', 'pages/'];
/** How many lines after the `locale ===` match still belong to the same ternary. */
const TERNARY_WINDOW = 3;
const LOCALE_TERNARY = /locale\s*===\s*['"](?:de|en)['"]\s*\?/;
const STRING_LITERAL = /'([^'\n]*)'|"([^"\n]*)"/g;

function astroFilesIn(dir: URL): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory()) return astroFilesIn(new URL(`${entry.name}/`, dir));
    return entry.name.endsWith('.astro') ? [fileURLToPath(new URL(entry.name, dir))] : [];
  });
}

/** Tailwind class lists are the one legitimate multi-word literal in a locale ternary. */
function isClassList(literal: string): boolean {
  const tokens = literal.trim().split(/\s+/);
  return /[-:]/.test(literal) && tokens.every((tok) => /^[a-z0-9][a-z0-9:_./[\]%()-]*$/.test(tok));
}

function looksLikeProse(literal: string): boolean {
  if (literal.startsWith('/') || literal.startsWith('#')) return false; // URLs and anchors
  if (isClassList(literal)) return false;
  const letters = literal.match(/\p{L}/gu)?.length ?? 0;
  return (/\s/.test(literal) && letters >= 2) || /[äöüßÄÖÜ]/.test(literal);
}

/* ------------------------------------------------------------------------- *
 * Guard 2: hardcoded prose in rendered markup.
 *
 * THE SIGNAL. A *text node* — the characters between a `>` that closes a tag and
 * the next `<` — that contains two or more word-like tokens and at least one
 * lowercase letter. Rationale: a text node is by definition the only thing in an
 * .astro file the reader of the page actually sees as copy. Everything that makes
 * these files full of legitimate English-looking literals (Tailwind class lists,
 * hrefs, locale codes, import specifiers, prop and component names, type
 * annotations, `@ai-note` comments) lives inside a tag, inside the frontmatter
 * fence, inside `{…}`, or inside a comment — none of which is a text node. So the
 * scanner below is a small .astro parser rather than a regex: it strips the
 * frontmatter, skips tags/comments/`<script>`/`<style>`, and descends into
 * expressions only far enough to find the markup nested in them — which is where
 * the original bug lived (`{trips.length > 0 ? (…) : (<p>Keine …</p>)}`).
 *
 * THE TRADEOFF. Requiring two words and a lowercase letter is what keeps the
 * false-positive rate at zero on this tree, and it is also the limit of the
 * guard. It cannot catch (verified, not assumed):
 *   - Single-word copy: `<p>Willkommen</p>` passes, because `Instagram ↗`
 *     (Footer.astro) and `Simon` (AboutPage.astro) are legitimate one-word text
 *     nodes and nothing distinguishes a proper noun from a one-word sentence.
 *     Umlauts are the one exception — `<p>Ausrüstung</p>` IS caught.
 *   - ALL-CAPS copy: this repo uppercases via the CSS `uppercase` class, so caps
 *     in the source is already a smell, but `<p>KEINE DATEN</p>` slips through.
 *   - Copy inside `<script>`/`<style>`, or in an attribute other than the four
 *     user-facing ones checked below.
 *   - Copy built in the frontmatter and rendered as `{msg}` — guard 1 catches
 *     only the locale-ternary form of that.
 *   - Anything outside .astro files: `src/scripts/*.ts` islands, MDX bodies, and
 *     the uploader's admin HTML are not scanned here.
 * ------------------------------------------------------------------------- */

/** Attributes whose literal value is shown to (or read out to) a human. */
const USER_FACING_ATTR = /\b(alt|title|placeholder|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---[^\S\r\n]*\r?\n?/;
/** `<` only opens a tag before a name, a closing slash, `<!…>`, or a `<>` fragment. */
const TAG_START = /[A-Za-z/!>]/;

interface Finding {
  line: number;
  text: string;
}

/**
 * Text nodes and user-facing attribute values of an .astro template, in source
 * order. Hand-rolled rather than using a real parser so the guard stays a
 * dependency-free part of the test suite.
 *
 * Known parser limits, none of which occur in this tree: a regex literal in
 * template code that contains a quote or a brace can desync the scanner, template
 * literals are skipped whole (their `${…}` interpolations are never inspected),
 * and a spaceless comparison in template code (`i<n`) is misread as a tag. All
 * three fail towards silence, never towards a false accusation — which is why the
 * last test below asserts the scanner still finds the real tree's text nodes.
 */
function renderedText(source: string): Finding[] {
  const match = FRONTMATTER.exec(source);
  const body = match ? source.slice(match[0].length) : source;
  const found: Finding[] = [];
  // Each frame is a nesting level of `{…}`; 'text' means we are in markup inside
  // that expression (`{cond ? (<p>…</p>) : null}`), 'code' means we are not.
  const stack: ('text' | 'code')[] = ['text'];
  let line = match ? match[0].split('\n').length : 1;
  let buf = '';
  let bufLine = line;
  let i = 0;

  // A text node counts only if a tag follows it, or if it sits in top-level markup.
  // Otherwise it is the tail of an expression, not markup: in `{x ? <A /> : null}`
  // the run between `/>` and `}` is the code `: null`, and code is not page copy.
  const flush = (beforeTag: boolean): void => {
    if (buf.trim() && (beforeTag || stack.length === 1)) found.push({ line: bufLine, text: buf });
    buf = '';
  };
  const advance = (to: number): void => {
    for (let k = i; k < to && k < body.length; k++) if (body[k] === '\n') line++;
    i = Math.min(to, body.length);
  };
  const skipUntil = (marker: string, from: number): void => {
    const at = body.indexOf(marker, from);
    advance(at < 0 ? body.length : at + marker.length);
  };

  while (i < body.length) {
    const ch = body[i] as string;
    const inText = stack[stack.length - 1] === 'text';

    if (inText && body.startsWith('<!--', i)) {
      flush(false);
      skipUntil('-->', i);
    } else if (ch === '<' && TAG_START.test(body[i + 1] ?? '')) {
      if (!inText) stack[stack.length - 1] = 'text'; // markup nested in an expression
      flush(true);
      const tagLine = line;
      let j = i + 1;
      let quote = '';
      let depth = 0;
      for (; j < body.length; j++) {
        const c = body[j];
        if (quote) {
          if (c === quote) quote = '';
        } else if (c === '"' || c === "'") quote = c;
        else if (c === '{') depth++;
        else if (c === '}') depth = Math.max(0, depth - 1);
        else if (c === '>' && depth === 0) break;
      }
      const tag = body.slice(i, Math.min(j + 1, body.length));
      for (const attr of tag.matchAll(USER_FACING_ATTR)) {
        found.push({ line: tagLine, text: attr[2] ?? attr[3] ?? '' });
      }
      advance(j + 1);
      // <script>/<style> bodies are code and CSS, never page copy.
      const name = /^<\s*([A-Za-z][\w:-]*)/.exec(tag)?.[1]?.toLowerCase();
      if ((name === 'script' || name === 'style') && !tag.endsWith('/>')) {
        const close = body.toLowerCase().indexOf(`</${name}`, i);
        if (close < 0) advance(body.length); // unterminated — stop rather than seek backwards
        else skipUntil('>', close);
      }
    } else if (!inText && (body.startsWith('//', i) || body.startsWith('/*', i))) {
      skipUntil(body[i + 1] === '/' ? '\n' : '*/', i);
    } else if (!inText && (ch === '"' || ch === "'" || ch === '`')) {
      let j = i + 1;
      while (j < body.length && body[j] !== ch) j += body[j] === '\\' ? 2 : 1;
      advance(j + 1);
    } else if (ch === '{') {
      flush(false);
      stack.push('code');
      advance(i + 1);
    } else if (ch === '}') {
      flush(false);
      if (stack.length > 1) stack.pop();
      advance(i + 1);
    } else {
      if (inText) {
        if (!buf.trim() && ch.trim()) bufLine = line;
        buf += ch;
      }
      advance(i + 1);
    }
  }
  flush(false);
  return found;
}

/** Two or more word-like tokens plus a lowercase letter — see THE TRADEOFF above. */
function looksLikeCopy(text: string): boolean {
  const plain = text
    .replace(/&[a-zA-Z][a-zA-Z0-9]*;|&#\d+;/g, ' ') // entities are punctuation, not words
    .replace(/\s+/g, ' ')
    .trim();
  if (!plain || !/\p{Ll}/u.test(plain)) return false;
  const words = plain.split(' ').filter((token) => /\p{L}{2,}/u.test(token));
  return words.length >= 2 || (words.length === 1 && /[äöüß]/i.test(plain));
}

describe('no hardcoded bilingual copy in templates', () => {
  const files = SCANNED.flatMap((dir) => astroFilesIn(new URL(dir, SRC_DIR)));

  it('scans the component, layout and page templates', () => {
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((file) => file.includes('/pages/'))).toBe(true);
  });

  it('has no locale ternary picking between human-readable strings', () => {
    const offenders: string[] = [];
    for (const file of files) {
      const lines = readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, i) => {
        if (!LOCALE_TERNARY.test(line)) return;
        const window = lines.slice(i, i + TERNARY_WINDOW).join('\n');
        for (const match of window.matchAll(STRING_LITERAL)) {
          const literal = match[1] ?? match[2] ?? '';
          if (looksLikeProse(literal)) {
            offenders.push(`${file}:${i + 1} → ${JSON.stringify(literal)}`);
          }
        }
      });
    }
    expect(offenders, 'move this copy into src/i18n/ui.ts and use t(...)').toEqual([]);
  });

  it('has no hardcoded prose in rendered markup', () => {
    const offenders = files.flatMap((file) =>
      renderedText(readFileSync(file, 'utf8'))
        .filter((hit) => looksLikeCopy(hit.text))
        .map((hit) => `${file}:${hit.line} → ${JSON.stringify(hit.text.trim())}`),
    );
    expect(
      offenders,
      'user-facing text is hardcoded in the template — move it into src/i18n/ui.ts and render it with t(...)',
    ).toEqual([]);
  });

  it('recognizes prose but not paths, class lists or locale codes', () => {
    expect(looksLikeProse('Skip to main content')).toBe(true);
    expect(looksLikeProse('Ausrüstung')).toBe(true);
    expect(looksLikeProse('Traveler & Storyteller')).toBe(true);
    expect(looksLikeProse('/en/rss.xml')).toBe(false);
    expect(looksLikeProse('#main-content')).toBe(false);
    expect(looksLikeProse('text-navy')).toBe(false);
    expect(looksLikeProse('font-semibold text-brand-red')).toBe(false);
    expect(looksLikeProse('de')).toBe(false);
    expect(looksLikeProse('DE')).toBe(false);
  });

  it('reads text nodes out of markup nested in expressions, and nothing else', () => {
    const sample = [
      '---',
      "import Card from './Card.astro';",
      "const label = 'not markup, ignored here';",
      '---',
      '',
      '<div class="mt-4 flex items-center gap-2" data-x="a b c">',
      '  {',
      '    trips.length > 0 ? (',
      '      trips.map((trip) => <Card title={trip.data.title} />)',
      '    ) : (',
      '      <p class="text-sm">Keine Beiträge gefunden</p>',
      '    )',
      '  }',
      '  <a href="/en/about-me/">Instagram ↗</a>',
      '</div>',
      '<script>const el = document.getElementById("map");</script>',
    ].join('\n');

    const hits = renderedText(sample).map((hit) => hit.text.trim());
    expect(hits).toContain('Keine Beiträge gefunden');
    expect(hits).toContain('Instagram ↗');
    expect(hits.filter(looksLikeCopy)).toEqual(['Keine Beiträge gefunden']);
    expect(renderedText(sample).find((hit) => looksLikeCopy(hit.text))?.line).toBe(11);
  });

  it('reads user-facing attribute values but not class or data attributes', () => {
    const hits = renderedText('<img alt="Ein Foto vom Gipfel" class="h-4 w-4" data-a="x y z" />');
    expect(hits.map((hit) => hit.text)).toEqual(['Ein Foto vom Gipfel']);
  });

  it('separates rendered copy from the code that surrounds it', () => {
    expect(looksLikeCopy('Keine Beiträge gefunden')).toBe(true);
    expect(looksLikeCopy('No stories found')).toBe(true);
    expect(looksLikeCopy('Ausrüstung')).toBe(true); // single word, but unmistakably German
    expect(looksLikeCopy('Instagram ↗')).toBe(false); // proper noun — must keep passing
    expect(looksLikeCopy('Simon')).toBe(false);
    expect(looksLikeCopy('★ ★')).toBe(false);
    expect(looksLikeCopy('&nbsp; &nbsp;')).toBe(false);
    expect(looksLikeCopy(') : (')).toBe(false);
    expect(looksLikeCopy('N° 01')).toBe(false);
  });

  it('extracts the known-good text nodes of the real tree rather than nothing at all', () => {
    // A parser that silently extracted nothing would also report zero offenders.
    // These are real, legitimate text nodes; if they stop being found, the scanner
    // has gone blind and the guard above is no longer proving anything.
    const all = files.flatMap((file) => renderedText(readFileSync(file, 'utf8')));
    const texts = all.map((hit) => hit.text.trim());
    expect(texts).toContain('Instagram ↗'); // Footer.astro
    expect(texts).toContain('Simon'); // AboutPage.astro
    expect(texts).toContain('404'); // 404.astro — proves pages/ is really parsed
    expect(all.length).toBeGreaterThan(10);
  });
});
