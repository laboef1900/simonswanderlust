# #310 public journeys — screen-reader check (gate G3)

**Who:** a person operating VoiceOver (iOS Safari) or TalkBack (Android Chrome) on a real phone.
**Where:** a disposable instance of the #310 head, never the owner's live site.
**Widths:** 320 px and 390 px CSS (iPhone SE / standard phone; or desktop browser responsive mode
*only* for the width, with the phone's own reader for the speech).
**Records:** fill the table at the end; one row per check per reader. A check fails if the reader
does not announce what the "Expect" column says, if focus gets lost or trapped, or if anything can
only be reached by sight.

## Fixture (set up by the agent before the session)

- DE-primary, DE+EN enabled. Three stories `Etappe 1–3`; 1 and 2 published, 3 a draft.
- Story 1 and 2 have public GPX tracks; story 3 does not.
- One published journey: DE `/rundreisen/balkan-rundreise/`, EN `/en/journeys/balkan-trip/`,
  members in order 1, 3, 2 (3 is a draft, so readers must see 1 then 2 only, "2 stories").
- A second journey with only the draft member (must produce no page, no index entry, no strip).

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
