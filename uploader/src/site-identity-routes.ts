import type { FastifyInstance, FastifyReply } from 'fastify';
import type { AuthGuard } from './authn.js';
import { IdentityConflictError, type SiteIdentityStore } from './site-identity.js';
import { IdentityAssetError, IDENTITY_UPLOAD_BYTES, normalizeIdentityUpload, type IdentityAssetGroup } from './site-identity-assets.js';
import { IdentityError } from '../../site/src/lib/site-identity.js';
import { diskSpace, insufficientSpace } from './disk.js';
import type { WorkLock } from './work-lock.js';
import { StorageReadOnlyError } from './storage-owner.js';

interface AssetRoutesOptions {
  store?: SiteIdentityStore;
  requireAdmin: AuthGuard;
  workLock?: WorkLock;
  storageDir: string;
  isWritable: () => boolean;
}
function groupOf(value: unknown): IdentityAssetGroup {
  if (value !== 'logo' && value !== 'favicon') throw new IdentityError('role');
  return value;
}
function revisionOf(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new IdentityError('revision');
  return value;
}
function failure(error: unknown, reply: FastifyReply) {
  if (error instanceof IdentityAssetError) return reply.code(error.status).send({ code: error.code });
  if (error instanceof IdentityConflictError) return reply.code(409).send({ code: error.code });
  if (error instanceof IdentityError) return reply.code(400).send({ code: error.code, field: error.field });
  const code = error && typeof error === 'object' && 'code' in error ? error.code : null;
  if (code === 'FST_FILES_LIMIT') return reply.code(413).send({ code: 'too_many_files' });
  if (code === 'FST_REQ_FILE_TOO_LARGE') return reply.code(413).send({ code: 'asset_too_large' });
  if (code === 'FST_FIELDS_LIMIT' || code === 'FST_PARTS_LIMIT' || code === 'FST_INVALID_MULTIPART_CONTENT_TYPE') {
    return reply.code(400).send({ code: 'image_invalid' });
  }
  throw error;
}

/** Assets share the identity revision but never write its text or mark onboarding complete. */
export function registerIdentityAssetRoutes(app: FastifyInstance, options: AssetRoutesOptions): void {
  const { store, requireAdmin } = options;
  app.put<{ Params: { role: string } }>('/settings/identity/assets/:role', { preHandler: requireAdmin }, async (req, reply) => {
    if (!store || !options.workLock) return reply.code(503).send({ code: 'identity_unavailable' });
    try {
      const group = groupOf(req.params.role);
      let bytes: Buffer | undefined;
      let revision: number | undefined;
      // Fully consume and validate multipart before encoding or mutating any row.
      for await (const part of req.parts({ limits: { files: 1, fileSize: IDENTITY_UPLOAD_BYTES, fields: 1, fieldSize: 32 } })) {
        if (part.type === 'file') {
          bytes = await part.toBuffer();
        } else {
          if (part.fieldname !== 'revision' || typeof part.value !== 'string' || !/^[1-9]\d*$/.test(part.value) || part.valueTruncated) throw new IdentityError('revision');
          revision = revisionOf(Number(part.value));
        }
      }
      if (!bytes?.length) throw new IdentityAssetError('image_invalid', 400);
      const upload = bytes;
      const expected = revisionOf(revision);
      if (store.get().revision !== expected) throw new IdentityConflictError();
      let space;
      try { space = await diskSpace(options.storageDir); }
      catch { console.error('identity asset: could not read free disk space; accepting upload.'); }
      if (space && insufficientSpace(space, bytes.length)) return reply.code(507).send({ code: 'insufficient_space' });
      const saved = await options.workLock.runShared(async () => {
        if (!options.isWritable()) throw new StorageReadOnlyError();
        const assets = await normalizeIdentityUpload(upload, group);
        if (!options.isWritable()) throw new StorageReadOnlyError();
        return store.replaceAssets(expected, group, assets);
      });
      return { revision: saved.revision, savedAt: saved.savedAt, takesEffect: 'next_build', assets: store.getAssetState() };
    } catch (error) { return failure(error, reply); }
  });
  app.delete<{ Params: { role: string } }>('/settings/identity/assets/:role', { preHandler: requireAdmin }, async (req, reply) => {
    if (!store) return reply.code(503).send({ code: 'identity_unavailable' });
    try {
      const group = groupOf(req.params.role);
      if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
        || Object.keys(req.body).some((key) => key !== 'revision')) throw new IdentityError('revision');
      const expected = revisionOf((req.body as Record<string, unknown>).revision);
      if (!options.isWritable()) throw new StorageReadOnlyError();
      const saved = await store.replaceAssets(expected, group, []);
      return { revision: saved.revision, savedAt: saved.savedAt, takesEffect: 'next_build', assets: store.getAssetState() };
    } catch (error) { return failure(error, reply); }
  });
}
