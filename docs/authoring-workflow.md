# Authoring & Publishing Workflow

How to write a new travel post, add its photos, and get it live. Three stages:
**(1) upload the photos**, **(2) write and publish via the in-admin editor**, **(3) rebuild (automatic on Publish)**.

**Post content lives in Postgres** — not in git or baked into the Docker image. The in-admin
editor (Phase B) is the authoring interface: you write DE and EN content directly in the browser
and hit **Publish** to trigger a rebuild. Story photos are kept out of git and Postgres: they go to
the self-hosted **image uploader**, which stores optimized variants on the server and serves them
from `https://img.simonswanderlust.com`. A post only ever references image **URLs** — and you
can upload images inline from the editor without visiting a separate page.

---

## Site name, logo and favicon (admin only)

Open **Settings → Site identity** to edit the public name, author, localized text and social
links. The About page's body remains separate content. Save stores identity without
rebuilding; the public site changes at the next **Publish** or **Rebuild site now**.

Logo and favicon have their own upload/remove actions, separate from the text Save:

- Choose one PNG, JPEG or **static WebP**, at most **2 MiB** and **4096 × 4096 pixels**.
  SVG and animated images are not accepted. A logo must be at least 32 pixels tall;
  a favicon source must be at least 180 × 180 pixels.
- Upload saves the selected file after normalization to metadata-free PNG. A logo is fitted
  inside 960 × 240 without enlargement. A favicon generates the 32px and 192px icons plus
  a 180px Apple icon on the site's light canvas background.
- The saved/custom indicator describes the saved settings, not the currently published site.
  Selecting a filename alone does not save it, and neither upload nor removal rebuilds.
- Uploading/removing an asset preserves unsaved text edits. Both use the same revision:
  if another save wins first, resolve the conflict with the explicit reload action rather
  than silently overwriting the newer identity. Reload discards unsaved changes.
- Confirm removal to return to the text site name or bundled favicon on the **next build**.
  Keep the source image if you may want to upload it again; originals are not retained.

**Rebuild site now uses saved values**, not unsaved form text or merely selected files.
These small identity images live in Postgres and travel with database backups, unlike story
photos in the image library. After a database restore, restart the app and rebuild to publish
the recovered identity. A supported pre-identity backup restores the legacy text identity
and default assets; it does not preserve destination-only custom logos/favicons.

---

## Importing existing WordPress content (one-time)

If you have an existing WordPress site with posts to migrate, you can import them directly
into Postgres without manually re-authoring each one:

1. **Export from WordPress** — WordPress admin → Tools → Export → select "All content" → download
   the `.xml` file (WXR format).
2. **Sign in to the uploader admin** — `/admin/` (the same login that manages posts and photos).
3. **Import** — Open the **Posts** tab, click **Import**, select the WXR file, and upload.
4. **What happens** — The importer parses the export, downloads hero + body images from the live
   WordPress site (so the old site must be reachable during import), stores optimized variants
   through the uploader's pipeline, and creates **draft posts** in Postgres. Slugs are preserved
   exactly — DE posts at the root, EN under `/en/`. Structured travel fields (country, region,
   coordinates, keyFacts) are filled with placeholder values — open each draft in the editor to
   enrich them. Images are already re-hosted, so no manual re-upload is needed.
5. **Refine and publish** — Open each draft in the editor, review the imported content, fill in
   missing details, and hit **Publish** when ready.

**Note:** The import is **idempotent by slug pair** — a group is matched to an existing post only
when *both* its DE and EN slugs belong to that same post. Re-importing the same WXR never touches
a published post. A draft from an earlier import is **merged, not rebuilt**: everything you edited
(country, region, coordinates, key facts, stops, alt text, body changes, a hero you picked) is
kept, and only the photos that were still missing are downloaded and swapped in — so re-running to
recover photos is safe. Tick **Replace existing drafts with the export** only when you changed a
post in WordPress and exported again; it rebuilds the matched drafts from the export and discards
your edits to them (each keeps a revision you can restore from the editor). A group whose slugs
overlap an existing post without matching it as a pair — one slug matches, the two slugs belong to
two different posts, or a slug equals another post's slug in the *other* language (re-hosted photos
are filed by slug, without a language) — is **rejected** with a warning naming the owner, and
nothing is written. Resolve the slug in the editor and run the import again.

**Untranslated stories:** The current importer requires a published DE/EN pair. A published
German or English post without a Polylang translation group is counted individually as
**Rejected**, with its unchanged slug and language in the warning list; a group missing its
other published language is rejected too. Neither creates a draft nor downloads photos, even
with **Replace existing drafts with the export** selected. An export containing only these
refusals still completes as an import job with a rejection summary and zero planned work —
it does not mean those stories were migrated. The five post counters sum to distinct Polylang
groups plus individual untranslated published DE/EN items, not the number of XML rows in pairs.
The warning list is capped, but the rejected count remains exact. Unknown/missing languages,
non-post items and unpublished posts remain excluded; an export with no reportable items
still fails as empty. No translation or replacement slug is generated.

---

## Stage 1 — Upload the photos (do this first)

The uploader must be running (`docker compose up -d` brings it up with the blog).

**Sign in first** — open `/admin/` (`https://simonswanderlust.com/admin/` or locally
`http://localhost:3000/admin/`). If this is a brand-new deployment, the first visit to `/login`
prompts you to create the initial admin account. After signing in, all admin pages work via the
session cookie — no token to paste.

**Hero image** (one per post) — you can upload it directly from the editor (see Stage 2), or
use the standalone upload page first:

- `https://simonswanderlust.com/admin/` (locally: `http://localhost:3000/admin/`) — enter a
  **key** like `trips/<slug>/hero`, alt text, pick the photo, **Upload**.
- Copy the returned `heroImage:` YAML values to paste into the editor's hero fields.

**Body / gallery photos** (the rest) — upload them inline from the editor's body toolbar:
each upload inserts a markdown image (`![alt](URL)`) at the cursor and records the photo's
dimensions automatically. Alternatively, pre-upload via the standalone upload page using a
`trips/<slug>/<name>` key per photo and paste the returned `<BodyImage …/>` body snippet into
the post body — it is converted to a markdown image on save. Write the German and English alt
text by hand.

> Key naming: use `trips/<slug>/<name>` (lowercase `a–z 0–9 / _ -`). The `<slug>` should match
> the post slug (below). Upload before publishing, or the URLs 404.

> The uploader accepts **one photo per request** (a second file in the same upload is rejected —
> bulk upload is a Phase 2 feature), and published variants keep only camera make/model, lens,
> capture date and exposure settings — never location, even if the original photo had it.

---

## Stage 2 — Write and publish via the in-admin editor

The in-admin editor at `/admin/posts.html` is the authoring interface — no GitHub or `curl`
needed. Content is stored in **Postgres**; MDX files are generated automatically as backups.

The editor opens on the title and story body; the command bar sits at the top of the
workspace (there is no separate page title). Long titles wrap and grow to show
the whole title; the saved title remains a single line. The masthead and left main
menu never scroll; only the white workspace does. On desktop, **Story details** stays
below the top command bar and scrolls independently; its header keeps a panel icon visible.
The panel holds the active language's country, permalink, summary, key facts, hero
image and optional title image; expedition details and taxonomy are shared. Select the
panel icon (**Collapse story details**) to slide the panel to the right into a slim rail
for more writing space; the same icon in the rail (**Expand story details**) brings it
back. On phones, the panel icon at the end of the command bar opens a keyboard-managed
drawer. Switching DE/EN preserves both languages' unsaved edits.

**Save draft**, **Publish** and **Review story** stay in the top command bar.
**More actions** (or **More** on phones) contains Preview and, for published posts,
Unpublish. The save indicator distinguishes **Not saved yet**, **Unsaved changes**,
**Saving…** and **Saved to server**. Publish readiness is separate. A failed save
leaves edits unsaved; edits typed while a save is running still need another save.
Browser recovery copies do not mean the draft has been saved to the server.

Writes from one editor tab run in order. Repeated **Save draft** clicks or
**Cmd/Ctrl+S** requests each keep the form as it was when requested; a second
save waits for the first response and uses its updated version. This also applies
when saving during **Building…**: the save waits for Publish to finish, then
stores a draft without changing the published snapshot. New posts are created
once; subsequent queued saves update that same bilingual pair. Preview's save,
Unpublish and GPX attachment/detachment share the same ordering.

Typing after the last requested save stays on screen as **Unsaved changes**, even
when earlier requests succeed. A rejected save does not prevent a later corrected
save. A genuine edit from another tab still produces the conflict dialog:
**Reload** replaces your editing base and cancels already queued older requests.
If that reload fails, saving remains blocked until the page loads successfully;
keep or recover your local draft rather than assuming it reached the server.
If a GPX preview is open while Reload reconciles a newly attached or replaced route,
its trimming selections remain intact. The replacement warning becomes available
for the current route; a changed route version requires fresh replacement confirmation.
If your session expires during a save, the editor keeps a browser recovery copy
and returns you to sign-in. Those edits remain unsaved; signing in is not a save.

Alt-text warnings start as a compact, collapsed **Alt-text review** disclosure
above the story, within the writing column. Expand it to see photos grouped by
language and issue. Selecting a photo opens the correct language and focuses its
gallery alt field, selects its inline Markdown alt, or reveals its hero alt field.
The audit reflects the last saved draft: save after repairs to refresh it. If a
photo has since been removed, the editor asks you to save rather than jumping to
an unrelated photo. These checks are optional and never block publishing.
Missing-field links select the right language and reveal the field to fix.
For an existing hero, use **Replace photo** to upload or choose from the library,
and **Adjust framing** for focal-point controls.

**Separate wide title image** — in Story details, use **Titelbild (optional)** on the DE tab
or **Title image (optional)** on the EN tab. Choose a photo from the media library or upload
a wide photograph, enter its language-specific alt text, and adjust framing if needed.
This changes only the photograph above the story and in Preview; cards, the homepage cover
and social images keep the hero. Each language has its own optional selection. **Remove title
image** restores the hero fallback without deleting either photo from the library.
Save a draft and preview first; only **Publish** changes the live banner. Upload encoding
can still be running when the upload returns: wait until the photo is ready before publishing.

### Create a new post

1. Sign in and open **Posts** (`/admin/posts.html`).
2. Click **New post** — the editor opens at `/admin/editor.html`.
3. Fill in the **German** tab first (the slug is set here and locked once published):

   | Field | Notes |
   |-------|-------|
   | **Slug** | Must match the live WordPress slug exactly — it becomes the URL (`/<slug>/`). It is derived from the title only while you have not typed into it (clear the field to re-derive); a slug loaded from the server — including an imported draft's — is never re-derived. Changing a saved draft's slug asks for confirmation naming both URLs; locked after publish. |
   | **Title** | DE page title |
   | **Date** | Publication / travel date (YYYY-MM-DD) |
   | **Country** | Localized country name |
   | **Country code** | ISO-3166 alpha-2 (e.g. `GR`) |
   | **Region** | `europe` \| `asia` \| `africa` \| `north-america` \| `south-america` \| `oceania` \| `antarctica` — a region's destination page appears once it has a published story |
   | **Excerpt** | 1-2 sentence summary |
   | **Hero image** | Open Story details → **Replace photo**, then **Upload hero** or **Choose from library**; edit alt text beside the preview and use **Adjust framing** for the focal point |
   | **Title image (optional)** | A separate wide photograph for the story header; choose/upload in Story details, add alt text and adjust framing. Leave empty to use the hero |
   | **Coordinates** | `lat`, `lng` decimal |
   | **Body** | Markdown (EasyMDE editor). Embed photos via the body toolbar's inline upload — it inserts a markdown image (`![alt](URL)`) and records the dimensions automatically. Pasted `<BodyImage …/>` tags (from an MDX backup or the upload page) also work: they're converted on save. |

4. Switch to the **English** tab and fill in the EN fields (title, country, excerpt, key facts,
   alt text, body) — **country** and **key facts** are per-locale and do NOT carry over from the
   German tab, so enter the English country name (e.g. "Greece", not "Griechenland") here too.
   The slug and shared fields (date, countryCode, region, coordinates) carry over automatically.
5. Click **Save draft** — both locale rows are written to Postgres. The post is not yet live.

**Slug length (#353, rollout-gated):** the existing lowercase ASCII slug grammar is limited
to **251 bytes**, so `<slug>.mdx` fits a 255-byte filename. Only newly auto-derived slugs
are truncated after normalization (with a cut-off trailing hyphen removed). Typed, pasted,
loaded, restored, stashed and published slugs are never shortened. An unset locale may stay
empty in a draft; publishing needs both slugs. Excessive saved/imported inputs are refused
with the locale field and length rather than renamed. MDX export checks both locales before
writing either file; database backups preserve legacy records that cannot be exported.

**Before activating the cap on an existing installation**, run the owner-authorized
read-only working/snapshot inventory described in
`docs/superpowers/specs/2026-10-27-slug-length-bound-design.md`. Any over-bound result,
including an imported draft, blocks rollout until an explicit owner decision. Do not shorten
a live WordPress URL, unpublish a record, or rewrite a backup as a workaround. Implementation
does not establish that the owner corpus has passed this gate.

### Fill coordinates from the country

Enter a country in either language's **Country** field, then leave the field. Recognized
German/English names and ISO codes fill empty latitude/longitude with an **approximate
country center**, and fill an empty country code. This lookup works offline; it does
not send the country to a geocoding service. Refine the point for a specific trip location.

Only values automatically filled during this editing session follow subsequent country
changes. Saved or manually entered coordinates, including a single entered coordinate,
are preserved. **Use country center** explicitly replaces them. An existing ISO code is
preserved too; the editor warns when it disagrees with the country. Conflicting DE/EN
countries are not guessed. Loading a post never silently fills or moves its map pin.
Save draft to keep the result.

### Generate an excerpt

In the active language's story details, select **Generate excerpt with AI**. It uses
**Settings → AI models → Story review & excerpts**: the same provider, model, timeout,
and that provider's API key as Story Review. Review instructions supply editorial guidance; the
generator requests a short plain-text excerpt in the active language from the unsaved
title and manuscript. It does not need the other language to be complete.

The browser sends this text directly to the configured provider only when requested;
provider charges and privacy policies apply. The app server never calls a model.
Review the suggestion and character count, then choose **Use excerpt** or **Replace
existing excerpt**. Generate alone never changes the current excerpt, saves, or publishes.
You can cancel or dismiss a suggestion; edits or a locale switch invalidate stale work.
Save draft remains a separate step. If the provider is unavailable, write the excerpt
manually.

### Find waypoint coordinates

In **Story details → Expedition details → Waypoints / stops**, add a stop and enter
a place name, for example **Cancun**. Click **Find coordinates** (or press Enter
in the name field), then choose the matching full location from the results.
Add a country to the name if the results are ambiguous.

Choosing a result fills that stop's latitude and longitude without changing its
name. Coordinates remain editable. **Save draft** keeps the change; lookup does
not save or publish automatically. Searches use an external geocoding service
(OpenStreetMap Nominatim by default), so do not enter confidential information.
If lookup is unavailable, enter coordinates manually.


### Publish

Click **Publish** — this marks both locale rows as published, takes a **published snapshot** of
the article content, and runs the rebuild
in-process, awaiting it before the request returns. Wait for the confirmation toast, then verify
the post is live at `/<slug>/` and `/en/<slug>/`.

> See Stage 3 for what the rebuild does and how to trigger it manually (e.g. after a restore).

### Edit an existing post

Open **Posts**, find the post, click its title or **Edit**. Saving a draft of a published post **never**
changes the live site — rebuilds of any kind (publishing another post, saving the About page,
**Rebuild site now**) keep serving the published snapshot, not your in-progress edits. The Posts
list marks such posts with an **Unpublished changes** badge and the editor status line shows
*has unpublished changes*. Your edits go live only when you hit **Publish** again, which
refreshes the snapshot.

Gallery descriptions are the exception: alt text and captions for photos in the Media
library use the current library values on the next rebuild, without republishing each
article. This does not publish any draft text or change gallery order.

**Revisions → Restore into editor** loads a saved snapshot into the form, not into the
database. If you have unsaved edits, a confirmation names the revision and its time,
and warns that it replaces content and metadata in **both German and English**, plus
shared story details. **Cancel** leaves your fields, text selections and local recovery
draft intact. A clean form loads the revision without that extra prompt; edits made
while the revision is loading still trigger confirmation.

After loading, the form is marked **Unsaved changes**. Review both languages before
choosing **Save draft**; only a separate **Publish** changes the live story. Published
posts retain their current, locked slugs even when the revision used older ones.
Restoring a revision does not reset conflict protection: a local recovery draft based
on an older saved version still cannot overwrite a newer writer, and a recovery draft
without a known base version remains blocked from saving.

**More actions → Unpublish** returns both languages to draft and rebuilds the site.
The previous release remains visible until that rebuild succeeds; if it fails, the
old live pages remain until a successful rebuild. After your own successful unpublish,
you can edit and **Save draft** in the same tab without reloading, provided nobody
else saved since the version you loaded. The editor adopts the unpublish's new
concurrency token only when its transaction-captured predecessor matches the
editor's current token. Unpublish still removes the story when your form is stale,
but a save made elsewhere before unpublish or while its rebuild is running still
produces the normal conflict dialog on your next save rather than overwriting it.
Choose **Cancel** there to keep your unsaved edits on screen for copying.

### Import and trim a private GPX route

Open **Story details → GPX route → Import GPX** and choose a local `.gpx` file
(maximum 5 MiB). The map is context, not an anonymization tool: inspect the route,
then choose **Point count** or **Distance** under **Trim using**, or remove whole segments.
Only the selected method applies; switching methods uses that method's entered values.
Distance is measured along the remaining segments, never across their gaps.
Removed sections stay visually distinct; separate runs are never connected. If tiles
or WebGL are unavailable, the grid/SVG and numeric controls still work. Removing every
usable run disables attachment; use **Detach route** to remove an existing attachment.

The solid line is the **public candidate**, simplified within each run at 25 m and rounded
to four decimal places. Neither that precision nor the z8 basemap anonymizes a location.
Wait for the candidate to finish before attaching. Collapsed runs are reported; an empty
candidate or one exceeding 100 runs, 2,000 vertices or 64 KiB cannot be attached/published.
Trim more, remove segments or replace the source; precision is never silently reduced.
A route attached before public-route support may need this correction on its first Publish.

**Attach route** is explicit. For an existing post it does not save unsaved story text
or other fields. For a new post, **Save draft and attach route** first saves the form;
if attachment fails afterwards, keep the saved draft and retry the preview. A conflict
requires reloading current state. An unknown network outcome blocks further changes
until reload rather than risking a second replacement.

When another tab attaches, replaces or detaches a route, **Save draft** can report a
conflict. Its **Reload** choice reloads both the story fields and route state; review
the refreshed attachment status before choosing **Publish** again. **Cancel** keeps
your unsaved text on screen and does not reload the route. While route state is loading
or unavailable, Attach, Detach and Publish cannot change it. If **Route state unavailable**
appears, reload the page explicitly and review the route after it loads successfully.
Detachment still retains the private original; it is not the same as never attaching a route.

If the first draft save fails, its reason appears inside the GPX dialog; the preview
remains available for retry and nothing is attached. Closing to correct the form
discards that preview, so choose the file again afterwards. An expired, cancelled or
restart-lost preview cannot be retried: choose the local file again, or close and use
**Load original again** when a retained original exists.

**Discard preview** / Close leaves the current attachment unchanged and requests deletion
of staging; unsuccessful cleanup is shown and retried automatically. Abandoned previews
expire after one hour and are not recovered from browser draft storage.
**Load original again** starts a new preview with reset trimming and replacement consent.
**Detach route** retains the latest original; replacing the route or deleting the post
removes that original. Older private backups remain until their normal retention expiry.

Waypoints are a separate choice: check only the stops you want, edit their shared names,
and confirm before adding them. **These stops keep exact coordinates and publish
independently of track trimming.** Closing the preview does not undo adopted stops;
remove sensitive stops separately and save the ordinary draft.

Private originals and paired database/route-archive backups deliberately retain removed
locations, elevation, timestamps and source metadata. Treat them as confidential.
Only explicit admin **Publish** updates the public route. Save, route edits, Detach and
**Rebuild site now** leave the last published line unchanged. To remove it publicly,
detach and then Publish. If the build fails after publication, the old release remains
served; fix the build failure and rebuild the committed snapshot.
Both language pages show the same public geometry, with localized per-run lengths and
start/end coordinates available without JavaScript or a map. Overview maps remain pin-only.


### Finding posts, and acting on several at once

The Posts list shows a hero thumbnail per post plus its country and trip date, and has a
**search / status / region / country / sort** toolbar above it. All of that runs in the browser
against the already-loaded list, so it is instant and never hits the server — that is the right
trade at this size and is documented to move server-side once the list grows to a few hundred
posts. A post with no hero yet shows a dashed placeholder instead of a broken image.

The status filter also offers **Unpublished changes** and **EN missing**. **X of Y posts**
reports the current results; **More filters** indicates active refinements even when collapsed.
Use **Clear filters** to return to the full inventory, including from an empty search.
Filter and sort state is recorded in the URL and restored when returning from the editor.
On narrow screens, rows stack into labeled groups without removing selection or actions.
If loading fails, stale row actions are removed; **Retry** reloads the list.

Tick the checkboxes to select posts (the header checkbox selects everything currently visible,
i.e. it respects the filters), then use **Publish**, **Unpublish** or **Delete** in the bar that
appears. Admin-only, like their single-post equivalents. Selections survive filter changes:
the bar reports how many selected posts are outside the current view. **Review selection**
lists every selected title; **Clear selection** deselects the entire set. Bulk confirmations
name the affected stories. Important details:

- **The whole batch triggers one rebuild**, at the end — not one per post. Bulk publish also
  writes each post's MDX backup, exactly like publishing one at a time.
- **Failures are reported per post, and the rest of the batch still runs.** A post that fails
  validation (or a half-created pair with only one locale row) is listed by name in the status
  box with its reason; everything else goes through. Failed stories remain selected for retry;
  successfully processed stories are deselected.
- **Bulk delete asks you to type `DELETE`.** Type the exact token and press Enter, or click
  **Delete**. Enter with a mismatched token keeps the confirmation open; Escape or Cancel
  dismisses it without deleting. There is no undo — revisions are per-save snapshots of a
  post, so deleting the post takes them with it.

### Export / backup

The **Export MDX to server backup** button (Posts list) writes MDX backup files for all posts to
`/data/backup` on the server. Exports contain the **working copies** (what you see in the
editor) — including draft prose/metadata edits not yet published. The optional `track`
field is deliberately different: it is only the **last published public artifact**, never
the current private attachment. Never-published routes are omitted; edited/detached routes
keep the last published line until Publish. These are reference copies — Postgres is the
source of truth.

GPX originals/private geometry are excluded from MDX. Recovery requires the private v10
database dump **and its manifest-matched route archive**, available to admins in Settings.
The images archive does not contain GPX originals. See
[Database dumps](../ARCHITECTURE.md#database-dumps) for the offline restore procedure.

### Body images

Body photos are markdown images (`![alt](URL)`) whose dimensions are recorded in the post's
images map — at build time they render as responsive `<picture>` elements (AVIF + WebP,
multiple sizes), the same markup as in the MDX era. The editor's inline body upload does both
steps for you: it inserts the markdown image at the cursor and records the dimensions.

Pasting a `<BodyImage src="…" width={…} height={…} alt="…" />` tag also works — e.g. from an
MDX backup under `/data/backup`, or the body snippet shown by the standalone upload page. It is
normalized to a markdown image on save and its width/height are merged into the images map.
Use the **DE body** tab for German alt text and the **EN body** tab for English alt text (same
image URL, language-appropriate alt):

```
<BodyImage src="https://img.simonswanderlust.com/trips/rhodes-2021/old-town" width={1600} height={1067} alt="Gepflasterte Gasse in der Altstadt von Rhodos" />
```

> Don't hand-write a bare markdown image for a photo whose dimensions were never recorded
> (i.e. not uploaded via the editor toolbar and not pasted as a `<BodyImage …/>` tag) — it
> renders as a plain `<img>` without the responsive treatment.

### The media library

`/admin/media.html` is where photos live. Drop files onto the drop zone (or use **Choose files**
— drag-and-drop is only an enhancement) and they upload into the currently selected folder.

**Uploads return immediately; encoding happens in the background.** The URL and dimensions you
get back are final, but the responsive AVIF/WebP variants take a few seconds per photo — around
19 s for a 24 MP frame — so a freshly uploaded photo shows a **processing** badge and its
thumbnail appears once it is done. You can close the tab: uploading needs the tab open,
encoding does not.

Two consequences worth knowing:

- **Publish refuses while a post's photos are still processing**, with a message naming them.
  That is deliberate — publishing early would put URLs on the live site that 404 until the
  encode lands.
- **A failed encode shows in the library** with a short reason, and **Retry encoding** re-queues
  it. The untouched original is always kept, so a retry is lossless.

Folders are **virtual**: moving a photo never changes its URL, so reorganising the library can
never break a published post. Renaming a folder moves its whole subtree (`Iceland` moves
`Iceland/South` but not `Iceland 2024`), and a folder must be empty before it can be deleted.
Folder rename and delete, and deleting a photo, are admin-only.
The folder list identifies exactly one current folder to assistive technology as well as
visually, including **All photos**. Rename and Delete apply to that current folder.

Select photos by clicking, shift-clicking or ctrl/cmd-clicking; the grid is fully keyboard
operable (arrows move, `Space` toggles, `Shift`+arrow extends, `Ctrl/Cmd`+`A` selects all).
The detail panel on the right edits title, both alt texts, both captions, tags and folder;
camera, lens and capture date are read-only, read from the photo's EXIF.

**Generate details with AI.** Uses **Settings → AI models → Photo descriptions** (the same vision
model as the editor's alt-text suggestions); the browser sends each photo's display image
straight to that provider, so its charges and privacy policy apply.

- **One photo:** select it, then **Suggest with AI** in the detail panel. Empty title,
  alt, caption and tag fields are filled; a field you already wrote keeps your text and
  shows the suggestion underneath with **Use**. Nothing is saved until **Save details**.
- **Several or all photos:** select photos and use **Generate details with AI** in the
  selection bar, or **Generate details with AI…** above the grid for every photo in the
  current folder and filters (all pages). Pick the fields, check the count and the
  destination, then **Generate**. Results are **saved as they arrive**. By default only
  empty fields are filled and complete photos are skipped, so you can stop (**Stop** or
  Esc) and run it again later to continue. **Replace text that is already filled in**
  overwrites the chosen fields and cannot be undone; it has to be ticked for every run.
  Failed photos are listed with a reason; three failures in a row stop the run.

For **article galleries**, Media is the source of truth for each language's alt text and
caption. Save details, then reopen the article to see the current descriptions; Preview
also uses them immediately. The public galleries update on the next **Rebuild site now**
or publication-triggered rebuild. You do not need to republish each affected article.
Clearing a Media field clears it in the galleries too. Review generated descriptions
before saving: they can appear in every article gallery using that photo.
The title labels the photo in the library/editor; it does not replace alt text.
Hero/title-image and ordinary inline-image descriptions remain article-specific.

> Photo GPS is stored for you but is **never published** — image variants carry an EXIF
> allow-list with no location at all, and the API hides coordinates from non-admin accounts.

**Rescan disk** (admin) reconciles the database with `/data/images`: it adds rows for photos that
predate the library, copies existing alt text from posts that already use them (exact URL matches
only), and flags rows whose files have gone missing without deleting the metadata.

In the post editor, the hero fields now offer **Choose from library** alongside **Upload hero** —
most heroes already exist, and re-uploading one would just mint a second copy under a new key.

The shared library picker — including **Aus Mediathek wählen** for the title image and
the gallery chooser — has the same nested **Folders** list as the Media page. Select
a folder to browse it and its subfolders, or **All photos** to return to the full
library. Search is scoped to the current folder; changing folders returns to page one
without dropping gallery selections or their order. Only ready photos are offered.
On a phone, expand **Folders** above the photos; it collapses after a folder is chosen.
Create, rename, and delete folders on the Media page, not in the picker.
The picker's **Previous** and **Next** controls retain keyboard focus while a page loads,
so Enter can continue through pages without tabbing back. Unavailable directions stay
focusable and are announced as disabled; repeated activation while loading or at a page
boundary does not request another page.

### Galleries

**Gallery previews.** Complete gallery blocks appear as photo previews inside the
article's writing area. For a library photo, the active language's **Alt text** field
is read-only, the current caption appears underneath, and **Edit in Media** opens the
library in another tab without losing your unsaved article. Change descriptions there
(including AI suggestions), then reopen the article to refresh the previews.
A failed library lookup locks the field and offers **Try again** rather than pretending
the saved copy is current.

Photos no longer present in the library keep their article-specific descriptions.
Their alt fields remain editable, including **Suggest alt text with AI**. Repeated uses
of the same image URL in one language share that local alt text; clearing it explicitly
saves an empty alt. Review AI suggestions before applying them, and click **Save draft**
to keep these article-local changes. Captions, order and layout are preserved.

Use **Edit photos and layout** in the preview to open the existing gallery picker.
**Show gallery Markdown** above the writing area exposes the underlying fence for
manual editing; **Show gallery previews** returns to visual editing. Undo/redo
continues to work through the Markdown editor. The inline view shows every photo
in order for editing; use the article's **Preview** for its published layout.

**The easy way: "Insert / edit gallery".** Each locale tab has the button next to "Insert body
image". Put the cursor where the gallery should go — or anywhere inside an existing one — and it
opens the media library in multi-select mode. Click photos to add them, use ↑ / ↓ to set the order
(that *is* the order they appear in), and × to drop one. Confirming writes the fence below for you;
confirming with nothing selected removes the gallery. The photos already in the gallery are
pre-selected the moment the dialog opens, whichever library page they happen to live on, and a photo
that is no longer in the library is kept too — marked `in gallery` and with no thumbnail — so
editing a gallery never quietly loses a photo. Alt text and captions you have already written for
*this post* win over the media library's own; only newly added photos take the library's.

Two cases it will refuse rather than guess: a gallery whose closing ` ``` ` is missing (its extent
would run to the end of the post), and a cursor inside a code block that is likewise unclosed. It
tells you which; close the fence and try again.

Visual gallery editing now asks the signed-in server to analyze the exact unsaved
manuscript. If analysis is unavailable, your Markdown and undo history remain
untouched; use the localized retry action or continue editing raw Markdown. If the
manuscript changes while the picker is open, reopen it against the current text
instead of applying an old selection.

Existing tilde fences, longer fences, indentation, list/blockquote galleries and
raw HTML `pre > code.language-gallery` galleries keep their placement and wrappers
when saved, exported or edited. These are the same forms the article renderer
already recognizes. Literal gallery examples inside other code blocks remain
examples. An extra opener argument such as `gallery slider` does **not** select a
layout: use the `#layout:` line below.


Everything below is what that button writes, and is still the format to hand-edit.

Several photos in one grid go in a fenced block with the language `gallery`, one image URL per
line. Order is line order; blank lines and `#`-prefixed lines are ignored.

````
```gallery
https://img.simonswanderlust.com/trips/rhodes-2021/a-1a2b3c4d | 3000x2000 | alt="Blick über die Bucht" | caption="Tag 3"
https://img.simonswanderlust.com/trips/rhodes-2021/b-9f8e7d6c | 2000x3000 | alt="Der Aufstieg"
```
````

Valid `| WIDTHxHEIGHT | alt="…" | caption="…"` metadata is **lifted into the post's images map
on save**, and the line becomes a bare URL. Dimensions are required unless already recorded;
alt and caption are optional. The picker and export escape values automatically. When editing
Markdown by hand, use `&quot;` for a quote and `&#124;` for a pipe inside a double-quoted value,
for example `caption="He said &quot;hello&quot; &#124; sunset"`. Backslash-escaped quotes (`\"`)
and literal `|` inside a value are **not** supported syntax.

If any field is malformed or unknown, the **whole photo line is saved unchanged**, and none
of its metadata is applied. A persistent warning names the language and source location;
select it to find the current problem, repair the syntax and save again. Other valid lines
still normalize. The warning returns when reopening the draft. The affected gallery remains
editable as Markdown, but visual picker/inline-alt updates cannot overwrite its invalid line.
Export preserves that line rather than guessing a repair.

This is a successful save, **not** a new publication block. Malformed captions can remain
missing on the published page, including immediately after an About-page save/rebuild.
Existing Media descriptions and previously stored metadata retain their usual precedence.

Two things silently drop a photo from the grid, both deliberate:

- **A URL from any other origin than the image host is refused** (compared by exact origin —
  `https://img.simonswanderlust.com.evil.com/…` does *not* count as the image host). Galleries
  may only reference photos this blog hosts.
- **A URL with no dimensions in the images map is skipped.** If that leaves the gallery with
  nothing to show, the fence is left visible as a code block rather than disappearing, so you
  can see what went wrong.

> On a local dev build with no `PUBLIC_BASE_URL` set, the allowed origin defaults to the
> production image host, so `http://localhost:3000/…` gallery URLs are refused and the fence
> renders as a code block. Set `PUBLIC_BASE_URL` (the repo-root `.env` already does) to preview
> galleries locally. Draft previews in the admin are unaffected — they use the app's own
> configured image base.

#### Layout modes

A gallery picks one of three layouts with a `#layout:` line **inside** the fence. The picker sets
it for you; by hand it looks like this:

````
```gallery
#layout: column
https://img.simonswanderlust.com/trips/rhodes-2021/a-1a2b3c4d | 3000x2000 | alt="Blick über die Bucht"
```
````

| Mode | What it does |
| --- | --- |
| `column` | **Default.** Justified rows aligned to the body-text column. |
| `breakout` | Justified rows, wider than the story column — the full spread on a desktop. |
| `slider` | One horizontally scrollable row. |

The directive goes **inside** the fence, not on the opener — ` ```gallery layout=slider ` does not
work, because the info string is discarded before the renderer sees it. It must be a whole line, so
a `#layout:` sequence inside an `alt="…"` value stays content. The first one wins, and an unknown
or missing mode falls back to `column`. (The default was `breakout` until 2026-09-20; a gallery
that should stay wide needs an explicit `#layout: breakout`, which the picker writes for you.)

In the justified modes the last row is capped at the height of the row above it, so a short final
row can't leave one photo towering over the rest.

#### Captions for this gallery only

By default a gallery shows each photo's caption from the Media library (or the caption saved with
the post for a photo that is no longer in the library). The gallery picker's **Show captions**
switch and its per-photo caption fields change that **for this gallery, in this language, only** —
never in Media, and never in another gallery that uses the same photo. Edits apply when you
confirm the picker; cancelling changes nothing. Resetting a caption makes the photo follow the
library again. By hand it looks like this:

````
```gallery
#captions: hidden
https://img.simonswanderlust.com/trips/rhodes-2021/a-1a2b3c4d | caption-override="Nur in dieser Galerie"
https://img.simonswanderlust.com/trips/rhodes-2021/b-9f8e7d6c | caption-override=""
https://img.simonswanderlust.com/trips/rhodes-2021/c-0a1b2c3d
```
````

- `#captions: hidden` hides every caption of this gallery, including in the lightbox. The text
  is kept, so removing the line brings it back. Like `#layout:`, it must be a whole line inside the
  fence and the first one wins; any other value (or none) means captions are shown.
- `caption-override="…"` sets this photo's caption here. An empty value deliberately shows no
  caption; leaving the field out follows the library. It uses the same escaping and 1,000-character
  limit as `alt="…"`, and it is the one field **not** lifted into the images map on save — it
  stays on its line (`URL | caption-override="…"`) so it cannot spread to other galleries. Export
  writes it last on the photo line, after the dimensions, alt and caption.
- Alt text is unaffected: it always follows the library for library photos.

Galleries work in **page** bodies (the About page) on the same terms. Clicking any photo opens a
lightbox, in all three modes. The draft preview renders galleries but **not** the lightbox — it is
a separate island that only runs on the built site.

The About page's search and social descriptions come from its rendered prose paragraphs,
before responsive images are inserted, not the raw Markdown. Prose remains eligible when an
image shares its paragraph: a single newline after a leading image is enough, and readable
text on both sides of an inline image is preserved. You can begin either language with an image, gallery or fenced code:
their URLs, alt text, captions and fence directives do not become the description. Inline
emphasis and links contribute their visible text; entities are decoded and line breaks become
spaces. Descriptions stop at a whole-word boundary within 150 characters. An empty or
media-only body uses the localized “Über mich” / “About me” fallback. Use **About → Publish**
to save both languages and rebuild the public pages; changing this metadata does not remove
the images, captions, code or formatting from the page itself.
The loader derives these descriptions from the same snapshot-backed page rows used for
the rendered content; the identity-configured structured-data author is independent.

### Comments

Reader comments are stored in Postgres and served at request time — they are **never** baked
into the static site, so none of the switches below need a Publish or a rebuild.

1. **Global switch** — on the admin-only Settings page (`/admin/settings.html`), *Enable comments
   on the site*. **Default off.** While it is off the form is hidden on every story and
   `POST /comments` answers 409; approved comments already visible stay visible, and the per-post
   checkbox has no effect. Turning it off is the rollback for the whole feature and deletes nothing.
2. **Per-post checkbox** — *Allow comments on this trip* under **Expedition details** in the
   editor (shared between DE and EN). **Default on**; untick it to close one thread. Authors can
   close a trip, but only an admin can open the site to comments.
3. **Moderation** — a reader's comment lands in `/admin/comments.html` as **pending** and is not
   public until an admin clicks **Approve**. Author replies are auto-approved and marked as such.
   Their localized **Autor / Author** badge follows the reply's stored author flag, independent
   of the number of approved comments elsewhere on the site. This does not change the current
   limit of the oldest 500 approved comments returned for one story.
   Both moderation views show the oldest comments first, **50 per page**. Use **Previous**
   and **Next** to reach every comment, including those beyond the old 500-row queue.
   The page indicator identifies the current page; a filter change or successful Approve,
   Unapprove, Delete, Spam or Reply returns to page one. Cancelling a confirmation leaves
   the current page untouched. Other moderators can shift the pages while you browse:
   restart at page one to see the new state. If the last page becomes empty, Previous
   remains available.
   Switching **Show** or refreshing after moderation immediately removes the old rows and
   actions while the selected view loads. Only the newest request can update the list,
   loading indicator or error message; a delayed response from an earlier view cannot
   replace it. A failed refresh leaves no stale rows or usable stale paging controls.
   Switch views to try loading again. Unsent replies stay attached to their comment for
   this page session, including after a failed refresh, paging or a filter change;
   navigating away or reloading the page discards them.
   A successful reply clears only its submitted draft, not newer text written meanwhile.
   Concurrent actions in the same filter each refresh after success, even when another
   action has already refreshed the list. A real filter or page change retires those
   old-view completions; paging focuses the page indicator, without discarding drafts.
   If those refreshes overlap, the newest one retains the last focused reply and its
   selection. Moving focus elsewhere cancels restoration, including when you then
   blur that control; a delayed response does not pull focus back.
4. **No rebuild** — closing or opening comments (either switch), approval, unapproval and
   deletion take effect on the next public request. A confirmed Delete or Spam is permanent.
   None requires **Publish** or triggers a site build.
5. **Deleting a post deletes its comments** — the thread is removed in the same transaction as the
   post and its revisions; there is no undo.

---

## Stage 3 — How the rebuild works

The **Publish** button in the editor triggers a rebuild automatically and waits for it to finish
before confirming — you don't need to run anything manually under normal authoring conditions.
This section explains what happens under the hood and how to trigger a rebuild manually if needed.

The blog is a **static site**, but there's no separate build server or web server anymore: the
same `app` container that runs the admin/CMS also builds and serves the blog. Content lives in
**Postgres** — not in the Docker image. `uploader/src/build.ts` spawns `astro build` **in-process**
(via plain `node`, no shell) on demand, and writes the output into `/data/site/releases/<stamp>`,
then atomically flips the `/data/site/current` symlink that the app serves directly.

**Rebuilding the `app` image does not update the live blog.** The image carries Astro/template
code; the already-built HTML on `/data/site` (rendered from Postgres at the last Publish/rebuild)
is untouched until something triggers a *new* build — an image rebuild alone doesn't. (Also note:
compose has no `build:` key, so `docker compose up -d --build` doesn't even rebuild the image —
use `docker build .` from the repo root instead.)

To trigger a rebuild manually (e.g. after a database restore, or a template code change), sign in
as an admin and use the **Rebuild site now** button on the settings page (`/admin/settings.html`),
which calls the admin-only `POST /rebuild` route. From a shell on the host, without signing in:

```bash
docker compose exec app node --import tsx src/cli.ts rebuild
```

That subcommand does **not** build in its own process — it asks the running app over loopback, so
the build still takes the one lock that keeps it from running beside image encoding (which is
what the container's memory ceiling is sized against). The app therefore has to be up; if there
is no release at all yet, boot builds one by itself.

Notes:

- **Rebuilds render published snapshots only.** The site is built from each post's published
  snapshot (taken at Publish time) — saved-but-unpublished edits never appear on the live site,
  no matter what triggers the rebuild.
- **Images don't need a rebuild to be served.** An uploaded file is reachable at its URL
  immediately — but the site's HTML only points at a *new* image URL after the post is saved
  with it and republished. Only text/content changes need a rebuild on their own.
- **Re-uploading a photo returns a NEW URL** (upload keys get a short content-hash suffix), so
  the previously published URL keeps serving and browser caches can never go stale. To put the
  replacement on the live site, save the post with the new `src` (the editor's inline upload
  fills it in automatically) and republish. A standalone upload via `/admin/` alone does not
  change a published post.
- **Required environment variable** for the stack: `DATABASE_URL` (Postgres connection string).
  See `uploader/.env.example`.

---

## Quick checklist

- [ ] Photos uploaded — hero and body images via the editor's inline upload, or pre-uploaded via `/admin/` (hero); snippets/URLs ready.
- [ ] In the editor: DE tab filled — slug (matches live WordPress slug, never renamed), title, date, country, countryCode, region, excerpt, heroImage fields, body photos inserted via the toolbar (or pasted `<BodyImage …/>` tags — converted on save) with DE alt text.
- [ ] In the editor: EN tab filled — title, country (its own field — does not carry over from DE), excerpt, EN hero alt text, EN body with its own photo inserts (EN alt text).
- [ ] **Save draft** — both locale rows written to Postgres; the live site is never affected by a save.
- [ ] **Publish** — snapshots the content as the live version and triggers the rebuild automatically.
- [ ] Verify the post renders at `/<slug>/` and `/en/<slug>/`, hero + body images load.
