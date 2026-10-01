import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '@dnd/protocol';
import { CHARACTER_VERSION, emptyState, type Character } from '@dnd/rules';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from './app';
import { openDb } from './db';
import type { SceneView } from '@dnd/protocol';
import { FogMask, MapData, gridGeometry, terrainCode, type Edge } from '@dnd/rules';

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

describe('map editor', () => {
  /** GM and player on a blank 10×8 scene (50px cells) that is in play, with the player's token at (1, 1). */
  async function mapTable() {
    const { gm, player, campaignId } = await campaignWithPlayer();
    const gmSock = await gm.socket(`campaign=${campaignId}`);
    const hello = await gmSock.until('hello');
    await player.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
    const { data: me } = await player.call('GET', '/api/auth/me');
    const playerSock = await player.socket(`campaign=${campaignId}`);
    await playerSock.until('hello');
    gmSock.send({ type: 'scene:create', name: 'Crypt', fileId: null, width: 500, height: 400, grid: { size: 50 } });
    const sceneId = (await gmSock.until('scenes')).scenes[0]!.id;
    gmSock.send({ type: 'scene:activate', sceneId });
    gmSock.send({ type: 'token:create', sceneId, name: 'Ana', color: '#3366ff', col: 1, row: 1, ownerUserId: me.user.id });
    const { scene } = await gmSock.until('scene', (m) => m.scene?.tokens.length === 1);
    await playerSock.until('scene', (m) => m.scene?.tokens.length === 1);
    return { gm, campaignId, gmSock, playerSock, sceneId, ana: scene!.tokens[0]! };
  }

  const decode = (scene: SceneView | null) => {
    const { cols, rows } = gridGeometry(scene!.grid, scene!.width, scene!.height);
    return MapData.decode(scene!.map, cols, rows);
  };
  const tokenAt = (scene: SceneView | null, id: string, col: number, row: number) =>
    scene?.tokens.some((t) => t.id === id && t.col === col && t.row === row) ?? false;

  it('lets only the GM draw walls, doors and terrain', async () => {
    const { gmSock, playerSock, sceneId } = await mapTable();
    const run: Edge[] = [0, 1, 2].map((col) => ({ side: 'top', col, row: 4 }));
    gmSock.send({ type: 'map:walls', sceneId, edges: run, wall: true });
    gmSock.send({ type: 'map:door', sceneId, edge: { side: 'top', col: 1, row: 4 }, state: 'closed', secret: false });
    gmSock.send({ type: 'map:terrain', sceneId, cells: [0, 1, 999], terrain: 'water' });
    let map = decode((await gmSock.until('scene', (m) => decode(m.scene).terrainAt(1, 0) !== 0)).scene);
    expect(map.feature({ side: 'top', col: 0, row: 4 })).toEqual({ kind: 'wall' });
    expect(map.feature({ side: 'top', col: 1, row: 4 })).toEqual({ kind: 'door', state: 'closed', secret: false });
    expect(map.terrainAt(0, 0)).toBe(terrainCode('water'));
    expect(map.terrainAt(2, 0)).toBe(0);

    // Erasing clears doors as well as walls.
    gmSock.send({ type: 'map:walls', sceneId, edges: run.slice(1), wall: false });
    gmSock.send({ type: 'map:fill', sceneId, terrain: 'rock' });
    map = decode((await gmSock.until('scene', (m) => decode(m.scene).terrainAt(5, 5) !== 0)).scene);
    expect([...map.edges()].map((e) => e.edge.col)).toEqual([0]);
    expect(map.terrainAt(9, 7)).toBe(terrainCode('rock'));
    gmSock.send({ type: 'map:clear-walls', sceneId });
    expect(decode((await gmSock.until('scene', (m) => !decode(m.scene).top.some(Boolean))).scene).terrainAt(0, 0)).toBe(terrainCode('rock'));

    for (const msg of [
      { type: 'map:walls', sceneId, edges: run, wall: true },
      { type: 'map:door', sceneId, edge: run[0], state: 'open', secret: false },
      { type: 'map:terrain', sceneId, cells: [0], terrain: 'floor' },
      { type: 'map:fill', sceneId, terrain: 'none' },
      { type: 'map:resize', sceneId, top: 1, right: 0, bottom: 0, left: 0 },
    ]) {
      playerSock.send(msg);
      expect(await playerSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
    }
  });

  it('shows players and table screens closed secret doors as walls, and nothing behind the fog', async () => {
    const { gm, campaignId, gmSock, playerSock, sceneId } = await mapTable();
    const secret: Edge = { side: 'left', col: 3, row: 2 };
    gmSock.send({ type: 'map:door', sceneId, edge: secret, state: 'locked', secret: true });
    const gmMap = decode((await gmSock.until('scene', (m) => m.scene!.map !== '')).scene);
    expect(gmMap.feature(secret)).toEqual({ kind: 'door', state: 'locked', secret: true });
    const playerScene = (await playerSock.until('scene', (m) => m.scene!.map !== '')).scene;
    expect(decode(playerScene).feature(secret)).toEqual({ kind: 'wall' });
    expect(playerScene!.map).toBe(new MapData(10, 8, { ...gmMap, left: gmMap.left.map((c) => (c ? 1 : 0)) }).encode());

    const { data: display } = await new Client().call('POST', '/api/displays');
    const tv = await Sock.open(`ws://${base}/ws?display=${display.token}`, '');
    await tv.until('display:unpaired');
    await gm.call('POST', `/api/campaigns/${campaignId}/displays`, { code: display.code });
    expect(decode((await tv.until('hello')).scene).feature(secret)).toEqual({ kind: 'wall' });

    // Once the GM opens it, everyone can see it is a door.
    gmSock.send({ type: 'door:toggle', sceneId, edge: secret });
    const opened = await playerSock.until('scene', (m) => decode(m.scene).feature(secret)?.kind === 'door');
    expect(decode(opened.scene).feature(secret)).toEqual({ kind: 'door', state: 'open', secret: false });
    expect(decode((await tv.until('scene')).scene).feature(secret)).toMatchObject({ kind: 'door', state: 'open' });

    // With fog on, walls and terrain under it stay on the server.
    const far: Edge = { side: 'top', col: 8, row: 6 };
    gmSock.send({ type: 'map:walls', sceneId, edges: [far], wall: true });
    gmSock.send({ type: 'map:terrain', sceneId, cells: [6 * 10 + 8], terrain: 'water' });
    gmSock.send({ type: 'scene:update', sceneId, fogEnabled: true });
    let fogged = await playerSock.until('scene', (m) => m.scene!.fogEnabled);
    expect(fogged.scene!.map).toBe('');
    gmSock.send({ type: 'fog:paint', sceneId, cells: [6 * 10 + 8], reveal: true });
    fogged = await playerSock.until('scene', (m) => m.scene!.map !== '');
    expect(decode(fogged.scene).blocks(far)).toBe(true);
    expect(decode(fogged.scene).terrainAt(8, 6)).toBe(terrainCode('water'));
    tv.close();
  });

  it('opens and closes doors: GMs any, players unlocked ones next to their token', async () => {
    const { gmSock, playerSock, sceneId } = await mapTable();
    const right: Edge = { side: 'left', col: 2, row: 1 };
    const above: Edge = { side: 'top', col: 1, row: 1 };
    const hidden: Edge = { side: 'left', col: 1, row: 1 };
    const far: Edge = { side: 'top', col: 8, row: 6 };
    gmSock.send({ type: 'map:door', sceneId, edge: right, state: 'closed', secret: false });
    gmSock.send({ type: 'map:door', sceneId, edge: above, state: 'locked', secret: false });
    gmSock.send({ type: 'map:door', sceneId, edge: hidden, state: 'closed', secret: true });
    gmSock.send({ type: 'map:door', sceneId, edge: far, state: 'closed', secret: false });
    await playerSock.until('scene', (m) => decode(m.scene).feature(far) !== null);

    playerSock.send({ type: 'door:toggle', sceneId, edge: right });
    await playerSock.until('scene', (m) => decode(m.scene).feature(right)?.kind === 'door' && !decode(m.scene).blocks(right));
    playerSock.send({ type: 'door:toggle', sceneId, edge: above });
    expect(await playerSock.until('error')).toMatchObject({ message: 'The door is locked' });
    playerSock.send({ type: 'door:toggle', sceneId, edge: hidden });
    expect(await playerSock.until('error')).toMatchObject({ message: "There's no door there" });
    playerSock.send({ type: 'door:toggle', sceneId, edge: { side: 'top', col: 5, row: 5 } });
    expect(await playerSock.until('error')).toMatchObject({ message: "There's no door there" });
    playerSock.send({ type: 'door:toggle', sceneId, edge: far });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Move your token next to the door first' });

    gmSock.send({ type: 'door:toggle', sceneId, edge: above });
    const unlocked = await gmSock.until('scene', (m) => decode(m.scene).feature(above)?.kind === 'door' && !decode(m.scene).blocks(above));
    expect(decode(unlocked.scene).feature(above)).toEqual({ kind: 'door', state: 'open', secret: false });
    playerSock.send({ type: 'door:toggle', sceneId, edge: right });
    const closed = await gmSock.until('scene', (m) => decode(m.scene).blocks(right));
    expect(decode(closed.scene).feature(right)).toEqual({ kind: 'door', state: 'closed', secret: false });
  });

  it('grows and shrinks blank maps on any side, keeping tokens, fog and walls in place', async () => {
    const { gm, campaignId, gmSock, playerSock, sceneId, ana } = await mapTable();
    gmSock.send({ type: 'map:walls', sceneId, edges: [{ side: 'top', col: 1, row: 1 }, { side: 'left', col: 10, row: 7 }], wall: true });
    gmSock.send({ type: 'map:terrain', sceneId, cells: [2 * 10 + 2], terrain: 'water' });
    gmSock.send({ type: 'scene:update', sceneId, fogEnabled: true });
    gmSock.send({ type: 'fog:paint', sceneId, cells: [1 * 10 + 1], reveal: true });
    await gmSock.until('scene', (m) => m.scene!.fog !== '' && !m.scene!.fog.startsWith('AAAA'));

    gmSock.send({ type: 'map:resize', sceneId, top: 1, right: 0, bottom: 0, left: 2 });
    const { scene } = await gmSock.until('scene', (m) => m.scene!.width === 600);
    expect(scene).toMatchObject({ width: 600, height: 450 });
    expect(scene!.tokens[0]).toMatchObject({ id: ana.id, col: 3, row: 2 });
    const map = decode(scene);
    expect([map.cols, map.rows]).toEqual([12, 9]);
    expect(map.blocks({ side: 'top', col: 3, row: 2 })).toBe(true);
    expect(map.blocks({ side: 'left', col: 12, row: 8 })).toBe(true);
    expect(map.terrainAt(4, 3)).toBe(terrainCode('water'));
    const fog = FogMask.decode(scene!.fog, 12, 9);
    expect(fog.isRevealed(3, 2)).toBe(true);
    expect(fog.isRevealed(1, 1)).toBe(false);
    // Players' copies move too.
    expect((await playerSock.until('scene', (m) => m.scene!.width === 600)).scene!.tokens[0]).toMatchObject({ col: 3, row: 2 });

    gmSock.send({ type: 'map:resize', sceneId, top: 0, right: 0, bottom: 0, left: -4 });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Ana is in the way: move it off that edge first' });
    gmSock.send({ type: 'map:resize', sceneId, top: 0, right: -1, bottom: -8, left: -3 });
    expect(await gmSock.until('error')).toMatchObject({ type: 'error' });
    gmSock.send({ type: 'map:resize', sceneId, top: -2, right: -1, bottom: 0, left: -3 });
    const shrunk = (await gmSock.until('scene', (m) => m.scene!.width === 400)).scene;
    expect(shrunk).toMatchObject({ width: 400, height: 350 });
    expect(shrunk!.tokens[0]).toMatchObject({ col: 0, row: 0 });
    expect([...decode(shrunk).edges()]).toEqual([{ edge: { side: 'top', col: 0, row: 0 }, code: 1 }]);

    // Image maps keep their size.
    const { data: file } = await gm.call('POST', `/api/campaigns/${campaignId}/files`, new Uint8Array(PNG));
    gmSock.send({ type: 'scene:create', name: 'Painted', fileId: file.id, width: 700, height: 700 });
    const painted = (await gmSock.until('scenes', (m) => m.scenes.length === 2)).scenes[1]!.id;
    gmSock.send({ type: 'map:resize', sceneId: painted, top: 1, right: 0, bottom: 0, left: 0 });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Only blank maps can be resized' });
  });

  it('keeps walls anchored to the top-left when grid calibration changes the cell count', async () => {
    const { gmSock, sceneId } = await mapTable();
    gmSock.send({ type: 'map:walls', sceneId, edges: [{ side: 'left', col: 2, row: 1 }, { side: 'top', col: 9, row: 7 }], wall: true });
    await gmSock.until('scene', (m) => m.scene!.map !== '');
    gmSock.send({ type: 'scene:update', sceneId, grid: { size: 100 } });
    const { scene } = await gmSock.until('scene', (m) => m.scene!.grid.size === 100);
    expect([...decode(scene).edges()]).toEqual([{ edge: { side: 'left', col: 2, row: 1 }, code: 1 }]);
  });
});

function fighter(name: string, overrides: Partial<Character> = {}): Character {
  return {
    version: CHARACTER_VERSION,
    name,
    color: '#2e86de',
    classId: 'fighter',
    level: 3,
    subclassId: 'champion',
    speciesId: 'human',
    subspeciesId: null,
    size: 'Medium',
    backgroundId: 'soldier',
    baseScores: { str: 15, dex: 13, con: 14, int: 8, wis: 12, cha: 10 },
    backgroundBonus: { str: 2, con: 1 },
    advancements: [],
    fightingStyle: 'defense',
    extraFeats: [],
    skills: ['perception', 'survival'],
    expertise: [],
    weaponMasteries: ['longsword'],
    hpRolls: [null, null],
    languages: [],
    tools: [],
    equipment: { armorId: 'chain-mail', shield: true, weapons: [{ weaponId: 'longsword' }], items: [] },
    currency: { cp: 0, sp: 0, ep: 0, gp: 10, pp: 0 },
    spells: [],
    state: emptyState({ classId: 'fighter', level: 3 }, 28),
    notes: 'Secret: owes the thieves guild',
    ...overrides,
  };
}

describe('characters', () => {
  async function party() {
    const { gm, player, campaignId } = await campaignWithPlayer();
    const gmSock = await gm.socket(`campaign=${campaignId}`);
    const { campaign } = await gmSock.until('hello');
    const other = await Client.register('bram', 'Bram');
    await player.call('POST', '/api/campaigns/join', { inviteCode: campaign.inviteCode });
    await other.call('POST', '/api/campaigns/join', { inviteCode: campaign.inviteCode });
    const playerSock = await player.socket(`campaign=${campaignId}`);
    const otherSock = await other.socket(`campaign=${campaignId}`);
    expect((await playerSock.until('hello')).characters).toEqual([]);
    await otherSock.until('hello');

    playerSock.send({ type: 'character:create', data: fighter('Ana') });
    const { characters } = await gmSock.until('characters');
    return { gm, gmSock, playerSock, otherSock, campaignId, id: characters[0]!.id, characters };
  }

  it('shares sheets with the party but keeps notes private', async () => {
    const { gmSock, otherSock, characters } = await party();
    expect(characters[0]!.data).toMatchObject({ name: 'Ana', notes: 'Secret: owes the thieves guild' });
    const seenByOther = await otherSock.until('characters');
    expect(seenByOther.characters[0]!.data).toMatchObject({ name: 'Ana', notes: '' });
    gmSock.close();
  });

  it('lets owners and the GM edit, but not other players', async () => {
    const { gmSock, playerSock, otherSock, id } = await party();
    otherSock.send({ type: 'character:state', characterId: id, patch: { hp: 1 } });
    expect(await otherSock.until('error')).toMatchObject({ message: "That's not your character" });

    // HP is clamped to the derived maximum.
    playerSock.send({ type: 'character:state', characterId: id, patch: { hp: 999, conditions: ['poisoned'] } });
    const patched = await gmSock.until('characters', (m) => m.characters[0]!.data.state.conditions.length === 1);
    expect(patched.characters[0]!.data.state).toMatchObject({ hp: 28, conditions: ['poisoned'] });

    gmSock.send({ type: 'character:update', characterId: id, data: fighter('Ana', { level: 4 }) });
    await playerSock.until('characters', (m) => m.characters[0]!.data.level === 4);

    playerSock.send({ type: 'character:update', characterId: id, data: fighter('Ana', { classId: 'necromancer' }) });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Unknown class' });
    playerSock.send({ type: 'character:update', characterId: id, data: { ...fighter('Ana'), level: 40 } });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Invalid message' });
  });

  it('resolves rests on the server and logs the hit dice roll', async () => {
    const { gmSock, playerSock, id } = await party();
    playerSock.send({ type: 'character:state', characterId: id, patch: { hp: 5, resourcesUsed: { 'second-wind': 2, 'action-surge': 1 } } });
    await gmSock.until('characters', (m) => m.characters[0]!.data.state.hp === 5);

    playerSock.send({ type: 'character:rest', characterId: id, kind: 'short', hitDice: 2 });
    const { entry } = await gmSock.until('log');
    expect(entry).toMatchObject({ kind: 'roll', label: 'Ana: Short Rest, 2 Hit Dice' });
    if (entry.kind !== 'roll') throw new Error('expected roll');
    expect(entry.roll.expression).toBe('2d10 + 4');
    const rested = (await gmSock.until('characters', (m) => m.characters[0]!.data.state.hitDiceSpent === 2)).characters[0]!.data.state;
    expect(rested.hp).toBe(Math.min(28, 5 + entry.roll.total));
    expect(rested.resourcesUsed).toEqual({ 'second-wind': 1, 'action-surge': 0 });

    playerSock.send({ type: 'character:rest', characterId: id, kind: 'long' });
    expect((await gmSock.until('log')).entry).toMatchObject({ kind: 'chat', text: 'Ana finishes a Long Rest.' });
    const full = (await gmSock.until('characters', (m) => m.characters[0]!.data.state.hitDiceSpent === 0)).characters[0]!.data.state;
    expect(full).toMatchObject({ hp: 28, resourcesUsed: {}, heroicInspiration: true });
  });

  it('places a linked token and keeps its name in sync', async () => {
    const { gmSock, playerSock, id } = await party();
    playerSock.send({ type: 'character:token', characterId: id });
    expect(await playerSock.until('error')).toMatchObject({ message: 'There is no map to place the token on' });

    gmSock.send({ type: 'scene:create', name: 'Road', fileId: null, width: 500, height: 500, grid: { size: 50 } });
    const { scenes } = await gmSock.until('scenes');
    gmSock.send({ type: 'scene:activate', sceneId: scenes[0]!.id });
    await playerSock.until('scene', (m) => m.scene !== null);

    playerSock.send({ type: 'character:token', characterId: id });
    const placed = await gmSock.until('scene', (m) => (m.scene?.tokens.length ?? 0) === 1);
    expect(placed.scene!.tokens[0]).toMatchObject({ name: 'Ana', characterId: id, col: 5, row: 5 });
    playerSock.send({ type: 'character:token', characterId: id });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Ana is already on this map' });

    playerSock.send({ type: 'character:update', characterId: id, data: fighter('Ana Swiftblade') });
    const renamed = await gmSock.until('scene', (m) => m.scene?.tokens[0]?.name === 'Ana Swiftblade');
    expect(renamed.scene!.tokens[0]!.characterId).toBe(id);
  });
});
