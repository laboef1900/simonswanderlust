# #356 — Remove exhaustive gallery work without changing the layout rule

**Status: OWNER APPROVED 2026-10-28 — exact optimizer plus yielding. Risk: High:** shared post-sanitize rendering on the Fastify event loop. Implementation and benchmark remain required; no photo cap, approximation, owner-data change or deployment is authorized.

## Decision requested

Approve an **exact, pruned partition search**, plus cooperative scheduling of its remaining work on request paths. Preserve the existing square/evenness selection and every accepted photo; do not impose a gallery-count cap, split a gallery into unrelated chunks, approximate the chosen row count, or change the 168px floor. The material engineering tradeoff is async renderer plumbing and bounded scheduling overhead instead of a new author-content restriction.

The issue's 100–400-photo timing evidence is accepted. Current `partitionRows` tries all `k = 1..n`, rebuilding an `O(k n²)` DP each time. `preview.ts` and `publish-gate.ts:analyzeBodyImages` run the transform in the same process that serves public pages. Restricting work to a guessed window near a square, or stopping after the first increasing height, has no proof of preserving the selected partition; neither is authorized here.

## Exact selection contract

For each legal row count, the existing objective is the contiguous partition minimizing `Σ(height − target(k))²`, where `target(k) = (width − (k−1)gap)/k`. Among those winners, choose the stacked height closest to width; equal distance keeps the smaller row count. Within a fixed count, preserve the existing predecessor iteration/tie rule. Height selection uses the current **uncapped** row heights; apply the existing proportional tall-row cap only after selection.

Retain order, multiplicity, all usable photos, full-width rows, the 12px gap, the 168px floor for multi-photo rows, singleton panorama exception and proportional portrait cap. Slider mode still does not partition. Use the current 1056/1112 design widths; the historical gallery specification's 800px example is not current authority.

## Algorithm and scheduling

1. Build ratio prefix sums once. Precompute only **legal contiguous row edges** `[start,end)` and their heights. A multi-photo row becomes permanently illegal as its end advances past the height floor (positive ratios increase the denominator while gaps reduce the numerator); stop that extension. Singleton rows remain allowed. The positive gap also bounds any legal multi-photo row length by a conservative `floor(width/gap)+1`, independent of gallery size. This is a mathematical pruning bound, not a photo cap.
2. Compute reachable row counts and minimum/maximum attainable stacked heights for each count over that same edge DAG, using rolling DP buffers. This costs `O(n² B)` worst-case, where `B` bounds legal row length, and provides a safe interval `[L[k], U[k]]` containing **every** legal partition's height for count `k`. Retain only final count bounds and required reachability data, not a second full parent matrix.
3. Evaluate feasible counts in ascending order. Once there is an incumbent, omit a count only when its interval's distance from the square cannot beat that incumbent. Near floating-point equality, evaluate rather than prune; a loose bound must never remove a potential winner. Do not assume the winner height is monotone in `k`.
4. For each surviving count, run the existing evenness objective over **legal edges and reachable prefix/suffix states only**, rather than all `m < i`; reuse prefix sums/edge heights and rolling cost buffers. Allocate predecessor storage for the current candidate, reconstruct only viable candidates, and retain only the best result. Keep comparisons/ties deterministic. This changes the unpruned worst case from `O(n⁴)` to `O(n³ B)` and typically discards most counts; **it is not a claim of linear worst-case time**.
5. That remaining exact search is still superlinear, so make its kernel resumable and yield after a fixed bounded number of edge/state operations (proposed starting quantum: **4096**), including precomputation/bounds work, not merely between complete galleries. Request-time preview and publication analysis must await a real event-loop yield (`setImmediate` through an injected scheduler), not `Promise.resolve()`/microtasks. Build-time callers can drain the same kernel without request scheduling. There is one optimizer, not separate approximate request/build layouts. The quantum changes scheduling only, never output or eligibility.

The kernel remains dependency-free and Astro/environment-free; the Node scheduler belongs at the uploader caller boundary. Thread the async completion through `justifiedRows`/`galleryNode`/`transformBodyImages`; use an awaited traversal, not an async callback passed to synchronous `unist-util-visit`. Migrate **all** callers/tests to await transformation: story/page loaders, preview and publish analysis. A clear render option supplies the request scheduler; no worker service, external queue, retry, request timeout policy, content cap or dependency is added.

Cooperative scheduling is not a substitute for reducing work: both pruning and yielding are required. It prevents a large exact search monopolizing the server; it does not promise that an arbitrarily large gallery completes instantly. Existing request-body admission limits remain unchanged. Exceptional work is never silently dropped or rendered with a different layout.

## Safety and integration

Keep gallery resolution/validation before partitioning: protocol and exact origin checks, positive integer dimensions, supported format, `String()` coercion of alt/caption and post-sanitize text escaping. No change to generated URL policy, source formats, EXIF privacy, preview CSP, captions, no-JS links, lightbox ordering or responsive stacking. Async continuations must operate on request-local arrays/trees; no shared mutable partition scratch state across concurrent renders.

Files: `site/src/lib/gallery-layout.ts`/tests and `body-images.ts`/tests; `postgres-loader.ts`, `pages-loader.ts`; `uploader/src/preview.ts`, `publish-gate.ts` and their tests. The issue directly motivates these consumers; no unrelated server workloads are moved. Coordinate async signatures with #358/#375/#378/#379. Update the existing gallery design spec and reconfirm `SECURITY.md` post-sanitize/request-time-rendering discussion, including the honest residual total-work bound.

## Required evidence after implementation

- Retain existing partition geometry tests. Compare exact row membership/caps against a test-only baseline oracle on deterministic small exhaustive and mixed-ratio corpora, both widths and invalid-ratio fallback cases. Include 1/2/37 photos, repeated images, panoramas/singleton-only legality, portrait-heavy sequences, floor-boundary intervals, ties and counts whose bound overlaps the square. Verify flattening returns every accepted photo in exact order.
- Test safe pruning itself: every excluded count has a bound that cannot improve the chosen score; a near-tie is evaluated. Exercise resumptions mid-precompute, mid-DP and reconstruction; synchronous drain and scheduled drain return identical output. Deterministic operation-count/yield-quantum assertions belong in CI, **not wall-clock thresholds**.
- Add a separate repeatable benchmark for 100/200/400 mixed 3:2/2:3 photos at both design widths, plus panorama-heavy and very thin-portrait sequences. Record warmup, Node version, timings, operation counts and peak memory for partition and the whole transform. Show substantial improvement over the supplied baseline; do not call the asymptotic change sufficient evidence on its own.
- Exercise an authenticated 400-photo preview and publication analysis while requesting an unrelated static page/image. Confirm the unrelated response completes before the partition finishes, and no multi-second partition-driven event-loop pause remains. Assert scheduler calls occur within the declared work quantum. Do not make CI depend on a fragile elapsed-milliseconds cutoff.
- Run affected site/uploader tests/typechecks and disposable preview/build checks after implementation. If exact pruning is insufficient on the specified benchmark, implementation is not accepted; do not silently swap to an approximate layout or cap photos.

## Recovery

No data/schema migration. Previous static releases remain valid; rebuild only through the normal admin flow. Revert the async renderer/caller cutover atomically if required; never leave an un-awaited Promise in rendered HTML. Reverting reopens the availability defect, so prefer a forward optimizer/scheduler correction. No owner photograph or gallery text may be removed to make preview responsive.

## Implementation and runtime evidence — 2026-10-28

Implemented the legal-edge DAG, minimum prefix/suffix row reachability, rolling attainable
height bounds and exact ascending-count objective search. Bounds use direct row sums (matching
final height selection); the objective retains original prefix subtraction and ascending
predecessors with strict `<`. Interval rejection has conservative floating-point slack and
evaluates ties/overlaps rather than pruning them. The kernel emits chunks of at most **4096**
accounted operations, with partial chunks at phase boundaries; yielding once per individual
edge was measured and discarded because generator overhead was unnecessarily expensive.

The standalone repeatable benchmark is `site/scripts/benchmark-gallery.ts`, run from `site/`:

```sh
node --import ../uploader/node_modules/tsx/dist/loader.mjs scripts/benchmark-gallery.ts
```

Node **v26.12.1**, Darwin arm64; one warmup per shape/width/size, then three measured runs.
Numbers below are medians in milliseconds, **partition / whole sanitized HTML transform**.
The transform includes HTML parsing/sanitization/emission, but not Markdown rendering.
The machine was shared with other backlog work; individual timings vary substantially and are
not CI thresholds. Operation counts are deterministic, independent of scheduling.

| Shape | Width | 100 photos | 200 photos | 400 photos | Operations at 100 / 200 / 400 |
|---|---:|---:|---:|---:|---:|
| mixed 3:2 / 2:3 | 1056 | 1.97 / 8.55 | 8.74 / 54.38 | 31.76 / 77.47 | 32,740 / 127,091 / 496,290 |
| mixed 3:2 / 2:3 | 1112 | 10.15 / 14.70 | 4.35 / 14.32 | 27.40 / 67.93 | 32,740 / 127,091 / 496,290 |
| panorama-heavy 10:1 / 3:2 | 1056 | 0.40 / 9.87 | 3.88 / 10.94 | 2.88 / 15.75 | 21,201 / 82,401 / 324,801 |
| panorama-heavy 10:1 / 3:2 | 1112 | 0.15 / 3.47 | 1.03 / 10.72 | 3.47 / 49.90 | 21,201 / 82,401 / 324,801 |
| thin portraits 1:50 | 1056 | 23.85 / 30.02 | 364.97 / 283.34 | 307.50 / 417.22 | 313,631 / 1,385,029 / 5,633,655 |
| thin portraits 1:50 | 1112 | 10.85 / 23.31 | 46.46 / 45.25 | 579.17 / 641.77 | 324,551 / 1,458,139 / 5,955,951 |

The mixed 400-photo column transform falls from the issue's **9712ms** to **77.47ms median**
(different runs/hardware conditions, not a controlled paired speedup). The benchmark's
process-wide cumulative peak RSS was **177,936 KiB**; this includes the renderer and previous
cases and is not an isolated per-gallery allocation measurement. Raw trials retain heap-used
snapshots and cumulative peak RSS. The largest tabulated thin-portrait transform trial was
1296.77ms: total latency is not bounded by one quantum and is not claimed to be linear.

A final-source repeat (`benchmark-gallery-final.jsonl`) additionally asserts every kernel
chunk is positive and at most **4096 operations**; all 18 cases passed, with a 4096 maximum.
The mixed 400-photo gallery emitted **125 chunks**, matching the observed request scheduler
calls. Final 400-photo medians (partition / transform): mixed **25.87 / 34.55ms** column and
**20.37 / 46.77ms** breakout; thin **292.78 / 366.45ms** column and **280.16 / 355.61ms** breakout.
Its cumulative process peak was **183,632 KiB**. The optional kernel candidate inspector is
used only by oracle tests to judge every excluded count against that count's original-DP
winner; production drivers do not collect candidate records.

Actual production-composition runtime proof used the isolated `swl_356_dev` database on
disposable PostgreSQL 18, port **33456**, generated landscape/portrait uploads encoded by the
real queue, and an authenticated admin. A 400-photo mixed gallery (repeated photos intentionally
preserved) returned preview **200**, 400 figures, **1169.34ms**. Publication returned **200** with
`published: true` and a successful real Astro release build (**10217.59ms**, build included);
the resulting public page returned **200** with all 400 figures.

A temporary observer wrapped the actual Node `setImmediate`, preserving its implementation,
and initiated an unrelated static HTTP request on the first renderer yield:

- Preview: **125** scheduler calls; static **200** completed at call **17**, before the last
  partition yield. First-to-last yields: **331.32ms**; largest observed gap: **41.72ms**.
- Publication (both locales): **250** calls; static **200** completed at call **13**, before
  the last partition yield. First-to-last yields: **346.08ms**; largest gap **115.96ms** includes
  work between locale transforms, not solely one optimizer quantum.
- App cumulative peak RSS: **217,504 KiB**. All services used for proof were stopped.

The first observer attempt used the mutable process image-origin environment value and its
static fetch failed; it is retained as failed evidence, **not** claimed as an interleaving
success. The final observer explicitly targeted the assigned listener `127.0.0.1:33456`.
Raw local evidence: `.issue-runtime/benchmark-gallery.jsonl`, `.issue-runtime/benchmark-gallery-final.jsonl`,
`.issue-runtime/runtime-http.json`, `.issue-runtime/runtime-scheduling.json`, and
`.issue-runtime/runtime-scheduling-failed-origin.json`.

Regression coverage adds a frozen original-DP oracle, exhaustive small sequences, deterministic
mixed/portrait/floor/tie/fallback corpora, operation-count and phase/resumption invariants,
concurrent request isolation, slider bypass and awaited multi-gallery output. Automated suites
and typechecks are intentionally left to the integration owner after handoff; the runtime proof
above is observed evidence, not a claim that those suites have run.

**Residual bounds:** O(n³ B) worst-case total work, O(n² B) bound construction, O(n² + nB)
optimizer memory. Native allocation/GC and the surrounding Markdown/sanitize/HTML pipeline are
not preemptible by the partition scheduler. The quantum bounds accounted optimizer work,
not wall-clock milliseconds or arbitrary author-content latency.
