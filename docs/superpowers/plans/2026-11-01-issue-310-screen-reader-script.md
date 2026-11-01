# #310 public journeys — screen-reader check (gate G3)

**Who:** the owner, operating VoiceOver (iOS Safari) on a real iPhone. TalkBack (Android Chrome) is
waived until 2027-05-01 (mobile matrix §13.1, E1); run its rows when an Android device is available.
**Where:** a disposable instance of the #310 head, never the owner's live site.
**Widths:** 320 px and 390 px CSS (iPhone SE / standard phone; or desktop browser responsive mode
*only* for the width, with the phone's own reader for the speech).
**Records:** fill the table at the end; one row per check per reader. A check fails if the reader
does not announce what the "Expect" column says, if focus gets lost or trapped, or if anything can
only be reached by sight.

## Fixture

- DE-primary, DE+EN enabled. Three stories `Etappe 1–3`; 1 and 2 published, 3 a draft.
- Story 1 and 2 have public GPX tracks; story 3 does not.
- One published journey: DE `/rundreisen/balkan-rundreise/`, EN `/en/journeys/balkan-trip/`,
  members in order 1, 3, 2 (3 is a draft, so readers must see 1 then 2 only, "2 stories").
- A second published journey whose only member is a separate draft, `Entwurf 4` (a story belongs
  to at most one journey): it must produce no page, no index entry and no strip.

### Starting the fixture instance

`uploader/scripts/journey-sr-fixture.mjs` builds exactly this fixture through the app's own HTTP
API (setup, photo upload and encode, drafts, GPX import/attach, publish, journeys). It refuses an
instance that already has an account, so it can only ever write to an empty one. From a checkout
of this branch on the machine that will serve the phones:

1. Create an **empty** Postgres database (never the live one) and an empty data directory.
2. In `uploader/` (after `npm ci`, `npm run build:native` and the four `scripts/copy-*.mjs`), start
   the app with `DATABASE_URL=<empty db>`, `PORT=<port>`, `HOST=<address the phones can reach>`,
   `TRUSTED_PROXY=loopback`, `PUBLIC_BASE_URL=<image origin>`, `IMG_HOST=<image host>`,
   `SITE_APP_DIR=<checkout>/site` and `STORAGE_DIR`, `SETTINGS_PATH`,
   `SITE_DIR`, `BACKUP_DIR`, `MAP_DIR` inside the empty data directory:
   `node --import tsx src/main.ts`.
3. Once `/health` answers, run `node scripts/journey-sr-fixture.mjs <that origin>`; it prints the
   URLs below. Stop the app and drop the database after the session.

On the owner's server use the disposable instance from the #300 run sheet §1a
(`https://new.simonswanderlust.com`, images on `https://img.new.simonswanderlust.com`) built from
the `dev` commit that contains #310, then run the fixture script against
`https://new.simonswanderlust.com`. Elsewhere, phones need the pages over **trusted HTTPS** behind
a reverse proxy with a certificate the phones trust (for example a LAN name with a certificate
from a CA you control installed on the phone). Any non-loopback setup needs **two names**: the
app serves the blog on the image host only for loopback (`server.ts` `imgHostServesBlog`), so set
`PUBLIC_BASE_URL`/`IMG_HOST` to an image name and open the pages on a second name proxied to the
same port. Record which setup was used.

Prepared 2026-11-01 on the merged head `4fa8596`: the script ran end to end against a fresh
database; `/rundreisen/`, both journey pages and stories 1–2 answered 200, `/etappe-3-de/` and
`/rundreisen/nur-entwurf/` 404; story 1 showed "Geschichte 1 von 2" with the two named
navigations; no horizontal overflow at 1280/390/320 px. That is fixture evidence, not G3.

## Checks

| # | Page | Do | Expect |
|---|---|---|---|
| 1 | `/rundreisen/` | Open; read from top | One H1 "Rundreisen", the intro, one entry "Balkan-Rundreise" with "2 Geschichten"; no entry for the draft-only journey |
| 2 | journey page | Open headings list (VO rotor / TalkBack headings) | H1 "Balkan-Rundreise", H2 "Geschichten dieser Rundreise" and "Orte und aufgezeichnete Routen"; no skipped levels |
| 3 | journey page | Read the intro | Read as plain text; any `<b>` in the intro is spoken as characters, never as formatting |
| 4 | journey page | Swipe through the story list | Each item: "Geschichte n von 2", title, date · country, as **one** link; only stories 1 and 2 |
| 5 | journey page | Open the landmarks list | Main, header navigation, footer; the map is named "Karte der Rundreise Balkan-Rundreise"; no unnamed landmark |
| 6 | journey page | Reach the map | Either the interactive map announces numbered locations with names, or the text fallback lists every published member as a link ("Geschichte 1: Etappe 1 de", "Geschichte 2: …"); no trap — swipe past it continues to the next content |
| 7 | journey page | Language switch link | Announced as the English version; activating it opens `/en/journeys/balkan-trip/` and the reader switches to English pronunciation (`lang="en"`) |
| 8 | story 1 page | Landmarks list | Two distinguishable navs: "Weitere Geschichten" (chronological pager) and "Navigation innerhalb der Rundreise: Balkan-Rundreise" |
| 9 | story 1 page | Read the journey strip | "Teil der Rundreise" + linked journey title; "Geschichte 1 von 2"; a "Nächste Geschichte der Rundreise" link to Etappe 2 de; no previous link |
| 10 | story 2 page | Read the journey strip | "Geschichte 2 von 2"; previous link to story 1; no next link; story 3 never mentioned |
| 11 | story 3 (draft) | Open its URL | 404; no strip anywhere references it |
| 12 | both widths | Zoom text to 200 % (iOS Larger Text / Android font size) | No content cut off or overlapping; strip and list remain readable in order |
| 13 | EN pages | Repeat 1–10 on `/en/journeys/` | Same structure in English wording |

## Record

| # | Reader + device + OS | Width | Result (pass/fail) | What was announced / notes |
|---|---|---|---|---|
| | | | | |

After the session: attach this table to PR #490 and to the journeys spec ("#310 screen-reader
evidence"). Any fail blocks merge until fixed and re-checked on the failing row.
