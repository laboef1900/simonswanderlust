import type { FastifyReply } from 'fastify';
import { IdentityError } from '../../site/src/lib/site-identity.js';
import {
  isProviderId, isProviderKind, isRemoteKind, newProviderId,
  providerNameError, providerUrlError, resolveProvider, slotFor,
  type AiProvider, type AiProviderKind,
} from './ai-providers.js';
import { projectBuildReport } from './build-state.js';
import { validateCanonicalRoles } from './canonical-origin.js';
import { DEFAULT_DRAFTING_PROMPT } from './drafting-prompt.js';
import { LanguageError, validateLanguage } from './language.js';
import { NavigationError } from './navigation.js';
import { OnboardingError } from './onboarding.js';
import { encodeVariant, normalizeProcessOptions, probeImage, type ImageProbe } from './pipeline.js';
import { isPlainObject } from './request-guards.js';
import { routingEndpointUsable } from './routing-origins.js';
import { SecretsError } from './secrets.js';
import type { ServerContext } from './server-context.js';
import { SettingsError, validate as validateSettings, type Settings } from './settings.js';
import { IdentityConflictError } from './site-identity.js';
import { registerIdentityAssetRoutes } from './site-identity-routes.js';
import { DEFAULT_TRANSLATION_PROMPT } from './translation-prompt.js';
import { WIDTHS } from './variants.js';

export function registerSettingsRoutes(ctx: ServerContext): void {
  const { app, cfg, language, requireAuth, requireAdmin, routingInternalOrigins, storageDir, isWritable, validatePageImages } = ctx;

  let settingsTail = Promise.resolve();
  function settingsOperation<T>(operation: () => Promise<T>): Promise<T> {
    const result = settingsTail.then(operation);
    settingsTail = result.then(() => {}, () => {});
    return result;
  }

  function captionConfig(s: Settings, provider: AiProvider) {
    return {
      lmModel: s.lmModel, captionPrompt: s.captionPrompt,
      captionTimeoutMs: s.captionTimeoutMs, captionMaxEdge: s.captionMaxEdge,
      captionMaxTokens: s.captionMaxTokens,
      captionProvider: provider.kind, captionBaseUrl: provider.baseUrl,
    };
  }

  const ASSIGNMENTS = {
    translation: (s: Settings) => ({
      providerId: s.translationProviderId, model: s.translationModel, timeoutMs: s.translationTimeoutMs, prompt: s.translationPrompt,
    }),
    drafting: (s: Settings) => ({
      providerId: s.draftingProviderId, model: s.draftingModel, timeoutMs: s.draftingTimeoutMs, prompt: s.draftingPrompt,
    }),
  } as const;
  type AssignmentPurpose = keyof typeof ASSIGNMENTS;

  function assignmentConfig(s: Settings, purpose: AssignmentPurpose) {
    const assignment = ASSIGNMENTS[purpose](s);
    const provider = resolveProvider(s, assignment.providerId);
    return {
      provider,
      config: {
        providerId: provider.id, providerName: provider.name, providerKind: provider.kind,
        baseUrl: provider.baseUrl, model: assignment.model, timeoutMs: assignment.timeoutMs,
        prompt: assignment.prompt,
      },
    };
  }

  function sendAssignmentConfig(reply: FastifyReply, purpose: AssignmentPurpose) {
    const local = assignmentConfig(cfg.settings.get(), purpose);
    if (!isRemoteKind(local.provider.kind)) return reply.send({ ...local.config, apiKey: null });
    return settingsOperation(async () => {
      const { provider, config } = assignmentConfig(cfg.settings.get(), purpose);
      try {
        const apiKey = isRemoteKind(provider.kind) ? await cfg.secrets.get(slotFor(provider.id)) : null;
        return reply.send({ ...config, apiKey });
      } catch (e) {
        return reply.code(503).send(secretFailure(e));
      }
    });
  }

  type ProviderView = AiProvider & { hasApiKey: boolean };
  async function providerViews(providers: readonly AiProvider[], known = new Map<string, boolean>()): Promise<ProviderView[]> {
    const flags = await Promise.all(providers.map(async (p) =>
      isRemoteKind(p.kind) ? (known.get(p.id) ?? await cfg.secrets.has(slotFor(p.id))) : false,
    ));
    return providers.map((p, index) => ({
      id: p.id, name: p.name, kind: p.kind, baseUrl: p.baseUrl, hasApiKey: flags[index]!,
    }));
  }

  function settingsResponse(s: Settings, aiProviders: ProviderView[]) {
    return {
      aiProviders, aiDefaultProviderId: s.aiDefaultProviderId,
      reviewProviderId: s.reviewProviderId, captionProviderId: s.captionProviderId,
      aiModel: s.aiModel, reviewPrompt: s.reviewPrompt, reviewTimeoutMs: s.reviewTimeoutMs,
      translationProviderId: s.translationProviderId, translationModel: s.translationModel,
      translationTimeoutMs: s.translationTimeoutMs,
      translationPrompt: s.translationPrompt, translationPromptDefault: DEFAULT_TRANSLATION_PROMPT,
      draftingProviderId: s.draftingProviderId, draftingModel: s.draftingModel,
      draftingTimeoutMs: s.draftingTimeoutMs,
      draftingPrompt: s.draftingPrompt, draftingPromptDefault: DEFAULT_DRAFTING_PROMPT,
      lmModel: s.lmModel, captionPrompt: s.captionPrompt,
      captionTimeoutMs: s.captionTimeoutMs, captionMaxTokens: s.captionMaxTokens, captionMaxEdge: s.captionMaxEdge,
      backupSchedule: s.backupSchedule, backupRetention: s.backupRetention,
      convertJpeg: s.convertJpeg, webpQuality: s.webpQuality, avifQuality: s.avifQuality,
      importDelayMs: s.importDelayMs, importRetries: s.importRetries,
      commentsEnabled: s.commentsEnabled,
      geocodingSearchUrl: s.geocodingSearchUrl,
      routingCarUrl: s.routingCarUrl, routingBikeUrl: s.routingBikeUrl, routingFootUrl: s.routingFootUrl,
    };
  }

  function secretFailure(error: unknown) {
    const safe = error instanceof SecretsError ? error : new SecretsError('ai_secret_store_unavailable');
    return { error: safe.message, code: safe.code };
  }

  function checkCandidate(candidate: Settings, reply: FastifyReply): Settings | null {
    try {
      return validateSettings(candidate);
    } catch (e) {
      void reply.code(e instanceof SettingsError ? 400 : 500)
        .send({ error: e instanceof SettingsError ? e.message : 'Settings could not be read.' });
      return null;
    }
  }

  type KeyChange = { op: 'keep' } | { op: 'set'; value: string } | { op: 'remove' };
  function apiKeyChange(b: Record<string, unknown>, kind: AiProviderKind): KeyChange | string {
    if (!Object.hasOwn(b, 'apiKey')) return { op: 'keep' };
    const key = b.apiKey;
    if (key === null || key === '') return isRemoteKind(kind) ? { op: 'remove' } : { op: 'keep' };
    if (typeof key !== 'string' || /\p{C}/u.test(key)) return 'API key must be a string without control characters, or null.';
    if (!isRemoteKind(kind)) return 'Local LM Studio providers do not use an API key.';
    return { op: 'set', value: key };
  }

  async function commitAiChange(
    reply: FastifyReply, partial: Partial<Settings>, views: ProviderView[], status: 200 | 201,
    secret?: { slot: string; change: KeyChange; partialError: string },
  ) {
    const keyChange = secret && secret.change.op !== 'keep' ? secret : undefined;
    if (keyChange) {
      try {
        if (keyChange.change.op === 'set') await cfg.secrets.set(keyChange.slot, keyChange.change.value);
        else await cfg.secrets.delete(keyChange.slot);
      } catch (e) {
        return reply.code(503).send(secretFailure(e));
      }
    }
    let next: Settings;
    try {
      next = Object.keys(partial).length ? cfg.settings.update(partial) : cfg.settings.get();
    } catch {
      return reply.code(500).send(keyChange
        ? { code: 'settings_partial_failure', error: keyChange.partialError }
        : { code: 'settings_write_failed', error: 'Settings were not saved. Reload settings before retrying.' });
    }
    return reply.code(status).send(settingsResponse(next, views));
  }

  const findProvider = (s: Settings, id: unknown): AiProvider | undefined =>
    isProviderId(id) ? s.aiProviders.find((p) => p.id === id) : undefined;

  const KEY_PARTIAL = 'API key change saved, but settings were not saved. Reload settings before retrying.';
  const PROVIDER_NOT_FOUND = { error: 'AI provider not found.' };

  app.get('/onboarding', { preHandler: requireAdmin }, async () => {
    if (!cfg.onboarding) throw new Error('Onboarding state unavailable.');
    return cfg.onboarding.read();
  });

  app.post('/onboarding', { preHandler: requireAdmin, bodyLimit: 1024 }, async (req, reply) => {
    const body = req.body;
    if (!isPlainObject(body) || Object.keys(body).length !== 1 || !('action' in body)
      || (body.action !== 'dismiss' && body.action !== 'resume' && body.action !== 'finish')) {
      return reply.code(400).send({ error: 'invalid_onboarding_action' });
    }
    if (!cfg.onboarding) throw new Error('Onboarding state unavailable.');
    try { return await cfg.onboarding.act(body.action); }
    catch (error) {
      if (error instanceof OnboardingError) return reply.code(409).send({ error: error.code });
      throw error;
    }
  });

  app.get('/language', { preHandler: requireAuth }, async (_req, reply) => reply.send(await language.get()));

  app.put('/language', { preHandler: requireAdmin }, async (req, reply) => {
    try {
      if (!isPlainObject(req.body) || Object.keys(req.body).some((key) => key !== 'primary' && key !== 'locales')) {
        throw new LanguageError('Choose a supported language mode.');
      }
      const next = validateLanguage(req.body);
      let changed = false;
      const saved = await language.update(next, async (candidate, client) => {
        changed = true;
        return cfg.pages.prepareActivation(candidate, client, validatePageImages);
      });
      if (!changed) return reply.send(saved);
      const build = projectBuildReport(await cfg.builder.build('rebuild'));
      return reply.send({ ...saved, build });
    } catch (error) {
      if (error instanceof LanguageError) return reply.code(error.code === 'invalid_language' ? 400 : 409).send({
        code: error.code, error: error.message, ...(error.blockers ? { blockers: error.blockers } : {}),
        ...(error.owner ? { owner: error.owner } : {}),
      });
      throw error;
    }
  });

  app.get('/settings/navigation', { preHandler: requireAdmin }, async (_req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!cfg.navigation) return reply.code(503).send({ error: 'Navigation unavailable.' });
    return { ...await cfg.navigation.get(), socialLinks: cfg.identityStore?.get().identity.socialLinks ?? [] };
  });

  app.put('/settings/navigation', { preHandler: requireAdmin }, async (req, reply) => {
    reply.header('Cache-Control', 'no-store');
    if (!cfg.navigation) return reply.code(503).send({ error: 'Navigation unavailable.' });
    try {
      if (!isPlainObject(req.body)) throw new NavigationError('invalid_navigation');
      const body = req.body;
      if (Object.keys(body).some((key) => key !== 'config' && key !== 'updatedAt')) throw new NavigationError('invalid_navigation');
      const saved = await cfg.navigation.save(body.config, body.updatedAt);
      return { saved, build: projectBuildReport(await cfg.builder.build('rebuild')) };
    } catch (error) {
      if (error instanceof NavigationError) return reply.code(error.code === 'conflict' ? 409 : 400).send({ code: error.code, error: error.message });
      throw error;
    }
  });

  registerIdentityAssetRoutes(app, { store: cfg.identityStore, requireAdmin, workLock: cfg.workLock, storageDir, isWritable });

  app.get('/settings/identity', { preHandler: requireAdmin }, async (_req, reply) => {
    if (!cfg.identityStore) return reply.code(503).send({ error: 'Site identity unavailable.' });
    return { ...cfg.identityStore.get(), assets: cfg.identityStore.getAssetState(), locales: (await language.get()).locales };
  });

  app.put('/settings/identity', { preHandler: requireAdmin }, async (req, reply) => {
    if (!cfg.identityStore) return reply.code(503).send({ error: 'Site identity unavailable.' });
    try {
      if (!isPlainObject(req.body)) throw new IdentityError('identity');
      const body = req.body;
      if (Object.keys(body).some((key) => key !== 'revision' && key !== 'identity')) throw new IdentityError('identity');
      if (typeof body.revision !== 'number' || !Number.isInteger(body.revision) || body.revision < 1) throw new IdentityError('revision');
      if (!isPlainObject(body.identity)) throw new IdentityError('identity');
      validateCanonicalRoles(body.identity.canonicalOrigin, cfg);
      const saved = await cfg.identityStore.update(body.revision, body.identity);
      return { revision: saved.revision, savedAt: saved.savedAt, takesEffect: 'next_build' };
    } catch (error) {
      if (error instanceof IdentityError) return reply.code(400).send({ code: error.code, field: error.field, error: error.message });
      if (error instanceof IdentityConflictError) return reply.code(409).send({ code: error.code });
      throw error;
    }
  });

  app.get('/settings', { preHandler: requireAdmin }, async (_req, reply) => settingsOperation(async () => {
    const s = cfg.settings.get();
    let views: ProviderView[];
    try {
      views = await providerViews(s.aiProviders);
    } catch (e) {
      return reply.code(503).send(secretFailure(e));
    }
    return reply.send(settingsResponse(s, views));
  }));

  app.post('/settings', { preHandler: requireAdmin }, async (req, reply) => settingsOperation(async () => {
    if (!isPlainObject(req.body)) {
      return reply.code(400).send({ error: 'Settings must be a JSON object.' });
    }
    const b = req.body;
    if (Object.hasOwn(b, 'aiApiKey')) return reply.code(400).send({ error: 'API keys are managed per provider.' });
    if (Object.hasOwn(b, 'aiProviders')) return reply.code(400).send({ error: 'Providers are managed with /ai-providers.' });
    const partial: Record<string, unknown> = {};
    if (b.lmModel !== undefined) partial.lmModel = String(b.lmModel).trim();
    if (b.captionTimeoutMs !== undefined) partial.captionTimeoutMs = Number(b.captionTimeoutMs);
    if (b.captionMaxTokens !== undefined) partial.captionMaxTokens = b.captionMaxTokens;
    if (b.captionMaxEdge !== undefined) partial.captionMaxEdge = Number(b.captionMaxEdge);
    if (b.captionPrompt !== undefined) partial.captionPrompt = String(b.captionPrompt);
    if (b.backupSchedule !== undefined) partial.backupSchedule = String(b.backupSchedule);
    if (b.backupRetention !== undefined) partial.backupRetention = Number(b.backupRetention);
    if (b.importDelayMs !== undefined) partial.importDelayMs = Number(b.importDelayMs);
    if (b.importRetries !== undefined) partial.importRetries = Number(b.importRetries);
    if (b.convertJpeg !== undefined) partial.convertJpeg = b.convertJpeg;
    if (b.commentsEnabled !== undefined) partial.commentsEnabled = b.commentsEnabled;
    if (b.webpQuality !== undefined) partial.webpQuality = Number(b.webpQuality);
    if (b.avifQuality !== undefined) partial.avifQuality = Number(b.avifQuality);
    for (const field of [
      'aiDefaultProviderId', 'reviewProviderId', 'captionProviderId', 'aiModel', 'reviewPrompt', 'reviewTimeoutMs',
      'translationProviderId', 'translationModel', 'translationTimeoutMs', 'translationPrompt',
      'draftingProviderId', 'draftingModel', 'draftingTimeoutMs', 'draftingPrompt',
    ] as const) {
      if (Object.hasOwn(b, field)) partial[field] = b[field];
    }
    if (Object.hasOwn(b, 'geocodingSearchUrl')) partial.geocodingSearchUrl = b.geocodingSearchUrl;
    const routingFields = [['routingCarUrl', 'Car'], ['routingBikeUrl', 'Bike'], ['routingFootUrl', 'Foot']] as const;
    for (const [field] of routingFields) {
      if (Object.hasOwn(b, field)) partial[field] = b[field];
    }
    const next = checkCandidate({ ...cfg.settings.get(), ...partial }, reply);
    if (!next) return reply;
    for (const [field, label] of routingFields) {
      if (Object.hasOwn(partial, field) && next[field] !== '' && !routingEndpointUsable(next[field], routingInternalOrigins)) {
        return reply.code(400).send({ error: `${label} routing URL must use HTTPS unless its exact origin is listed in ROUTING_INTERNAL_ORIGINS.` });
      }
    }
    let views: ProviderView[];
    try {
      views = await providerViews(next.aiProviders);
    } catch (e) {
      return reply.code(503).send(secretFailure(e));
    }
    return commitAiChange(reply, partial, views, 200);
  }));

  app.post('/ai-providers', { preHandler: requireAdmin }, async (req, reply) => settingsOperation(async () => {
    if (!isPlainObject(req.body)) {
      return reply.code(400).send({ error: 'AI provider must be a JSON object.' });
    }
    const b = req.body;
    if (!isProviderKind(b.kind)) {
      return reply.code(400).send({ error: 'AI provider kind must be lm-studio, openrouter, deepseek, anthropic, openai, or custom.' });
    }
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    const baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim() : '';
    const invalid = providerNameError(name) ?? providerUrlError(baseUrl);
    if (invalid) return reply.code(400).send({ error: invalid });
    const change = apiKeyChange(b, b.kind);
    if (typeof change === 'string') return reply.code(400).send({ error: change });
    const current = cfg.settings.get();
    const provider: AiProvider = { id: newProviderId(current.aiProviders), name, kind: b.kind, baseUrl };
    const aiProviders = [...current.aiProviders, provider];
    if (!checkCandidate({ ...current, aiProviders }, reply)) return reply;
    let views: ProviderView[];
    try {
      views = await providerViews(aiProviders, change.op === 'set' ? new Map([[provider.id, true]]) : undefined);
    } catch (e) {
      return reply.code(503).send(secretFailure(e));
    }
    return commitAiChange(reply, { aiProviders }, views, 201, change.op === 'set'
      ? { slot: slotFor(provider.id), change, partialError: KEY_PARTIAL } : undefined);
  }));

  app.put('/ai-providers/:id', { preHandler: requireAdmin }, async (req, reply) => settingsOperation(async () => {
    const current = cfg.settings.get();
    const existing = findProvider(current, (req.params as Record<string, unknown>).id);
    if (!existing) return reply.code(404).send(PROVIDER_NOT_FOUND);
    if (!isPlainObject(req.body)) {
      return reply.code(400).send({ error: 'AI provider must be a JSON object.' });
    }
    const b = req.body;
    if (Object.hasOwn(b, 'kind') && b.kind !== existing.kind) {
      return reply.code(400).send({ error: 'A provider\'s kind cannot change.' });
    }
    const name = !Object.hasOwn(b, 'name') ? existing.name : typeof b.name === 'string' ? b.name.trim() : '';
    const baseUrl = !Object.hasOwn(b, 'baseUrl') ? existing.baseUrl : typeof b.baseUrl === 'string' ? b.baseUrl.trim() : '';
    const invalid = providerNameError(name) ?? providerUrlError(baseUrl);
    if (invalid) return reply.code(400).send({ error: invalid });
    const change = apiKeyChange(b, existing.kind);
    if (typeof change === 'string') return reply.code(400).send({ error: change });
    const aiProviders = current.aiProviders.map((p) => (p.id === existing.id ? { ...existing, name, baseUrl } : p));
    if (!checkCandidate({ ...current, aiProviders }, reply)) return reply;
    let views: ProviderView[];
    try {
      views = await providerViews(aiProviders, change.op === 'keep' ? undefined : new Map([[existing.id, change.op === 'set']]));
    } catch (e) {
      return reply.code(503).send(secretFailure(e));
    }
    return commitAiChange(reply, { aiProviders }, views, 200, { slot: slotFor(existing.id), change, partialError: KEY_PARTIAL });
  }));

  app.delete('/ai-providers/:id', { preHandler: requireAdmin }, async (req, reply) => settingsOperation(async () => {
    const current = cfg.settings.get();
    const existing = findProvider(current, (req.params as Record<string, unknown>).id);
    if (!existing) return reply.code(404).send(PROVIDER_NOT_FOUND);
    if (existing.id === current.aiDefaultProviderId) {
      return reply.code(409).send({ code: 'provider_is_default', error: 'The default AI provider cannot be deleted. Choose another default first.' });
    }
    const useCases: ('review' | 'caption' | 'translation' | 'drafting')[] = [];
    if (current.reviewProviderId === existing.id) useCases.push('review');
    if (current.captionProviderId === existing.id) useCases.push('caption');
    if (current.translationProviderId === existing.id) useCases.push('translation');
    if (current.draftingProviderId === existing.id) useCases.push('drafting');
    if (useCases.length) {
      return reply.code(409).send({ code: 'provider_in_use', error: 'This AI provider is assigned to a use case. Assign another provider first.', useCases });
    }
    const aiProviders = current.aiProviders.filter((p) => p.id !== existing.id);
    if (!checkCandidate({ ...current, aiProviders }, reply)) return reply;
    let views: ProviderView[];
    let hadKey: boolean;
    try {
      views = await providerViews(aiProviders);
      hadKey = isRemoteKind(existing.kind) && await cfg.secrets.has(slotFor(existing.id));
    } catch (e) {
      return reply.code(503).send(secretFailure(e));
    }
    return commitAiChange(reply, { aiProviders }, views, 200, hadKey ? {
      slot: slotFor(existing.id), change: { op: 'remove' },
      partialError: 'The provider\'s API key was removed, but the provider was not deleted. Reload settings before retrying.',
    } : undefined);
  }));

  app.get('/ai-providers/:id/credential', { preHandler: requireAdmin }, async (req, reply) => settingsOperation(async () => {
    const provider = findProvider(cfg.settings.get(), (req.params as Record<string, unknown>).id);
    if (!provider) return reply.code(404).send(PROVIDER_NOT_FOUND);
    if (!isRemoteKind(provider.kind)) return reply.send({ apiKey: null });
    try {
      return reply.send({ apiKey: await cfg.secrets.get(slotFor(provider.id)) });
    } catch (e) {
      return reply.code(503).send(secretFailure(e));
    }
  }));

  app.get('/ai-config', { preHandler: requireAuth }, async (req, reply) => {
    const purpose = (req.query as Record<string, unknown>).purpose;
    if (purpose === 'translation' || purpose === 'drafting') return sendAssignmentConfig(reply, purpose);
    if (purpose === 'caption') {
      const current = cfg.settings.get();
      const local = resolveProvider(current, current.captionProviderId);
      if (!isRemoteKind(local.kind)) return reply.send({ ...captionConfig(current, local), captionApiKey: null });
      return settingsOperation(async () => {
        const s = cfg.settings.get();
        const provider = resolveProvider(s, s.captionProviderId);
        try {
          const captionApiKey = isRemoteKind(provider.kind) ? await cfg.secrets.get(slotFor(provider.id)) : null;
          return reply.send({ ...captionConfig(s, provider), captionApiKey });
        } catch (e) {
          return reply.code(503).send(secretFailure(e));
        }
      });
    }
    if (purpose !== undefined) return reply.code(400).send({ error: 'Unknown AI configuration purpose.' });
    return settingsOperation(async () => {
      const s = cfg.settings.get();
      const caption = resolveProvider(s, s.captionProviderId);
      const review = resolveProvider(s, s.reviewProviderId);
      try {
        const aiApiKey = isRemoteKind(review.kind) ? await cfg.secrets.get(slotFor(review.id)) : null;
        return reply.send({
          ...captionConfig(s, caption), aiProvider: review.kind, aiBaseUrl: review.baseUrl, aiModel: s.aiModel,
          reviewPrompt: s.reviewPrompt, reviewTimeoutMs: s.reviewTimeoutMs, hasAiApiKey: aiApiKey !== null, aiApiKey,
        });
      } catch (e) {
        return reply.code(503).send(secretFailure(e));
      }
    });
  });

  let previewRunning = false;
  const PREVIEW_QUALITY_RE = /^\d{1,3}$/;
  const PREVIEW_MAX_WIDTH = Math.max(...WIDTHS);
  app.post('/settings/image-preview', { preHandler: requireAdmin }, async (req, reply) => {
    if (previewRunning) {
      return reply.code(429).send({ error: 'A preview is already running. Try again in a moment.' });
    }
    previewRunning = true;
    try {
      let buf: Buffer | undefined;
      let format = '';
      let quality = '';
      let invalidFileType = false;
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname === 'file') {
            if (part.mimetype && !part.mimetype.startsWith('image/')) {
              part.file.resume();
              invalidFileType = true;
            } else {
              buf = await part.toBuffer();
            }
          } else {
            part.file.resume();
          }
        } else if (part.fieldname === 'format') {
          format = String(part.value);
        } else if (part.fieldname === 'quality') {
          quality = String(part.value);
        }
      }
      if (format !== 'webp' && format !== 'avif') {
        return reply.code(400).send({ error: 'Format must be webp or avif.' });
      }
      const previewFormat: 'webp' | 'avif' = format;
      const q = PREVIEW_QUALITY_RE.test(quality) ? Number(quality) : NaN;
      if (!Number.isInteger(q) || q < 1 || q > 100) {
        return reply.code(400).send({ error: 'Quality must be a whole number from 1 to 100.' });
      }
      if (invalidFileType) return reply.code(400).send({ error: 'Could not read that image.' });
      if (!buf) return reply.code(400).send({ error: 'Choose an image to preview.' });
      const input = buf;
      let original: ImageProbe;
      try {
        original = await probeImage(input);
      } catch {
        return reply.code(400).send({ error: 'Could not read that image.' });
      }
      if (!original.width || !original.height) {
        return reply.code(400).send({ error: 'Could not read that image.' });
      }
      const width = Math.min(original.width, PREVIEW_MAX_WIDTH);
      const profile = normalizeProcessOptions(previewFormat === 'webp' ? { webpQuality: q } : { avifQuality: q });
      const encode = () => encodeVariant(input, width, previewFormat, profile);
      let data: Buffer;
      let encoded: ImageProbe;
      try {
        data = cfg.workLock ? await cfg.workLock.runShared(encode) : await encode();
        encoded = await probeImage(data);
      } catch {
        return reply.code(400).send({ error: 'Could not read that image.' });
      }
      return reply
        .type(previewFormat === 'webp' ? 'image/webp' : 'image/avif')
        .header('Cache-Control', 'no-store')
        .header('X-Preview-Width', String(encoded.width))
        .header('X-Preview-Height', String(encoded.height))
        .header('X-Original-Width', String(original.width))
        .header('X-Original-Height', String(original.height))
        .send(data);
    } finally {
      previewRunning = false;
    }
  });
}
