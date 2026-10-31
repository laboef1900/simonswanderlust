/** Run from site: node --import ../uploader/node_modules/tsx/dist/loader.mjs scripts/benchmark-gallery.ts */
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { COLUMN_WIDTH, BREAKOUT_WIDTH, PARTITION_WORK_QUANTUM, partitionRows, partitionRowWork } from '../src/lib/gallery-layout.js';
import { STORY_BODY_SIZES, transformBodyImages } from '../src/lib/body-images.js';

const origin = 'http://127.0.0.1:33456';
const repeats = 3;
console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, warmups: 1, repeats, memory: 'process.resourceUsage().maxRSS: cumulative process peak KiB' }));
for (const shape of ['mixed', 'panorama', 'thin'] as const) {
  for (const width of [COLUMN_WIDTH, BREAKOUT_WIDTH]) {
    for (const count of [100, 200, 400]) {
      const ratios = Array.from({ length: count }, (_, i) => shape === 'mixed' ? (i % 3 ? 1.5 : 2 / 3) : shape === 'panorama' ? (i % 3 ? 10 : 1.5) : 0.02);
      const images = Object.fromEntries(ratios.map((ratio, i) => [`${origin}/trips/bench/p${i}`, { width: Math.round(ratio * 6000), height: 6000 }]));
      const html = `<pre><code class="language-gallery">#layout: ${width === COLUMN_WIDTH ? 'column' : 'breakout'}\n${Object.keys(images).join('\n')}</code></pre>`;
      partitionRows(ratios, width);
      await transformBodyImages(html, images, origin, { locale: 'en', inlineSizes: STORY_BODY_SIZES });
      const partitionMs: number[] = [];
      const transformMs: number[] = [];
      for (let repeat = 0; repeat < repeats; repeat++) {
        let start = performance.now();
        partitionRows(ratios, width);
        partitionMs.push(performance.now() - start);
        start = performance.now();
        await transformBodyImages(html, images, origin, { locale: 'en', inlineSizes: STORY_BODY_SIZES });
        transformMs.push(performance.now() - start);
      }
      let operations = 0;
      let chunks = 0;
      let maxChunkOperations = 0;
      for (const work of partitionRowWork(ratios, width)) {
        assert.ok(work.operations > 0 && work.operations <= PARTITION_WORK_QUANTUM);
        operations += work.operations;
        maxChunkOperations = Math.max(maxChunkOperations, work.operations);
        chunks++;
      }
      console.log(JSON.stringify({ shape, width, count, operations, chunks, maxChunkOperations, partitionMs, transformMs, peakRssKiB: process.resourceUsage().maxRSS, heapUsedBytes: process.memoryUsage().heapUsed }));
    }
  }
}
