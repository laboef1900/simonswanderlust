import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { postgresTripsLoader } from './lib/postgres-loader';
import { postgresPagesLoader } from './lib/pages-loader';

const trips = defineCollection({
  loader: postgresTripsLoader(),
  schema: () =>
    z.object({
      title: z.string(),
      date: z.coerce.date(),
      country: z.string(),
      countryCode: z.string().length(2),
      region: z.enum(['europe', 'north-america', 'south-america']),
      translationKey: z.string(),
      excerpt: z.string(),
      heroImage: z.object({
        src: z.url(),
        width: z.number().int().positive(),
        height: z.number().int().positive(),
        alt: z.string().min(1),
        format: z.literal('jpeg').optional(),
        // Optional by design: absent = centre crop, which is how every post
        // written before the field renders. `site/src/lib/images.ts`
        // re-clamps at the render boundary, because the WordPress importer
        // and a partial draft save both reach `posts.hero_image` without
        // passing through this schema.
        focus: z
          .object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) })
          .optional(),
      }),
      coordinates: z.object({ lat: z.number(), lng: z.number() }),
      stops: z.array(z.object({ name: z.string(), lat: z.number(), lng: z.number() })).optional(),
      route: z.string().optional(),
      keyFacts: z.record(z.string(), z.string()).optional(),
      // Optional, never defaulted: absent/undefined = not featured, so every
      // entry written before this field stays valid without a migration of
      // the content shape. It marks "use as the homepage cover"; uniqueness is
      // NOT enforced, because a unique flag would need a cross-post mutation
      // on every save. HomePage.astro takes the FIRST flagged entry of the
      // locale's newest-first set and falls back to the newest entry overall,
      // so zero flags and several flags both render something sensible.
      featured: z.boolean().optional(),
    }),
});

const pages = defineCollection({
  loader: postgresPagesLoader(),
  schema: () => z.object({ title: z.string() }),
});

export const collections = { trips, pages };
