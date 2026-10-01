import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { ServerMessage, WikiPageView } from '@dnd/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildApp } from './app';
import { openDb } from './db';

type App = Awaited<ReturnType<typeof buildApp>>;

let app: App;
let base: string;
let uploadsDir: string;

beforeEach(async () => {
  uploadsDir = mkdtempSync(path.join(tmpdir(), 'dnd-table-wiki-test-'));
  app = await buildApp({ db: openDb(':memory:'), uploadsDir });
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  await app.close();
  rmSync(uploadsDir, { recursive: true, force: true });
});

// 1×1 transparent PNG and a minimal Ogg page, as in app.test.ts.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0, 2, ...new Array(58).fill(0)]);

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

  private constructor(readonly ws: WebSocket) {
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

  async until<T extends ServerMessage['type']>(
    type: T,
    pred: (msg: Extract<ServerMessage, { type: T }>) => boolean = () => true,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    for (;;) {
      const msg = await this.next();
      if (msg.type === type && pred(msg as Extract<ServerMessage, { type: T }>)) return msg as Extract<ServerMessage, { type: T }>;
    }
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }
}

/** GM, Ana and Bram (players), and a paired table screen, all connected. */
async function wikiTable() {
  const gm = await Client.register('dungeon', 'Dungeon Master');
  const ana = await Client.register('ana', 'Ana');
  const bram = await Client.register('bram', 'Bram');
  const { data: campaign } = await gm.call('POST', '/api/campaigns', { name: 'Lost Mine' });
  const campaignId = campaign.id as string;
  const gmSock = await gm.socket(`campaign=${campaignId}`);
  const hello = await gmSock.until('hello');
  expect(hello.wiki).toEqual([]);
  await ana.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
  await bram.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
  const anaId = (await ana.call('GET', '/api/auth/me')).data.user.id as string;
  const bramId = (await bram.call('GET', '/api/auth/me')).data.user.id as string;
  const anaSock = await ana.socket(`campaign=${campaignId}`);
  const bramSock = await bram.socket(`campaign=${campaignId}`);
  expect((await anaSock.until('hello')).wiki).toEqual([]);
  expect((await bramSock.until('hello')).wiki).toEqual([]);

  const { data: display } = await new Client().call('POST', '/api/displays');
  const tv = await Sock.open(`ws://${base}/ws?display=${display.token}`, '');
  await tv.until('display:unpaired');
  await gm.call('POST', `/api/campaigns/${campaignId}/displays`, { code: display.code });
  expect((await tv.until('hello')).wiki).toEqual([]);
  return { gm, ana, bram, campaignId, gmSock, anaSock, bramSock, tv, anaId, bramId };
}

const titles = (m: { wiki?: WikiPageView[]; pages?: WikiPageView[] }) => (m.wiki ?? m.pages ?? []).map((p) => p.title);
const page = (fields: Record<string, unknown>) => ({ type: 'wiki:create', category: 'npc', body: '', audience: 'gm', ...fields });

describe('wiki pages', () => {
  it('lets only the GM write pages and shares them with everyone or chosen players', async () => {
    const { ana, bram, campaignId, gmSock, anaSock, bramSock, tv, anaId } = await wikiTable();

    // GM-only pages stay with the GM, secret notes and all.
    gmSock.send(
      page({
        title: 'Gundren Rockseeker',
        aliases: ['Gundren', ' gundren ', 'Gundren Rockseeker'],
        tags: ['dwarf', 'Dwarf', 'patron'],
        body: 'A dwarf who hired the party to escort a wagon to [[Phandalin]].',
        secret: 'Captured by the Cragmaw goblins.',
      }),
    );
    const created = await gmSock.until('wiki', (m) => m.pages.length === 1);
    const gundren = created.pages[0]!;
    expect(gundren).toMatchObject({
      title: 'Gundren Rockseeker',
      aliases: ['Gundren'],
      tags: ['dwarf', 'patron'],
      category: 'npc',
      audience: 'gm',
      userIds: [],
      secret: 'Captured by the Cragmaw goblins.',
      authorName: 'Dungeon Master',
      imageUrl: null,
      fileId: null,
    });
    expect((await anaSock.until('wiki')).pages).toEqual([]);
    expect((await bramSock.until('wiki')).pages).toEqual([]);

    // Players can't write, edit or delete pages.
    anaSock.send(page({ title: 'Forged', audience: 'all' }));
    expect(await anaSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
    anaSock.send({ type: 'wiki:update', pageId: gundren.id, audience: 'all' });
    expect(await anaSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });
    anaSock.send({ type: 'wiki:delete', pageId: gundren.id });
    expect(await anaSock.until('error')).toMatchObject({ message: 'Only the GM can do that' });

    // Shared with Ana only: she gets it without the secret notes or who else can see it; Bram never does.
    gmSock.send({ type: 'wiki:update', pageId: gundren.id, audience: 'players', userIds: [anaId] });
    const forAna = (await anaSock.until('wiki', (m) => m.pages.length === 1)).pages[0]!;
    expect(forAna).toEqual({
      id: gundren.id,
      title: 'Gundren Rockseeker',
      aliases: ['Gundren'],
      category: 'npc',
      tags: ['dwarf', 'patron'],
      imageUrl: null,
      body: gundren.body,
      authorName: 'Dungeon Master',
      createdAt: gundren.createdAt,
      updatedAt: gundren.createdAt,
    });
    expect((await bramSock.until('wiki')).pages).toEqual([]);

    // The same on reconnect.
    const anaAgain = await ana.socket(`campaign=${campaignId}`);
    expect((await anaAgain.until('hello')).wiki).toEqual([forAna]);
    const bramAgain = await bram.socket(`campaign=${campaignId}`);
    expect((await bramAgain.until('hello')).wiki).toEqual([]);

    // Everyone, sorted by title.
    gmSock.send(page({ title: 'Phandalin', category: 'location', audience: 'all', secret: 'The Redbrands hide under Tresendar Manor.' }));
    expect(titles(await bramAgain.until('wiki', (m) => m.pages.length === 1))).toEqual(['Phandalin']);
    const both = await anaAgain.until('wiki', (m) => m.pages.length === 2);
    expect(titles(both)).toEqual(['Gundren Rockseeker', 'Phandalin']);
    expect(JSON.stringify(both)).not.toContain('Tresendar');

    // Deleting removes it everywhere.
    gmSock.send({ type: 'wiki:delete', pageId: gundren.id });
    expect(titles(await anaAgain.until('wiki', (m) => m.pages.length === 1))).toEqual(['Phandalin']);
    expect(titles(await gmSock.until('wiki', (m) => m.pages.length === 1 && m.pages[0]!.title === 'Phandalin'))).toEqual(['Phandalin']);
    gmSock.send({ type: 'wiki:delete', pageId: gundren.id });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Page not found' });

    // Table screens never receive pages.
    gmSock.send({ type: 'chat', text: 'done', visibility: 'public' });
    const seen: string[] = [];
    for (;;) {
      const msg = await tv.next();
      seen.push(msg.type);
      if (msg.type === 'log') break;
    }
    expect(seen).not.toContain('wiki');
    tv.close();
  });

  it('never sends secret notes to players, and secret-only edits look like no change to them', async () => {
    const { gmSock, anaSock } = await wikiTable();
    gmSock.send(page({ title: 'Glasstaff', audience: 'all', body: 'A wizard in a dark cloak.', secret: 'He is Iarno Albrek.' }));
    const shared = (await anaSock.until('wiki', (m) => m.pages.length === 1)).pages[0]!;
    expect(shared).not.toHaveProperty('secret');
    expect(JSON.stringify(shared)).not.toContain('Iarno');

    const gmPage = (await gmSock.until('wiki', (m) => m.pages.length === 1)).pages[0]!;
    gmSock.send({ type: 'wiki:update', pageId: gmPage.id, secret: 'He is Iarno Albrek, and he serves the Black Spider.' });
    const gmAfter = (await gmSock.until('wiki', (m) => m.pages[0]?.secret?.includes('Spider') ?? false)).pages[0]!;
    expect(gmAfter.updatedAt > gmPage.updatedAt).toBe(true);
    const anaAfter = (await anaSock.until('wiki')).pages[0]!;
    expect(anaAfter).toEqual(shared);

    // A visible change moves the player's timestamp.
    gmSock.send({ type: 'wiki:update', pageId: gmPage.id, body: 'A wizard in a dark cloak, with a glass staff.' });
    const anaEdited = (await anaSock.until('wiki')).pages[0]!;
    expect(anaEdited.body).toContain('glass staff');
    expect(anaEdited.updatedAt > shared.updatedAt).toBe(true);
  });

  it('sends pages to players as they gain or lose access', async () => {
    const { gmSock, anaSock, bramSock, anaId, bramId } = await wikiTable();
    gmSock.send(page({ title: 'Cragmaw Hideout', category: 'location' }));
    const id = (await gmSock.until('wiki', (m) => m.pages.length === 1)).pages[0]!.id;
    await anaSock.until('wiki');
    await bramSock.until('wiki');

    gmSock.send({ type: 'wiki:update', pageId: id, audience: 'players', userIds: [anaId, bramId] });
    expect(titles(await anaSock.until('wiki'))).toEqual(['Cragmaw Hideout']);
    expect(titles(await bramSock.until('wiki'))).toEqual(['Cragmaw Hideout']);

    // Bram loses it, Ana keeps it.
    gmSock.send({ type: 'wiki:update', pageId: id, userIds: [anaId] });
    expect(titles(await anaSock.until('wiki'))).toEqual(['Cragmaw Hideout']);
    expect(titles(await bramSock.until('wiki'))).toEqual([]);

    // Back to GM only: nobody has it, and the recipients are forgotten.
    gmSock.send({ type: 'wiki:update', pageId: id, audience: 'gm' });
    expect(titles(await anaSock.until('wiki'))).toEqual([]);
    expect(titles(await bramSock.until('wiki'))).toEqual([]);
    expect((await gmSock.until('wiki', (m) => m.pages[0]?.audience === 'gm')).pages[0]!.userIds).toEqual([]);

    // Everyone again.
    gmSock.send({ type: 'wiki:update', pageId: id, audience: 'all' });
    expect(titles(await anaSock.until('wiki'))).toEqual(['Cragmaw Hideout']);
    expect(titles(await bramSock.until('wiki'))).toEqual(['Cragmaw Hideout']);

    // Recipients must be players of this campaign.
    gmSock.send({ type: 'wiki:update', pageId: id, audience: 'players', userIds: ['nobody'] });
    expect(await gmSock.until('error')).toMatchObject({ message: 'That player is not in this campaign' });
  });

  it('keeps titles and aliases unique, ignoring case', async () => {
    const { gmSock } = await wikiTable();
    gmSock.send(page({ title: 'Gundren Rockseeker', aliases: ['Gundren'] }));
    gmSock.send(page({ title: 'Sildar Hallwinter' }));
    const pages = (await gmSock.until('wiki', (m) => m.pages.length === 2)).pages;
    const sildar = pages.find((p) => p.title === 'Sildar Hallwinter')!;

    gmSock.send(page({ title: 'gundren  ROCKSEEKER' }));
    expect(await gmSock.until('error')).toMatchObject({ message: 'There is already a page called "Gundren Rockseeker"' });
    gmSock.send(page({ title: 'GUNDREN' }));
    expect(await gmSock.until('error')).toMatchObject({ message: '"GUNDREN" is already another name for "Gundren Rockseeker"' });
    gmSock.send(page({ title: 'Nundro Rockseeker', aliases: ['gundren rockseeker'] }));
    expect(await gmSock.until('error')).toMatchObject({ message: 'There is already a page called "Gundren Rockseeker"' });
    gmSock.send({ type: 'wiki:update', pageId: sildar.id, title: 'Gundren' });
    expect(await gmSock.until('error')).toMatchObject({ message: '"Gundren" is already another name for "Gundren Rockseeker"' });

    // Renaming a page to a different case of its own name is fine.
    gmSock.send({ type: 'wiki:update', pageId: sildar.id, title: 'SILDAR Hallwinter', aliases: ['Sildar'] });
    const renamed = await gmSock.until('wiki');
    expect(renamed.pages.find((p) => p.id === sildar.id)).toMatchObject({ title: 'SILDAR Hallwinter', aliases: ['Sildar'] });

    // Brackets and pipes would break [[links]].
    gmSock.send(page({ title: 'The [[Lost]] Mine' }));
    expect(await gmSock.until('error')).toMatchObject({ message: 'Invalid message' });
    gmSock.send(page({ title: 'Wave|Echo' }));
    expect(await gmSock.until('error')).toMatchObject({ message: 'Invalid message' });
    gmSock.send(page({ title: '   ' }));
    expect(await gmSock.until('error')).toMatchObject({ message: 'Invalid message' });
    gmSock.send(page({ title: 'Somewhere', category: 'planet' }));
    expect(await gmSock.until('error')).toMatchObject({ message: 'Invalid message' });
  });

  it('only accepts images uploaded to the same campaign', async () => {
    const { gm, campaignId, gmSock, anaSock } = await wikiTable();
    const { data: image } = await gm.call('POST', `/api/campaigns/${campaignId}/files`, new Uint8Array(PNG));
    const { data: other } = await gm.call('POST', '/api/campaigns', { name: 'Other' });
    const { data: foreign } = await gm.call('POST', `/api/campaigns/${other.id}/files`, new Uint8Array(PNG));
    const { data: song } = await gm.call('POST', `/api/campaigns/${campaignId}/files`, OGG);
    expect(song.kind).toBe('audio');

    gmSock.send(page({ title: 'Foreign', fileId: foreign.id }));
    expect(await gmSock.until('error')).toMatchObject({ message: 'Image not found' });
    gmSock.send(page({ title: 'Song', fileId: song.id }));
    expect(await gmSock.until('error')).toMatchObject({ message: 'Image not found' });
    gmSock.send(page({ title: 'Missing', fileId: 'no-such-file' }));
    expect(await gmSock.until('error')).toMatchObject({ message: 'Image not found' });

    gmSock.send(page({ title: 'Sildar Hallwinter', fileId: image.id, audience: 'all' }));
    const gmPage = (await gmSock.until('wiki', (m) => m.pages.length === 1)).pages[0]!;
    expect(gmPage).toMatchObject({ fileId: image.id, imageUrl: image.url });
    expect((await anaSock.until('wiki', (m) => m.pages.length === 1)).pages[0]).toMatchObject({ imageUrl: image.url });

    gmSock.send({ type: 'wiki:update', pageId: gmPage.id, fileId: foreign.id });
    expect(await gmSock.until('error')).toMatchObject({ message: 'Image not found' });
    gmSock.send({ type: 'wiki:update', pageId: gmPage.id, fileId: null });
    expect((await anaSock.until('wiki')).pages[0]).toMatchObject({ imageUrl: null });
  });

  it('does not let a GM touch pages of another campaign', async () => {
    const { gm, gmSock } = await wikiTable();
    gmSock.send(page({ title: 'Here' }));
    const id = (await gmSock.until('wiki', (m) => m.pages.length === 1)).pages[0]!.id;
    const { data: other } = await gm.call('POST', '/api/campaigns', { name: 'Other' });
    const otherSock = await gm.socket(`campaign=${other.id}`);
    expect((await otherSock.until('hello')).wiki).toEqual([]);
    otherSock.send({ type: 'wiki:update', pageId: id, body: 'hijacked' });
    expect(await otherSock.until('error')).toMatchObject({ message: 'Page not found' });
    otherSock.send({ type: 'wiki:delete', pageId: id });
    expect(await otherSock.until('error')).toMatchObject({ message: 'Page not found' });
    // A page with the same title is fine in another campaign.
    otherSock.send(page({ title: 'Here' }));
    expect(titles(await otherSock.until('wiki'))).toEqual(['Here']);
  });
});
