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
