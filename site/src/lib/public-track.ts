import { z } from 'astro/zod';
import type { Locale } from '../i18n/ui.js';

const ordinate = (limit: number) => z.number().min(-limit).max(limit).refine(
  (value) => !Object.is(value, -0) && Number(value.toFixed(4)) === value,
  { message: 'Invalid public coordinate precision' },
);
const position = z.tuple([ordinate(180), ordinate(90)]);
const run = z.array(position).min(2).max(2000).refine(
  (positions) => positions.every((point, index) => index === 0
    || ((point[0] !== positions[index - 1]![0] || point[1] !== positions[index - 1]![1])
      && Math.abs(point[0] - positions[index - 1]![0]) <= 180)),
  { message: 'Invalid public run continuity' },
);

/** Strict public projection; never accepts or strips private GPX metadata. */
export const publicTrackSchema = z.object({
  version: z.literal(1),
  type: z.literal('MultiLineString'),
  coordinates: z.array(run).min(1).max(100),
}).strict().superRefine((track, ctx) => {
  if (track.coordinates.reduce((count, positions) => count + positions.length, 0) > 2000) {
    ctx.addIssue({ code: 'custom', message: 'Public track vertex limit exceeded' });
  }
  // This exact shape is ASCII-only, so compact JSON length equals its UTF-8 bytes.
  if (JSON.stringify(track).length > 64 * 1024) {
    ctx.addIssue({ code: 'custom', message: 'Public track byte limit exceeded' });
  }
});

export type PublicTrack = z.infer<typeof publicTrackSchema>;

/** Public-only distances: separate runs never contribute a gap to a length. */
export function publicTrackSummary(track: PublicTrack, locale: Locale) {
  const radians = Math.PI / 180;
  const distanceFormat = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const coordinate = ([lng, lat]: [number, number]) => `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
  return track.coordinates.map((positions) => {
    let metres = 0;
    for (let index = 1; index < positions.length; index++) {
      const [lng1, lat1] = positions[index - 1]!;
      const [lng2, lat2] = positions[index]!;
      const a = Math.sin((lat2 - lat1) * radians / 2) ** 2
        + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin((lng2 - lng1) * radians / 2) ** 2;
      metres += 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
    }
    return {
      distance: distanceFormat.format(metres / 1000),
      start: coordinate(positions[0]!),
      end: coordinate(positions[positions.length - 1]!),
    };
  });
}
