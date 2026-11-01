// Disposable #310 screen-reader fixture (gate G3). Talks ONLY to a freshly booted,
// empty instance over HTTP; it creates the first admin through /setup, so it refuses
// any instance that already has an account (never point it at real content).
//
//   node uploader/scripts/journey-sr-fixture.mjs http://<host>:<port>
//
// Creates (docs/superpowers/plans/2026-11-01-issue-310-screen-reader-script.md):
// DE-primary DE+EN; stories "Etappe 1–3" (1 and 2 published with public GPX tracks,
// 3 a draft) and a draft "Entwurf 4"; journey "Balkan-Rundreise" (members 1, 3, 2) and a
// journey whose only member is draft 4, both published; then prints the URLs to check.
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';

const base = (process.argv[2] ?? '').replace(/\/$/, '');
if (!/^https?:\/\/[^/]+$/.test(base)) throw new Error('Usage: journey-sr-fixture.mjs http://host:port');
const origin = new URL(base).origin;
let cookie = '';

async function call(method, path, body, { form = false, expect = [200, 201] } = {}) {
  const headers = { origin, ...(cookie ? { cookie } : {}) };
  if (body !== undefined && !form) headers['content-type'] = 'application/json';
  const response = await fetch(base + path, { method, headers, body: body === undefined ? undefined : form ? body : JSON.stringify(body) });
  const text = await response.text();
  if (!expect.includes(response.status)) throw new Error(`${method} ${path} → ${response.status}: ${text.slice(0, 300)}`);
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0];
  return text ? JSON.parse(text) : null;
}

const status = await call('GET', '/auth/status');
if (status?.needsSetup !== true) throw new Error('Refusing: this instance already has an account. Use a fresh, empty database.');
const password = randomUUID();
await call('POST', '/setup', { username: 'fixture-admin', password });
await call('POST', '/login', { username: 'fixture-admin', password });
const me = await call('GET', '/auth/me');
const userId = me.userId;

// One real hero photo, encoded by the app itself, so publish gates and <picture> markup are real.
const jpeg = await sharp({ create: { width: 1600, height: 1000, channels: 3, background: '#41627e' } }).jpeg().toBuffer();
const upload = new FormData();
for (const [k, v] of Object.entries({ uploadId: randomUUID(), expectedOwnerId: userId, retryGeneration: '0', key: 'fixtures/balkan-hero', alt: 'Bergstraße im Abendlicht' })) upload.append(k, v);
upload.append('file', new Blob([jpeg], { type: 'image/jpeg' }), 'balkan-hero.jpg');
const uploaded = await call('POST', '/upload', upload, { form: true, expect: [200, 201, 202] });
const heroKey = uploaded.key ?? uploaded.media?.key;
for (let i = 0; ; i++) {
  const list = await call('GET', '/media?q=' + encodeURIComponent('balkan-hero'));
  const items = list.items ?? list;
  const item = items.find((m) => m.key === heroKey);
  if (item?.status === 'ready') break;
  if (item?.status === 'failed' || i > 120) throw new Error('Hero photo did not become ready: ' + JSON.stringify(item));
  await new Promise((resolve) => setTimeout(resolve, 500));
}
const heroImage = (alt) => ({ src: `${new URL(uploaded.url ?? `${origin}/${heroKey}`).origin}/${heroKey}`, width: 1600, height: 1000, alt });

const places = [
  { de: 'Etappe 1 de', en: 'Stage 1 en', country: ['Kroatien', 'Croatia'], code: 'HR', lat: 42.65, lng: 18.09 },
  { de: 'Etappe 2 de', en: 'Stage 2 en', country: ['Montenegro', 'Montenegro'], code: 'ME', lat: 42.42, lng: 18.77 },
  { de: 'Etappe 3 de', en: 'Stage 3 en', country: ['Albanien', 'Albania'], code: 'AL', lat: 41.33, lng: 19.82 },
  // A story belongs to at most one journey, so the draft-only journey gets its own draft.
  { de: 'Entwurf 4 de', en: 'Draft 4 en', country: ['Nordmazedonien', 'North Macedonia'], code: 'MK', lat: 41.12, lng: 20.80 },
];
const stories = [];
for (const [index, place] of places.entries()) {
  const translationKey = randomUUID();
  const locale = (code, title, country) => ({
    locale: code, slug: `etappe-${index + 1}-${code}`, title, excerpt: `${title}: Fixture für den Screenreader-Test.`, country,
    heroImage: heroImage(title), bodyMarkdown: `## ${title}\n\nEin kurzer Absatz für die Prüfung.`, images: {}, keyFacts: {}, omitted: false,
  });
  const pair = {
    translationKey, status: 'draft', saveId: randomUUID(), expectedOwnerId: userId,
    shared: { date: `2024-0${index + 4}-10`, countryCode: place.code, region: 'europe', coordinates: { lat: place.lat, lng: place.lng } },
    de: locale('de', place.de, place.country[0]), en: locale('en', place.en, place.country[1]),
  };
  const saved = await call('POST', '/posts', pair);
  stories.push({ tk: translationKey, updatedAt: saved.updatedAt, ...place, slug: index + 1 });
}

// Public GPX tracks for stories 1 and 2 through the real import → attach path.
for (const story of stories.slice(0, 2)) {
  const points = Array.from({ length: 12 }, (_, i) => `<trkpt lat="${(story.lat + i * 0.01).toFixed(5)}" lon="${(story.lng + i * 0.012).toFixed(5)}"><ele>${100 + i}</ele><time>2024-05-0${story.slug}T0${Math.floor(i / 6)}:${String((i * 5) % 60).padStart(2, '0')}:00Z</time></trkpt>`).join('');
  const gpx = `<?xml version="1.0"?><gpx version="1.1" creator="fixture" xmlns="http://www.topografix.com/GPX/1/1"><trk><name>${story.de}</name><trkseg>${points}</trkseg></trk></gpx>`;
  const form = new FormData();
  form.append('file', new Blob([gpx], { type: 'application/gpx+xml' }), `etappe-${story.slug}.gpx`);
  const preview = await call('POST', '/gpx/imports', form, { form: true });
  const route = await call('GET', `/posts/${story.tk}/route`);
  await call('PUT', `/posts/${story.tk}/route`, {
    importId: preview.importId, baseVersion: route.version, baseUpdatedAt: new Date(story.updatedAt).toISOString(),
    selection: { startPoints: 0, endPoints: 0, removedSegments: [] }, confirmReplace: false,
  });
}

const language = await call('GET', '/language');
await call('POST', '/posts/bulk', { action: 'publish', keys: stories.slice(0, 2).map((s) => s.tk), baseLanguageUpdatedAt: language.updatedAt });

const journey = (slugDe, slugEn, titleDe, titleEn, members) => ({
  de: { slug: slugDe, title: titleDe, intro: 'Drei Etappen durch den Balkan. <b>Kein Markup</b> wird ausgeführt.', heroImage: heroImage(titleDe), omitted: false },
  en: { slug: slugEn, title: titleEn, intro: 'Three stages through the Balkans. <b>No markup</b> is executed.', heroImage: heroImage(titleEn), omitted: false },
  members,
});
const published = [];
for (const draft of [
  journey('balkan-rundreise', 'balkan-trip', 'Balkan-Rundreise', 'Balkan trip', [stories[0].tk, stories[2].tk, stories[1].tk]),
  journey('nur-entwurf', 'draft-only', 'Nur Entwurf', 'Draft only', [stories[3].tk]),
]) {
  const created = await call('POST', '/journey-admin', draft);
  const result = await call('POST', `/journey-admin/${created.id}/publish`, { baseUpdatedAt: created.updatedAt }, { expect: [200, 201, 409, 422] });
  published.push({ title: draft.de.title, result: result?.error ?? 'published' });
}

console.log(JSON.stringify({ journeys: published, urls: [
  '/rundreisen/', '/rundreisen/balkan-rundreise/', '/etappe-1-de/', '/etappe-2-de/', '/etappe-3-de/ (draft → 404)', '/rundreisen/nur-entwurf/ (draft-only → 404)',
  '/en/journeys/', '/en/journeys/balkan-trip/', '/en/etappe-1-en/', '/en/etappe-2-en/',
].map((path) => base + path) }, null, 2));
