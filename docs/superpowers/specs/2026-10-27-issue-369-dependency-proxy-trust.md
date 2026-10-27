# Issue #369: patch the production dependency locks without breaking proxy trust

**Status: OWNER APPROVED, 2026-10-27.** The owner selected **“Approve documented host-proxy
topology”** for PR #404 at `fad862fff4e8fcba5fe4c8c6ccf558b3e65ac185`. This authorizes the
dependency and explicit immediate-peer trust contract for a single host TLS proxy, without a
CDN or extra proxy hop, including fail-closed gateway discovery. Under `CLAUDE.md` this remains
high risk: proxy trust feeds rate limits, Secure cookies and GPX Origin checks; the site
toolchain feeds the sanitized body renderer. SECURITY.md reconfirmation and all §7 checks
remain implementation requirements. No release, deployment or production topology change is authorized.

Baseline: `origin/dev` @ `11e16d1b8e43141d296b801ee663a351ae3fe415`, app version `0.17.1`.
Related: #347 (sharp). It lands first; see §8.
Registry metadata and advisories were read on 2026-10-27. Implementation re-checks them (§7, step 0).

## 1. Problem (verified against the tree and upstream)

| Fact | Evidence |
| --- | --- |
| `uploader/src/server.ts:189` constructs `Fastify({ logger: false, trustProxy: 1, … })`. `test/gpx-private.integration.test.ts:63` builds its own instance the same way. | code read |
| `req.ip` keys the per-IP auth limiter (`rate-limit.ts:101`) and the public comment limiter (`comments-public.ts:129`). `req.protocol` drives the session cookie's `Secure` flag (`authn.ts:20`, used at `server.ts:1223,1255`). It also builds the GPX mutation Origin comparison, `${request.protocol}://${request.headers.host}` (`gpx-routes.ts:65`). No code reads `request.host`, `request.hostname` or `request.ips`. Host routing and the GPX Origin use the raw `Host` header. | grep of `uploader/src` |
| Compose publishes `127.0.0.1:3000:3000` and attaches `app` and `db` to the project's default bridge network. No `networks:` block exists, so Docker allocates the subnet automatically. The process listens on `0.0.0.0` (`main.ts:207`). | `docker-compose.yml`, `main.ts` |
| The repo documents a **host-level** TLS proxy that forwards to `127.0.0.1:3000` (`README.md:151`, `uploader/README.md:147`, `SECURITY.md:759-762`). The proxy software is unspecified (nginx, Caddy or Traefik). No production deployment exists yet; Phase 4 (DNS cutover) is pending. | docs read |
| **GHSA-3m5p-2c4r-xxw2** (CVE-2026-16732, fastify `>=5.8.3 <5.12.1`): the hop-count form ignores the connecting address. Anyone who reaches the origin directly can spoof `X-Forwarded-For`, `-Proto` and `-Host`. The fix in 5.12.1 **disables numeric `trustProxy` at runtime** and removes it from the TypeScript union. | [advisory](https://github.com/advisories/GHSA-3m5p-2c4r-xxw2), [v5.12.1](https://github.com/fastify/fastify/releases/tag/v5.12.1) |
| In fastify 5.12.7, `lib/request.js` `getTrustProxyFn` returns `() => false` for a number. A blind upgrade that kept `trustProxy: 1` would fail closed silently at runtime: `req.ip` becomes the socket peer for every client, and `req.protocol` becomes `http`. `tsc` would catch it, because the type no longer accepts a number. | tarball `fastify-5.12.7/package/lib/request.js:43-62`, `fastify.d.ts:152` |
| The documented string, CIDR and function forms validate `proxyFn(socket.remoteAddress, 0)` before trusting `X-Forwarded-Proto` or `-Host`. `request.ip` walks `proxyAddr.all(req, fn)` and stops at the first untrusted hop. | `request.js:103-148`, `@fastify/proxy-addr@5.1.2` `alladdrs` |
| `npm audit --omit=dev` at the baseline reports **uploader**: fastify (high), @fastify/static (high), brace-expansion (high), sharp (high). Total 4 high. | read-only `npm audit --json --omit=dev` |
| It reports **site**: astro (critical), devalue, http-cache-semantics, js-yaml, nanoid, postcss, smol-toml, source-map-js, svgo, vite, zod, sharp. Total 1 critical and 11 high. | same |
| `npm audit` without `--omit=dev` adds the following. **Site**: @vitest/mocker and vitest (moderate), fast-uri (high, via `@astrojs/check`→`yaml-language-server`→`ajv`), happy-dom (high), and postcss-selector-parser via @tailwindcss/typography (moderate). The uploader's extra entries (vite, vitest and others) are dev-only. | same |
| The Dockerfile runs `npm ci --omit=dev` for the uploader but plain `npm ci` for the site (`Dockerfile:45,53`). **The site's devDependencies ship in the runtime image.** | `Dockerfile` |
| The uploader's draft preview and publish gate import `site/src/lib/render-markdown.ts` (`preview.ts:12`, `publish-gate.ts:28`). That module imports `@astrojs/markdown-satteri` directly, and its `MARKDOWN_OPTIONS` must mirror `astro.config.mjs`. A site dependency change therefore also changes uploader runtime behaviour. | code read |

## 2. Advisory inventory, fix target and reachability

"Reachable" here means reachable through this app as deployed. Every row is patched regardless.
No row is left unpatched on a reachability argument, except the two in §2.3.

### 2.1 Uploader (`--omit=dev`, the set shipped in the image)

| Package @ baseline | Advisories (range → patched) | Target | Reachability today |
| --- | --- | --- | --- |
| fastify 5.9.0 | GHSA-3m5p (hop-count spoof, <5.12.1). GHSA-w2qp (schema coercion, <5.12.1). GHSA-667r, GHSA-p68q, GHSA-hwr6, GHSA-9q9j (<5.12.2). GHSA-4mh8 (HTTP/2 trailers, <5.12.5). GHSA-389g (header `propertyNames`, 5.12.2–5.12.5, low; not yet in the audit DB, fixed in 5.12.6). | **5.12.7** (npm `latest`, 2026-10-13) | **3m5p is reachable** by any peer that can open a TCP connection to `:3000` without going through the proxy. That covers host processes and every container on the compose network (`db`). The schema advisories are not reachable, because no route declares a Fastify schema (grep finds no `schema:`). p68q is not reachable: there is one root `setNotFoundHandler` (`server.ts:2158`) and no encapsulated not-found handler with a preHandler. 4mh8 is not reachable, because the app does not serve HTTP/2. |
| @fastify/static 9.1.3 | GHSA-83w8 (route-guard bypass via `..`, ≤10.1.0). GHSA-8pvw (`allowedPath` evaluated before normalisation, ≤10.1.1). GHSA-r799 (case-insensitive FS, fixed in 10.1.4). | **10.1.8** (`latest`, SLSA provenance; 10.1.8 is docs-only over 10.1.7) | 8pvw targets the `allowedPath` guard that keeps GPS-bearing `-orig.*` originals and `.part-*` temps off the image host. `VARIANT_FILE_RE` = `/-(\d+)\.(avif\|webp\|jpeg)$/` (`media-files.ts:14`) anchors on the **last** segment. Dot-segment normalisation only removes segments, so a path whose last segment matches can never resolve to an original. This matches the issue's finding that no arbitrary original-file access was found. Still reviewed as load-bearing (§6.3). 83w8 does not apply: no route-based guard protects static files. r799 does not apply: the server filesystem is Linux, which is case-sensitive. |
| brace-expansion 5.0.7 (←minimatch 10.2.5 ←glob 13.0.6 ←@fastify/static) | GHSA-mh99, -rgw5, -q2hr, -qhr7, -6j4f (DoS, <5.0.12) | **5.0.12** via minimatch **10.2.6** (`brace-expansion ^5.0.8`) | Not reachable. glob runs only when @fastify/static enumerates its roots at registration (`wildcard` handling), over patterns this app supplies. No request-controlled pattern reaches it. |
| sharp 0.35.3 | GHSA-rgj7, GHSA-wq5f | **owned by #347** (0.35.5 / libvips 1.3.4) | see the #347 spec |

### 2.2 Site (`--omit=dev`)

| Package @ baseline (path) | Advisories | Target | Reachability |
| --- | --- | --- | --- |
| astro 7.0.6 | GHSA-26w7 (AVIF RCE via image optimisation, critical, <7.2.8). GHSA-4g3v (View Transition XSS, ≤7.0.9). GHSA-376h (`base` stripping, ≤7.2.3). GHSA-98hj (`<script>`/`<style>` children in JSX/MDX, <7.3.2). | **7.4.2** (`latest`, 2026-10-21) | 26w7 is not reachable: no `astro:assets`, no `<Image>`, no image config, so Astro never invokes sharp. The codec itself is removed by #347. 4g3v is not reachable: no View Transitions. 376h is not reachable: no `base`, no middleware, static output. 98hj is not reachable: no `.mdx` is compiled, because content comes from the Postgres loaders and `src/content/trips/*.mdx` is an export-only reference not matched by any loader. |
| devalue 5.8.1 (←astro) | eight advisories, ≤5.9.2 | 6.0.3 (astro 7.4.2 requires `^6.0.2`) | Build-time serialisation of trusted data only. |
| http-cache-semantics 4.2.0 (←astro) | GHSA-ch52 | 4.3.0 (astro requires `^4.3.0`) | Not reachable: no SSR cache. |
| js-yaml 4.3.0 (←astro, @astrojs/internal-helpers 0.10.1) | GHSA-5p4m, GHSA-2883 | **removed**: astro 7.4.2 and internal-helpers 0.13.0 depend on `yaml`, not `js-yaml`. If another path still resolves it, ≥4.3.2. | Frontmatter is not parsed. Content is loaded from Postgres. |
| smol-toml 1.7.0 | GHSA-7w5x, GHSA-r4xh | 1.9.1 (astro `^1.9.1`) | Not reachable: no TOML input. |
| svgo 4.0.1 (←astro) | GHSA-2p49, -4vpr, -w27v | 4.1.0 (astro `^4.1.0`) | Not reachable: Astro's SVG component path is unused, and uploaded SVG is rasterised by sharp. |
| zod 4.4.3 (←astro, rss, sitemap) | GHSA-mrhx | 4.6.7 | Build-time validation of loader rows, which are bounded (and author-controlled). |
| vite 8.1.3 (←astro, @tailwindcss/vite) | launch-editor ×3, GHSA-9jrq, GHSA-rq7h | 8.3.5 (astro `^8.3.4`) | Not reachable: the dev server never runs in production. |
| postcss 8.5.16, nanoid 3.3.15, source-map-js 1.2.1 (←vite, tailwind) | GHSA-fxqj, GHSA-r28c. nanoid GHSA-28wg, GHSA-2v37. source-map-js GHSA-68fv. | 8.5.32, 3.3.20, 1.2.2 (postcss 8.5.32 requires `nanoid ^3.3.20`, `source-map-js ^1.2.2`) | Build-time processing of the repo's own CSS. Authors cannot inject CSS: `style` is removed by the sanitiser (#124). |
| sharp 0.35.3 (optional ←astro) | as above | owned by #347. astro 7.4.2 declares `sharp ^0.35.4`, so the 0.35.5 lock from #347 stays valid. | |

### 2.3 Site devDependencies that ship in the image (owner decision §11 D3)

| Package | Advisory | Proposal |
| --- | --- | --- |
| vitest 4.1.9 / @vitest/mocker | GHSA-82fw, GHSA-qxg6 (<4.1.12) | Patch now to **^4.1.12** in both trees. Same major, test-only. |
| fast-uri 3.1.3 (←ajv←yaml-language-server←@astrojs/check) | five host-confusion/SSRF advisories (<3.1.6) | Refresh the lock within `ajv`'s `^3.0.1`. `@astrojs/check` is unchanged. Runs only under `astro check`. |
| happy-dom 20.11.1 | GHSA-834v (fix requires major 21) | **Document as not reachable and defer** to a separate issue. Only Vitest DOM tests load it. A major change to the test harness falls outside this issue's production scope. |
| postcss-selector-parser 6.0.10 (←@tailwindcss/typography 0.5.20, which pins `"6.0.10"` exactly; 0.5.20 is `latest`) | GHSA-rj75 (quadratic selector parsing) | **Document as not reachable; no override.** The only selectors parsed are the repo's own stylesheet (`global.css` `@plugin`). `npm audit fix` "fixes" this by **downgrading** typography to 0.5.4, which is why a blind `audit fix` is forbidden. |

## 3. Recommended dependency contract (exact)

Use targeted installs only. Never run `npm audit fix` or `npm update` without an argument. Every package
that moves in a lock diff must appear in this table or in §2, or the implementer backs it out.

**Uploader** (`uploader/package.json` + lock), applied after #347:

| Change | Range | Lock | Integrity (npm) |
| --- | --- | --- | --- |
| `fastify` | `^5.9.0` → `^5.12.7` | 5.12.7 | `sha512-v4pEPsTRPuqlDIYiQFB+BHjVN4SdHX9u0ABk0ZDUKbbdY1vsNryUd1j4Z+jQEZajvYIVk047Kimva9/AJ79GYw==` |
| `@fastify/static` (**major**) | `^9.1.3` → `^10.1.7` | 10.1.8 | `sha512-3CbgWOXJX8f46xxsuOgQl9h0lyQQiABMG40kxRF5PWJk4LyBW5m3mLZoW5glnm2TUTC1gVFCBnqOt5S6zIIIrg==` |
| `minimatch` / `brace-expansion` (transitive) | none | 10.2.6 / 5.0.12 | `sha512-vpLQ…4Ll1A==` / `sha512-YovQ…NEimQ==` |
| `vitest` (dev) | `^4.1.9` → `^4.1.12` | 4.1.12 | `sha512-5eWd…0NiWA==` |
| dev transitives (vite, postcss, nanoid, source-map-js) | none | as resolved by `npm update vite postcss nanoid source-map-js` | |
| required fastify/static transitives | upstream dependency ranges | `fast-json-stringify` 7.2.0 + its `fast-uri` 4.2.3; `@fastify/send` 4.2.0; nested `fastify-plugin` 6.0.1; `content-disposition` 3.0.0 | required by the approved new majors/ranges, not independent upgrades |
| required Vitest family | exact upstream pins | `@vitest/{expect,mocker,pretty-format,runner,snapshot,spy,utils}` 4.1.12 | matches vitest 4.1.12 |
| required Vite transitives | upstream dependency ranges | `picomatch` 4.0.7; `lightningcss` + platform packages 1.33.0; `rolldown` + platform bindings 1.2.15; `@oxc-project/types` 0.155.0 | Vite 8.3.5 requires these newer ranges; Rolldown no longer carries the WASI binding, removing its private `@emnapi/core`, `@emnapi/wasi-threads`, `@napi-rs/wasm-runtime`, `@tybys/wasm-util` and old nested `@emnapi/runtime` dependency chain |

Commands: `npm install fastify@^5.12.7 @fastify/static@^10.1.7 && npm install -D vitest@^4.1.12 && npm update minimatch brace-expansion vite postcss nanoid source-map-js`.
`@fastify/cookie` and `@fastify/multipart` do not move: they have no advisory, and @fastify/static 10's `fastify-plugin ^6` coexists with their `^5`.
`allowScripts` keeps #347's `"sharp@0.35.5"`. If `esbuild` moves, the `esbuild@<ver>` key is renamed to the exact new version, and nothing else changes.

Uploader implementation metadata recheck (2026-10-27): npm registry versions/integrities for
fastify 5.12.7, static 10.1.8, minimatch 10.2.6, brace-expansion 5.0.12 and vitest 4.1.12
agree with this contract. Fastify/static remain latest; Vitest latest is now 5.0.5, but this
approved same-major change stays on 4.1.12. The rebased pre-install audit reported 7 high
and 2 moderate findings across uploader production/dev dependencies (sharp already patched).
Required dependency-range changes are listed above; unrelated refreshes of chai, tinyrainbow
and @jridgewell/sourcemap-codec were backed out of the lock. This records metadata and intent,
not executed application, container or topology proof. #347's sharp 0.35.5 and required
@emnapi/runtime 1.11.3 resolution remain unchanged.

**Site** (`site/package.json` + lock):

| Change | Range | Lock | Why |
| --- | --- | --- | --- |
| `astro` | `^7.0.6` → `^7.4.2` | 7.4.2 | all four astro advisories; pulls patched devalue, http-cache-semantics, smol-toml, svgo, zod, vite and internal-helpers 0.13.0 (drops js-yaml) |
| `@astrojs/markdown-satteri` | `^0.3.3` → **`0.4.5` (exact)** | 0.4.5 | astro 7.4.2 pins `@astrojs/markdown-satteri: "0.4.5"` **exactly**. Keeping `^0.3.3` would install **two** copies: the build renders through 0.4.5 while `render-markdown.ts` (preview + publish gate) renders through 0.3.x. That silently breaks the build/preview parity that `render-markdown.ts` exists to guarantee. |
| `@astrojs/mdx` (**major**) | `^7.0.2` → `^8.1.1` | 8.1.1 | mdx 7.0.8 peers `@astrojs/markdown-satteri ^0.3.1`, which conflicts with 0.4.5. mdx 8 peers `astro ^7.2.10` and `markdown-satteri ^0.4.0`. Its only major change moves MDX compilation into the Markdown processor, and this site compiles no `.mdx`. |
| `shiki`, `@shikijs/themes` | `^4.3.1` → `^4.5.0` | 4.5.0 | internal-helpers 0.13.0 requires `shiki ^4.5.0`. Raising the direct deps keeps a single Shiki, so `shiki-classes.ts` builds `SHIKI_CSS` from the same theme object the highlighter uses. |
| `vitest` (dev) | `^4.1.9` → `^4.1.12` | 4.1.12 | §2.3 |
| transitive refresh | none | as resolved | `npm update devalue http-cache-semantics smol-toml svgo zod vite postcss nanoid source-map-js fast-uri js-yaml` |

`@astrojs/sitemap`, `@astrojs/rss`, `@tailwindcss/vite`, `tailwindcss` and `@astrojs/check` do not move. Their
ranges already admit the patched transitives.

Rejected alternatives:
- **`npm audit fix [--force]`**: it proposes a typography downgrade and an unreviewed major on @fastify/static.
- **Pinning fastify `<5.8.3`** to keep numeric trust working: that walks back into the schema, not-found and body-collision advisories.
- **Staying on @fastify/static 9.x**: no 9.x release fixes 83w8 or 8pvw.
- **An npm `overrides` entry for postcss-selector-parser**: it adds a forced cross-version edge for a finding that is not reachable.
- **Dropping the direct `@astrojs/markdown-satteri` dependency and importing Astro's copy**: that relies on hoisting, and npm does not guarantee it.

## 4. Recommended proxy-trust contract

### 4.1 Who is the socket peer? (the topology question)

The host proxy connects to `127.0.0.1:3000`, but **the container never sees `127.0.0.1`**.

- With Docker's default `userland-proxy: true`, `docker-proxy` accepts on host loopback and opens a
  new connection to the container from the **bridge network's gateway address** (`172.x.0.1` for an
  auto-allocated compose network). See [docker/docs#17312](https://github.com/docker/docs/issues/17312),
  where loopback `RemoteAddr` is replaced by the gateway IP.
- With `userland-proxy: false`, Docker DNATs loopback traffic and masquerades it out of the bridge.
  Its source is again the bridge's own address, the gateway.
  [INFERENCE] This rests on Docker's NAT design and is not stated on a docs page. §7 step 7 measures it on the server.
- Inside the container, `127.0.0.1` only ever means in-container processes (the compose healthcheck).
- Any other container on the compose network (`db`) arrives from its own container IP, never the gateway.
- Bare-host local dev (`npm run dev` on macOS or Linux) sees `127.0.0.1`/`::1` from the browser or a local proxy.

A loopback-only allow-list (`'127.0.0.1/8,::1'`, as suggested in the earlier SecurityGates handoff) is therefore
**rejected**. In production it fails closed with three symptoms:
- **Shared limiter buckets.** Every client gets `req.ip` = gateway, so the 10-per-15-min login bucket and
  the 5-per-15-min comment bucket become global. Any one client can lock every reader and the admin out.
- **No `Secure` flag.** `req.protocol` becomes `http`, so session cookies lose `Secure`.
- **GPX writes refused.** Every GPX mutation compares `https://…` against `http://…` and returns 403.

### 4.2 Contract

1. **New module `uploader/src/trusted-proxy.ts`** (pure, Node built-ins only):
   - `parseDefaultGateway(procNetRoute: string): string | null`. Parses Linux `/proc/net/route` and
     returns the IPv4 gateway of the single route with `Destination = 00000000`, `Mask = 00000000` and
     `Flags & 0x3 = 0x3` (RTF_UP|RTF_GATEWAY). The gateway hex is little-endian: `010012AC` →
     `172.18.0.1`. It returns `null` when no such route exists, when two default routes disagree, or
     when the gateway field is malformed.
   - `resolveTrustPolicy(mode: string | undefined, readRoute: () => string): TrustPolicy`, where
     `TrustPolicy = { trust: (address: string | undefined, hop: number) => boolean; describe: string }`.
     - `undefined`, or `'loopback'`: trusted peers = `127.0.0.0/8` and `::1`.
     - `'docker-gateway'`: loopback **plus** the discovered gateway as a single address. If
       `readRoute` throws or `parseDefaultGateway` returns `null`, it **throws**.
     - Any other value, **including the empty string**, throws. This follows the existing
       `ENCRYPTION_KEY` rule: omitted stays absent, an explicitly empty value is invalid.
   - `trust(address, hop)` returns `hop === 0 && address !== undefined && list.check(address, family)`,
     using one `net.BlockList`. BlockList matches IPv4-mapped `::ffff:a.b.c.d` against IPv4 rules,
     as `safe-fetch.ts:90` already relies on (verified on Node 26.12.1). The **`hop === 0` term
     preserves #108's "exactly one hop" invariant.** `req.ip` is the rightmost `X-Forwarded-For`
     entry when the socket peer is trusted. The walk never continues left, even when that entry
     happens to equal a trusted address.
2. **`ServerConfig.trustProxy: TrustPolicy['trust']` is a required field.** `buildServer` passes it
   to `Fastify({ trustProxy })`, and no default exists. tsc forces every construction site to choose,
   which closes the #206 failure class ("main.ts never passed the store").
   Tests share one `TEST_TRUST = resolveTrustPolicy(undefined, …).trust` helper.
   `gpx-private.integration.test.ts` migrates to it.
3. **`main.ts`** calls `resolveTrustPolicy(process.env.TRUSTED_PROXY, () => readFileSync('/proc/net/route', 'utf8'))`
   **before** constructing the server. On a throw it writes one line to stderr naming the variable
   and the problem, then exits non-zero. The line never includes headers or addresses beyond the
   gateway. On success it logs `trusted proxy peers: <describe>`, for example
   `loopback, 172.18.0.1 (container default gateway)`. A gateway address is not sensitive.
4. **`docker-compose.yml`** adds a **literal** to `app.environment`: `TRUSTED_PROXY: docker-gateway`.
   It is not `${…}` interpolation and does not go in `.env`. The policy lives in the same file that
   publishes `127.0.0.1:3000` and creates the bridge, so whoever changes one sees the other. The
   port-line comment is rewritten to drop "`trustProxy: 1`".
5. **`server.ts`'s `@ai-warning`** is rewritten around the address-validated rule. It states three
   things: never `true`; never a bare hop count or hop-only function; and a second proxy layer needs
   a new spec, not a number.
6. **Unchanged:**
   - `X-Forwarded-Host` stays unused. Code keeps reading `req.headers.host`, never `request.host`
     or `request.hostname`, because those would honour `X-Forwarded-Host` from a trusted peer.
   - The image mount's host constraint stays on the raw `Host`.
   - Limiter maps, limits, cookie attributes and the comment Origin check are unchanged.

### 4.3 Proxy requirements (documented, not enforced)

The host proxy MUST:
- forward the verbatim `Host` (already required);
- **overwrite** `X-Forwarded-Proto` with its own scheme;
- set `X-Forwarded-For` so the **rightmost** entry is the client it accepted, by appending or by
  overwriting. nginx: `proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;` and
  `proxy_set_header X-Forwarded-Proto $scheme;`. Caddy and Traefik do both by default.

If `X-Forwarded-For` is missing, every client collapses onto the gateway address (fail closed, a
DoS of the limiters). Step 7 of §7 detects this before cutover.

### 4.4 Alternatives considered

| Option | Verdict |
| --- | --- |
| `trustProxy: true` | Rejected (#108): trusts client-supplied entries. |
| Hop-only function `(a, hop) => hop < 1` | Rejected: this is exactly what GHSA-3m5p closes; upstream docs warn against it. |
| Loopback-only CIDR | Rejected (§4.1): wrong peer under Docker. |
| Pin the compose subnet and trust a literal gateway | Rejected as the default. It requires `docker compose down` to recreate the network, risks colliding with unknown host subnets, and duplicates the address in two places. |
| Trust the compose subnet or all of RFC1918 | Rejected: it trusts `db` and anything attached to the network. |
| `TRUSTED_PROXY` as a free CIDR list in `.env` | Rejected as the default. It grows `.env`, and the auto-allocated gateway is unknown until first `up`. It remains an option if the owner later runs the proxy as a container on a shared network (§11 D2). |
| Detect "in a container" automatically (`/.dockerenv`, cgroups) and trust the gateway | Rejected: implicit. On a bare Linux host the default gateway is the LAN router, and trusting it silently would be wrong. Explicit opt-in avoids that. |
| Derive the `Secure` flag from configured origins instead of `req.protocol` | Out of scope: it changes semantics for local plain-HTTP dev and is a separate design. |

### 4.5 Trust boundaries and misuse cases

| Actor / path | Peer seen | Result |
| --- | --- | --- |
| Internet → host proxy → `127.0.0.1:3000` → docker-proxy or NAT | gateway (trusted, hop 0) | `req.ip` = proxy-appended client; `protocol` = proxy's `X-Forwarded-Proto` |
| Client rotates a leftmost `X-Forwarded-For` through the proxy | gateway | rightmost unchanged → same bucket (pinned by test) |
| Client sends `X-Forwarded-For: <gateway IP>` through the proxy | gateway | rightmost is still the client; hop 1 is untrusted, so the walk stops |
| Compromised or co-tenant container on the compose network → `app:3000` with forged headers | its own container IP (untrusted) | headers ignored; own bucket; `http` → no `Secure`; GPX Origin mismatch → 403 |
| Any host-local process → `127.0.0.1:3000` | gateway (trusted) | **can forge headers**. The host is the trust boundary, as under #108. Accepted residual. |
| Docker direct routing enabled (`allow-direct-routing`, `gateway_mode=routed`) → container IP | the remote's own address | headers ignored (fail closed). Under hop count this was spoofable. |
| `network_mode: host` or any non-bridge network with `docker-gateway` | the LAN router could be "trusted" | **Invariant:** `docker-gateway` is valid only with the shipped bridge topology. Changing `network_mode` or `networks:` requires changing `TRUSTED_PROXY` and a spec update (written into the compose comment and SECURITY.md). |
| CDN or second proxy layer in front of the host proxy | gateway; rightmost `X-Forwarded-For` = CDN edge | all clients behind one edge share a bucket (fail closed). A CDN needs its own spec (§11 D2). |
| In-container healthcheck (`127.0.0.1`, no forwarded headers) | loopback | unaffected |

### 4.6 Invariants

- I1. `X-Forwarded-*` is honoured only when the immediate socket peer is in the boot-time allow-list.
  Only one hop is ever trusted.
- I2. Every unknown, empty or undiscoverable configuration refuses to boot. Nothing falls back to a
  broader trust set, and in Docker nothing falls back to a narrower one silently.
- I3. `TRUSTED_PROXY` unset ⇒ loopback-only. Tests, bare-host dev and older compose files behave as
  "no proxy".
- I4. `ServerConfig.trustProxy` is required. Nothing else in the code configures trust.
- I5. No route reads `X-Forwarded-Host`, `request.host` or `request.hostname`.

## 5. Why refuse boot rather than degrade (owner decision §11 D1)

The alternative to refusing boot is to fall back to loopback-only when the gateway cannot be discovered. That fallback:
- keeps the blog up;
- silently drops `Secure` from session cookies on an HTTPS site. A plain-HTTP request to the same host
  (an `:80` redirect vhost) would then carry `sid`;
- turns the limiters into global buckets.

`CLAUDE.md` says security and integrity failures MUST NOT fall back to weaker defaults, and a cookie
without `Secure` is weaker. The proposal therefore **refuses to boot**. Discovery reads a kernel file
that exists in every Linux container, so the failure means a misconfigured topology, not a transient
outage. `restart: unless-stopped` plus the single stderr line makes the failure obvious in
`docker compose logs`.

## 6. Compatibility

### 6.1 Fastify 5.9 → 5.12.7

Release notes 5.10.0–5.12.7 were reviewed. The changes that matter here:
- `request.port` is now derived from `request.host`. Unused here.
- HTTP `QUERY` method support was added. The `isMutation` wrapper treats any method other than
  GET/HEAD/OPTIONS as a mutation, so it fails safe.
- `callNotFound` runs the not-found preHandler regardless of registration order.
- Invalid content types now return `undefined` from the parser.
- Raw response header handling changed, and a `set-cookie` array is now copied.

None changes a documented contract here. The suites in §7 cover the not-found, cookie and upload paths.

### 6.2 @fastify/static 9 → 10 (major)

- **Breaking:** `setHeaders` receives the `FastifyReply`, not the raw `ServerResponse`. Only the image
  mount uses it (`server.ts:358`): `setHeaders: (res) => { res.setHeader('Access-Control-Allow-Origin', '*'); }`
  becomes `(reply) => { reply.header('Access-Control-Allow-Origin', '*'); }`. tsc flags the old
  form. At runtime it would throw on every image (`reply.setHeader` is not a function).
- In 10.1.8, `setHeaders` runs **after** `reply.headers(sendHeaders)` (`index.js:536-538`), so the
  ACAO header is kept. This also means a header set in `setHeaders` now wins over @fastify/send's
  own headers. The `server.ts` comments claiming that `cacheControl` overwrites a custom
  `setHeaders` (`:269-270`, `:346-347`) become stale and are corrected in PR-A. Behaviour does not
  change, because those mounts use `maxAge`/`immutable` and the `onSend` hook. The `/map/` MIME
  override stays in `onSend`, and the 206 handling is re-checked by the existing `/map/` range tests.
- `dotfiles` defaults to `'allow'` in both 9.1.3 and 10.1.8, so nothing changes. Tightening it is out of scope.
- 10.1.0 switched errors to `@fastify/error`. 10.1.7 serves files with `#` or `?` in their names.
  Variant keys cannot contain either (`assertSafeKey`).
- `allowedPath` is now evaluated on the normalised pathname and re-checked on the final path. This
  is stricter, and the existing `-orig`/`.part-` tests (`server.test.ts:298-309,346`) must stay green.

### 6.3 Astro 7.0.6 → 7.4.2, satteri 0.3.3 → 0.4.5, mdx 7 → 8

The Astro changelog (7.1–7.4.2) contains:
- minimum Node 22.22.0 (the image runs Node 26);
- the sharp ≥0.35.4 floor;
- the satteri 0.4 line;
- `<script>`/`<style>` escaping in MDX;
- the `glob()` loader no longer swallowing render errors (this site does not use `glob()`);
- the i18n fallback path fixes (no `fallback` is configured).

satteri 0.4.x moves `satteri` 0.9 → 0.10.x. It also fixes two things that touch output:
- fenced-code highlighting when raw HTML is enabled;
- `satteriHeadingIdsPlugin` sharing slugger state across documents, which could change heading
  `id`s for repeated heading texts.

Both touch the body-HTML render path. The `gallery` exclusion and `shikiStyleToClass` must survive,
and both are already pinned by existing suites. Heading-id changes may alter in-page anchors,
including Story Contents links, which are generated from the same render. No slugs or routes are
affected (Golden Rule 2).

## 7. Verification plan (all must pass; nothing here was run for this proposal)

0. **Re-check metadata.** Re-run `npm view <pkg> version dist.integrity` and the read-only
   `npm audit --json` in both trees on the rebased #347 head. Any new advisory or newer patch is
   recorded in the PR before installing.
1. **Lock review.** Read `git diff --stat` and the full lock diffs. Every moved package must be in
   §3 or §2 (with a reason). Then:
   - `npm ls @astrojs/markdown-satteri shiki` in `site/` shows exactly one copy of each.
   - `npm ls sharp` in both trees shows 0.35.5.
   - `npm audit --omit=dev` shows **0** in both trees.
   - Full `npm audit` in `site/` shows only happy-dom and postcss-selector-parser (§2.3).
2. **New permanent tests:**
   - `uploader/test/trusted-proxy.test.ts`:
     - `parseDefaultGateway` on a captured compose-container route table → `172.18.0.1`. It returns
       `null` for no default route, two conflicting defaults, a non-UP route, malformed hex and the header only.
     - `resolveTrustPolicy` covers unset, `'loopback'`, `'docker-gateway'` with a gateway,
       `'docker-gateway'` without one (throws), `''` (throws) and `'1'` (throws).
     - `trust` is true at hop 0 for `127.0.0.5`, `::1`, `::ffff:127.0.0.1`, the gateway and
       `::ffff:<gateway>`. It is false at hop 0 for `172.18.0.3`, `203.0.113.9` and `undefined`, and false at hop ≥1 for every address.
   - `uploader/test/server.test.ts`, using `inject({ remoteAddress })` with a gateway-trusting policy:
     - **Real client IP preserved.** From the gateway, `X-Forwarded-For: 10.0.0.1, 198.51.100.7`
       and then `10.0.0.2, 198.51.100.7` → the second request is 429. Rightmost `203.0.113.9` → its own bucket. This adapts the existing #108 test.
     - **Spoof refusal.** From `172.18.0.3` with a rotating `X-Forwarded-For`, every request
       shares the peer's bucket → 429 at the limit. `X-Forwarded-Proto: https` from that peer → `Set-Cookie` lacks `Secure`.
     - **Secure cookie.** From the gateway with `X-Forwarded-Proto: https`, `/setup` and `/login`
       set `Secure`. From the gateway without the header, they do not.
     - **One hop only.** From the gateway with `X-Forwarded-For: 203.0.113.9, 172.18.0.1` →
       `req.ip` is `172.18.0.1` and the walk stops. Observed through limiter bucket sharing with a direct gateway request.
   - `uploader/test/comments-public.test.ts`: the same trusted and untrusted pair for the
     `POST /comments` per-address limiter.
   - `uploader/test/gpx-private.integration.test.ts`: with the trusted peer and
     `X-Forwarded-Proto: https`, the Origin `https://journal.test` is accepted. With an untrusted
     peer and the same headers → 403. The existing `X-Forwarded-Host` refusal is kept.
   - `uploader/test/server.test.ts` (static): on the image host these return 404: `//<key>-orig.jpg`,
     `/./<key>-orig.jpg`, `/x/../<key>-orig.jpg`, `/x/%2e%2e/<key>-orig.jpg` and their `.part-`
     equivalents. A variant still returns 200 with `Access-Control-Allow-Origin: *`
     (`routing.test.ts:127`). Blog `/foo` → 301 `/foo/`; `/admin` → 301 `/admin/`.
   - `uploader/test/main-boot.integration.test.ts` (`TEST_DATABASE_URL`): booting the real
     `src/main.ts` with `TRUSTED_PROXY=bogus` exits non-zero with the named error. Unset, it boots,
     and over **real TCP** from `127.0.0.1` a forwarded `X-Forwarded-Proto: https` login sets `Secure`.
     This proves `main.ts` wires the policy into `buildServer`.
   - `site/src/lib/` lock test: `package-lock.json` contains exactly one
     `node_modules/@astrojs/markdown-satteri` entry. Its version equals
     `packages["node_modules/astro"].dependencies["@astrojs/markdown-satteri"]`, and the direct dependency
     in `package.json` equals it exactly. This catches the next Astro bump.
3. **Existing suites.** In uploader: `npx tsc --noEmit` and `npm test` with `TEST_DATABASE_URL`
   (full Postgres-backed). In site: `npm test`, `npx astro check` and `npm run build` against a
   disposable Postgres (CI). CI must be green on both jobs. Before the bump, CI was also green on the
   vulnerable locks, so a green run alone does not prove the fix.
4. **Render diff (site PR).** Build `dist/` on the CI fixture database at the baseline and at the
   PR head, then diff with `_astro/*` hashes normalised. Expected: no change in body HTML except the
   heading-`id`/highlighting fixes from §6.3, each listed in the PR. The owner repeats the diff on a
   **disposable restore** of a DB dump (never the live database), then checks published stories in both locales.
5. **Image.** Run `docker build .`. Then run #347's throwaway loaded-codec smoke inside the built
   image: `sharp.versions` heif ≥1.23.2 and rsvg ≥2.63.2 from both `/app/uploader` and `/app/site`.
   Also run `npm ls sharp`. Re-run it because the locks were regenerated. No permanent sharp guard is added.
6. **Serving smoke** on the built image with a disposable `/data` and a disposable Postgres:
   - the blog home and a story in DE and EN;
   - `/admin/` and the login page;
   - an image variant with ACAO, and `-orig` returning 404;
   - `/map/*` with a range request;
   - Publish of a fixture post (the build runs in-process);
   - draft preview and the publish gate refusing a foreign image.
7. **Topology check** on the target server before Phase 4. It uses no owner data, only the login
   endpoint with wrong passwords.
   - With the real host proxy, `docker compose logs app` shows
     `trusted proxy peers: loopback, 172.x.0.1 (container default gateway)`.
   - A browser login through HTTPS gets `Secure` on `sid`.
   - Two different client networks (for example, phone on mobile data and a laptop) get independent
     429 buckets after 10 bad logins from one.
   - Run `docker compose run --rm --no-deps --entrypoint node app -e "<fetch http://app:3000/login with X-Forwarded-For/X-Forwarded-Proto>"`
     from the compose network. Its bad logins share that container's bucket regardless of the
     forwarded headers, and any cookie lacks `Secure`. This is the spoof refusal across the Docker bridge.
   - Record the observed peer, and the `userland-proxy` setting from `docker info`, in the PR.

## 8. Dependency contracts and ordering

- **#347 lands first** as a lock-only sharp change in both trees. This issue rebases on it:
  - It changes no sharp range.
  - It keeps `allowScripts` `"sharp@0.35.5"`.
  - It re-runs #347's throwaway codec smoke (§7.5).

  If #369 were forced first, it would carry no sharp change, and #347 would regenerate its locks afterwards.
- **Split into two PRs** (§11 D4), each independently deployable from one image. Both ship in the
  same image, so whichever lands second rebases on the first.
  - **PR-A (uploader):** fastify, @fastify/static, the trust policy, compose, docs and tests.
  - **PR-B (site):** astro, mdx, satteri, shiki and the transitives. PR-B also changes uploader
    runtime behaviour (preview and publish gate import `render-markdown.ts`), so its uploader
    suites run too. PR-B does not depend on the proxy design and can be approved separately.
- **#319** (comment origin) and **#372** (rate-limit `return`) touch `comments-public.ts`,
  `server.ts` and `rate-limit.ts` near the same lines. The trust change is orthogonal: it changes
  only how `req.ip` and `req.protocol` are derived. Whichever lands later rebases, and the tests in
  §7.2 apply unchanged.
- **#72** (Traefik timeouts) and the Phase 4 cutover: step 7 runs during cutover preparation.

## 9. Documentation and SECURITY.md (part of PR-A; reconfirmation required)

- **`SECURITY.md:205`, `:287-289` and `:759-762`.** Replace "`trustProxy: 1` / one hop / raise to
  `2`" with the address-validated rule (I1–I3), the Docker-gateway explanation, the proxy
  requirements in §4.3 and the host-is-the-boundary residual.
- **`ARCHITECTURE.md` env table (`:685`).** Add a `TRUSTED_PROXY` row: compose literal, values,
  boot refusal.
- **`uploader/README.md` step 5 and `README.md:151`.** Add the proxy header requirements.
- **`docker-compose.yml` comments.**
- **`CLAUDE.md`.** Ports table note `(#108)` → `(#108, #369)`, plus a Done entry when merged.
- **Spec `2026-09-03-write-by-identity-and-trust-proxy-notes.md` §#108.** Add a superseded-by
  pointer to this spec. The historical text stays.

## 10. Rollback and containment

- **PR-A.** Redeploy the previous image by setting `IMAGE_TAG` back. No schema or data changes are
  involved, and an older image ignores `TRUSTED_PROXY`. The rollback re-exposes GHSA-3m5p. Containment
  while rolled back: the port stays loopback-only, so only host processes and compose-network peers
  can forge headers. If the new policy misbehaves in production, the symptoms are distinctive:
  everyone hits 429, `sid` has no `Secure`, and GPX writes return 403. There is deliberately no
  "trust more" escape hatch; the fix is the image rollback.
- **PR-B.** Use the previous image. Static output already published by the new toolchain keeps being
  served from `/data/site/current`. If the output itself is the problem, run **Rebuild site now**
  after the rollback.
- The locks are the source of truth. A revert commit restores the exact previous resolution, and
  `npm ci` reproduces it.

Any recovery image must retain #347's patched codec floors: the owner approved that upgrade
**roll-forward only**. The previous `0.17.1` image is therefore not an authorized rollback target.
If no suitable patched image exists, fix forward without weakening proxy or output-safety controls.

## 11. Owner decisions to batch

- **D1. A gateway that cannot be discovered under `docker-gateway`.** **Recommended:** refuse boot (§5).
  Alternative: boot loopback-only and log an error. This trades a weaker cookie and global limiter
  buckets for blog availability.
- **D2. Topology confirmation** (the repo cannot answer this). Recommended contract: one TLS proxy
  running in the **host** network namespace and connecting to `127.0.0.1:3000`, with **no** CDN or
  second proxy layer. If the cutover will put a CDN in front, or run the proxy as a container on a
  shared Docker network, the owner says so now. Either case needs an extra trusted source, such as
  the CDN's published ranges or the proxy container's address, which this spec does not define.
- **D3. Site devDependencies shipped in the image.** **Recommended:** patch vitest and fast-uri
  now; document happy-dom (major 21) and postcss-selector-parser as not reachable; open a follow-up
  for happy-dom. Alternative: include happy-dom 21 here.
- **D4. Split.** **Recommended:** PR-A (uploader) and PR-B (site) approved and merged separately,
  both after #347. Alternative: one combined PR.
- **D5. Configuration surface.** **Recommended:** a compose **literal** `TRUSTED_PROXY: docker-gateway`.
  It is not interpolated from `.env`, which keeps "do not grow `.env`". The owner confirms that this
  counts as bootstrap topology rather than an app setting. Alternatives: an interpolated
  `${TRUSTED_PROXY:-docker-gateway}`, or no variable plus automatic container detection (rejected in §4.4).
- **D6. @fastify/static lock version.** **Recommended:** range `^10.1.7`, lock 10.1.8. 10.1.8 is a
  docs-only delta with SLSA provenance, published 2026-10-27. Alternative: hold the lock at 10.1.7
  (2026-10-21) under a minimum-release-age policy.

### Approval record and workflow interpretation

- **Approver/date:** repository owner, interactive implementation session, 2026-10-27.
- **Evidence:** **“Approve documented host-proxy topology”**, linked to PR #404 at
  `fad862fff4e8fcba5fe4c8c6ccf558b3e65ac185`.
- The recommended security/dependency contract is approved, including D1/D2/D3/D5/D6.
- D4 is executed as one focused issue PR with separately reviewable uploader/site commits,
  following the owner's one-issue branch/worktree workflow; neither half is omitted.
- #347 must be the prerequisite; its roll-forward-only codec constraint applies here too.


## 12. Evidence sources

- Repository: `uploader/src/server.ts:173-189,338-390,2158`, `authn.ts:20`, `rate-limit.ts:101`,
  `comments-public.ts:129`, `gpx-routes.ts:57-67`, `main.ts:207`, `media-files.ts:14`,
  `safe-fetch.ts:85-110`, `site/src/lib/render-markdown.ts`, `site/astro.config.mjs`,
  `docker-compose.yml`, `Dockerfile:42-53`, `SECURITY.md:25-40,195-210,280-295,745-770`,
  the #108 notes spec, and both lockfiles.
- Fastify: [GHSA-3m5p](https://github.com/advisories/GHSA-3m5p-2c4r-xxw2), the
  [releases](https://github.com/fastify/fastify/releases) v5.10.0–v5.12.7, and the
  `fastify@5.12.7` tarball (`docs/Reference/Server.md` § trustProxy, `lib/request.js`).
- @fastify/static: the [releases](https://github.com/fastify/fastify-static/releases) v9.2.0–v10.1.8
  (v10.0.0 breaking `setHeaders`), GHSA-83w8, GHSA-8pvw, GHSA-r799, and the `@fastify/static@10.1.8`
  tarball (`index.js`, `README.md` § dotfiles).
- Astro: [GHSA-26w7](https://github.com/withastro/astro/security/advisories/GHSA-26w7-cxv4-gfx2),
  GHSA-4g3v, GHSA-376h and GHSA-98hj, plus `packages/astro`, `integrations/mdx` and
  `markdown/satteri` CHANGELOG.md on `withastro/astro@main`. npm metadata for `astro@7.4.2`
  (exact `@astrojs/markdown-satteri: "0.4.5"`) and `@astrojs/mdx@8.1.1` / `7.0.8` peers.
- npm registry `dist.integrity`, `time` and provenance for every target in §3 (read 2026-10-27).
- Docker: the [port publishing](https://docs.docker.com/engine/network/port-publishing/) docs and
  [docker/docs#17312](https://github.com/docker/docs/issues/17312) for the userland-proxy source address.
