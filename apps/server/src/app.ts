import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import {
  CloseCode,
  CreateCampaignBody,
  JoinCampaignBody,
  LoginBody,
  PairDisplayBody,
  RegisterBody,
  type NewDisplay,
  type ServerConfig,
  type User,
} from '@dnd/protocol';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { DB } from './db';
import { Hub } from './hub';
import { hashPassword, normalizeCode, verifyPassword } from './security';
import { Store } from './store';
import { MAX_UPLOAD_BYTES, UPLOAD_MIME_TYPES, sniffImage } from './uploads';

export interface AppOptions {
  db: DB;
  /** Where uploaded images are written; served under /files/. */
  uploadsDir: string;
  /** Built web client to serve (apps/web/dist). Omitted in dev, where Vite serves it. */
  webDist?: string;
  /** Required to register when set, so an internet-facing server isn't open to strangers. */
  signupCode?: string;
  /** Set when served over HTTPS. */
  secureCookies?: boolean;
  logger?: boolean;
}

const SESSION_COOKIE = 'dnd_session';

class HttpError extends Error {
  constructor(
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
  }
}

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? 'Invalid request');
  return result.data;
}

export async function buildApp(opts: AppOptions) {
  const app = Fastify({ logger: opts.logger ?? false });
  const store = new Store(opts.db);
  const hub = new Hub(store);
  app.addHook('onClose', async () => hub.close());

  mkdirSync(opts.uploadsDir, { recursive: true });

  await app.register(cookie);
  // Uploads arrive as the raw request body (fetch(url, { body: file })), no multipart needed.
  app.addContentTypeParser(
    [...UPLOAD_MIME_TYPES, 'application/octet-stream'],
    { parseAs: 'buffer', bodyLimit: MAX_UPLOAD_BYTES },
    (_req, body, done) => done(null, body),
  );
  await app.register(fastifyStatic, {
    root: opts.uploadsDir,
    prefix: '/files/',
    decorateReply: false,
    immutable: true,
    maxAge: '365d',
  });
  await app.register(websocket, { options: { maxPayload: 64 * 1024 } });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    reply.status(status).send({ error: status >= 500 ? 'Something went wrong' : err.message });
  });

  function currentUser(req: FastifyRequest): User | undefined {
    const token = req.cookies[SESSION_COOKIE];
    return token ? store.userForSession(token) : undefined;
  }

  function requireUser(req: FastifyRequest): User {
    const user = currentUser(req);
    if (!user) throw new HttpError(401, 'Not signed in');
    return user;
  }

  function requireGm(req: FastifyRequest, campaignId: string): User {
    const user = requireUser(req);
    if (store.roleIn(campaignId, user.id) !== 'gm') throw new HttpError(403, 'Only the GM can do that');
    return user;
  }

  function startSession(reply: FastifyReply, userId: string): void {
    const { token, expiresAt } = store.createSession(userId);
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: opts.secureCookies ?? false,
      expires: expiresAt,
    });
  }

  // ---------- meta ----------

  app.get('/api/health', async () => ({ ok: true }));
  app.get('/api/config', async (): Promise<ServerConfig> => ({ signupCodeRequired: Boolean(opts.signupCode) }));

  // ---------- auth ----------

  app.post('/api/auth/register', async (req, reply) => {
    const body = parse(RegisterBody, req.body);
    if (opts.signupCode && body.signupCode !== opts.signupCode) throw new HttpError(403, 'Wrong signup code');
    const user = store.createUser(body.username, body.displayName, await hashPassword(body.password));
    if (!user) throw new HttpError(409, 'That username is taken');
    startSession(reply, user.id);
    return { user };
  });

  app.post('/api/auth/login', async (req, reply) => {
    const body = parse(LoginBody, req.body);
    const found = store.findUserForLogin(body.username);
    if (!found || !(await verifyPassword(body.password, found.passwordHash))) {
      throw new HttpError(401, 'Wrong username or password');
    }
    startSession(reply, found.id);
    const { passwordHash: _, ...user } = found;
    return { user };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const token = req.cookies[SESSION_COOKIE];
    if (token) store.deleteSession(token);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => ({ user: currentUser(req) ?? null }));

  // ---------- campaigns ----------

  app.get('/api/campaigns', async (req) => store.campaignsForUser(requireUser(req).id));

  app.post('/api/campaigns', async (req) => {
    const user = requireUser(req);
    const { name } = parse(CreateCampaignBody, req.body);
    const campaign = store.createCampaign(name, user.id);
    return { id: campaign.id };
  });

  app.post('/api/campaigns/join', async (req) => {
    const user = requireUser(req);
    const { inviteCode } = parse(JoinCampaignBody, req.body);
    const campaign = store.findCampaignByInvite(normalizeCode(inviteCode));
    if (!campaign) throw new HttpError(404, 'No campaign with that invite code');
    if (store.addPlayer(campaign.id, user.id)) hub.membersChanged(campaign.id);
    return { id: campaign.id };
  });

  // ---------- uploads ----------

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/files', async (req) => {
    requireGm(req, req.params.id);
    if (!Buffer.isBuffer(req.body)) throw new HttpError(415, 'Upload a PNG, JPEG, WebP or GIF image');
    const kind = sniffImage(req.body);
    if (!kind) throw new HttpError(415, 'Upload a PNG, JPEG, WebP or GIF image');
    const id = randomUUID();
    const filename = `${id}.${kind.ext}`;
    await writeFile(path.join(opts.uploadsDir, filename), req.body);
    store.addFile({ id, campaignId: req.params.id, filename, mime: kind.mime, bytes: req.body.length });
    return { id, url: `/files/${filename}` };
  });

  // ---------- table displays ----------

  app.post('/api/displays', async (): Promise<NewDisplay> => {
    const { display, token } = store.createDisplay();
    return { id: display.id, token, code: display.code };
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/displays', async (req) => {
    requireGm(req, req.params.id);
    const { code } = parse(PairDisplayBody, req.body);
    const display = store.unpairedDisplayByCode(normalizeCode(code));
    if (!display) throw new HttpError(404, 'No waiting display with that code');
    store.pairDisplay(display.id, req.params.id);
    hub.pairDisplay(display.id, req.params.id);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; displayId: string } }>(
    '/api/campaigns/:id/displays/:displayId',
    async (req) => {
      requireGm(req, req.params.id);
      const code = store.unpairDisplay(req.params.displayId, req.params.id);
      if (!code) throw new HttpError(404, 'Display not found');
      hub.unpairDisplay(req.params.displayId, req.params.id, code);
      return { ok: true };
    },
  );

  // ---------- realtime ----------

  app.get<{ Querystring: { campaign?: string; display?: string } }>(
    '/ws',
    { websocket: true },
    (socket, req) => {
      if (req.query.display) {
        const display = store.displayForToken(req.query.display);
        if (!display) return socket.close(CloseCode.Unauthorized, 'Unknown display');
        return hub.attachDisplay(socket, display);
      }
      const user = currentUser(req);
      if (!user) return socket.close(CloseCode.Unauthorized, 'Not signed in');
      const campaignId = req.query.campaign ?? '';
      const role = store.roleIn(campaignId, user.id);
      if (!role) return socket.close(CloseCode.Forbidden, 'Not a member of this campaign');
      hub.attachUser(socket, user, campaignId, role);
    },
  );

  // ---------- web client ----------

  if (opts.webDist && existsSync(opts.webDist)) {
    await app.register(fastifyStatic, { root: opts.webDist, wildcard: false });
    // Client-side routes (/c/:id, /table, ...) all load the SPA shell.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      reply.status(404).send({ error: 'Not found' });
    });
  }

  return app;
}
