import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { postgresTripsLoader } from './lib/postgres-loader';
import { postgresPagesLoader } from './lib/pages-loader';
import { regions } from './lib/paths';
import { publicTrackSchema } from './lib/public-track';
import { postgresJourneysLoader } from './lib/journeys-loader';

const storyImage = z.object({
  src: z.url(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  alt: z.string().min(1),
  format: z.literal('jpeg').optional(),
  focus: z.object({ x: z.number().min(0).max(100), y: z.number().min(0).max(100) }).optional(),
});

const trips = defineCollection({
  loader: postgresTripsLoader(),
  schema: () =>
    z.object({
      title: z.string(),
      date: z.coerce.date(),
      country: z.string(),
      countryCode: z.string().length(2),
      region: z.enum(regions),
      translationKey: z.string(),
      excerpt: z.string(),
      heroImage: storyImage,
      titleImage: storyImage.optional(),
      coordinates: z.object({ lat: z.number(), lng: z.number() }),
      stops: z.array(z.object({ name: z.string(), lat: z.number(), lng: z.number() })).optional(),
      route: z.string().optional(),
      track: publicTrackSchema.optional(),
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

const journeys = defineCollection({
  loader: postgresJourneysLoader(),
  schema: () => z.object({
    journeyId: z.uuid(),
    title: z.string().min(1).max(200),
    intro: z.string().max(2000).refine((value) => value.trim().length > 0),
    heroImage: storyImage.strict(),
    members: z.array(z.string().min(1)).max(50).refine((keys) => new Set(keys).size === keys.length),
  }).strict(),
});

export const collections = { trips, pages, journeys };
