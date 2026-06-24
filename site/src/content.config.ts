import { defineCollection } from 'astro:content';
import { z } from 'astro/zod';
import { postgresTripsLoader } from './lib/postgres-loader';

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
      }),
      coordinates: z.object({ lat: z.number(), lng: z.number() }),
      stops: z.array(z.object({ name: z.string(), lat: z.number(), lng: z.number() })).optional(),
      route: z.string().optional(),
      keyFacts: z.record(z.string(), z.string()).optional(),
    }),
});

export const collections = { trips };
