import { z } from 'astro/zod';
import { publicRunSchema } from './public-track.js';

/**
 * Strict public stop route (#513): `published_snapshot.stop_route`, entry field
 * `stopRoute`. The GPX track limits apply unchanged, but the shape and key are
 * its own, so it can never be mistaken for (or summarized as) a GPX track.
 * Mirrors `validatePublicStopRoute` in uploader/public/stop-route.js; the
 * shared-fixture test in public-stop-route.test.ts keeps both in step.
 * @ai-context docs/superpowers/specs/2026-11-03-issue-513-stop-routing-design.md
 */
export const publicStopRouteSchema = z.object({
  version: z.literal(1),
  runs: z.array(z.object({
    kind: z.enum(['road', 'straight']),
    coordinates: publicRunSchema,
  }).strict()).min(1).max(100),
}).strict().superRefine((route, ctx) => {
  if (route.runs.reduce((count, run) => count + run.coordinates.length, 0) > 2000) {
    ctx.addIssue({ code: 'custom', message: 'Public stop route vertex limit exceeded' });
  }
  // ASCII-only shape: compact JSON length equals its UTF-8 bytes.
  if (JSON.stringify(route).length > 64 * 1024) {
    ctx.addIssue({ code: 'custom', message: 'Public stop route byte limit exceeded' });
  }
});

export type PublicStopRoute = z.infer<typeof publicStopRouteSchema>;
