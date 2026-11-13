import {
  SESSION_COOKIE, SESSION_TTL_MS,
  clearSessionCookie, isSecureRequest, setSessionCookie,
} from './authn.js';
import {
  DUMMY_STORED_HASH, MAX_PASSWORD_LENGTH, UserExistsError,
  passwordPolicyViolation, usernamePolicyViolation, verifyPassword,
} from './users.js';
import type { ServerContext } from './server-context.js';

export function registerAuthRoutes(ctx: ServerContext): void {
  const { app, cfg, requireAuth, requireAdmin, optionalAuth, limitAuth, accountLimiter, passwordLimiter } = ctx;
  const { users, sessions } = cfg;

  app.get('/login', (_req, reply) => reply.sendFile('login.html'));

  app.get('/auth/status', { preHandler: optionalAuth }, async (req) => {
    if (req.authUser) {
      return { authenticated: true, username: req.authUser.username, isAdmin: req.authUser.isAdmin, needsSetup: false };
    }
    return { authenticated: false, needsSetup: (await users.count()) === 0 };
  });

  app.get('/auth/me', { preHandler: requireAuth }, async (req) => {
    const user = req.authUser!;
    return { authenticated: true, userId: user.id, username: user.username, isAdmin: user.isAdmin, needsSetup: false };
  });

  let setupChain: Promise<unknown> = Promise.resolve();
  const withSetupLock = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = setupChain.then(fn, fn);
    setupChain = run.then(() => undefined, () => undefined);
    return run;
  };

  app.post('/setup', { preHandler: limitAuth }, async (req, reply) => withSetupLock(async () => {
    if ((await users.count()) > 0) return reply.code(409).send({ error: 'setup already complete' });
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = String(b.username ?? '').trim();
    const password = String(b.password ?? '');
    if (!username || !password) return reply.code(400).send({ error: 'username and password are required' });
    const violation = usernamePolicyViolation(username) ?? passwordPolicyViolation(password);
    if (violation) return reply.code(400).send({ error: violation });
    const user = await users.create({ username, password, isAdmin: true });
    const token = await sessions.create(user.id, SESSION_TTL_MS);
    setSessionCookie(reply, token, isSecureRequest(req));
    return reply.send({ username: user.username, isAdmin: user.isAdmin });
  }));

  app.post('/login', { preHandler: limitAuth }, async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = String(b.username ?? '').trim();
    const password = String(b.password ?? '');
    const user = await users.findByUsername(username);
    if (accountLimiter.isLocked(username)) {
      return reply.code(429).send({ error: 'account is temporarily locked due to excessive failed login attempts' });
    }
    const storedHash = user ? user.passwordHash : DUMMY_STORED_HASH;
    const isValid = verifyPassword(password, storedHash);
    if (!user || !isValid) {
      accountLimiter.recordFailure(username);
      return reply.code(401).send({ error: 'invalid username or password' });
    }
    accountLimiter.recordSuccess(username);
    const token = await sessions.create(user.id, SESSION_TTL_MS);
    setSessionCookie(reply, token, isSecureRequest(req));
    return reply.send({ username: user.username, isAdmin: user.isAdmin });
  });

  app.post('/logout', { preHandler: requireAuth }, async (req, reply) => {
    const token = req.cookies?.[SESSION_COOKIE];
    if (token) await sessions.destroy(token);
    clearSessionCookie(reply);
    return reply.send({ ok: true });
  });

  app.get('/users', { preHandler: requireAdmin }, async () => {
    const list = await users.list();
    return list.map((u) => ({ id: u.id, username: u.username, isAdmin: u.isAdmin, createdAt: u.createdAt }));
  });

  app.post('/users', { preHandler: requireAdmin }, async (req, reply) => {
    const b = (req.body ?? {}) as { username?: unknown; password?: unknown; isAdmin?: unknown };
    const username = String(b.username ?? '').trim();
    const password = String(b.password ?? '');
    const isAdmin = Boolean(b.isAdmin);
    if (!username || !password) return reply.code(400).send({ error: 'username and password are required' });
    const violation = usernamePolicyViolation(username) ?? passwordPolicyViolation(password);
    if (violation) return reply.code(400).send({ error: violation });
    try {
      const user = await users.create({ username, password, isAdmin });
      return reply.send({ id: user.id, username: user.username, isAdmin: user.isAdmin, createdAt: user.createdAt });
    } catch (e) {
      if (e instanceof UserExistsError) return reply.code(409).send({ error: 'username already exists' });
      throw e;
    }
  });

  app.delete('/users/:id', { preHandler: requireAdmin }, async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (req.authUser && req.authUser.id === id) return reply.code(409).send({ error: 'you cannot delete your own account' });
    const outcome = await users.remove(id);
    if (outcome === 'not_found') return reply.code(404).send({ error: 'user not found' });
    if (outcome === 'last_admin') return reply.code(409).send({ error: 'cannot remove the last admin' });
    await sessions.destroyAllForUser(id);
    return reply.send({ ok: true });
  });

  app.post('/users/me/password', { preHandler: [limitAuth, requireAuth] }, async (req, reply) => {
    const b = (req.body ?? {}) as { currentPassword?: unknown; newPassword?: unknown };
    const currentPassword = String(b.currentPassword ?? '');
    const newPassword = String(b.newPassword ?? '');
    if (!currentPassword || !newPassword) {
      return reply.code(400).send({ error: 'current and new password are required' });
    }
    const violation = passwordPolicyViolation(newPassword);
    if (violation) return reply.code(400).send({ error: `new ${violation}` });
    if (currentPassword.length > MAX_PASSWORD_LENGTH) return reply.code(400).send({ error: 'current password is incorrect' });
    const user = req.authUser ? await users.findById(req.authUser.id) : null;
    if (!user) return reply.code(401).send({ error: 'unauthorized' });
    if (passwordLimiter.isLocked(user.id)) {
      return reply.code(429).send({ error: 'too many failed attempts, please wait and try again' });
    }
    if (!verifyPassword(currentPassword, user.passwordHash)) {
      passwordLimiter.recordFailure(user.id);
      return reply.code(400).send({ error: 'current password is incorrect' });
    }
    passwordLimiter.recordSuccess(user.id);
    await users.setPassword(user.id, newPassword);
    await sessions.destroyAllForUser(user.id);
    const token = await sessions.create(user.id, SESSION_TTL_MS);
    setSessionCookie(reply, token, isSecureRequest(req));
    return reply.send({ ok: true });
  });
}
