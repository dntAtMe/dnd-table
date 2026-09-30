import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '@dnd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from './app';
import { openDb } from './db';

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let base: string;
let uploadsDir: string;

beforeEach(async () => {
  uploadsDir = mkdtempSync(path.join(tmpdir(), 'dnd-table-test-'));
  app = await buildApp({ db: openDb(':memory:'), uploadsDir });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await app.close();
  rmSync(uploadsDir, { recursive: true, force: true });
});

class Client {
  cookie = '';

  async call<T = any>(method: string, path: string, body?: unknown): Promise<{ status: number; data: T }> {
    const raw = body instanceof Uint8Array;
    const res = await fetch(`http://${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': raw ? 'application/octet-stream' : 'application/json' }),
        cookie: this.cookie,
      },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    return { status: res.status, data: (await res.json()) as T };
  }

  static async register(username: string, displayName = username): Promise<Client> {
    const c = new Client();
    const res = await c.call('POST', '/api/auth/register', { username, displayName, password: 'correct horse' });
    expect(res.status).toBe(200);
    return c;
  }

  socket(query: string): Promise<Sock> {
    return Sock.open(`ws://${base}/ws?${query}`, this.cookie);
  }
}

/** WebSocket wrapper that queues messages so tests can await them in order. */
class Sock {
  private queue: ServerMessage[] = [];
  private waiters: ((m: ServerMessage) => void)[] = [];
  closed?: number;
  private readonly closedPromise: Promise<number>;

  private constructor(readonly ws: WebSocket) {
    this.closedPromise = new Promise((resolve) => ws.once('close', (code) => resolve((this.closed = code))));
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      const waiter = this.waiters.shift();
      if (waiter) waiter(msg);
      else this.queue.push(msg);
    });
  }

  static open(url: string, cookie: string): Promise<Sock> {
    const ws = new WebSocket(url, { headers: { cookie } });
    const sock = new Sock(ws);
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(sock));
      ws.once('error', reject);
    });
  }

  next(): Promise<ServerMessage> {
    const msg = this.queue.shift();
    if (msg) return Promise.resolve(msg);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out waiting for message')), 2000);
      this.waiters.push((m) => {
        clearTimeout(timer);
        resolve(m);
      });
    });
  }

  /** Skips messages until one of the given type (optionally matching `pred`) arrives. */
  async until<T extends ServerMessage['type']>(
    type: T,
    pred: (msg: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    for (;;) {
      const msg = await this.next();
      if (msg.type === type && pred(msg as Extract<ServerMessage, { type: T }>)) {
        return msg as Extract<ServerMessage, { type: T }>;
      }
    }
  }

  waitClosed(): Promise<number> {
    return this.closedPromise;
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }
}

async function campaignWithPlayer() {
  const gm = await Client.register('dungeon', 'Dungeon Master');
  const player = await Client.register('ana', 'Ana');
  const { data: created } = await gm.call('POST', '/api/campaigns', { name: 'Lost Mine' });
  const { data: detail } = await gm.call('GET', '/api/campaigns');
  expect(detail).toMatchObject([{ id: created.id, name: 'Lost Mine', role: 'gm', memberCount: 1 }]);
  return { gm, player, campaignId: created.id as string };
}

describe('auth', () => {
  it('registers, signs in and out', async () => {
    const c = await Client.register('bob');
    expect((await c.call('GET', '/api/auth/me')).data.user.username).toBe('bob');

    await c.call('POST', '/api/auth/logout');
    expect((await c.call('GET', '/api/auth/me')).data.user).toBeNull();

    const bad = await c.call('POST', '/api/auth/login', { username: 'bob', password: 'nope' });
    expect(bad.status).toBe(401);
    const good = await c.call('POST', '/api/auth/login', { username: 'BOB', password: 'correct horse' });
    expect(good.status).toBe(200);
    expect((await c.call('GET', '/api/auth/me')).data.user.displayName).toBe('bob');
  });

  it('rejects duplicate usernames and short passwords', async () => {
    await Client.register('bob');
    const dup = await new Client().call('POST', '/api/auth/register', {
      username: 'Bob',
      displayName: 'x',
      password: 'long enough',
    });
    expect(dup.status).toBe(409);
    const short = await new Client().call('POST', '/api/auth/register', {
      username: 'carl',
      displayName: 'x',
      password: 'short',
    });
    expect(short.status).toBe(400);
  });

  it('requires the signup code when configured', async () => {
    await app.close();
    app = await buildApp({ db: openDb(':memory:'), uploadsDir, signupCode: 'tavern' });
    await app.listen({ port: 0, host: '127.0.0.1' });
    base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const body = { username: 'bob', displayName: 'Bob', password: 'correct horse' };
    expect((await new Client().call('POST', '/api/auth/register', body)).status).toBe(403);
    expect((await new Client().call('POST', '/api/auth/register', { ...body, signupCode: 'tavern' })).status).toBe(200);
  });
});

describe('campaign session', () => {
  it('lets players join by invite code and see each other online', async () => {
    const { gm, player, campaignId } = await campaignWithPlayer();

    const gmSock = await gm.socket(`campaign=${campaignId}`);
    const hello = await gmSock.until('hello');
    expect(hello.you.role).toBe('gm');
    const inviteCode = hello.campaign.inviteCode!;
    expect(inviteCode).toMatch(/^[A-Z2-9]{6}$/);

    // Not a member yet.
    const denied = await player.socket(`campaign=${campaignId}`);
    expect(await denied.waitClosed()).toBe(4403);

    const join = await player.call('POST', '/api/campaigns/join', { inviteCode: inviteCode.toLowerCase() });
    expect(join.data.id).toBe(campaignId);
    const joined = await gmSock.until('members', (m) => m.members.length === 2);
    expect(joined.members.map((m) => m.name)).toEqual(['Dungeon Master', 'Ana']);

    const playerSock = await player.socket(`campaign=${campaignId}`);
    const playerHello = await playerSock.until('hello');
    expect(playerHello.you.role).toBe('player');
    expect(playerHello.campaign.inviteCode).toBeUndefined();
    expect(playerHello.displays).toBeUndefined();
    await gmSock.until('members', (m) => m.members.some((x) => x.name === 'Ana' && x.online));

    playerSock.close();
    await gmSock.until('members', (m) => m.members.some((x) => x.name === 'Ana' && !x.online));
    gmSock.close();
  });

  it('rolls dice on the server and hides GM-only rolls from others', async () => {
    const { gm, player, campaignId } = await campaignWithPlayer();
    const gmSock = await gm.socket(`campaign=${campaignId}`);
    const { campaign } = await gmSock.until('hello');
    await player.call('POST', '/api/campaigns/join', { inviteCode: campaign.inviteCode });
    const playerSock = await player.socket(`campaign=${campaignId}`);
    await playerSock.until('hello');

    playerSock.send({ type: 'roll', expr: '2d20kh1+3', label: 'Stealth', visibility: 'public' });
    const seenByGm = await gmSock.until('log');
    const seenByPlayer = await playerSock.until('log');
    expect(seenByGm.entry).toEqual(seenByPlayer.entry);
    expect(seenByGm.entry).toMatchObject({ kind: 'roll', label: 'Stealth', author: { name: 'Ana', role: 'player' } });
    if (seenByGm.entry.kind !== 'roll') throw new Error('expected roll');
    expect(seenByGm.entry.roll.total).toBeGreaterThanOrEqual(4);
    expect(seenByGm.entry.roll.total).toBeLessThanOrEqual(23);

    // GM's hidden roll reaches only the GM.
    gmSock.send({ type: 'roll', expr: '1d20', label: 'Secret perception', visibility: 'gm' });
    expect((await gmSock.until('log')).entry).toMatchObject({ label: 'Secret perception', visibility: 'gm' });
    // Player whispers to GM: player and GM see it.
    playerSock.send({ type: 'chat', text: 'I pocket the gem', visibility: 'gm' });
    expect((await playerSock.until('log')).entry).toMatchObject({ kind: 'chat', text: 'I pocket the gem' });
    expect((await gmSock.until('log')).entry).toMatchObject({ kind: 'chat', text: 'I pocket the gem' });

    // Bad expressions come back as errors, not log entries.
    playerSock.send({ type: 'roll', expr: '1d0', visibility: 'public' });
    expect(await playerSock.next()).toMatchObject({ type: 'error' });

    // History on reconnect is filtered the same way.
    playerSock.close();
    const again = await player.socket(`campaign=${campaignId}`);
    const hello = await again.until('hello');
    expect(hello.log.map((e) => (e.kind === 'roll' ? e.label : e.text))).toEqual(['Stealth', 'I pocket the gem']);
    again.close();
    gmSock.close();
  });
});

describe('table displays', () => {
  it('pairs a display by code, shows only public entries, and unpairs', async () => {
    const { gm, player, campaignId } = await campaignWithPlayer();
    const { data: display } = await new Client().call('POST', '/api/displays');
    const tv = await Sock.open(`ws://${base}/ws?display=${display.token}`, '');
    expect(await tv.next()).toEqual({ type: 'display:unpaired', code: display.code });

    // Only the GM can pair.
    const gmSock = await gm.socket(`campaign=${campaignId}`);
    const { campaign } = await gmSock.until('hello');
    await player.call('POST', '/api/campaigns/join', { inviteCode: campaign.inviteCode });
    expect((await player.call('POST', `/api/campaigns/${campaignId}/displays`, { code: display.code })).status).toBe(403);
    expect((await gm.call('POST', `/api/campaigns/${campaignId}/displays`, { code: 'ZZZZZZ' })).status).toBe(404);
    expect((await gm.call('POST', `/api/campaigns/${campaignId}/displays`, { code: display.code })).status).toBe(200);

    const tvHello = await tv.until('hello');
    expect(tvHello.you.role).toBe('display');
    expect(tvHello.campaign).toEqual({ id: campaignId, name: 'Lost Mine' });
    const shown = await gmSock.until('displays', (m) => m.displays.length > 0);
    expect(shown.displays).toMatchObject([{ id: display.id, online: true }]);

    gmSock.send({ type: 'roll', expr: '1d20', label: 'hidden', visibility: 'gm' });
    gmSock.send({ type: 'roll', expr: '1d6', label: 'public', visibility: 'public' });
    expect((await tv.until('log')).entry).toMatchObject({ label: 'public' });

    // Reconnecting with the same token goes straight back to the campaign.
    tv.close();
    const tv2 = await Sock.open(`ws://${base}/ws?display=${display.token}`, '');
    expect((await tv2.until('hello')).log.map((e) => e.kind === 'roll' && e.label)).toEqual(['public']);

    expect((await gm.call('DELETE', `/api/campaigns/${campaignId}/displays/${display.id}`)).status).toBe(200);
    const unpaired = await tv2.until('display:unpaired');
    expect(unpaired.code).not.toBe(display.code);

    const bogus = await Sock.open(`ws://${base}/ws?display=nope`, '');
    expect(await bogus.waitClosed()).toBe(4401);
    tv2.close();
    gmSock.close();
  });
});

// 1×1 transparent PNG.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

describe('uploads', () => {
  it('stores images from the GM and serves them as static files', async () => {
    const { gm, player, campaignId } = await campaignWithPlayer();
    const up = await gm.call('POST', `/api/campaigns/${campaignId}/files`, new Uint8Array(PNG));
    expect(up.status).toBe(200);
    expect(up.data.url).toMatch(/^\/files\/[0-9a-f-]{36}\.png$/);

    const res = await fetch(`http://${base}${up.data.url}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(Buffer.from(await res.arrayBuffer()).equals(PNG)).toBe(true);

    expect((await player.call('POST', `/api/campaigns/${campaignId}/files`, new Uint8Array(PNG))).status).toBe(403);
    const notImage = await gm.call('POST', `/api/campaigns/${campaignId}/files`, new TextEncoder().encode('<svg/>'));
    expect(notImage.status).toBe(415);
  });
});

describe('scenes and tokens', () => {
  async function table() {
    const { gm, player, campaignId } = await campaignWithPlayer();
    const gmSock = await gm.socket(`campaign=${campaignId}`);
    const hello = await gmSock.until('hello');
    expect(hello.scene).toBeNull();
    expect(hello.scenes).toEqual([]);
    await player.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
    const { data: me } = await player.call('GET', '/api/auth/me');
    const playerSock = await player.socket(`campaign=${campaignId}`);
    expect((await playerSock.until('hello')).scene).toBeNull();

    // A blank 10×8 scene with 50px cells.
    gmSock.send({ type: 'scene:create', name: 'Cave', fileId: null, width: 500, height: 400, grid: { size: 50 } });
    const { scenes } = await gmSock.until('scenes');
    const sceneId = scenes[0]!.id;
    expect((await gmSock.until('scene')).scene).toMatchObject({ id: sceneId, name: 'Cave', grid: { size: 50 } });
    return { gm, player, campaignId, gmSock, playerSock, sceneId, playerId: me.user.id as string };
  }

  it('only shows players the active scene', async () => {
    const { gmSock, playerSock, sceneId } = await table();
    // Creating a scene doesn't show it to players.
    playerSock.send({ type: 'ping', sceneId, x: 1, y: 1 });
    gmSock.send({ type: 'scene:activate', sceneId });
    const shown = await playerSock.until('scene', (m) => m.scene !== null);
    expect(shown.scene).toMatchObject({ id: sceneId, width: 500, height: 400 });
    expect(await gmSock.until('scenes')).toMatchObject({ activeSceneId: sceneId });

    gmSock.send({ type: 'scene:activate', sceneId: null });
    expect((await playerSock.until('scene')).scene).toBeNull();
  });

  it('filters hidden and fogged tokens and lets players move only their own', async () => {
    const { gmSock, playerSock, sceneId, playerId } = await table();
    gmSock.send({ type: 'scene:activate', sceneId });
    await playerSock.until('scene', (m) => m.scene !== null);

    gmSock.send({ type: 'token:create', sceneId, name: 'Ana', color: '#3366ff', col: 1, row: 1, ownerUserId: playerId });
    gmSock.send({ type: 'token:create', sceneId, name: 'Goblin', color: '#44aa44', col: 5, row: 5 });
    gmSock.send({ type: 'token:create', sceneId, name: 'Lurker', color: '#aa4444', col: 3, row: 3, hidden: true });
    const gmView = await gmSock.until('scene', (m) => m.scene?.tokens.length === 3);
    let view = await playerSock.until('scene', (m) => m.scene?.tokens.length === 2);
    expect(view.scene!.tokens.map((t) => t.name)).toEqual(['Ana', 'Goblin']);

    // Fog on: only the player's own token stays visible until the GM reveals the goblin's cell.
    gmSock.send({ type: 'scene:update', sceneId, fogEnabled: true });
    view = await playerSock.until('scene', (m) => m.scene?.fogEnabled === true);
    expect(view.scene!.tokens.map((t) => t.name)).toEqual(['Ana']);
    gmSock.send({ type: 'fog:paint', sceneId, cells: [5 * 10 + 5], reveal: true });
    view = await playerSock.until('scene', (m) => m.scene?.tokens.length === 2);
    expect(view.scene!.tokens.map((t) => t.name)).toEqual(['Ana', 'Goblin']);

    const ana = gmView.scene!.tokens.find((t) => t.name === 'Ana')!;
    const goblin = gmView.scene!.tokens.find((t) => t.name === 'Goblin')!;
    playerSock.send({ type: 'token:move', tokenId: goblin.id, col: 0, row: 0 });
    expect(await playerSock.until('error')).toMatchObject({ message: "That's not your token" });
    // Moves are clamped to the grid.
    playerSock.send({ type: 'token:move', tokenId: ana.id, col: 99, row: 2 });
    const moved = await gmSock.until('scene', (m) => m.scene?.tokens.some((t) => t.id === ana.id && t.col === 9) ?? false);
    expect(moved.scene!.tokens.find((t) => t.id === ana.id)).toMatchObject({ col: 9, row: 2 });

    playerSock.send({ type: 'token:delete', tokenId: ana.id });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
  });

  it('resets fog and clamps tokens when the grid changes size', async () => {
    const { gmSock, sceneId } = await table();
    gmSock.send({ type: 'token:create', sceneId, name: 'Ogre', color: '#aa7744', col: 8, row: 6, size: 2 });
    gmSock.send({ type: 'scene:update', sceneId, fogEnabled: true });
    gmSock.send({ type: 'fog:fill', sceneId, reveal: true });
    await gmSock.until('scene', (m) => m.scene?.fog.startsWith('/////') ?? false);
    gmSock.send({ type: 'scene:update', sceneId, grid: { size: 100 } });
    const { scene } = await gmSock.until('scene', (m) => m.scene?.grid.size === 100);
    expect(scene!.tokens[0]).toMatchObject({ col: 3, row: 2 });
    expect(scene!.fog).toMatch(/^A+=*$/); // every cell fogged again

    gmSock.send({ type: 'scene:update', sceneId, grid: { size: 1 } });
    expect(await gmSock.until('error')).toMatchObject({ type: 'error' });
  });

  it('relays pings to viewers and the GM camera to table screens', async () => {
    const { gm, gmSock, playerSock, campaignId, sceneId } = await table();
    gmSock.send({ type: 'scene:activate', sceneId });
    await playerSock.until('scene', (m) => m.scene !== null);

    playerSock.send({ type: 'ping', sceneId, x: 120, y: 80 });
    expect(await gmSock.until('ping')).toMatchObject({ x: 120, y: 80, name: 'Ana', role: 'player' });

    const rect = { x: 0, y: 0, w: 250, h: 200 };
    gmSock.send({ type: 'camera', sceneId, rect });
    const { data: display } = await new Client().call('POST', '/api/displays');
    const tv = await Sock.open(`ws://${base}/ws?display=${display.token}`, '');
    await tv.until('display:unpaired');
    await gm.call('POST', `/api/campaigns/${campaignId}/displays`, { code: display.code });
    expect((await tv.until('hello')).scene).toMatchObject({ id: sceneId });
    expect(await tv.until('camera')).toEqual({ type: 'camera', sceneId, rect });
  });

  it('checks that map images belong to the campaign', async () => {
    const { gm, gmSock, campaignId } = await table();
    const { data: other } = await gm.call('POST', '/api/campaigns', { name: 'Other' });
    const { data: file } = await gm.call('POST', `/api/campaigns/${other.id}/files`, new Uint8Array(PNG));
    gmSock.send({ type: 'scene:create', name: 'Stolen', fileId: file.id, width: 100, height: 100 });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Map image not found' });

    const { data: mine } = await gm.call('POST', `/api/campaigns/${campaignId}/files`, new Uint8Array(PNG));
    gmSock.send({ type: 'scene:create', name: 'Mine', fileId: mine.id, width: 100, height: 100 });
    const { scenes } = await gmSock.until('scenes', (m) => m.scenes.length === 2);
    expect(scenes[1]).toMatchObject({ name: 'Mine', imageUrl: mine.url });
  });
});
