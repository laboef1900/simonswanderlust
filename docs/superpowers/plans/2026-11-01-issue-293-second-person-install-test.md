# #293 acceptance: a second person installs from the guide alone

Acceptance item: "A second person (not the author) completes the guide on a fresh host without
consulting source; result recorded." This is a human test. It needs an owner decision on who
runs it and on which host; nothing here has been executed.

## Who and what

- **Tester:** anyone who did not write `docs/install.md` and has not worked on this repository.
  They may read `docs/install.md` and the pages it links to. They must **not** read source code,
  ask the author, or use this repository's issues/PRs during the run.
- **Observer (optional):** the owner, silent, taking notes. Answering a question counts as a
  failure of the step being asked about.
- **Host:** a **fresh** disposable Linux VM, amd64 or arm64, Ubuntu 24.04 LTS or newer, with
  Docker Engine + Compose v2 installed and nothing else running. At least 8 GB RAM is
  suggested so the app's 4608 MiB ceiling plus Postgres fit; that is a test allocation, not a
  requirement. Two DNS names the tester controls (e.g. `blog.<test-domain>` and
  `img.<test-domain>`) pointing at the VM, ports 80/443 reachable for certificate issuance.
- **Image:** the first published `ghcr.io/laboef1900/wanderlust-studio` release if it exists,
  otherwise the guide's "Build the image locally" path (needs `dhi.io` access — the owner
  provides it if the tester has none, and records that).
- **Never** the production server, the owner's `.env`, `uploader/data` or database.

## Steps (the tester follows docs/install.md top to bottom)

Record start/end time, every command typed, and for each step: done / done-with-friction /
blocked, plus a sentence for anything unclear.

1. §1–§3: decide whether the host is supported; note anything that was ambiguous.
2. §4a: clone, check out the release, create `.env` with generated secrets; prepare `uploader/data`.
   Before filling `PUBLIC_BASE_URL`/`IMG_HOST`, run `docker compose config --quiet` once and
   record the error message (expected: `set IMG_HOST in .env` / `set PUBLIC_BASE_URL in .env`).
3. §4b: pull (or build) the image.
4. §4c: start; record `docker compose ps` and the `/health` result.
5. §4d: install nginx (or the proxy of the tester's choice, recorded), adapt the example,
   obtain certificates, reload.
6. §4e: create the admin, choose a language mode, set Site identity incl. the public domain,
   rebuild, upload two of the tester's own photos, write and publish one short story, enable
   comments and post one comment from the public page.
7. §5: run every verification bullet; record pass/fail for each.
8. §6: take one in-app backup; read (do not execute) the upgrade runbook and note whether its
   first step is clear.
9. Tear down the VM.

## Pass criteria

- Every step in §4 and every check in §5 passes **without** consulting source or the author.
- No secret appears in the record (redact `.env` values, cookies, keys).
- Each friction note is either fixed in the guide or accepted by the owner in the record.

## Record

Add a dated section "Second-person install — <date>" to `docs/install.md`'s PR (or a follow-up
PR) with: tester (name or initials, with consent), host (provider, arch, OS, Docker/Compose
versions, RAM/CPU), image tag + digest, per-step outcome table, total time, friction notes and
their disposition. Then tick the acceptance item on #293.
