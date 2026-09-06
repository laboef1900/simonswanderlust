# Publish gate refuses un-hosted (foreign-origin) body images (issue #91)

**Date:** 2026-09-06 · **Risk:** high (publish gate, a named-sensitive surface) · **Size:** medium

## Decision

`POST /posts/:tk/publish` and the bulk `publish` action refuse (409, per-post failure on the bulk
path) while the **rendered** body of either locale would put an `http(s)` image on the page whose
origin is not the configured image host (`PUBLIC_BASE_URL`, `cfg.baseUrl`), or contains a gallery
line the renderer would silently drop for the same reason.

**The gate judges the rendered body, not the Markdown text.** `foreignImageUrls(body, imageOrigin)`
(`uploader/src/publish-gate.ts`) runs the body through `renderMarkdown` and then
`bodyImageSources` (`site/src/lib/body-images.ts`), which parses and sanitizes exactly as
`transformBodyImages` does and reads, from that hast tree, **before any `images` resolution**:

- the `src`/`srcset` of every `<img>` and `<source>` (the sanitizer allows a raw `<picture>`
  through, and a browser picks its foreign `<source>` over an own-origin fallback), and
- every photo line of every gallery block as `galleryCode`/`galleryPhotos` recognise it —
  attributes and whitespace included (first `|`-separated field, blank and `#` lines skipped).

Reading before resolution is load-bearing: with the map applied the transform would turn a
foreign inline image into a `<picture>` hot-linking `…-640.webp` on the old host and — worse —
silently **drop** a foreign gallery line, which is exactly the "photo vanishes at render" hole
this gate exists to close. Reading the renderer's own tree (not a regex over serialized HTML —
attribute values keep a raw `>`, `<pre>` may carry `id`/whitespace) makes the renderer's
definition of an image and of a gallery the gate's, by construction.

Why render rather than scan: four review rounds of a text/regex scanner each found a new place where
its idea of an image diverged from the renderer's — a code span crossing a heading, backticks
inside HTML attributes, `&colon;`, `![x](\nurl)`, `<img alt="x > y">`, image-like text inside an
own-origin tag's `alt` — and every divergence was a silent bypass or a false refusal on a
named-sensitive surface. Two parsers of the same grammar cannot be kept in agreement by tests;
one parser can. `test/publish-gate.test.ts` therefore asserts each case against the renderer's
own output rather than a hand-picked expectation.

Cost: one Markdown render per locale per publish — the same work `GET /posts/:tk/preview` does
per request (author-level) and `astro build` does per post. A body that is slow to render is
slow everywhere; the gate (admin-only) adds no new surface. Typical bodies render in
milliseconds; see *Residual* for the pathological case.

The response carries the count and up to five example URLs so the author can find them:

```json
{ "error": "2 image(s) in the body still point at another host — re-run the WordPress import to re-host them, or replace them with library photos, then publish again", "foreignImages": ["https://old.example/wp-content/uploads/a.jpg", "…"], "foreignImageCount": 2 }
```

`server.ts` wraps the function per pair (`foreignBodyImages`) next to `notReadyPhotos`. Order in
the handler: `validateForPublish` (400) → foreign images (409, no store access) → `notReadyPhotos`
(409, hits the media store). A foreign URL has no `media` row to look up, so checking it first
avoids a pointless query and reports the more fundamental problem.

**Residual, accepted:** the Markdown renderer (micromark) is superlinear on adversarial input —
a 1.6 MB body of 1,400 unmatched backtick runs followed by 100k pairs takes ~2 minutes to render.
That cost pre-exists on the author-level preview route and in the build, and Fastify's 1 MiB
`bodyLimit` bounds what a save can store; capping `bodyMarkdown` length is a separate change.

## Why

A failed re-host in the WXR importer leaves the WordPress URL in the body (#85 made this visible
in the import summary, not un-publishable). At render, `body-images.ts` emits an inline image
with no `images` entry **unchanged** — a hot-link to the old domain — and drops a gallery line
whose origin is foreign, so the photo vanishes. Neither gate noticed: `validateForPublish` looks
only at the hero, and `notReadyPhotos` maps URLs through `srcToKey`, which returns `null` for a
foreign origin, so the foreign URL was simply filtered out. After the Phase 4 DNS cutover every
such hot-link 404s on the live site.

## Trust boundaries

- Input: the stored body Markdown (author-controlled, or importer-written from an
  attacker-influenced export) and the image origin from configuration.
- The check renders and reads back; it performs no fetch, no DNS, no file access. The rendered
  HTML is discarded — it is never served from here.
- Origin comparison is **equality on `new URL(u).origin`**, never a prefix — the same rule as the
  gallery allow-list in `body-images.ts`, for the same reason (`https://img.example.com.evil/x`
  and `https://img.example.com@evil/x` are foreign).
- The response echoes URLs already in the author's own body back to an admin (publish is
  admin-only); nothing new is disclosed.

## What is deliberately not checked

- **The hero.** It is one explicit, visible field; the importer writes a placeholder on a failed
  hero re-host that `validateForPublish` already rejects, and its render path (`RemoteImage`) is
  not the silent one this issue is about.
- **`images` map keys.** The map is never pruned and has no UI to edit it, so blocking on a stale
  key would leave the author no way to publish. Only what the render path reads from the body
  counts; the function therefore takes the body and the origin, not the map.
- **Non-`http(s)` destinations** (`data:`, relative paths): they do not hot-link anything.
- **Pages** (`/pages`): the about page has its own publish path and no importer feeding it.

## Misuse cases considered

- An export naming an unreachable host → import completes with warnings, the draft cannot be
  published until re-run or hand-fixed. That is the intended outcome; previously it published.
- A body with thousands of foreign images → the gate returns the count and 5 examples; the work
  is one render, no amplification.
- A URL crafted to *look* like ours (`https://img.example.com.evil/…`, userinfo trick) → foreign
  by origin equality; refused.
- Foreign image inside a code fence or code span → renders as text; not reported; publishable.
- Foreign URL hidden behind Markdown escapes, `<…>`, character references (`&colon;`,
  `&#00000058;`), a `>` inside a quoted attribute, backticks inside attributes, or syntax spanning
  lines → the renderer resolves all of them; the gate sees the resulting `<img>`.
- Image-like text inside an own-origin tag's `alt` → not an image to the renderer; not reported.

## Invariants (tested)

- `uploader/test/publish-gate.test.ts`: every case above carries an explicit verdict AND must
  equal an independent oracle (every quoted `src`/`srcset` in the rendered, sanitized HTML); a
  foreign gallery line is reported under every spelling the renderer accepts (backtick, tilde,
  indented, extra info words, raw `<pre id>`/whitespace) and the test shows the renderer would
  drop it; results are de-duplicated.
- `site/src/lib/body-images.test.ts`: `bodyImageSources` reads `img`/`source` `src`+`srcset`,
  drops a `javascript:` src with the sanitizer, and reads gallery lines in every accepted shape.
- `uploader/test/server.test.ts` (`publish gate (foreign images)`): 409 with `foreignImages` +
  count on the single-post route, nothing published; per-post failure on the bulk path; a body
  with only own-origin images publishes.

## Rollback

Revert the commit. No schema or data change; the gate is a pure check in the request path.
