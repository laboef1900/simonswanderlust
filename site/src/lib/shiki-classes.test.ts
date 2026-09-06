import { describe, expect, it } from 'vitest';
import githubDark from '@shikijs/themes/github-dark';
import { SHIKI_CSS, SHIKI_THEME, classesFor, shikiCss } from './shiki-classes';
import { MARKDOWN_OPTIONS } from './render-markdown';

describe('classesFor', () => {
  it('maps the declarations Shiki emits to classes', () => {
    expect(classesFor('color:#F97583;font-style:italic;font-weight:bold;text-decoration:underline line-through'))
      .toEqual(['sh-c-f97583', 'sh-italic', 'sh-bold', 'sh-underline', 'sh-strike']);
    expect(classesFor('background-color:#24292e;color:#e1e4e8; overflow-x: auto;'))
      .toEqual(['sh-bg-24292e', 'sh-c-e1e4e8']);
    expect(classesFor('user-select: none;')).toEqual(['sh-nosel']);
  });

  it('drops anything that is not a colour or font decoration — the hole #124 closes', () => {
    expect(classesFor('position:fixed;inset:0;background:url(https://evil.example/px.png)')).toEqual([]);
    expect(classesFor('color:url(https://evil.example/px.png)')).toEqual([]);
    expect(classesFor('color:red')).toEqual([]);
  });

  it('drops a colour the theme cannot produce, so no class is ever emitted without a rule', () => {
    // ANSI truecolor (`\x1b[38;2;12;34;56m`) is unbounded; it inherits instead.
    expect(classesFor('color:#0c2238')).toEqual([]);
    expect(classesFor('background-color:#0c2238')).toEqual([]);
  });
});

describe('SHIKI_CSS', () => {
  it('is generated from the theme MARKDOWN_OPTIONS highlights with', () => {
    expect(MARKDOWN_OPTIONS.shikiConfig?.theme).toBe(SHIKI_THEME);
    expect(githubDark.name).toBe(SHIKI_THEME);
    expect(SHIKI_CSS).toBe(shikiCss(githubDark));
  });

  it('has a rule for every colour the theme can put on a token or an ANSI cell', () => {
    const selectors = new Set<string>();
    for (const rule of githubDark.tokenColors ?? []) {
      if (rule.settings.foreground) selectors.add(`.sh-c-${rule.settings.foreground.slice(1).toLowerCase()}{`);
      if (rule.settings.background) selectors.add(`.sh-bg-${rule.settings.background.slice(1).toLowerCase()}{`);
    }
    // A ```ansi fence paints with `terminal.ansi*`, as foreground or background.
    for (const [key, value] of Object.entries(githubDark.colors ?? {})) {
      if (!key.startsWith('terminal.ansi')) continue;
      selectors.add(`.sh-c-${value.slice(1).toLowerCase()}{`);
      selectors.add(`.sh-bg-${value.slice(1).toLowerCase()}{`);
    }
    expect(selectors.size).toBeGreaterThan(30);
    for (const selector of selectors) expect(SHIKI_CSS).toContain(selector);
    expect(SHIKI_CSS).toContain('.astro-code{overflow-x:auto}');
  });
});
