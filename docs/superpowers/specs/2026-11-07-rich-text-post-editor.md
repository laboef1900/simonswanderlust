# Rich-text post editor

## Approval and scope

Owner requested the Compendiq editor at https://app.lutzs.ch/pages/465 as the visual reference on 2026-11-07, then explicitly selected rich-text editing with Markdown compatibility. This is a high-risk authoring-boundary change: stored source must not be lost or executed. No schema, public renderer, route, publishing, authentication or image-map contract changes are authorized.

### Approved build exception

The owner explicitly approved a self-hosted editor bundle on 2026-11-07, waiving
PRODUCT.md's no-bundler constraint for this surface only. Reason: use a maintained
rich-text engine rather than hand-writing contenteditable behavior. Risk: added
dependencies and a required generated asset. Controls: exact dependency versions,
lockfile inventory and license notices, local vendor build, no CDN, Markdown
preservation regressions and explicit source-mode recovery on initialization failure.
Approver: repository owner in this conversation. Review at the next rich-text engine
major upgrade; the rest of the admin remains vanilla JavaScript.

## Design

Operate mode, extending Editorial desk. One white document canvas, quiet sticky formatting tools, unboxed title and rendered editable prose, and the existing collapsible Story details column. Keep desktop and phone controls keyboard accessible; preserve the existing focus-managed phone drawer, locale tabs, review disclosure and save feedback. Inter and existing steel-blue/neutral tokens remain authoritative. No public-site redesign.

Visual is the default writing mode. Markdown is an explicit editable source mode, not a read-only preview. Both operate on the same Markdown body used by current draft saving, recovery, review, gallery analysis and publication. No autosave or new external service.

Use a self-hosted Tiptap editor and a locally built browser bundle. Retain EasyMDE for the genuine Markdown mode and its established gallery authoring tools. Rich-text transactions synchronously update the Markdown draft; source edits and programmatic edits update the visual document without feedback loops. Merely opening a story or changing mode must not dirty or rewrite its source.

## Content and security invariants

- DE and EN have independent bodies, histories and selections. Only enabled locales are shown.
- Headings, paragraphs, emphasis, links, lists, quotations and code have visual editing controls; undo/redo remain meaningful.
- Gallery fenced blocks retain exact directives, order, captions and source URLs. Existing picker and image metadata contracts remain authoritative. Visual gallery edits use the same picker, not a new persistence path.
- Unsupported Markdown/HTML is retained as an explicitly labelled source block, never silently discarded. Opening or switching modes preserves the original source byte-for-byte; editing adjacent content preserves unsupported source.
- Source HTML is never inserted into the admin DOM as HTML. Unsafe link schemes never become active links. Image previews retain exact-origin checks and do not fetch arbitrary author-controlled URLs.
- Save, conflict recovery, local draft recovery, preview and publish collect the latest visible edit. Asynchronous photo/gallery operations retain existing stale-selection and revision guards.
- Rich-text initialization failure keeps the editable Markdown source available and reports the failure, rather than hiding or replacing content.
- An unterminated fenced block stays in Markdown mode: a visual paragraph after it would otherwise save inside the fence. Closing the fence and choosing Visual restores rich editing without losing the source.
- No server content mutations during browser verification; use isolated browser storage and intercepted mutation responses where needed.

## Acceptance and verification

Automated regression coverage for semantic Markdown round trips, exact untouched source, unsupported syntax and raw HTML retention, gallery directives/captions, safe URLs, mode switching, locale independence and toolbar commands. Existing authoring regressions continue to pass. Run uploader typecheck/full Vitest, site Vitest and Astro check, with explicit reporting of unavailable database-backed checks.

Browser smoke against working-tree assets: real populated post, visual typing and formatting, Markdown source and return, undo/redo, DE/EN switching, gallery insertion/editing, save payload, desktop/phone layout, Details drawer and keyboard focus. Inspect desktop and phone screenshots together; no horizontal overflow or inaccessible clipped controls.

## Recovery

Rollback the frontend assets and dependencies together; stored content is still Markdown and needs no migration. Keep all existing server sanitization, image-origin validation and publish checks unchanged. Before release, require human review of Markdown preservation and browser evidence; local implementation is not deployment approval.
