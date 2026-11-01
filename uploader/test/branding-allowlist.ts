import { readFileSync } from 'node:fs';

/**
 * Fresh-install branding scan (#272). The allow-list is data, owned by
 * docs/site-identity-branding-allowlist.{md,json}: an entry exempts only the
 * matches that fall inside an occurrence of its exact `text` in a matching
 * path, so a new hardcoded owner name anywhere else still fails the scan.
 * Shared by uploader/test/branding-scan.test.ts (served admin) and
 * site/test/empty-build.integration.test.ts (fresh-install release).
 */
type Entry = { surface: 'admin' | 'site'; path: string; text: string; owner: string; reason: string };
type Allowlist = { expression: string; flags: string; entries: Entry[] };

const allowlist = JSON.parse(readFileSync(new URL('../../docs/site-identity-branding-allowlist.json', import.meta.url), 'utf8')) as Allowlist;

export type BrandingMatch = { path: string; value: string; context: string };

export function unallowedBranding(surface: Entry['surface'], path: string, text: string): BrandingMatch[] {
  const covered: Array<[number, number]> = [];
  for (const entry of allowlist.entries) {
    if (entry.surface !== surface || !new RegExp(entry.path).test(path)) continue;
    for (let at = text.indexOf(entry.text); at !== -1; at = text.indexOf(entry.text, at + 1)) covered.push([at, at + entry.text.length]);
  }
  const found: BrandingMatch[] = [];
  for (const match of text.matchAll(new RegExp(allowlist.expression, allowlist.flags))) {
    const start = match.index, end = start + match[0].length;
    if (covered.some(([from, to]) => from <= start && end <= to)) continue;
    found.push({ path, value: match[0], context: text.slice(Math.max(0, start - 40), end + 40) });
  }
  return found;
}
