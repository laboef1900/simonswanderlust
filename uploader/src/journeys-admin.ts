import type { FastifyInstance, FastifyReply, preHandlerHookHandler } from 'fastify';
import { JourneyError, validateJourneyDraft, type JourneyStore, type StoredJourney } from './journeys.js';
import type { PostStore } from './posts.js';
import type { LanguageStore } from './language.js';
import type { SiteBuilder } from './build.js';
import { projectBuildReport, type BuildTrigger } from './build-state.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const conflicts: Record<string, true> = { conflict: true, duplicate_slug: true, slug_locked: true, slug_change_unconfirmed: true, story_in_other_journey: true, locale_published: true, journey_hero_not_ready: true };
interface Options { store: JourneyStore; posts: PostStore; language: LanguageStore; imageBase: string; builder: SiteBuilder; requireAuth: preHandlerHookHandler; requireAdmin: preHandlerHookHandler }
function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) throw new JourneyError('invalid_journey');
  return value as Record<string, unknown>;
}
function token(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new JourneyError('invalid_journey');
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw new JourneyError('invalid_journey');
  return date;
}

/** Registered on the ordinary app: ownership admission and tracked writes apply unchanged. */
export function registerJourneyAdmin(app: FastifyInstance, opts: Options): void {
  const { store, posts, language } = opts;
  const read = { preHandler: opts.requireAuth, bodyLimit: 64 * 1024 };
  const admin = { preHandler: opts.requireAdmin, bodyLimit: 64 * 1024 };
  const failure = (error: unknown, reply: FastifyReply) => {
    if (!(error instanceof JourneyError)) throw error;
    const code = error.code;
    return reply.code(code === 'not_found' ? 404 : conflicts[code] ? 409 : 400).send({ error: code, code,
      ...(error.locale ? { locale: error.locale } : {}), ...(error.owner ? { owner: error.owner } : {}) });
  };
  async function find(id: string, reply: FastifyReply) {
    const journey = UUID.test(id) ? await store.get(id) : null;
    if (!journey) reply.code(404).send({ code: 'not_found', error: 'not_found' });
    return journey;
  }
  async function summary(journey: StoredJourney) {
    const mode = await language.get();
    const live = { de: false, en: false };
    if (journey.status === 'published' && journey.publishedSnapshot) {
      const visible = await Promise.all(journey.publishedSnapshot.members.map(key => posts.getPublishedLocales(key)));
      for (const locale of mode.locales) live[locale] = !!journey.publishedSnapshot.locales[locale] && visible.some(locales => locales.includes(locale));
    }
    return { id: journey.id, titles: { de: journey.de.title, en: journey.en.title }, slugs: { de: journey.de.slug, en: journey.en.slug },
      status: journey.status, hasUnpublishedChanges: journey.hasUnpublishedChanges, memberCount: journey.members.length, live, updatedAt: journey.updatedAt };
  }
  function working(journey: StoredJourney) {
    // Serialize the committed result itself; no post-commit read can turn a
    // successful write into a misleading unacknowledged failure.
    return { id: journey.id, status: journey.status, updatedAt: journey.updatedAt,
      de: journey.de, en: journey.en, members: journey.members, hasUnpublishedChanges: journey.hasUnpublishedChanges };
  }
  async function detail(journey: StoredJourney) {
    const stories = new Map((await posts.list()).map(story => [story.translationKey, story]));
    return { ...await summary(journey), de: journey.de, en: journey.en, members: journey.members,
      memberStories: journey.members.map(key => ({ translationKey: key, title: stories.get(key)?.title ?? key, status: stories.get(key)?.status ?? 'draft' })) };
  }
  async function rebuilt(reply: FastifyReply, journey: StoredJourney, trigger: BuildTrigger) {
    // Store promise has committed and released its locks before the builder takes its work lock.
    const deleted = trigger === 'delete';
    const saved = deleted ? { id: journey.id, updatedAt: journey.updatedAt } : working(journey);
    const build = projectBuildReport(await opts.builder.build(trigger));
    return reply.send({ ...(deleted ? { deleted: true } : {}), saved, build });
  }
  app.get<{ Querystring: { member?: string } }>('/journey-admin', read, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    if (request.query.member !== undefined) {
      if (typeof request.query.member !== 'string' || !request.query.member || request.query.member.length > 200) return reply.code(400).send({ code: 'invalid_journey' });
      const claimed = await store.claiming(request.query.member);
      return claimed ? summary(claimed) : null;
    }
    return { journeys: await Promise.all((await store.list()).map(summary)) };
  });
  app.get<{ Params: { id: string } }>('/journey-admin/:id', read, async (request, reply) => {
    reply.header('cache-control', 'no-store');
    const journey = await find(request.params.id, reply); if (journey) return detail(journey);
  });
  app.post('/journey-admin', read, async (request, reply) => {
    try { const draft = validateJourneyDraft(request.body, opts.imageBase); return reply.code(201).send(working(await store.create(draft))); }
    catch (error) { return failure(error, reply); }
  });
  app.put<{ Params: { id: string } }>('/journey-admin/:id', read, async (request, reply) => {
    if (!await find(request.params.id, reply)) return;
    try {
      const body = object(request.body, ['baseUpdatedAt', 'de', 'en', 'members', 'confirmSlugChange']);
      if (body.confirmSlugChange !== undefined && typeof body.confirmSlugChange !== 'boolean') throw new JourneyError('invalid_journey');
      const base = token(body.baseUpdatedAt);
      const draft = validateJourneyDraft({ de: body.de, en: body.en, members: body.members }, opts.imageBase);
      return working(await store.save(request.params.id, draft, base, body.confirmSlugChange as boolean | undefined));
    } catch (error) { return failure(error, reply); }
  });
  app.post<{ Params: { id: string } }>('/journey-admin/:id/publish', admin, async (request, reply) => {
    if (!await find(request.params.id, reply)) return;
    try { const body = object(request.body, ['baseUpdatedAt']); return await rebuilt(reply, await store.publish(request.params.id, token(body.baseUpdatedAt)), 'publish'); }
    catch (error) { return failure(error, reply); }
  });
  app.post<{ Params: { id: string } }>('/journey-admin/:id/unpublish', admin, async (request, reply) => {
    if (!await find(request.params.id, reply)) return;
    try { if (request.body !== undefined) object(request.body, []); return await rebuilt(reply, await store.unpublish(request.params.id), 'unpublish'); }
    catch (error) { return failure(error, reply); }
  });
  app.delete<{ Params: { id: string } }>('/journey-admin/:id', admin, async (request, reply) => {
    if (!await find(request.params.id, reply)) return;
    try {
      if (request.body !== undefined) object(request.body, []);
      const removed = await store.remove(request.params.id);
      return removed.status === 'published' ? rebuilt(reply, removed, 'delete') : reply.send({ deleted: true, saved: { id: removed.id, updatedAt: removed.updatedAt } });
    } catch (error) { return failure(error, reply); }
  });
}
