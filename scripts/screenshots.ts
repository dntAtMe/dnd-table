// Takes the screenshots in docs/screenshots from a demo campaign.
//
//   pnpm screenshots
//
// Builds the client, starts a production server on a spare port with a throwaway data folder,
// seeds a campaign (a GM, two players with characters, a dungeon map, a fight, wiki pages, a
// handout) through the same API the app uses, then drives headless Chromium through each view.
// Needs Playwright's Chromium once: pnpm exec playwright install --only-shell chromium
import type { CharacterRecord, ServerMessage } from '@dnd/protocol';
import { CHARACTER_VERSION, computeCharacter, emptyState, type Character } from '@dnd/rules';
import { execSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import WebSocket from 'ws';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'docs/screenshots');
const PORT = 3217;
const base = `http://127.0.0.1:${PORT}`;
const PASSWORD = 'demo-password';

// ---------- a tiny client for the app's API ----------

class Client {
  cookie = '';

  async call<T = any>(method: string, url: string, body?: unknown): Promise<T> {
    const res = await fetch(base + url, {
      method,
      headers: { ...(body !== undefined && { 'content-type': 'application/json' }), cookie: this.cookie },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0]!;
    const data = await res.json();
    if (!res.ok) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(data)}`);
    return data as T;
  }

  static async register(username: string, displayName: string): Promise<Client> {
    const c = new Client();
    await c.call('POST', '/api/auth/register', { username, displayName, password: PASSWORD });
    return c;
  }

  socket(campaignId: string): Promise<Sock> {
    return Sock.open(`ws://127.0.0.1:${PORT}/ws?campaign=${campaignId}`, this.cookie);
  }

  get session(): string {
    return this.cookie.split('=')[1]!;
  }
}

class Sock {
  private latest = new Map<string, ServerMessage>();
  private waiters: { type: string; pred: (m: any) => boolean; resolve: (m: any) => void }[] = [];

  private constructor(private readonly ws: WebSocket) {
    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString()) as ServerMessage;
      if (msg.type === 'error') console.warn('  server:', (msg as { message: string }).message);
      this.latest.set(msg.type, msg);
      this.waiters = this.waiters.filter((w) => {
        if (w.type !== msg.type || !w.pred(msg)) return true;
        w.resolve(msg);
        return false;
      });
    });
  }

  static open(url: string, cookie: string): Promise<Sock> {
    const ws = new WebSocket(url, { headers: { cookie } });
    return new Promise((resolve, reject) => {
      ws.once('open', () => resolve(new Sock(ws)));
      ws.once('error', reject);
    });
  }

  /** The latest message of a type that matches, now or when it arrives. */
  until<T extends ServerMessage['type']>(type: T, pred: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true) {
    const seen = this.latest.get(type);
    if (seen && pred(seen as never)) return Promise.resolve(seen as Extract<ServerMessage, { type: T }>);
    return new Promise<Extract<ServerMessage, { type: T }>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), 5000);
      this.waiters.push({ type, pred: pred as never, resolve: (m) => (clearTimeout(timer), resolve(m)) });
    });
  }

  send(msg: unknown): void {
    this.ws.send(JSON.stringify(msg));
  }

  close(): void {
    this.ws.close();
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------- demo content ----------

function character(fields: Partial<Character> & Pick<Character, 'name' | 'classId' | 'level'>): Character {
  const c: Character = {
    version: CHARACTER_VERSION,
    color: '#2e86de',
    subclassId: null,
    speciesId: 'human',
    subspeciesId: null,
    size: 'Medium',
    backgroundId: 'soldier',
    baseScores: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    backgroundBonus: {},
    advancements: [],
    fightingStyle: null,
    extraFeats: [],
    skills: [],
    expertise: [],
    weaponMasteries: [],
    hpRolls: [],
    languages: [],
    tools: [],
    equipment: { armorId: null, shield: false, weapons: [], items: [] },
    currency: { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 },
    spells: [],
    state: emptyState({ classId: fields.classId, level: fields.level }, 1),
    notes: '',
    ...fields,
  };
  return { ...c, state: emptyState(c, computeCharacter(c).hpMax) };
}

const BRAKKA = character({
  name: 'Brakka Stonefist',
  color: '#c0392b',
  classId: 'fighter',
  level: 3,
  subclassId: 'champion',
  speciesId: 'dwarf',
  backgroundId: 'soldier',
  baseScores: { str: 15, dex: 12, con: 14, int: 8, wis: 13, cha: 10 },
  backgroundBonus: { str: 2, con: 1 },
  fightingStyle: 'defense',
  skills: ['athletics', 'intimidation', 'perception', 'survival'],
  weaponMasteries: ['greataxe', 'handaxe', 'light-crossbow'],
  hpRolls: [null, null],
  languages: ['dwarvish'],
  equipment: {
    armorId: 'chain-mail',
    shield: false,
    weapons: [{ weaponId: 'greataxe' }, { weaponId: 'handaxe' }, { weaponId: 'light-crossbow' }],
    items: [
      { name: 'Explorer’s Pack', qty: 1 },
      { name: 'Torch', qty: 5 },
    ],
  },
  currency: { cp: 0, sp: 4, ep: 0, gp: 23, pp: 0 },
});

const ELARA = character({
  name: 'Elara Vance',
  color: '#8e44ad',
  classId: 'wizard',
  level: 3,
  subclassId: 'evoker',
  speciesId: 'elf',
  subspeciesId: 'elven-lineage-high-elf',
  backgroundId: 'sage',
  baseScores: { str: 8, dex: 14, con: 13, int: 15, wis: 12, cha: 10 },
  backgroundBonus: { int: 2, con: 1 },
  skills: ['arcana', 'history', 'investigation', 'perception', 'insight'],
  hpRolls: [null, null],
  languages: ['elvish', 'draconic'],
  equipment: {
    armorId: null,
    shield: false,
    weapons: [{ weaponId: 'quarterstaff' }, { weaponId: 'dagger' }],
    items: [
      { name: 'Spellbook', qty: 1 },
      { name: 'Scholar’s Pack', qty: 1 },
    ],
  },
  currency: { cp: 0, sp: 10, ep: 0, gp: 15, pp: 0 },
  spells: [
    { spellId: 'fire-bolt', name: 'Fire Bolt', level: 0, prepared: true },
    { spellId: 'light', name: 'Light', level: 0, prepared: true },
    { spellId: 'mage-hand', name: 'Mage Hand', level: 0, prepared: true },
    { spellId: 'magic-missile', name: 'Magic Missile', level: 1, prepared: true },
    { spellId: 'shield', name: 'Shield', level: 1, prepared: true },
    { spellId: 'sleep', name: 'Sleep', level: 1, prepared: true },
    { spellId: 'detect-magic', name: 'Detect Magic', level: 1, prepared: true },
    { spellId: 'misty-step', name: 'Misty Step', level: 2, prepared: true },
    { spellId: 'scorching-ray', name: 'Scorching Ray', level: 2, prepared: true },
  ],
});

/** A 30 × 20 cave: rock everywhere, an entry hall, a corridor and a cavern with a pool. */
function dungeon(sock: Sock, sceneId: string) {
  const cols = 30;
  const rect = (c0: number, r0: number, c1: number, r1: number) => {
    const cells: number[] = [];
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) cells.push(r * cols + c);
    return cells;
  };
  sock.send({ type: 'map:fill', sceneId, terrain: 'rock' });
  sock.send({ type: 'map:terrain', sceneId, terrain: 'floor', cells: [...rect(2, 5, 9, 14), ...rect(10, 9, 15, 10), ...rect(16, 2, 27, 17), ...rect(12, 11, 13, 15)] });
  sock.send({ type: 'map:terrain', sceneId, terrain: 'water', cells: [...rect(22, 4, 25, 7), ...rect(23, 8, 24, 8)] });
  sock.send({ type: 'map:terrain', sceneId, terrain: 'difficult', cells: [...rect(17, 13, 19, 16), ...rect(12, 14, 13, 15)] });
  sock.send({ type: 'map:terrain', sceneId, terrain: 'rock', cells: [...rect(20, 10, 21, 11)] });
  // Walls framing the corridor mouths, and doors.
  sock.send({ type: 'map:door', sceneId, edge: { side: 'left', col: 10, row: 9 }, state: 'open', secret: false });
  sock.send({ type: 'map:door', sceneId, edge: { side: 'left', col: 10, row: 10 }, state: 'open', secret: false });
  sock.send({ type: 'map:door', sceneId, edge: { side: 'top', col: 12, row: 11 }, state: 'closed', secret: false });
  sock.send({ type: 'map:door', sceneId, edge: { side: 'top', col: 13, row: 11 }, state: 'locked', secret: true });
}

async function seed() {
  const gm = await Client.register('dungeon-master', 'Dungeon Master');
  const mira = await Client.register('mira', 'Mira');
  const tobin = await Client.register('tobin', 'Tobin');
  const { id: campaignId } = await gm.call<{ id: string }>('POST', '/api/campaigns', { name: 'The Sunken Vault' });
  const gmSock = await gm.socket(campaignId);
  const hello = await gmSock.until('hello');
  for (const p of [mira, tobin]) await p.call('POST', '/api/campaigns/join', { inviteCode: hello.campaign.inviteCode });
  const miraSock = await mira.socket(campaignId);
  const tobinSock = await tobin.socket(campaignId);

  // The map.
  gmSock.send({ type: 'scene:create', name: 'Goblin Cave', fileId: null, width: 2100, height: 1400, grid: { size: 70 } });
  const sceneId = (await gmSock.until('scenes', (m) => m.scenes.length === 1)).scenes[0]!.id;
  gmSock.send({ type: 'scene:view', sceneId });
  await gmSock.until('scene', (m) => m.scene?.id === sceneId);
  dungeon(gmSock, sceneId);
  gmSock.send({ type: 'scene:activate', sceneId });

  // Characters and their tokens.
  miraSock.send({ type: 'character:create', data: ELARA });
  tobinSock.send({ type: 'character:create', data: BRAKKA });
  const chars = (await gmSock.until('characters', (m) => m.characters.length === 2)).characters;
  const charId = (name: string) => chars.find((c: CharacterRecord) => c.data.name === name)!.id;
  await miraSock.until('scene', (m) => m.scene?.id === sceneId);
  await tobinSock.until('scene', (m) => m.scene?.id === sceneId);
  miraSock.send({ type: 'character:token', characterId: charId('Elara Vance') });
  tobinSock.send({ type: 'character:token', characterId: charId('Brakka Stonefist') });
  await gmSock.until('scene', (m) => (m.scene?.tokens.length ?? 0) >= 2);

  // A fight.
  gmSock.send({ type: 'combat:start' });
  await gmSock.until('combat', (m) => m.combat !== null);
  gmSock.send({ type: 'combat:add', source: { kind: 'character', characterId: charId('Brakka Stonefist') } });
  gmSock.send({ type: 'combat:add', source: { kind: 'character', characterId: charId('Elara Vance') } });
  gmSock.send({ type: 'combat:add', source: { kind: 'monster', monsterId: 'goblin-boss', placeToken: true } });
  gmSock.send({ type: 'combat:add', source: { kind: 'monster', monsterId: 'goblin-warrior', count: 3, placeToken: true } });
  gmSock.send({ type: 'combat:add', source: { kind: 'monster', monsterId: 'wolf', placeToken: true, hidden: true } });
  const scene = (await gmSock.until('scene', (m) => (m.scene?.tokens.length ?? 0) === 7)).scene!;
  const token = (name: string) => scene.tokens.find((t) => t.name === name)!;
  const place: [string, number, number][] = [
    ['Brakka Stonefist', 16, 9],
    ['Elara Vance', 14, 10],
    ['Goblin Boss', 23, 11],
    ['Goblin Warrior 1', 19, 8],
    ['Goblin Warrior 2', 20, 13],
    ['Goblin Warrior 3', 25, 14],
    ['Wolf', 26, 3],
  ];
  for (const [name, col, row] of place) gmSock.send({ type: 'token:move', tokenId: token(name).id, col, row });

  const combat = (await gmSock.until('combat', (m) => m.combat?.combatants.length === 7)).combat!;
  const combatant = (name: string) => combat.combatants.find((c) => c.name === name)!.id;
  const inits: [string, number][] = [
    ['Elara Vance', 19],
    ['Goblin Boss', 17],
    ['Brakka Stonefist', 14],
    ['Goblin Warrior 1', 12],
    ['Goblin Warrior 2', 12],
    ['Goblin Warrior 3', 9],
    ['Wolf', 6],
  ];
  for (const [name, value] of inits) gmSock.send({ type: 'combat:initiative', combatantId: combatant(name), value });
  gmSock.send({ type: 'combat:turn', dir: 'next' });
  gmSock.send({ type: 'combat:turn', dir: 'next' });
  gmSock.send({ type: 'combat:turn', dir: 'next' });
  gmSock.send({ type: 'combat:hp', combatantId: combatant('Goblin Warrior 1'), op: 'damage', amount: 6 });
  gmSock.send({ type: 'combat:hp', combatantId: combatant('Brakka Stonefist'), op: 'damage', amount: 7 });
  gmSock.send({ type: 'combat:condition', combatantId: combatant('Goblin Warrior 2'), condition: 'prone', on: true });

  // A little table talk in the log.
  miraSock.send({ type: 'roll', expr: '1d20+5', label: 'Elara Vance: Fire Bolt attack', visibility: 'public' });
  miraSock.send({ type: 'roll', expr: '1d10', label: 'Elara Vance: Fire Bolt damage', visibility: 'public' });
  gmSock.send({ type: 'roll', expr: '1d20+4', label: 'Goblin Boss: Scimitar', visibility: 'gm' });
  tobinSock.send({ type: 'chat', text: 'Brakka raises his torch: "Who wants to meet Gundren\'s axe first?"', visibility: 'public' });
  tobinSock.send({ type: 'roll', expr: '1d20+5', label: 'Brakka Stonefist: Greataxe attack', visibility: 'public' });
  tobinSock.send({ type: 'roll', expr: '1d12+3', label: 'Brakka Stonefist: Greataxe damage', visibility: 'public' });

  // The campaign wiki and a handout.
  gmSock.send({
    type: 'wiki:create',
    title: 'Gundren Rockseeker',
    aliases: ['Gundren'],
    category: 'npc',
    tags: ['ally', 'phandalin'],
    body:
      'A dwarf prospector who hired the party to escort a wagon of supplies to Phandalin.\n\n' +
      'He and his brothers rediscovered the entrance to [[Wave Echo Cave]], lost for five centuries. ' +
      'Last seen heading up the Triboar Trail with [[Sildar Hallwinter]], shortly before the goblin ambush.',
    secret: 'Captured by the Cragmaw goblins and taken to their king. Carries the only map to the cave.',
    audience: 'all',
  });
  gmSock.send({
    type: 'wiki:create',
    title: 'Sildar Hallwinter',
    aliases: ['Sildar'],
    category: 'npc',
    tags: ['ally', 'lords-alliance'],
    body: 'A kindly human warrior of the Lords’ Alliance, travelling with [[Gundren]]. Fights with a longsword and a shield.',
    audience: 'all',
  });
  gmSock.send({
    type: 'wiki:create',
    title: 'Wave Echo Cave',
    category: 'location',
    tags: ['dungeon'],
    body: 'The legendary mine of the Phandelver Pact, where gnomes and dwarves once worked magic into steel.',
    secret: 'A Flameskull still guards the old temple of Dumathoin.',
    audience: 'gm',
  });
  gmSock.send({
    type: 'handout:create',
    title: 'A note found on the goblin boss',
    text: 'Klarg,\n\nThe dwarf and his escort are bound for Phandalin. Take them alive, and bring me the map.\n\n— King Grol',
    fileId: null,
    audience: 'all',
  });
  await gmSock.until('wiki', (m) => m.pages.length === 3);
  await sleep(500);

  for (const s of [gmSock, miraSock, tobinSock]) s.close();
  return { gm, mira, tobin, campaignId, tokens: Object.fromEntries(place.map(([name]) => [name, token(name).id])) };
}

// ---------- screenshots ----------

async function contextFor(browser: Browser, client: Client | null, opts: Parameters<Browser['newContext']>[0]): Promise<BrowserContext> {
  const ctx = await browser.newContext({ colorScheme: 'dark', ...opts });
  if (client) await ctx.addCookies([{ name: 'dnd_session', value: client.session, url: base }]);
  return ctx;
}

async function shot(page: Page, name: string) {
  await sleep(400); // let transitions settle
  await page.screenshot({ path: path.join(outDir, `${name}.png`) });
  console.log(`  ✓ ${name}.png`);
}

/** Pans the map (by dragging an empty spot) so a token sits at a fraction of the map's width and height. */
async function bringToken(page: Page, tokenId: string, fx: number, fy: number) {
  const map = (await page.locator('.map__svg').boundingBox())!;
  const t = (await page.locator(`[data-token-id="${tokenId}"] .token__disc`).boundingBox())!;
  const from = { x: map.x + 8, y: map.y + map.height * 0.55 };
  const dx = map.x + map.width * fx - (t.x + t.width / 2);
  const dy = map.y + map.height * fy - (t.y + t.height / 2);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(from.x + (dx * i) / 10, from.y + (dy * i) / 10);
  await page.mouse.up();
  await sleep(200);
}

async function openCampaign(page: Page, campaignId: string) {
  await page.goto(`${base}/c/${campaignId}`);
  await page.waitForSelector('.token');
  await sleep(800); // fonts, the SRD chunks and the fitted camera
}

async function capture(browser: Browser, demo: Awaited<ReturnType<typeof seed>>) {
  const { gm, mira, campaignId, tokens } = demo;
  const desktop = { viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 };

  // GM: the fight, with a monster's quick actions open.
  const gmPage = await (await contextFor(browser, gm, desktop)).newPage();
  await openCampaign(gmPage, campaignId);
  await gmPage.getByRole('button', { name: 'Zoom in' }).click();
  await sleep(300);
  await bringToken(gmPage, tokens['Brakka Stonefist']!, 0.42, 0.3);
  await gmPage.locator(`[data-token-id="${tokens['Brakka Stonefist']}"]`).click();
  await gmPage.waitForSelector('.token-popup[data-measured]');
  await shot(gmPage, 'gm-combat');

  // GM: preparing the scene.
  await gmPage.keyboard.press('Escape');
  await gmPage.getByRole('radio', { name: 'Edit scene' }).click();
  await gmPage.locator('.edit-section', { hasText: 'Lighting & vision' }).locator('summary').click();
  await shot(gmPage, 'gm-edit-scene');
  await gmPage.getByRole('button', { name: 'Done' }).click();

  // Knowledge base: quick search, then a nested popup.
  await gmPage.keyboard.press('Control+k');
  await gmPage.keyboard.type('fireball');
  await sleep(300);
  await gmPage.keyboard.press('Enter');
  await gmPage.waitForSelector('.kb-popup');
  await gmPage.locator('.kb-popup [data-entry="damage-type:fire"]').first().click();
  await sleep(300);
  await shot(gmPage, 'knowledge-base');

  // Campaign wiki.
  await gmPage.keyboard.press('Escape');
  await gmPage.keyboard.press('Escape');
  await gmPage.getByRole('tab', { name: /Compendium/ }).click();
  await gmPage.getByRole('tab', { name: /Campaign wiki/ }).first().click();
  await gmPage.getByText('Gundren Rockseeker', { exact: true }).first().click();
  await shot(gmPage, 'wiki');

  // Player on a phone: the character sheet, then their token's quick actions.
  const phone = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const miraPage = await (await contextFor(browser, mira, phone)).newPage();
  await openCampaign(miraPage, campaignId);
  await miraPage.locator('.tabbar button').nth(1).tap();
  await miraPage.locator('.mobile-switch:visible').getByRole('tab', { name: 'Sheet' }).tap();
  await miraPage.waitForSelector('.hp-card');
  await shot(miraPage, 'player-sheet');
  await miraPage.locator('.tabbar button').first().tap();
  await sleep(300);
  for (let i = 0; i < 3; i++) await miraPage.getByRole('button', { name: 'Zoom in' }).tap();
  await sleep(300);
  await bringToken(miraPage, tokens['Elara Vance']!, 0.3, 0.2);
  await miraPage.locator(`[data-token-id="${tokens['Elara Vance']}"]`).tap();
  await miraPage.waitForSelector('.token-popup');
  await shot(miraPage, 'player-map');

  // The TV: pair a table display and show the map.
  const tv = await (await contextFor(browser, null, { viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 })).newPage();
  await tv.goto(`${base}/table`);
  const code = (await tv.locator('.pairing__code').innerText()).replace(/\s/g, '');
  await gm.call('POST', `/api/campaigns/${campaignId}/displays`, { code });
  await tv.waitForSelector('.token');
  await sleep(4000); // let the latest-roll spotlight fade
  await shot(tv, 'table-display');
}

async function main() {
  mkdirSync(outDir, { recursive: true });
  console.log('Building the client…');
  execSync('pnpm build', { cwd: root, stdio: 'ignore' });

  const dataDir = mkdtempSync(path.join(tmpdir(), 'dnd-table-demo-'));
  const server = spawn(path.join(root, 'node_modules/.bin/tsx'), ['apps/server/src/index.ts'], {
    cwd: root,
    env: { ...process.env, NODE_ENV: 'production', PORT: String(PORT), HOST: '127.0.0.1', DATA_DIR: dataDir, NODE_OPTIONS: '--disable-warning=ExperimentalWarning' },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  let browser: Browser | undefined;
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(`${base}/api/health`)).ok) break;
      } catch {
        if (i > 100) throw new Error('The demo server did not start');
      }
      await sleep(100);
    }
    console.log('Seeding a demo campaign…');
    const demo = await seed();
    console.log('Taking screenshots…');
    browser = await chromium.launch();
    await capture(browser, demo);
  } finally {
    await browser?.close();
    server.kill('SIGTERM');
    rmSync(dataDir, { recursive: true, force: true });
  }
}

await main();
