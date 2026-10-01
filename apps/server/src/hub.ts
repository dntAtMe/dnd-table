import {
  BACKGROUNDS,
  CLASSES,
  DEFAULT_GRID,
  DiceError,
  SPECIES,
  abilityMod,
  computeCharacter,
  formatModifier,
  gridGeometry,
  longRest,
  rollDice,
  shortRest,
  type Character,
} from '@dnd/rules';
import {
  ClientMessage,
  type CameraRect,
  type CharacterRecord,
  type ClientRole,
  type DisplayInfo,
  type LogEntry,
  type Member,
  type SceneView,
  type ServerMessage,
  type Token,
  type User,
} from '@dnd/protocol';
import type { WebSocket } from 'ws';
import { GameError, applyGridPatch, clampToGrid, fogMask, sceneView, summary } from './scenes';
import type { Display, SceneRecord, Store } from './store';

const LOG_HISTORY = 100;
const HEARTBEAT_MS = 30_000;

interface Conn {
  socket: WebSocket;
  role: ClientRole;
  campaignId: string;
  user?: User;
  displayId?: string;
  /** GM only: the scene they have open, which may differ from the one players see. */
  viewSceneId?: string;
}

type Msg<T extends ClientMessage['type']> = Extract<ClientMessage, { type: T }>;

function send(socket: WebSocket, msg: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
}

function canSee(conn: Conn, entry: LogEntry): boolean {
  return entry.visibility === 'public' || conn.role === 'gm' || conn.user?.id === entry.author.userId;
}

/**
 * Live state of every connected screen. Each campaign is a room; the server is the
 * source of truth and fans out only what each role is allowed to see.
 */
export class Hub {
  private readonly rooms = new Map<string, Set<Conn>>();
  /** Table displays waiting to be paired, keyed by display id. */
  private readonly pending = new Map<string, Set<WebSocket>>();
  private readonly alive = new WeakMap<WebSocket, boolean>();
  /** Last GM framing per campaign, so a table screen that (re)connects shows the same view. */
  private readonly cameras = new Map<string, { sceneId: string; rect: CameraRect }>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(private readonly store: Store) {
    // Phones drop off Wi-Fi without closing sockets; ping so presence stays honest.
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_MS);
    this.heartbeat.unref();
  }

  close(): void {
    clearInterval(this.heartbeat);
  }

  // ---------- connections ----------

  attachUser(socket: WebSocket, user: User, campaignId: string, role: ClientRole): void {
    this.track(socket);
    const conn: Conn = { socket, role, campaignId, user };
    this.join(conn);
    socket.on('message', (data) => this.onMessage(conn, data.toString()));
    socket.on('close', () => this.leave(conn));
  }

  attachDisplay(socket: WebSocket, display: Display): void {
    this.track(socket);
    socket.on('close', () => {
      this.pending.get(display.id)?.delete(socket);
      for (const room of this.rooms.values()) {
        for (const conn of room) if (conn.socket === socket) this.leave(conn);
      }
    });
    if (display.campaignId) this.join({ socket, role: 'display', campaignId: display.campaignId, displayId: display.id });
    else this.waitForPairing(socket, display.id, display.code);
  }

  private track(socket: WebSocket): void {
    this.alive.set(socket, true);
    socket.on('pong', () => this.alive.set(socket, true));
  }

  private sweep(): void {
    const sockets = new Set<WebSocket>();
    for (const room of this.rooms.values()) for (const conn of room) sockets.add(conn.socket);
    for (const set of this.pending.values()) for (const s of set) sockets.add(s);
    for (const socket of sockets) {
      if (!this.alive.get(socket)) {
        socket.terminate();
        continue;
      }
      this.alive.set(socket, false);
      socket.ping();
    }
  }

  private waitForPairing(socket: WebSocket, displayId: string, code: string): void {
    let set = this.pending.get(displayId);
    if (!set) this.pending.set(displayId, (set = new Set()));
    set.add(socket);
    send(socket, { type: 'display:unpaired', code });
  }

  private join(conn: Conn): void {
    let room = this.rooms.get(conn.campaignId);
    if (!room) this.rooms.set(conn.campaignId, (room = new Set()));
    room.add(conn);
    this.sendHello(conn);
    const camera = this.cameras.get(conn.campaignId);
    if (conn.role === 'display' && camera && camera.sceneId === this.store.activeSceneId(conn.campaignId)) {
      send(conn.socket, { type: 'camera', ...camera });
    }
    this.broadcastPresence(conn.campaignId);
  }

  private leave(conn: Conn): void {
    const room = this.rooms.get(conn.campaignId);
    if (!room?.delete(conn)) return;
    if (room.size === 0) this.rooms.delete(conn.campaignId);
    this.broadcastPresence(conn.campaignId);
  }

  private sendHello(conn: Conn): void {
    const campaign = this.store.getCampaign(conn.campaignId);
    if (!campaign) return;
    const isGm = conn.role === 'gm';
    const log = this.store
      .recentLog(conn.campaignId, LOG_HISTORY * 3)
      .filter((e) => canSee(conn, e))
      .slice(-LOG_HISTORY);
    send(conn.socket, {
      type: 'hello',
      you: { role: conn.role, userId: conn.user?.id, name: conn.user?.displayName },
      campaign: { id: campaign.id, name: campaign.name, ...(isGm && { inviteCode: campaign.inviteCode }) },
      members: this.members(conn.campaignId),
      ...(isGm && { displays: this.displays(conn.campaignId) }),
      log,
      activeSceneId: this.store.activeSceneId(conn.campaignId),
      scene: this.viewFor(conn),
      ...(isGm && { scenes: this.store.scenes(conn.campaignId).map(summary) }),
      characters: this.charactersFor(conn),
    });
  }

  // ---------- characters ----------

  /** Everyone sees the party's sheets, but only owners and GMs see a character's notes. */
  private charactersFor(conn: Conn, all = this.store.characters(conn.campaignId)): CharacterRecord[] {
    if (conn.role === 'display') return [];
    return all.map(({ campaignId: _, ...rec }) =>
      conn.role === 'gm' || rec.ownerUserId === conn.user?.id ? rec : { ...rec, data: { ...rec.data, notes: '' } },
    );
  }

  private charactersChanged(campaignId: string): void {
    const all = this.store.characters(campaignId);
    for (const conn of this.rooms.get(campaignId) ?? []) {
      if (conn.role !== 'display') send(conn.socket, { type: 'characters', characters: this.charactersFor(conn, all) });
    }
  }

  private characterOf(conn: Conn, characterId: string, edit = true) {
    const rec = this.store.getCharacter(characterId);
    if (!rec || rec.campaignId !== conn.campaignId) throw new GameError('Character not found');
    if (edit && conn.role !== 'gm' && rec.ownerUserId !== conn.user?.id) throw new GameError("That's not your character");
    return rec;
  }

  private checkCharacter(data: Character): void {
    if (!CLASSES[data.classId]) throw new GameError('Unknown class');
    if (!SPECIES[data.speciesId]) throw new GameError('Unknown species');
    if (!BACKGROUNDS[data.backgroundId]) throw new GameError('Unknown background');
    try {
      computeCharacter(data);
    } catch (err) {
      throw new GameError(`Invalid character: ${(err as Error).message}`);
    }
  }

  private saveCharacter(conn: Conn, id: string, data: Character, before?: Character): void {
    this.store.updateCharacter(id, data);
    if (!before || before.name !== data.name || before.color !== data.color) {
      for (const sceneId of this.store.syncCharacterTokens(id, data.name, data.color)) this.sceneChanged(conn.campaignId, sceneId);
    }
    this.charactersChanged(conn.campaignId);
  }

  private rest(conn: Conn & { user: User }, msg: Msg<'character:rest'>): void {
    const rec = this.characterOf(conn, msg.characterId);
    const data = rec.data;
    const derived = computeCharacter(data);
    let state;
    if (msg.kind === 'long') {
      state = longRest(data, derived);
      this.publish(conn, this.store.addLog(conn.campaignId, conn.user.id, 'chat', 'public', { text: `${data.name} finishes a Long Rest.` }));
    } else {
      const dice = Math.min(msg.hitDice ?? 0, data.level - data.state.hitDiceSpent);
      let healing = 0;
      if (dice > 0) {
        const con = abilityMod(derived.scores.con) * dice;
        const roll = rollDice(con ? `${dice}d${derived.hitDie} ${formatModifier(con)}` : `${dice}d${derived.hitDie}`);
        healing = Math.max(0, roll.total);
        const label = `${data.name}: Short Rest, ${dice} Hit ${dice === 1 ? 'Die' : 'Dice'}`;
        this.publish(conn, this.store.addLog(conn.campaignId, conn.user.id, 'roll', 'public', { label, roll }));
      } else {
        this.publish(conn, this.store.addLog(conn.campaignId, conn.user.id, 'chat', 'public', { text: `${data.name} takes a Short Rest.` }));
      }
      state = shortRest(data, derived, dice, healing);
    }
    this.saveCharacter(conn, rec.id, { ...data, state }, data);
  }

  private placeCharacterToken(conn: Conn, characterId: string): void {
    const rec = this.characterOf(conn, characterId);
    const sceneId = this.sceneIdFor(conn);
    if (!sceneId) throw new GameError('There is no map to place the token on');
    const scene = this.sceneOf(conn, sceneId);
    const tokens = this.store.tokens(scene.id);
    if (tokens.some((t) => t.characterId === rec.id)) throw new GameError(`${rec.data.name} is already on this map`);
    const { cols, rows } = gridGeometry(scene.grid, scene.width, scene.height);
    const taken = (c: number, r: number) => tokens.some((t) => c >= t.col && c < t.col + t.size && r >= t.row && r < t.row + t.size);
    let spot = { col: Math.floor(cols / 2), row: Math.floor(rows / 2) };
    search: for (let ring = 0; ring < Math.max(cols, rows); ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
          const col = spot.col + dc;
          const row = spot.row + dr;
          if (col >= 0 && row >= 0 && col < cols && row < rows && !taken(col, row)) {
            spot = { col, row };
            break search;
          }
        }
      }
    }
    this.store.createToken({
      sceneId: scene.id,
      name: rec.data.name,
      color: rec.data.color,
      size: 1,
      hidden: false,
      ownerUserId: rec.ownerUserId,
      characterId: rec.id,
      ...spot,
    });
    this.sceneChanged(conn.campaignId, scene.id);
  }

  // ---------- scenes ----------

  /** The scene a connection is looking at: players and displays always see the active one. */
  private sceneIdFor(conn: Conn): string | null {
    const active = this.store.activeSceneId(conn.campaignId);
    if (conn.role !== 'gm') return active;
    if (conn.viewSceneId && this.store.getScene(conn.viewSceneId)?.campaignId === conn.campaignId) {
      return conn.viewSceneId;
    }
    return active ?? this.store.scenes(conn.campaignId).at(-1)?.id ?? null;
  }

  private viewFor(conn: Conn): SceneView | null {
    const id = this.sceneIdFor(conn);
    const scene = id ? this.store.getScene(id) : undefined;
    return scene ? sceneView(scene, this.store.tokens(scene.id), { role: conn.role, userId: conn.user?.id }) : null;
  }

  /** Re-sends a scene to everyone looking at it, each filtered for their role. */
  private sceneChanged(campaignId: string, sceneId: string): void {
    const scene = this.store.getScene(sceneId);
    if (!scene) return;
    const tokens = this.store.tokens(sceneId);
    const views = new Map<string, SceneView>();
    for (const conn of this.rooms.get(campaignId) ?? []) {
      if (this.sceneIdFor(conn) !== sceneId) continue;
      const key = conn.role === 'player' ? `player:${conn.user?.id}` : conn.role;
      let view = views.get(key);
      if (!view) views.set(key, (view = sceneView(scene, tokens, { role: conn.role, userId: conn.user?.id })));
      send(conn.socket, { type: 'scene', scene: view });
    }
  }

  /** The scene list or active scene changed: refresh GM lists and everyone's current scene. */
  private scenesChanged(campaignId: string): void {
    const scenes = this.store.scenes(campaignId).map(summary);
    const activeSceneId = this.store.activeSceneId(campaignId);
    for (const conn of this.rooms.get(campaignId) ?? []) {
      if (conn.role === 'gm') send(conn.socket, { type: 'scenes', scenes, activeSceneId });
      send(conn.socket, { type: 'scene', scene: this.viewFor(conn) });
    }
  }

  private requireGm(conn: Conn): void {
    if (conn.role !== 'gm') throw new GameError('Only the GM can do that');
  }

  private sceneOf(conn: Conn, sceneId: string): SceneRecord {
    const scene = this.store.getScene(sceneId);
    if (!scene || scene.campaignId !== conn.campaignId) throw new GameError('Scene not found');
    return scene;
  }

  private tokenOf(conn: Conn, tokenId: string): { token: Token; scene: SceneRecord } {
    const token = this.store.getToken(tokenId);
    const scene = token && this.store.getScene(token.sceneId);
    if (!token || !scene || scene.campaignId !== conn.campaignId) throw new GameError('Token not found');
    return { token, scene };
  }

  private checkOwner(conn: Conn, ownerUserId: string | null | undefined): void {
    if (ownerUserId && !this.store.roleIn(conn.campaignId, ownerUserId)) throw new GameError('Owner is not in this campaign');
  }

  private createScene(conn: Conn, msg: Msg<'scene:create'>): void {
    this.requireGm(conn);
    if (msg.fileId && this.store.getFile(msg.fileId)?.campaignId !== conn.campaignId) {
      throw new GameError('Map image not found');
    }
    const grid = applyGridPatch(DEFAULT_GRID, msg.grid, msg.width, msg.height);
    conn.viewSceneId = this.store.createScene({
      campaignId: conn.campaignId,
      name: msg.name,
      fileId: msg.fileId,
      width: msg.width,
      height: msg.height,
      grid,
      fogEnabled: false,
      fog: '',
      map: '',
    });
    this.scenesChanged(conn.campaignId);
  }

  private updateScene(conn: Conn, msg: Msg<'scene:update'>): void {
    this.requireGm(conn);
    const scene = this.sceneOf(conn, msg.sceneId);
    const grid = msg.grid ? applyGridPatch(scene.grid, msg.grid, scene.width, scene.height) : scene.grid;
    const before = gridGeometry(scene.grid, scene.width, scene.height);
    const after = gridGeometry(grid, scene.width, scene.height);
    const resized = before.cols !== after.cols || before.rows !== after.rows;
    // A different cell count invalidates the fog mask; start fully fogged again.
    this.store.updateScene(scene.id, { name: msg.name, grid, fogEnabled: msg.fogEnabled, ...(resized && { fog: '' }) });
    if (resized) {
      const updated = { ...scene, grid };
      for (const token of this.store.tokens(scene.id)) {
        this.store.updateToken({ ...token, ...clampToGrid(updated, token.col, token.row, token.size) });
      }
    }
    if (msg.name !== undefined && msg.name !== scene.name) this.scenesChanged(conn.campaignId);
    else this.sceneChanged(conn.campaignId, scene.id);
  }

  private paintFog(conn: Conn, sceneId: string, apply: (fog: ReturnType<typeof fogMask>) => void): void {
    this.requireGm(conn);
    const scene = this.sceneOf(conn, sceneId);
    const fog = fogMask(scene);
    apply(fog);
    this.store.updateScene(scene.id, { fog: fog.encode() });
    this.sceneChanged(conn.campaignId, scene.id);
  }

  private createToken(conn: Conn, msg: Msg<'token:create'>): void {
    this.requireGm(conn);
    const scene = this.sceneOf(conn, msg.sceneId);
    this.checkOwner(conn, msg.ownerUserId);
    const size = msg.size ?? 1;
    this.store.createToken({
      sceneId: scene.id,
      name: msg.name,
      color: msg.color,
      size,
      hidden: msg.hidden ?? false,
      ownerUserId: msg.ownerUserId ?? null,
      characterId: null,
      ...clampToGrid(scene, msg.col, msg.row, size),
    });
    this.sceneChanged(conn.campaignId, scene.id);
  }

  private updateToken(conn: Conn, msg: Msg<'token:update'>): void {
    this.requireGm(conn);
    const { token, scene } = this.tokenOf(conn, msg.tokenId);
    this.checkOwner(conn, msg.ownerUserId);
    const { type: _, tokenId: __, ...patch } = msg;
    const next = { ...token, ...patch };
    this.store.updateToken({ ...next, ...clampToGrid(scene, next.col, next.row, next.size) });
    this.sceneChanged(conn.campaignId, scene.id);
  }

  private moveToken(conn: Conn, msg: Msg<'token:move'>): void {
    const { token, scene } = this.tokenOf(conn, msg.tokenId);
    if (conn.role !== 'gm') {
      if (!conn.user || token.ownerUserId !== conn.user.id) throw new GameError("That's not your token");
      if (scene.id !== this.store.activeSceneId(conn.campaignId)) throw new GameError('That scene is not in play');
    }
    const pos = clampToGrid(scene, msg.col, msg.row, token.size);
    if (pos.col === token.col && pos.row === token.row) return;
    this.store.updateToken({ ...token, ...pos });
    this.sceneChanged(conn.campaignId, scene.id);
  }

  private ping(conn: Conn, msg: Msg<'ping'>): void {
    if (!conn.user || this.sceneIdFor(conn) !== msg.sceneId) return;
    const out: ServerMessage = { type: 'ping', sceneId: msg.sceneId, x: msg.x, y: msg.y, name: conn.user.displayName, role: conn.role };
    for (const other of this.rooms.get(conn.campaignId) ?? []) {
      if (this.sceneIdFor(other) === msg.sceneId) send(other.socket, out);
    }
  }

  private camera(conn: Conn, msg: Msg<'camera'>): void {
    this.requireGm(conn);
    if (msg.sceneId !== this.store.activeSceneId(conn.campaignId)) return;
    const camera = { sceneId: msg.sceneId, rect: msg.rect };
    this.cameras.set(conn.campaignId, camera);
    for (const other of this.rooms.get(conn.campaignId) ?? []) {
      if (other.role === 'display') send(other.socket, { type: 'camera', ...camera });
    }
  }

  // ---------- presence ----------

  private members(campaignId: string): Member[] {
    const online = new Set<string>();
    for (const conn of this.rooms.get(campaignId) ?? []) if (conn.user) online.add(conn.user.id);
    return this.store.members(campaignId).map((m) => ({ ...m, online: online.has(m.userId) }));
  }

  private displays(campaignId: string): DisplayInfo[] {
    const online = new Set<string>();
    for (const conn of this.rooms.get(campaignId) ?? []) if (conn.displayId) online.add(conn.displayId);
    return this.store.displaysFor(campaignId).map((d) => ({ id: d.id, name: d.name, online: online.has(d.id) }));
  }

  private broadcastPresence(campaignId: string): void {
    const room = this.rooms.get(campaignId);
    if (!room) return;
    const members: ServerMessage = { type: 'members', members: this.members(campaignId) };
    const displays: ServerMessage = { type: 'displays', displays: this.displays(campaignId) };
    for (const conn of room) {
      send(conn.socket, members);
      if (conn.role === 'gm') send(conn.socket, displays);
    }
  }

  /** Called by REST routes when campaign membership changes. */
  membersChanged(campaignId: string): void {
    this.broadcastPresence(campaignId);
  }

  // ---------- display pairing ----------

  pairDisplay(displayId: string, campaignId: string): void {
    const sockets = this.pending.get(displayId);
    this.pending.delete(displayId);
    for (const socket of sockets ?? []) this.join({ socket, role: 'display', campaignId, displayId });
    if (!sockets?.size) this.broadcastPresence(campaignId);
  }

  unpairDisplay(displayId: string, campaignId: string, newCode: string): void {
    const room = this.rooms.get(campaignId);
    for (const conn of [...(room ?? [])]) {
      if (conn.displayId !== displayId) continue;
      this.leave(conn);
      this.waitForPairing(conn.socket, displayId, newCode);
    }
    this.broadcastPresence(campaignId);
  }

  // ---------- messages ----------

  private onMessage(conn: Conn, raw: string): void {
    if (!conn.user || conn.role === 'display') return;
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return send(conn.socket, { type: 'error', message: 'Malformed message' });
    }
    const parsed = ClientMessage.safeParse(json);
    if (!parsed.success) return send(conn.socket, { type: 'error', message: 'Invalid message' });
    try {
      this.dispatch(conn as Conn & { user: User }, parsed.data);
    } catch (err) {
      if (err instanceof GameError || err instanceof DiceError) send(conn.socket, { type: 'error', message: err.message });
      else throw err;
    }
  }

  private dispatch(conn: Conn & { user: User }, msg: ClientMessage): void {
    switch (msg.type) {
      case 'roll': {
        const roll = rollDice(msg.expr);
        const label = msg.label || undefined;
        this.publish(conn, this.store.addLog(conn.campaignId, conn.user.id, 'roll', msg.visibility, { label, roll }));
        break;
      }
      case 'chat':
        this.publish(conn, this.store.addLog(conn.campaignId, conn.user.id, 'chat', msg.visibility, { text: msg.text }));
        break;
      case 'scene:create':
        return this.createScene(conn, msg);
      case 'scene:update':
        return this.updateScene(conn, msg);
      case 'scene:delete':
        this.requireGm(conn);
        this.store.deleteScene(this.sceneOf(conn, msg.sceneId).id);
        if (this.cameras.get(conn.campaignId)?.sceneId === msg.sceneId) this.cameras.delete(conn.campaignId);
        return this.scenesChanged(conn.campaignId);
      case 'scene:activate':
        this.requireGm(conn);
        if (msg.sceneId) conn.viewSceneId = this.sceneOf(conn, msg.sceneId).id;
        this.store.setActiveScene(conn.campaignId, msg.sceneId);
        this.cameras.delete(conn.campaignId);
        return this.scenesChanged(conn.campaignId);
      case 'scene:view':
        this.requireGm(conn);
        conn.viewSceneId = this.sceneOf(conn, msg.sceneId).id;
        return send(conn.socket, { type: 'scene', scene: this.viewFor(conn) });
      case 'fog:paint':
        return this.paintFog(conn, msg.sceneId, (fog) => {
          for (const i of msg.cells) fog.setIndex(i, msg.reveal);
        });
      case 'fog:fill':
        return this.paintFog(conn, msg.sceneId, (fog) => fog.fill(msg.reveal));
      case 'token:create':
        return this.createToken(conn, msg);
      case 'token:update':
        return this.updateToken(conn, msg);
      case 'token:move':
        return this.moveToken(conn, msg);
      case 'token:delete': {
        this.requireGm(conn);
        const { token, scene } = this.tokenOf(conn, msg.tokenId);
        this.store.deleteToken(token.id);
        return this.sceneChanged(conn.campaignId, scene.id);
      }
      case 'character:create': {
        this.checkCharacter(msg.data as Character);
        this.store.createCharacter(conn.campaignId, conn.user.id, msg.data as Character);
        return this.charactersChanged(conn.campaignId);
      }
      case 'character:update': {
        const rec = this.characterOf(conn, msg.characterId);
        this.checkCharacter(msg.data as Character);
        return this.saveCharacter(conn, rec.id, msg.data as Character, rec.data);
      }
      case 'character:state': {
        const rec = this.characterOf(conn, msg.characterId);
        const state = { ...rec.data.state, ...msg.patch } as Character['state'];
        state.hp = Math.min(state.hp, computeCharacter(rec.data).hpMax);
        return this.saveCharacter(conn, rec.id, { ...rec.data, state }, rec.data);
      }
      case 'character:delete':
        this.store.deleteCharacter(this.characterOf(conn, msg.characterId).id);
        return this.charactersChanged(conn.campaignId);
      case 'character:rest':
        return this.rest(conn, msg);
      case 'character:token':
        return this.placeCharacterToken(conn, msg.characterId);
      case 'ping':
        return this.ping(conn, msg);
      case 'camera':
        return this.camera(conn, msg);
    }
  }

  private publish(from: Conn, entry: LogEntry): void {
    for (const conn of this.rooms.get(from.campaignId) ?? []) {
      if (canSee(conn, entry)) send(conn.socket, { type: 'log', entry });
    }
  }
}
