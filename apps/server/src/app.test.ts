import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerMessage } from '@dnd/protocol';
import { CHARACTER_VERSION, emptyState, type Character } from '@dnd/rules';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from './app';
import { openDb } from './db';
import { Store } from './store';
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

const ascii = (s: string) => new TextEncoder().encode(s);

/** Tiny audio files: just enough header bytes for each format's signature. */
const AUDIO = {
  mp3: new Uint8Array([...ascii('ID3'), 4, 0, 0, 0, 0, 0, 0]),
  mp3Frame: new Uint8Array([0xff, 0xfb, 0x90, 0x64, 0, 0, 0, 0]),
  aac: new Uint8Array([0xff, 0xf1, 0x50, 0x80, 0, 0x1f, 0xfc]),
  ogg: new Uint8Array([...ascii('OggS'), 0, 2, 0, 0, 0, 0, 0, 0, 0, 0]),
  wav: new Uint8Array([...ascii('RIFF'), 36, 0, 0, 0, ...ascii('WAVEfmt '), 16, 0, 0, 0]),
  m4a: new Uint8Array([0, 0, 0, 0x18, ...ascii('ftypM4A '), 0, 0, 0, 0, ...ascii('isom')]),
  flac: new Uint8Array([...ascii('fLaC'), 0, 0, 0, 0x22]),
};

const AUDIO_FIXTURES: [string, Uint8Array, string, string][] = [
  ['mp3 (ID3)', AUDIO.mp3, 'mp3', 'audio/mpeg'],
  ['mp3 (frame)', AUDIO.mp3Frame, 'mp3', 'audio/mpeg'],
  ['aac', AUDIO.aac, 'aac', 'audio/aac'],
  ['ogg', AUDIO.ogg, 'ogg', 'audio/ogg'],
  ['wav', AUDIO.wav, 'wav', 'audio/wav'],
  ['m4a', AUDIO.m4a, 'm4a', 'audio/mp4'],
  ['flac', AUDIO.flac, 'flac', 'audio/flac'],
];

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

  it('sniffs audio by its magic bytes and enforces per-kind size limits', async () => {
    const { gm, player, campaignId } = await campaignWithPlayer();
    const upload = (body: Uint8Array, as = gm) => as.call('POST', `/api/campaigns/${campaignId}/files`, body);

    for (const [name, bytes, ext, mime] of AUDIO_FIXTURES) {
      const up = await upload(bytes);
      expect(up.status, name).toBe(200);
      expect(up.data, name).toMatchObject({ kind: 'audio', mime });
      expect(up.data.url, name).toMatch(new RegExp(`^/files/[0-9a-f-]{36}\\.${ext}$`));
    }
    const served = await fetch(`http://${base}${(await upload(AUDIO.mp3)).data.url}`);
    expect(served.headers.get('content-type')).toBe('audio/mpeg');
    expect(Buffer.from(await served.arrayBuffer()).equals(Buffer.from(AUDIO.mp3))).toBe(true);
    expect((await upload(new Uint8Array(PNG))).data).toMatchObject({ kind: 'image', mime: 'image/png' });

    // Look-alikes and garbage are refused; so are players.
    const riffAvi = new Uint8Array([...ascii('RIFF'), 4, 0, 0, 0, ...ascii('AVI '), 0, 0, 0, 0]);
    for (const bad of [riffAvi, ascii('fLaX....'), new Uint8Array([0xff, 0x00, 0x00, 0x00]), ascii('MThd')]) {
      expect((await upload(bad)).status).toBe(415);
    }
    expect((await upload(AUDIO.ogg, player)).status).toBe(403);

    // Images keep their 30 MB limit; audio may be up to 50 MB.
    const big = (header: Uint8Array, size: number) => {
      const body = new Uint8Array(size);
      body.set(header);
      return body;
    };
    const tooBigImage = await upload(big(new Uint8Array(PNG), 30 * 1024 * 1024 + 1));
    expect(tooBigImage.status).toBe(413);
    expect(tooBigImage.data.error).toMatch(/too large/);
    expect((await upload(big(AUDIO.mp3, 30 * 1024 * 1024 + 1))).status).toBe(200);
    expect((await upload(big(AUDIO.mp3, 50 * 1024 * 1024 + 1))).status).toBe(413);
  }, 20_000);
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
    const { data: song } = await gm.call('POST', `/api/campaigns/${campaignId}/files`, AUDIO.ogg);
    gmSock.send({ type: 'scene:create', name: 'Song', fileId: song.id, width: 100, height: 100 });
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

  it("blocks players' moves through walls, closed doors and rock, but not the GM's", async () => {
    const { gmSock, playerSock, sceneId, ana } = await mapTable();
    const door: Edge = { side: 'top', col: 1, row: 3 };
    gmSock.send({ type: 'map:walls', sceneId, edges: [{ side: 'left', col: 3, row: 1 }], wall: true });
    gmSock.send({ type: 'map:door', sceneId, edge: door, state: 'closed', secret: false });
    gmSock.send({ type: 'map:terrain', sceneId, cells: [5 * 10 + 1], terrain: 'rock' });
    await playerSock.until('scene', (m) => decode(m.scene).terrainAt(1, 5) !== 0);

    playerSock.send({ type: 'token:move', tokenId: ana.id, col: 4, row: 1 });
    expect(await playerSock.until('error')).toMatchObject({ message: 'A wall or closed door is in the way' });
    playerSock.send({ type: 'token:move', tokenId: ana.id, col: 1, row: 4 });
    expect(await playerSock.until('error')).toMatchObject({ message: 'A wall or closed door is in the way' });
    playerSock.send({ type: 'token:move', tokenId: ana.id, col: 1, row: 2 });
    await gmSock.until('scene', (m) => tokenAt(m.scene, ana.id, 1, 2));

    gmSock.send({ type: 'door:toggle', sceneId, edge: door });
    await playerSock.until('scene', (m) => !decode(m.scene).blocks(door));
    playerSock.send({ type: 'token:move', tokenId: ana.id, col: 1, row: 4 });
    await gmSock.until('scene', (m) => tokenAt(m.scene, ana.id, 1, 4));
    playerSock.send({ type: 'token:move', tokenId: ana.id, col: 1, row: 6 });
    expect(await playerSock.until('error')).toMatchObject({ message: "You can't move through solid rock" });

    // The GM can put tokens anywhere.
    gmSock.send({ type: 'token:move', tokenId: ana.id, col: 1, row: 5 });
    await gmSock.until('scene', (m) => tokenAt(m.scene, ana.id, 1, 5));
    gmSock.send({ type: 'token:move', tokenId: ana.id, col: 5, row: 1 });
    await gmSock.until('scene', (m) => tokenAt(m.scene, ana.id, 5, 1));
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

describe('combat', () => {
  /** GM and Ana (with a character and its token on the live scene), plus Bram, a second player. */
  async function encounterTable() {
    const { gm, player, campaignId } = await campaignWithPlayer();
    const gmSock = await gm.socket(`campaign=${campaignId}`);
    const hello = await gmSock.until('hello');
    expect(hello.combat).toBeNull();
    const other = await Client.register('bram', 'Bram');
    await player.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
    await other.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
    const playerSock = await player.socket(`campaign=${campaignId}`);
    const otherSock = await other.socket(`campaign=${campaignId}`);
    await playerSock.until('hello');
    await otherSock.until('hello');

    playerSock.send({ type: 'character:create', data: fighter('Ana') });
    const characterId = (await gmSock.until('characters')).characters[0]!.id;
    gmSock.send({ type: 'scene:create', name: 'Road', fileId: null, width: 500, height: 500, grid: { size: 50 } });
    const sceneId = (await gmSock.until('scenes')).scenes[0]!.id;
    gmSock.send({ type: 'scene:activate', sceneId });
    await playerSock.until('scene', (m) => m.scene !== null);
    playerSock.send({ type: 'character:token', characterId });
    await gmSock.until('scene', (m) => m.scene?.tokens.length === 1);
    return { gm, gmSock, playerSock, otherSock, campaignId, characterId, sceneId };
  }

  const names = (m: Extract<ServerMessage, { type: 'combat' }>) => m.combat?.combatants.map((c) => c.name) ?? [];

  it('runs initiative order, ties, turns and rounds', async () => {
    const { gmSock, playerSock, sceneId } = await encounterTable();
    gmSock.send({ type: 'token:create', sceneId, name: 'Wolf', color: '#7f8c8d', col: 1, row: 1 });
    await gmSock.until('scene', (m) => m.scene?.tokens.length === 2);

    gmSock.send({ type: 'combat:start', fromScene: true });
    expect((await playerSock.until('log')).entry).toMatchObject({ kind: 'chat', text: 'Combat begins. Roll initiative!' });
    const started = await gmSock.until('combat');
    expect(started.combat).toMatchObject({ round: 1, activeId: null });
    expect(started.combat!.combatants.map((c) => [c.name, c.kind])).toEqual([
      ['Ana', 'character'],
      ['Wolf', 'npc'],
    ]);

    // Two goblins with tokens on the GM's scene, numbered.
    gmSock.send({ type: 'combat:add', source: { kind: 'monster', monsterId: 'goblin-warrior', count: 2, placeToken: true } });
    const placed = await gmSock.until('scene', (m) => m.scene?.tokens.length === 4);
    expect(placed.scene!.tokens.filter((t) => t.name.startsWith('Goblin')).map((t) => t.name)).toEqual(['Goblin Warrior 1', 'Goblin Warrior 2']);
    const added = await gmSock.until('combat', (m) => m.combat?.combatants.length === 4);
    const goblin = added.combat!.combatants.find((c) => c.name === 'Goblin Warrior 1')!;
    expect(goblin).toMatchObject({ kind: 'monster', monsterId: 'goblin-warrior', ac: 15, hp: 10, hpMax: 10, initiativeBonus: 2 });
    // Their tokens see with the stat block's senses.
    expect(placed.scene!.tokens.find((t) => t.id === goblin.tokenId)).toMatchObject({ senses: { darkvision: 60 } });

    // The server rolls for every creature without initiative, hidden from players.
    gmSock.send({ type: 'combat:roll-initiative' });
    const rolled = await gmSock.until('combat', (m) => m.combat!.combatants.filter((c) => c.initiative !== null).length === 3);
    for (const c of rolled.combat!.combatants.filter((x) => x.kind !== 'character')) {
      expect(c.initiative).toBeGreaterThanOrEqual(c.initiativeBonus! + 1);
      expect(c.initiative).toBeLessThanOrEqual(c.initiativeBonus! + 20);
    }
    gmSock.send({ type: 'combat:roll-initiative' });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Every creature has rolled initiative' });

    // Ties: goblins (+2, DEX 15) beat Ana (+1); between goblins, join order decides.
    const byName = (n: string) => rolled.combat!.combatants.find((c) => c.name === n)!.id;
    gmSock.send({ type: 'combat:initiative', combatantId: byName('Wolf'), value: 15 });
    gmSock.send({ type: 'combat:initiative', combatantId: byName('Goblin Warrior 2'), value: 12 });
    gmSock.send({ type: 'combat:initiative', combatantId: byName('Goblin Warrior 1'), value: 12 });
    playerSock.send({ type: 'combat:initiative', combatantId: byName('Wolf'), value: 30 });
    expect(await playerSock.until('error')).toMatchObject({ message: "That's not your character" });
    playerSock.send({ type: 'combat:initiative', combatantId: byName('Ana'), value: 12 });
    expect((await gmSock.until('log', (m) => m.entry.kind === 'chat')).entry).toMatchObject({ text: 'Ana has initiative 12.' });
    const ordered = await playerSock.until('combat', (m) => m.combat!.combatants.every((c) => c.initiative !== null));
    expect(names(ordered)).toEqual(['Wolf', 'Goblin Warrior 1', 'Goblin Warrior 2', 'Ana']);

    // Turns: the first "next" starts round 1; players may only end their own turn.
    gmSock.send({ type: 'combat:turn', dir: 'next' });
    expect((await playerSock.until('log')).entry).toMatchObject({ text: 'Round 1' });
    expect((await playerSock.until('combat')).combat!.activeId).toBe(byName('Wolf'));
    playerSock.send({ type: 'combat:turn', dir: 'next' });
    expect(await playerSock.until('error')).toMatchObject({ message: "It's not your turn" });
    gmSock.send({ type: 'combat:turn', dir: 'next' });
    gmSock.send({ type: 'combat:turn', dir: 'next' });
    gmSock.send({ type: 'combat:turn', dir: 'next' });
    await playerSock.until('combat', (m) => m.combat!.activeId === byName('Ana'));
    playerSock.send({ type: 'combat:turn', dir: 'next' });
    await gmSock.until('log', (m) => m.entry.kind === 'chat' && m.entry.text === 'Round 2');
    expect((await gmSock.until('combat')).combat).toMatchObject({ round: 2, activeId: byName('Wolf') });
    playerSock.send({ type: 'combat:turn', dir: 'prev' });
    expect(await playerSock.until('error')).toMatchObject({ message: "It's not your turn" });
    gmSock.send({ type: 'combat:turn', dir: 'prev' });
    expect((await gmSock.until('combat')).combat).toMatchObject({ round: 1, activeId: byName('Ana') });

    // Removing the active combatant passes the turn on.
    gmSock.send({ type: 'combat:remove', combatantId: byName('Ana') });
    const removed = await gmSock.until('combat');
    expect(names(removed)).toEqual(['Wolf', 'Goblin Warrior 1', 'Goblin Warrior 2']);
    expect(removed.combat).toMatchObject({ round: 2, activeId: byName('Wolf') });
  });

  it('keeps character HP in sync and shows players only what they may see', async () => {
    const { gm, gmSock, playerSock, otherSock, campaignId, characterId } = await encounterTable();
    gmSock.send({ type: 'combat:start' });
    gmSock.send({ type: 'combat:add', source: { kind: 'character', characterId } });
    gmSock.send({ type: 'combat:add', source: { kind: 'monster', monsterId: 'ogre' } });
    gmSock.send({ type: 'combat:add', source: { kind: 'monster', monsterId: 'goblin-warrior', hidden: true, placeToken: true } });
    const gmView = (await gmSock.until('combat', (m) => m.combat?.combatants.length === 3)).combat!;
    const id = (n: string) => gmView.combatants.find((c) => c.name === n)!.id;
    expect(gmView.combatants.find((c) => c.name === 'Ana')).toMatchObject({ characterId, hp: 28, hpMax: 28, ac: 19, status: 'healthy' });
    // The character's existing token is linked.
    expect(gmView.combatants.find((c) => c.name === 'Ana')!.tokenId).not.toBeNull();

    // Players: no hidden goblin, no monster numbers; party characters keep theirs.
    let seen = (await otherSock.until('combat', (m) => m.combat?.combatants.length === 2)).combat!;
    expect(seen.combatants.map((c) => c.name).sort()).toEqual(['Ana', 'Ogre']);
    const ogre = seen.combatants.find((c) => c.name === 'Ogre')!;
    expect(ogre).toEqual({
      id: id('Ogre'),
      name: 'Ogre',
      kind: 'monster',
      tokenId: null,
      characterId: null,
      ownerUserId: null,
      initiative: null,
      status: 'healthy',
      conditions: [],
      hidden: false,
    });
    expect(seen.combatants.find((c) => c.name === 'Ana')).toMatchObject({ hp: 28, ac: 19 });
    // The hidden goblin's token stays off the players' map too.
    const playerScene = await playerSock.until('scene');
    expect(playerScene.scene!.tokens.map((t) => t.name)).toEqual(['Ana']);

    // Bloodied shows as a status, never a number.
    gmSock.send({ type: 'combat:hp', combatantId: id('Ogre'), op: 'damage', amount: 40 });
    expect((await gmSock.until('combat', (m) => m.combat!.combatants.some((c) => c.hp === 28 && c.name === 'Ogre'))).combat).toBeTruthy();
    seen = (await otherSock.until('combat', (m) => m.combat!.combatants.some((c) => c.status === 'bloodied'))).combat!;
    expect(seen.combatants.find((c) => c.name === 'Ogre')).not.toHaveProperty('hp');

    // Damage to a character goes through the sheet, temp HP first.
    gmSock.send({ type: 'combat:hp', combatantId: id('Ana'), op: 'temp', amount: 5 });
    gmSock.send({ type: 'combat:hp', combatantId: id('Ana'), op: 'damage', amount: 8 });
    const sheet = await playerSock.until('characters', (m) => m.characters[0]!.data.state.hp === 25);
    expect(sheet.characters[0]!.data.state.tempHp).toBe(0);
    seen = (await playerSock.until('combat', (m) => m.combat!.combatants.some((c) => c.name === 'Ana' && c.hp === 25))).combat!;
    // ...and sheet edits show up in the tracker.
    playerSock.send({ type: 'character:state', characterId, patch: { hp: 3 } });
    seen = (await gmSock.until('combat', (m) => m.combat!.combatants.some((c) => c.name === 'Ana' && c.hp === 3))).combat!;
    expect(seen.combatants.find((c) => c.name === 'Ana')!.status).toBe('bloodied');

    // Owners may change their own character; nobody else's.
    playerSock.send({ type: 'combat:condition', combatantId: id('Ana'), condition: 'prone', on: true });
    await gmSock.until('characters', (m) => m.characters[0]!.data.state.conditions.includes('prone'));
    otherSock.send({ type: 'combat:hp', combatantId: id('Ana'), op: 'heal', amount: 5 });
    expect(await otherSock.until('error')).toMatchObject({ message: "That's not your character" });
    playerSock.send({ type: 'combat:hp', combatantId: id('Ogre'), op: 'damage', amount: 5 });
    expect(await playerSock.until('error')).toMatchObject({ message: "That's not your character" });
    gmSock.send({ type: 'combat:condition', combatantId: id('Ogre'), condition: 'grappled', on: true });
    seen = (await otherSock.until('combat', (m) => m.combat!.combatants.some((c) => c.conditions.includes('grappled')))).combat!;

    // An initiative roll from the sheet fills in the tracker.
    playerSock.send({ type: 'roll', expr: '1d20 + 1', label: 'Ana: Initiative', visibility: 'public', initiativeFor: characterId });
    const { entry } = await gmSock.until('log', (m) => m.entry.kind === 'roll');
    if (entry.kind !== 'roll') throw new Error('expected roll');
    seen = (await gmSock.until('combat', (m) => m.combat!.combatants.some((c) => c.name === 'Ana' && c.initiative !== null))).combat!;
    expect(seen.combatants.find((c) => c.name === 'Ana')!.initiative).toBe(entry.roll.total);

    // Hidden creatures act without telling players whose turn it is.
    gmSock.send({ type: 'combat:initiative', combatantId: id('Goblin Warrior'), value: 25 });
    gmSock.send({ type: 'combat:turn', dir: 'next' });
    expect((await gmSock.until('combat', (m) => m.combat!.activeId !== null)).combat!.activeId).toBe(id('Goblin Warrior'));
    // The round is announced just before the turn update goes out.
    await otherSock.until('log', (m) => m.entry.kind === 'chat' && m.entry.text === 'Round 1');
    const duringHidden = await otherSock.until('combat');
    expect(duringHidden.combat!.combatants).toHaveLength(2);
    expect(duringHidden.combat!.activeId).toBeNull();

    // Table screens get public information only.
    const { data: display } = await new Client().call('POST', '/api/displays');
    const tv = await Sock.open(`ws://${base}/ws?display=${display.token}`, '');
    await tv.until('display:unpaired');
    await gm.call('POST', `/api/campaigns/${campaignId}/displays`, { code: display.code });
    const tvCombat = (await tv.until('hello')).combat!;
    expect(tvCombat.combatants.map((c) => c.name).sort()).toEqual(['Ana', 'Ogre']);
    for (const c of tvCombat.combatants) expect(c).not.toHaveProperty('hp');
    expect(tvCombat.combatants.find((c) => c.name === 'Ana')!.status).toBe('bloodied');

    // Revealing the goblin reveals its token as well.
    gmSock.send({ type: 'combat:update', combatantId: id('Goblin Warrior'), hidden: false });
    expect((await otherSock.until('scene', (m) => m.scene!.tokens.length === 2)).scene!.tokens.map((t) => t.name)).toContain('Goblin Warrior');
    seen = (await otherSock.until('combat', (m) => m.combat!.combatants.length === 3)).combat!;
    expect(seen.activeId).toBe(id('Goblin Warrior'));
    tv.close();
  });

  it('checks permissions, persists the encounter and ends it', async () => {
    const { gm, gmSock, playerSock, campaignId } = await encounterTable();
    playerSock.send({ type: 'combat:start' });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
    gmSock.send({ type: 'combat:turn', dir: 'next' });
    expect(await gmSock.until('error')).toMatchObject({ message: 'No combat is running' });

    gmSock.send({ type: 'combat:start' });
    await gmSock.until('combat', (m) => m.combat !== null);
    gmSock.send({ type: 'combat:start' });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Combat is already running' });
    playerSock.send({ type: 'combat:add', source: { kind: 'monster', monsterId: 'wolf' } });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
    gmSock.send({ type: 'combat:add', source: { kind: 'monster', monsterId: 'tarrasque-jr' } });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Unknown monster' });
    gmSock.send({ type: 'combat:add', source: { kind: 'custom', name: 'Lair Action', initiativeBonus: 0 } });
    gmSock.send({ type: 'combat:add', source: { kind: 'monster', monsterId: 'wolf', rollHp: true } });
    const view = (await gmSock.until('combat', (m) => m.combat!.combatants.length === 2)).combat!;
    const wolf = view.combatants.find((c) => c.name === 'Wolf')!;
    expect(wolf.hp).toBeGreaterThanOrEqual(2);
    expect(wolf.hp).toBe(wolf.hpMax);
    const lair = view.combatants.find((c) => c.name === 'Lair Action')!;
    gmSock.send({ type: 'combat:hp', combatantId: lair.id, op: 'damage', amount: 3 });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Set hit points for Lair Action first' });
    playerSock.send({ type: 'combat:remove', combatantId: wolf.id });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
    playerSock.send({ type: 'combat:update', combatantId: wolf.id, hidden: true });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });

    // Survives reconnects (and server restarts: it lives in the database).
    gmSock.close();
    const again = await gm.socket(`campaign=${campaignId}`);
    expect((await again.until('hello')).combat!.combatants).toHaveLength(2);

    playerSock.send({ type: 'combat:end' });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
    again.send({ type: 'combat:end' });
    expect((await playerSock.until('log')).entry).toMatchObject({ text: 'Combat ends.' });
    expect((await playerSock.until('combat')).combat).toBeNull();
  });
});

describe('vision', () => {
  /**
   * GM, Ana and Bram on a blank 10×8 scene (50px cells) in play. A wall runs down between columns
   * 4 and 5 with a closed door at row 1. Ana's token is at (1, 1), a goblin at (6, 1).
   */
  async function visionTable() {
    const { gm, player, campaignId } = await campaignWithPlayer();
    const gmSock = await gm.socket(`campaign=${campaignId}`);
    const hello = await gmSock.until('hello');
    const bram = await Client.register('bram', 'Bram');
    await player.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
    await bram.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
    const anaId = (await player.call('GET', '/api/auth/me')).data.user.id as string;
    const bramId = (await bram.call('GET', '/api/auth/me')).data.user.id as string;
    const playerSock = await player.socket(`campaign=${campaignId}`);
    await playerSock.until('hello');
    gmSock.send({ type: 'scene:create', name: 'Keep', fileId: null, width: 500, height: 400, grid: { size: 50 } });
    const sceneId = (await gmSock.until('scenes')).scenes[0]!.id;
    gmSock.send({ type: 'scene:activate', sceneId });
    const wall: Edge[] = [0, 2, 3, 4, 5, 6, 7].map((row) => ({ side: 'left', col: 5, row }));
    gmSock.send({ type: 'map:walls', sceneId, edges: wall, wall: true });
    gmSock.send({ type: 'map:door', sceneId, edge: door, state: 'closed', secret: false });
    gmSock.send({ type: 'token:create', sceneId, name: 'Ana', color: '#3366ff', col: 1, row: 1, ownerUserId: anaId });
    gmSock.send({ type: 'token:create', sceneId, name: 'Goblin', color: '#44aa44', col: 6, row: 1 });
    const { scene } = await gmSock.until('scene', (m) => m.scene?.tokens.length === 2);
    const playerView = (await playerSock.until('scene', (m) => m.scene?.tokens.length === 2)).scene!;
    const token = (name: string) => scene!.tokens.find((t) => t.name === name)!;
    return { gm, bram, campaignId, gmSock, playerSock, sceneId, bramId, playerView, ana: token('Ana'), goblin: token('Goblin') };
  }

  const door: Edge = { side: 'left', col: 5, row: 1 };
  const names = (scene: SceneView | null) => scene!.tokens.map((t) => t.name).sort();
  const mask = (scene: SceneView | null, field: 'visible' | 'dim' | 'fog') => {
    const { cols, rows } = gridGeometry(scene!.grid, scene!.width, scene!.height);
    return FogMask.decode(scene![field] ?? '', cols, rows);
  };

  it('shows players only what their tokens see: not past walls, closed doors or into darkness', async () => {
    const { gmSock, playerSock, sceneId, ana, goblin, playerView } = await visionTable();
    let view = playerView;
    // Vision off: nothing changes.
    expect(view.vision).toEqual({ enabled: false, lighting: 'bright', dynamicFog: false });
    expect(view.visible).toBeUndefined();
    expect(names(view)).toEqual(['Ana', 'Goblin']);

    gmSock.send({ type: 'vision:scene', sceneId, enabled: true });
    view = (await playerSock.until('scene', (m) => m.scene!.vision.enabled)).scene!;
    expect(names(view)).toEqual(['Ana']);
    expect(mask(view, 'visible').isRevealed(4, 6)).toBe(true);
    expect(mask(view, 'visible').isRevealed(6, 1)).toBe(false);
    expect(mask(view, 'dim').isRevealed(4, 6)).toBe(false);
    // Without fog the map itself is known; only creatures are hidden.
    expect(MapData.decode(view.map, 10, 8).blocks({ side: 'left', col: 5, row: 7 })).toBe(true);
    const gmView = (await gmSock.until('scene', (m) => m.scene!.vision.enabled)).scene!;
    expect(names(gmView)).toEqual(['Ana', 'Goblin']);
    expect(gmView.visible).toBeUndefined();

    gmSock.send({ type: 'door:toggle', sceneId, edge: door });
    view = (await playerSock.until('scene', (m) => m.scene!.tokens.length === 2)).scene!;
    expect(mask(view, 'visible').isRevealed(6, 1)).toBe(true);

    // Night falls: Ana has no darkvision and no light, so she sees nothing but still has her token.
    gmSock.send({ type: 'vision:scene', sceneId, lighting: 'dark' });
    view = (await playerSock.until('scene', (m) => m.scene!.vision.lighting === 'dark')).scene!;
    expect(names(view)).toEqual(['Ana']);
    expect(mask(view, 'visible').bits.every((b) => b === 0)).toBe(true);

    // She lights a torch: bright light 20 ft, dim 20 ft further, so the goblin 25 ft away is in dim light.
    playerSock.send({ type: 'vision:token', tokenId: ana.id, light: { preset: 'torch', bright: 20, dim: 20 } });
    view = (await playerSock.until('scene', (m) => m.scene!.tokens.length === 2)).scene!;
    expect(view.tokens.find((t) => t.id === ana.id)!.light).toEqual({ preset: 'torch', bright: 20, dim: 20 });
    expect(mask(view, 'dim').isRevealed(6, 1)).toBe(true);
    expect(mask(view, 'dim').isRevealed(2, 1)).toBe(false);
    expect(mask(view, 'visible').isRevealed(7, 6)).toBe(false);

    // Closing the door shuts the goblin out again.
    gmSock.send({ type: 'door:toggle', sceneId, edge: door });
    view = (await playerSock.until('scene', (m) => m.scene!.tokens.length === 1)).scene!;
    expect(names(view)).toEqual(['Ana']);

    // Players may only light their own token, and only the GM sets senses or scene lighting.
    playerSock.send({ type: 'vision:token', tokenId: goblin.id, light: null });
    expect(await playerSock.until('error')).toMatchObject({ message: "That's not your token" });
    playerSock.send({ type: 'vision:token', tokenId: ana.id, senses: { darkvision: 120 } });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Only the GM can change senses' });
    playerSock.send({ type: 'vision:scene', sceneId, lighting: 'bright' });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
  });

  it("gives character tokens their character's darkvision unless the GM overrides it", async () => {
    const { gmSock, playerSock, sceneId, ana, goblin } = await visionTable();
    gmSock.send({ type: 'token:delete', tokenId: ana.id });
    playerSock.send({ type: 'character:create', data: fighter('Thora', { speciesId: 'dwarf' }) });
    const characterId = (await playerSock.until('characters', (m) => m.characters.length === 1)).characters[0]!.id;
    playerSock.send({ type: 'character:token', characterId });
    gmSock.send({ type: 'vision:scene', sceneId, enabled: true, lighting: 'dark' });
    await gmSock.until('scene', (m) => m.scene!.vision.lighting === 'dark');
    gmSock.send({ type: 'token:move', tokenId: goblin.id, col: 8, row: 6 });

    // Thora stands at (5, 4); darkvision 120 ft sees the goblin in the dark as dim.
    let view = (await playerSock.until('scene', (m) => m.scene!.tokens.some((t) => t.name === 'Goblin' && t.col === 8))).scene!;
    expect(view.vision.lighting).toBe('dark');
    const thora = view.tokens.find((t) => t.name === 'Thora')!;
    expect(thora).toMatchObject({ col: 5, row: 4, characterId });
    expect(mask(view, 'dim').isRevealed(8, 6)).toBe(true);

    // Beyond the darkvision the GM sets instead, the goblin is lost in the dark.
    gmSock.send({ type: 'vision:token', tokenId: thora.id, senses: { darkvision: 10 } });
    view = (await playerSock.until('scene', (m) => m.scene!.tokens.length === 1)).scene!;
    expect(names(view)).toEqual(['Thora']);
    gmSock.send({ type: 'vision:token', tokenId: thora.id, senses: {} });
    await playerSock.until('scene', (m) => m.scene!.tokens.length === 2);

    // A human can't see in the dark: changing species re-sends the view.
    playerSock.send({ type: 'character:update', characterId, data: fighter('Thora') });
    view = (await playerSock.until('scene', (m) => m.scene!.tokens.length === 1)).scene!;
    expect(names(view)).toEqual(['Thora']);
  });

  it('shows table screens what the whole party sees', async () => {
    const { gm, bram, campaignId, gmSock, playerSock, sceneId, bramId } = await visionTable();
    const bramSock = await bram.socket(`campaign=${campaignId}`);
    await bramSock.until('hello');
    gmSock.send({ type: 'token:create', sceneId, name: 'Bram', color: '#aa3366', col: 8, row: 6, ownerUserId: bramId });
    gmSock.send({ type: 'token:create', sceneId, name: 'Orc', color: '#448844', col: 2, row: 6 });
    gmSock.send({ type: 'token:create', sceneId, name: 'Familiar', color: '#888888', col: 3, row: 3 });
    gmSock.send({ type: 'vision:scene', sceneId, enabled: true });
    await gmSock.until('scene', (m) => m.scene!.vision.enabled && m.scene!.tokens.length === 5);
    const { data: display } = await new Client().call('POST', '/api/displays');
    const tv = await Sock.open(`ws://${base}/ws?display=${display.token}`, '');
    await tv.until('display:unpaired');
    await gm.call('POST', `/api/campaigns/${campaignId}/displays`, { code: display.code });

    expect(names((await playerSock.until('scene', (m) => m.scene!.vision.enabled && m.scene!.tokens.length === 3)).scene)).toEqual([
      'Ana',
      'Familiar',
      'Orc',
    ]);
    expect(names((await bramSock.until('scene', (m) => m.scene!.vision.enabled)).scene)).toEqual(['Bram', 'Goblin']);
    const tvView = (await tv.until('hello')).scene!;
    expect(names(tvView)).toEqual(['Ana', 'Bram', 'Familiar', 'Goblin', 'Orc']);
    expect(mask(tvView, 'visible').bits.every((b) => b === 0xff)).toBe(true);
    tv.close();
  });

  it('remembers explored areas with dynamic fog, writing only when something new is seen', async () => {
    const { gmSock, playerSock, sceneId, ana, goblin } = await visionTable();
    gmSock.send({ type: 'vision:scene', sceneId, enabled: true, dynamicFog: true });
    // Dynamic fog turns fog on; what Ana sees is revealed for good.
    const gmView = (await gmSock.until('scene', (m) => m.scene!.fogEnabled)).scene!;
    expect(gmView.vision).toEqual({ enabled: true, lighting: 'bright', dynamicFog: true });
    expect(mask(gmView, 'fog').isRevealed(0, 7)).toBe(true);
    expect(mask(gmView, 'fog').isRevealed(6, 1)).toBe(false);
    let view = (await playerSock.until('scene', (m) => m.scene!.fogEnabled)).scene!;
    expect(MapData.decode(view.map, 10, 8).blocks({ side: 'left', col: 5, row: 7 })).toBe(true);

    // Moving where nothing new comes into view doesn't touch the stored fog.
    const spy = vi.spyOn(Store.prototype, 'updateScene');
    const fogWrites = () => spy.mock.calls.filter(([, patch]) => patch.fog !== undefined).length;
    playerSock.send({ type: 'token:move', tokenId: ana.id, col: 2, row: 1 });
    await gmSock.until('scene', (m) => m.scene!.tokens.some((t) => t.id === ana.id && t.col === 2));
    expect(fogWrites()).toBe(0);

    // Opening the door reveals the other side; once closed again it stays explored, without the goblin.
    gmSock.send({ type: 'door:toggle', sceneId, edge: door });
    await playerSock.until('scene', (m) => m.scene!.tokens.length === 2);
    expect(fogWrites()).toBe(1);
    gmSock.send({ type: 'door:toggle', sceneId, edge: door });
    view = (await playerSock.until('scene', (m) => m.scene!.tokens.length === 1)).scene!;
    expect(fogWrites()).toBe(1);
    spy.mockRestore();
    expect(mask(view, 'fog').isRevealed(7, 1)).toBe(true);
    expect(mask(view, 'visible').isRevealed(7, 1)).toBe(false);

    // The GM can still paint: cells out of sight stay as painted, cells in sight are seen again.
    gmSock.send({ type: 'fog:paint', sceneId, cells: [1 * 10 + 7, 1 * 10 + 1], reveal: false });
    const painted = (await gmSock.until('scene', (m) => !mask(m.scene, 'fog').isRevealed(7, 1))).scene!;
    expect(mask(painted, 'fog').isRevealed(1, 1)).toBe(true);
    gmSock.send({ type: 'fog:paint', sceneId, cells: [7 * 10 + 9], reveal: true });
    view = (await playerSock.until('scene', (m) => mask(m.scene, 'fog').isRevealed(9, 7))).scene!;
    expect(mask(view, 'fog').isRevealed(7, 1)).toBe(false);
    expect(names(view)).toEqual(['Ana']);
    expect(goblin.col).toBe(6);
  });
});

describe('area templates', () => {
  /** GM, Ana (with a token at (2, 2)) and Bram on a live blank 10×8 scene (50px cells), plus a second scene. */
  async function templateTable() {
    const { gm, player, campaignId } = await campaignWithPlayer();
    const gmSock = await gm.socket(`campaign=${campaignId}`);
    const hello = await gmSock.until('hello');
    const other = await Client.register('bram', 'Bram');
    await player.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
    await other.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
    const { data: me } = await player.call('GET', '/api/auth/me');
    const playerSock = await player.socket(`campaign=${campaignId}`);
    const otherSock = await other.socket(`campaign=${campaignId}`);
    await playerSock.until('hello');
    await otherSock.until('hello');
    gmSock.send({ type: 'scene:create', name: 'Back room', fileId: null, width: 300, height: 300, grid: { size: 50 } });
    gmSock.send({ type: 'scene:create', name: 'Hall', fileId: null, width: 500, height: 400, grid: { size: 50 } });
    const { scenes } = await gmSock.until('scenes', (m) => m.scenes.length === 2);
    const [backId, sceneId] = [scenes[0]!.id, scenes[1]!.id];
    gmSock.send({ type: 'scene:activate', sceneId });
    gmSock.send({ type: 'token:create', sceneId, name: 'Ana', color: '#3366ff', col: 2, row: 2, ownerUserId: me.user.id });
    const { scene } = await gmSock.until('scene', (m) => m.scene?.tokens.length === 1);
    await playerSock.until('scene', (m) => m.scene?.tokens.length === 1);
    await otherSock.until('scene', (m) => m.scene?.tokens.length === 1);
    return { gm, campaignId, gmSock, playerSock, otherSock, sceneId, backId, ana: scene!.tokens[0]!, playerId: me.user.id as string };
  }

  const fireball = { shape: 'sphere', size: 20, x: 5, y: 4, angle: 0, color: '#e8743b', label: 'Fireball' } as const;
  const labels = (scene: SceneView | null) => scene?.templates.map((t) => t.label) ?? [];

  it('lets players place templates on the scene in play and everyone see them', async () => {
    const { gm, campaignId, gmSock, playerSock, otherSock, sceneId, backId, playerId } = await templateTable();
    playerSock.send({ type: 'template:place', sceneId, ...fireball, x: 99, y: -3, angle: -90 });
    const { scene } = await otherSock.until('scene', (m) => labels(m.scene).includes('Fireball'));
    // The origin is kept on the map and the angle normalised.
    expect(scene!.templates[0]).toMatchObject({
      sceneId,
      shape: 'sphere',
      size: 20,
      x: 10,
      y: 0,
      angle: 270,
      ownerUserId: playerId,
      tokenId: null,
      hidden: false,
      linger: false,
    });
    expect(labels((await gmSock.until('scene', (m) => labels(m.scene).includes('Fireball'))).scene)).toEqual(['Fireball']);

    // Table screens see them too.
    const { data: display } = await new Client().call('POST', '/api/displays');
    const tv = await Sock.open(`ws://${base}/ws?display=${display.token}`, '');
    await tv.until('display:unpaired');
    await gm.call('POST', `/api/campaigns/${campaignId}/displays`, { code: display.code });
    expect(labels((await tv.until('hello')).scene)).toEqual(['Fireball']);
    tv.close();

    // Not on a scene that isn't in play, which only the GM can use.
    playerSock.send({ type: 'template:place', sceneId: backId, ...fireball });
    expect(await playerSock.until('error')).toMatchObject({ message: 'That scene is not in play' });
    gmSock.send({ type: 'scene:view', sceneId: backId });
    await gmSock.until('scene', (m) => m.scene?.id === backId);
    gmSock.send({ type: 'template:place', sceneId: backId, ...fireball, label: 'Trap' });
    const back = await gmSock.until('scene', (m) => m.scene?.id === backId && m.scene.templates.length === 1);
    expect(back.scene!.templates[0]).toMatchObject({ label: 'Trap', x: 5, y: 4 });

    // Bad shapes and sizes never reach the game.
    playerSock.send({ type: 'template:place', sceneId, ...fireball, shape: 'donut' });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Invalid message' });
    playerSock.send({ type: 'template:place', sceneId, ...fireball, size: 0 });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Invalid message' });
  });

  it('keeps hidden templates from players and table screens', async () => {
    const { gmSock, playerSock, otherSock, sceneId } = await templateTable();
    playerSock.send({ type: 'template:place', sceneId, ...fireball, hidden: true });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Only the GM can hide templates' });

    gmSock.send({ type: 'template:place', sceneId, ...fireball, label: 'Glyph', hidden: true, linger: true });
    await gmSock.until('scene', (m) => m.scene?.templates.length === 1);
    playerSock.send({ type: 'template:place', sceneId, ...fireball, label: 'Web', shape: 'cube', linger: true });
    const gmView = await gmSock.until('scene', (m) => m.scene?.templates.length === 2);
    expect(labels(gmView.scene)).toEqual(['Glyph', 'Web']);
    const seen = await otherSock.until('scene', (m) => labels(m.scene).includes('Web'));
    expect(labels(seen.scene)).toEqual(['Web']);

    // Players can't find, move or remove what they can't see, nor hide what they can.
    const [glyph, web] = gmView.scene!.templates;
    playerSock.send({ type: 'template:delete', templateId: glyph!.id });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Template not found' });
    playerSock.send({ type: 'template:update', templateId: web!.id, hidden: true });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Only the GM can hide templates' });

    // Revealing it shows it to everyone.
    gmSock.send({ type: 'template:update', templateId: glyph!.id, hidden: false });
    expect(labels((await otherSock.until('scene', (m) => m.scene?.templates.length === 2)).scene)).toEqual(['Glyph', 'Web']);
  });

  it('lets owners and the GM move, turn and remove templates, and the GM clear them all', async () => {
    const { gmSock, playerSock, otherSock, sceneId } = await templateTable();
    playerSock.send({ type: 'template:place', sceneId, shape: 'cone', size: 15, x: 3, y: 2.5, angle: 0, color: '#3366ff', label: 'Burning Hands', linger: true });
    const placed = await otherSock.until('scene', (m) => m.scene?.templates.length === 1);
    const cone = placed.scene!.templates[0]!;

    otherSock.send({ type: 'template:update', templateId: cone.id, angle: 90 });
    expect(await otherSock.until('error')).toMatchObject({ message: "That's not your template" });
    otherSock.send({ type: 'template:delete', templateId: cone.id });
    expect(await otherSock.until('error')).toMatchObject({ message: "That's not your template" });

    playerSock.send({ type: 'template:update', templateId: cone.id, x: 4, y: 3.5, angle: 450, label: 'Hands' });
    const moved = await otherSock.until('scene', (m) => m.scene?.templates[0]?.label === 'Hands');
    expect(moved.scene!.templates[0]).toMatchObject({ x: 4, y: 3.5, angle: 90, size: 15 });
    gmSock.send({ type: 'template:update', templateId: cone.id, size: 30 });
    expect((await playerSock.until('scene', (m) => m.scene?.templates[0]?.size === 30)).scene!.templates[0]).toMatchObject({ angle: 90 });
    playerSock.send({ type: 'template:delete', templateId: cone.id });
    await otherSock.until('scene', (m) => m.scene?.templates.length === 0);

    playerSock.send({ type: 'template:place', sceneId, ...fireball, linger: true });
    otherSock.send({ type: 'template:place', sceneId, ...fireball, label: 'Shatter', size: 10, linger: true });
    const two = await gmSock.until('scene', (m) => m.scene?.templates.length === 2);
    gmSock.send({ type: 'template:delete', templateId: two.scene!.templates.find((t) => t.label === 'Shatter')!.id });
    expect(labels((await otherSock.until('scene', (m) => labels(m.scene).join() === 'Fireball')).scene)).toEqual(['Fireball']);
    playerSock.send({ type: 'template:clear', sceneId });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
    gmSock.send({ type: 'template:clear', sceneId });
    await playerSock.until('scene', (m) => m.scene?.templates.length === 0);
  });

  it('moves an Emanation with its creature and hides it with the creature', async () => {
    const { gmSock, playerSock, otherSock, sceneId, ana } = await templateTable();
    const guardians = { type: 'template:place', sceneId, shape: 'emanation', size: 15, x: 0, y: 0, angle: 0, color: '#f1c40f', label: 'Spirit Guardians', linger: true };
    otherSock.send({ ...guardians, tokenId: ana.id });
    expect(await otherSock.until('error')).toMatchObject({ message: "That's not your token" });
    playerSock.send({ ...guardians, shape: 'sphere', tokenId: ana.id });
    expect(await playerSock.until('error')).toMatchObject({ message: 'Only an Emanation can follow a token' });

    playerSock.send({ ...guardians, tokenId: ana.id });
    let seen = await otherSock.until('scene', (m) => m.scene?.templates.length === 1);
    expect(seen.scene!.templates[0]).toMatchObject({ tokenId: ana.id, x: 2, y: 2, span: 1 });

    // It follows the token, and dragging the template itself doesn't detach it.
    playerSock.send({ type: 'token:move', tokenId: ana.id, col: 6, row: 5 });
    seen = await otherSock.until('scene', (m) => m.scene?.templates[0]?.x === 6);
    expect(seen.scene!.templates[0]).toMatchObject({ x: 6, y: 5 });
    playerSock.send({ type: 'template:update', templateId: seen.scene!.templates[0]!.id, x: 1, y: 1, size: 10 });
    seen = await otherSock.until('scene', (m) => m.scene?.templates[0]?.size === 10);
    expect(seen.scene!.templates[0]).toMatchObject({ x: 6, y: 5 });
    gmSock.send({ type: 'token:update', tokenId: ana.id, size: 2 });
    expect((await otherSock.until('scene', (m) => m.scene?.templates[0]?.span === 2)).scene!.templates[0]).toMatchObject({ x: 6, y: 5 });

    // Hiding the creature hides its aura from other players; its owner and the GM still see both.
    gmSock.send({ type: 'token:update', tokenId: ana.id, hidden: true });
    seen = await otherSock.until('scene', (m) => m.scene?.tokens.length === 0);
    expect(seen.scene!.templates).toEqual([]);
    expect((await playerSock.until('scene', (m) => m.scene?.tokens[0]?.hidden === true)).scene!.templates).toHaveLength(1);

    // Removing the creature removes its aura.
    gmSock.send({ type: 'token:delete', tokenId: ana.id });
    expect((await gmSock.until('scene', (m) => m.scene?.tokens.length === 0)).scene!.templates).toEqual([]);
  });

  it('clears one-shot templates when the turn passes or their owner places another', async () => {
    const { gmSock, playerSock, otherSock, sceneId } = await templateTable();
    playerSock.send({ type: 'template:place', sceneId, ...fireball });
    playerSock.send({ type: 'template:place', sceneId, ...fireball, label: 'Fireball 2', x: 2 });
    await gmSock.until('scene', (m) => labels(m.scene).includes('Fireball 2'));
    otherSock.send({ type: 'template:place', sceneId, ...fireball, label: 'Cloudkill', linger: true });
    const seen = await gmSock.until('scene', (m) => labels(m.scene).includes('Cloudkill'));
    expect(labels(seen.scene)).toEqual(['Fireball 2', 'Cloudkill']);

    gmSock.send({ type: 'combat:start', fromScene: true });
    await gmSock.until('combat', (m) => m.combat !== null);
    gmSock.send({ type: 'combat:turn', dir: 'next' });
    const after = await otherSock.until('scene', (m) => !labels(m.scene).includes('Fireball 2') && labels(m.scene).includes('Cloudkill'));
    expect(labels(after.scene)).toEqual(['Cloudkill']);
  });
});

describe('handouts', () => {
  /** GM, Ana and Bram (players), and a paired table screen. */
  async function handoutTable() {
    const { gm, player, campaignId } = await campaignWithPlayer();
    const gmSock = await gm.socket(`campaign=${campaignId}`);
    const hello = await gmSock.until('hello');
    expect(hello.handouts).toEqual([]);
    const bram = await Client.register('bram', 'Bram');
    await player.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
    await bram.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
    const anaId = (await player.call('GET', '/api/auth/me')).data.user.id as string;
    const bramId = (await bram.call('GET', '/api/auth/me')).data.user.id as string;
    const anaSock = await player.socket(`campaign=${campaignId}`);
    const bramSock = await bram.socket(`campaign=${campaignId}`);
    await anaSock.until('hello');
    await bramSock.until('hello');

    const { data: display } = await new Client().call('POST', '/api/displays');
    const tv = await Sock.open(`ws://${base}/ws?display=${display.token}`, '');
    await tv.until('display:unpaired');
    await gm.call('POST', `/api/campaigns/${campaignId}/displays`, { code: display.code });
    const tvHello = await tv.until('hello');
    expect(tvHello.handouts).toEqual([]);
    expect(tvHello.showcase).toBeNull();
    return { gm, player, bram, campaignId, gmSock, anaSock, bramSock, tv, anaId, bramId, displayToken: display.token as string };
  }

  const titles = (m: { handouts: { title: string }[] }) => m.handouts.map((h) => h.title);

  it('shares handouts with everyone or chosen players, and never leaks the rest', async () => {
    const { gm, player, bram, campaignId, gmSock, anaSock, bramSock, tv, anaId } = await handoutTable();
    const { data: image } = await gm.call('POST', `/api/campaigns/${campaignId}/files`, new Uint8Array(PNG));

    // A draft stays with the GM.
    gmSock.send({ type: 'handout:create', title: 'Secret letter', text: 'Dear Iarno,\n\nThe spiders…', fileId: null, audience: 'gm' });
    const drafted = await gmSock.until('handouts', (m) => m.handouts.length === 1);
    const letter = drafted.handouts[0]!;
    expect(letter).toMatchObject({ title: 'Secret letter', audience: 'gm', sharedAt: null, imageUrl: null, userIds: [] });
    expect((await anaSock.until('handouts')).handouts).toEqual([]);
    expect((await bramSock.until('handouts')).handouts).toEqual([]);

    // Shared with Ana only: Bram never receives it, live or on reconnect.
    gmSock.send({ type: 'handout:create', title: 'Map of Phandalin', text: '', fileId: image.id, audience: 'players', userIds: [anaId] });
    const shared = await gmSock.until('handouts', (m) => m.handouts.length === 2);
    const map = shared.handouts.find((h) => h.title === 'Map of Phandalin')!;
    expect(map).toMatchObject({ imageUrl: image.url, audience: 'players', userIds: [anaId] });
    expect(map.sharedAt).not.toBeNull();
    const anaView = await anaSock.until('handouts', (m) => m.handouts.length === 1);
    expect(anaView.handouts).toEqual([{ id: map.id, title: 'Map of Phandalin', text: '', imageUrl: image.url, sharedAt: map.sharedAt, unread: true }]);
    expect((await bramSock.until('handouts')).handouts).toEqual([]);
    bramSock.close();
    const bramAgain = await bram.socket(`campaign=${campaignId}`);
    expect((await bramAgain.until('hello')).handouts).toEqual([]);

    // Players can't author handouts or open ones that aren't theirs.
    anaSock.send({ type: 'handout:create', title: 'Forged', text: '', fileId: null, audience: 'all' });
    expect(await anaSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
    anaSock.send({ type: 'handout:read', handoutId: letter.id });
    expect(await anaSock.until('error')).toMatchObject({ message: 'Handout not found' });
    bramAgain.send({ type: 'handout:read', handoutId: map.id });
    expect(await bramAgain.until('error')).toMatchObject({ message: 'Handout not found' });

    // Reading clears the unread marker; a change while shared sets it again.
    anaSock.send({ type: 'handout:read', handoutId: map.id });
    expect((await anaSock.until('handouts')).handouts[0]).toMatchObject({ id: map.id, unread: false });
    gmSock.send({ type: 'handout:update', handoutId: map.id, text: 'X marks the hideout.' });
    expect((await anaSock.until('handouts')).handouts[0]).toMatchObject({ text: 'X marks the hideout.', unread: true });

    // Shared with everyone, newest first for players.
    gmSock.send({ type: 'handout:update', handoutId: letter.id, audience: 'all' });
    expect(titles(await bramAgain.until('handouts', (m) => m.handouts.length === 1))).toEqual(['Secret letter']);
    expect(titles(await anaSock.until('handouts', (m) => m.handouts.length === 2))).toEqual(['Secret letter', 'Map of Phandalin']);
    const anaHello = await (await player.socket(`campaign=${campaignId}`)).until('hello');
    expect(titles(anaHello)).toEqual(['Secret letter', 'Map of Phandalin']);

    // Un-sharing makes it a draft again; deleting removes it.
    gmSock.send({ type: 'handout:update', handoutId: letter.id, audience: 'gm' });
    expect((await bramAgain.until('handouts')).handouts).toEqual([]);
    const unshared = await gmSock.until('handouts', (m) => m.handouts.some((h) => h.id === letter.id && h.audience === 'gm'));
    expect(unshared.handouts.find((h) => h.id === letter.id)!.sharedAt).toBeNull();
    gmSock.send({ type: 'handout:delete', handoutId: map.id });
    expect((await anaSock.until('handouts', (m) => m.handouts.length === 0)).handouts).toEqual([]);
    expect(titles(await gmSock.until('handouts', (m) => m.handouts.length === 1))).toEqual(['Secret letter']);

    // Recipients must be players here, and images must belong to the campaign.
    const { data: gmMe } = await gm.call('GET', '/api/auth/me');
    gmSock.send({ type: 'handout:update', handoutId: letter.id, audience: 'players', userIds: [gmMe.user.id] });
    expect(await gmSock.until('error')).toMatchObject({ message: 'That player is not in this campaign' });
    const { data: other } = await gm.call('POST', '/api/campaigns', { name: 'Other' });
    const { data: foreign } = await gm.call('POST', `/api/campaigns/${other.id}/files`, new Uint8Array(PNG));
    gmSock.send({ type: 'handout:update', handoutId: letter.id, fileId: foreign.id });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Image not found' });
    const { data: song } = await gm.call('POST', `/api/campaigns/${campaignId}/files`, AUDIO.ogg);
    gmSock.send({ type: 'handout:create', title: 'Song', text: '', fileId: song.id, audience: 'all' });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Image not found' });

    // Table screens never receive handout lists.
    tv.send({ type: 'handout:read', handoutId: letter.id });
    gmSock.send({ type: 'chat', text: 'done', visibility: 'public' });
    const seen: string[] = [];
    for (;;) {
      const msg = await tv.next();
      seen.push(msg.type);
      if (msg.type === 'log') break;
    }
    expect(seen).not.toContain('handouts');
  });

  it('shows handouts and images over the map on table screens, and on players only when asked', async () => {
    const { gm, player, campaignId, gmSock, anaSock, tv, displayToken } = await handoutTable();
    gmSock.send({ type: 'handout:create', title: 'Wanted poster', text: 'Reward: 50 gp', fileId: null, audience: 'gm' });
    const posterId = (await gmSock.until('handouts', (m) => m.handouts.length === 1)).handouts[0]!.id;

    // A draft shown on the table reaches the table and the GM, not players.
    gmSock.send({ type: 'showcase:show', handoutId: posterId, toPlayers: false });
    const onTv = await tv.until('showcase');
    expect(onTv.showcase).toMatchObject({ handoutId: posterId, title: 'Wanted poster', text: 'Reward: 50 gp', imageUrl: null, toPlayers: false });
    expect((await gmSock.until('showcase')).showcase).toEqual(onTv.showcase);
    expect((await anaSock.until('showcase')).showcase).toBeNull();

    // Editing what's shown updates it in place; players still don't get it.
    gmSock.send({ type: 'handout:update', handoutId: posterId, text: 'Reward: 100 gp' });
    const edited = await tv.until('showcase');
    expect(edited.showcase).toMatchObject({ id: onTv.showcase!.id, text: 'Reward: 100 gp' });
    expect((await anaSock.until('showcase')).showcase).toBeNull();

    // Any uploaded image, also on players' screens.
    const { data: image } = await gm.call('POST', `/api/campaigns/${campaignId}/files`, new Uint8Array(PNG));
    gmSock.send({ type: 'showcase:show', fileId: image.id, title: 'The dragon', toPlayers: true });
    const forAna = await anaSock.until('showcase', (m) => m.showcase !== null);
    expect(forAna.showcase).toMatchObject({ handoutId: null, title: 'The dragon', imageUrl: image.url, toPlayers: true });
    expect((await tv.until('showcase')).showcase).toEqual(forAna.showcase);

    // Late joiners see what's on the table.
    const tv2 = await Sock.open(`ws://${base}/ws?display=${displayToken}`, '');
    expect((await tv2.until('hello')).showcase).toEqual(forAna.showcase);
    const ana2 = await player.socket(`campaign=${campaignId}`);
    expect((await ana2.until('hello')).showcase).toEqual(forAna.showcase);

    // Only the GM controls the table.
    anaSock.send({ type: 'showcase:clear' });
    expect(await anaSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
    gmSock.send({ type: 'showcase:show', toPlayers: false });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Nothing to show' });

    // Back to the map.
    gmSock.send({ type: 'showcase:clear' });
    expect((await tv2.until('showcase')).showcase).toBeNull();
    expect((await ana2.until('showcase')).showcase).toBeNull();

    // Deleting a handout that's on show takes it down.
    gmSock.send({ type: 'showcase:show', handoutId: posterId, toPlayers: true });
    await tv2.until('showcase', (m) => m.showcase?.handoutId === posterId);
    gmSock.send({ type: 'handout:delete', handoutId: posterId });
    expect((await tv2.until('showcase')).showcase).toBeNull();
    tv.close();
    tv2.close();
  });
});

describe('soundboard', () => {
  it('lets the GM manage tracks and keeps every screen on the same playback state', async () => {
    const { gm, player, campaignId } = await campaignWithPlayer();
    const gmSock = await gm.socket(`campaign=${campaignId}`);
    const hello = await gmSock.until('hello');
    expect(hello.tracks).toEqual([]);
    expect(hello.audio).toMatchObject({ layers: [], volume: 1 });
    await player.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
    const anaSock = await player.socket(`campaign=${campaignId}`);
    const anaHello = await anaSock.until('hello');
    expect(anaHello.tracks).toBeUndefined();
    const { data: display } = await new Client().call('POST', '/api/displays');
    const tv = await Sock.open(`ws://${base}/ws?display=${display.token}`, '');
    await tv.until('display:unpaired');
    await gm.call('POST', `/api/campaigns/${campaignId}/displays`, { code: display.code });
    expect((await tv.until('hello')).tracks).toBeUndefined();

    const upload = async (body: Uint8Array) => (await gm.call('POST', `/api/campaigns/${campaignId}/files`, body)).data as { id: string; url: string };
    const [mp3, ogg, wav, png] = await Promise.all([upload(AUDIO.mp3), upload(AUDIO.ogg), upload(AUDIO.wav), upload(new Uint8Array(PNG))]);

    // Only the GM manages tracks, and only with this campaign's audio files.
    anaSock.send({ type: 'track:create', name: 'Mine', fileId: mp3.id, kind: 'music', loop: true, volume: 1 });
    expect(await anaSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
    gmSock.send({ type: 'track:create', name: 'Picture', fileId: png.id, kind: 'music', loop: true, volume: 1 });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Audio file not found' });

    const add = async (name: string, file: { id: string }, kind: string, loop: boolean, volume: number, duration: number | null) => {
      gmSock.send({ type: 'track:create', name, fileId: file.id, kind, loop, volume, duration });
      const { tracks } = await gmSock.until('tracks', (m) => m.tracks.some((t) => t.name === name));
      return tracks.find((t) => t.name === name)!;
    };
    const tavern = await add('Tavern', mp3, 'music', true, 0.8, 120);
    expect(tavern).toMatchObject({ fileId: mp3.id, url: mp3.url, kind: 'music', loop: true, volume: 0.8, duration: 120 });
    const rain = await add('Rain', ogg, 'ambience', true, 0.6, null);
    const battle = await add('Battle', wav, 'music', true, 1, 90);
    const door = await add('Door', wav, 'effect', false, 0.9, 1.5);

    const layerNames = (m: { audio: { layers: { name: string }[] } }) => m.audio.layers.map((l) => l.name);

    // Music plus an ambience layer; starting other music replaces the old one.
    gmSock.send({ type: 'audio:play', trackId: tavern.id });
    const started = await tv.until('audio');
    expect(started.audio.layers).toEqual([
      expect.objectContaining({ trackId: tavern.id, url: mp3.url, kind: 'music', loop: true, volume: 0.8, playing: true, position: 0 }),
    ]);
    expect(started.audio.serverTime - started.audio.layers[0]!.startedAt).toBeGreaterThanOrEqual(0);
    expect(await anaSock.until('audio')).toEqual(started);
    gmSock.send({ type: 'audio:play', trackId: rain.id });
    expect(layerNames(await tv.until('audio'))).toEqual(['Tavern', 'Rain']);
    gmSock.send({ type: 'audio:play', trackId: battle.id });
    expect(layerNames(await tv.until('audio'))).toEqual(['Rain', 'Battle']);

    // Volumes: per layer and master.
    gmSock.send({ type: 'audio:volume', trackId: rain.id, volume: 0.3 });
    expect((await tv.until('audio')).audio.layers[0]).toMatchObject({ trackId: rain.id, volume: 0.3 });
    gmSock.send({ type: 'audio:volume', trackId: null, volume: 0.5 });
    expect((await tv.until('audio')).audio.volume).toBe(0.5);
    gmSock.send({ type: 'audio:volume', trackId: tavern.id, volume: 0.5 });
    expect(await gmSock.until('error')).toMatchObject({ message: "That track isn't playing" });

    // One-shot effects play once for whoever is connected and don't join the shared state.
    gmSock.send({ type: 'audio:play', trackId: door.id });
    expect(await tv.until('audio:effect')).toMatchObject({ trackId: door.id, url: wav.url, volume: 0.9 });
    expect(await anaSock.until('audio:effect')).toMatchObject({ trackId: door.id });

    // Pause keeps the position; late joiners get the state with a server timestamp to seek by.
    await new Promise((r) => setTimeout(r, 40));
    gmSock.send({ type: 'audio:pause', trackId: battle.id });
    const paused = (await tv.until('audio')).audio.layers.find((l) => l.trackId === battle.id)!;
    expect(paused.playing).toBe(false);
    expect(paused.position).toBeGreaterThanOrEqual(0.03);
    const late = await (await player.socket(`campaign=${campaignId}`)).until('hello');
    expect(late.audio.volume).toBe(0.5);
    const lateRain = late.audio.layers.find((l) => l.trackId === rain.id)!;
    expect(lateRain).toMatchObject({ playing: true, volume: 0.3 });
    expect(late.audio.serverTime - lateRain.startedAt).toBeGreaterThanOrEqual(40);
    expect(late.audio.layers.find((l) => l.trackId === battle.id)).toMatchObject({ playing: false, position: paused.position });

    // Resuming continues from where it paused.
    gmSock.send({ type: 'audio:play', trackId: battle.id });
    const resumed = (await tv.until('audio')).audio;
    const battleLayer = resumed.layers.find((l) => l.trackId === battle.id)!;
    expect(battleLayer.playing).toBe(true);
    expect(resumed.serverTime - battleLayer.startedAt).toBeGreaterThanOrEqual(paused.position * 1000 - 1);

    // Players can't touch playback.
    anaSock.send({ type: 'audio:stop-all' });
    expect(await anaSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });

    // Track edits apply to what's playing; deleting a track stops it.
    gmSock.send({ type: 'track:update', trackId: rain.id, name: 'Storm', loop: false });
    expect((await tv.until('audio')).audio.layers[0]).toMatchObject({ name: 'Storm', loop: false });
    gmSock.send({ type: 'track:delete', trackId: rain.id });
    expect(layerNames(await tv.until('audio'))).toEqual(['Battle']);
    expect((await gmSock.until('tracks', (m) => m.tracks.length === 3)).tracks.map((t) => t.name)).toEqual(['Tavern', 'Battle', 'Door']);
    gmSock.send({ type: 'audio:stop', trackId: battle.id });
    expect((await tv.until('audio')).audio.layers).toEqual([]);
    gmSock.send({ type: 'audio:play', trackId: tavern.id });
    await tv.until('audio', (m) => m.audio.layers.length === 1);
    gmSock.send({ type: 'audio:stop-all' });
    expect((await tv.until('audio')).audio.layers).toEqual([]);
    tv.close();
  });
});
