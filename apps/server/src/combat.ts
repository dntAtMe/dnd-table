import type {
  CharacterRecord,
  ClientMessage,
  ClientRole,
  CombatView,
  CombatantKind,
  CombatantView,
  LogEntry,
  ServerMessage,
  Token,
  User,
  Visibility,
} from '@dnd/protocol';
import {
  SIZE_CELLS,
  advanceTurn,
  applyHp,
  applyHpChange,
  compareInitiative,
  computeCharacter,
  d20Expression,
  d20Test,
  gridGeometry,
  healthStatus,
  monsterInitiative,
  monsterSenses,
  rollDice,
  type Character,
  type ConditionId,
} from '@dnd/rules';
import { MONSTERS_BY_ID } from '@dnd/rules/monsters';
import { randomUUID } from 'node:crypto';
import { GameError } from './scenes';
import type { SceneRecord, Store } from './store';

/** A combatant as stored. For characters the sheet is the source of truth for HP, AC and conditions. */
export interface StoredCombatant {
  id: string;
  name: string;
  kind: CombatantKind;
  tokenId: string | null;
  characterId: string | null;
  monsterId: string | null;
  ownerUserId: string | null;
  initiative: number | null;
  initiativeBonus: number;
  /** DEX score, the last initiative tiebreaker. */
  dex: number;
  /** Null when not tracked (e.g. a plain token the GM hasn't statted). */
  ac: number | null;
  hp: number | null;
  hpMax: number | null;
  tempHp: number;
  conditions: ConditionId[];
  hidden: boolean;
  /** Join order, for stable ties. */
  seq: number;
}

/** One running encounter per campaign. */
export interface Encounter {
  round: number;
  activeId: string | null;
  nextSeq: number;
  combatants: StoredCombatant[];
}

export interface CombatConn {
  role: ClientRole;
  campaignId: string;
  user?: User;
}

/** What the combat tracker needs from the hub. */
export interface CombatHost<C extends CombatConn> {
  /** Sends every connection in the campaign the message built for it. */
  broadcast(campaignId: string, build: (conn: C) => ServerMessage): void;
  /** The scene this connection is looking at. */
  sceneIdFor(conn: C): string | null;
  sceneChanged(campaignId: string, sceneId: string): void;
  /** Saves a character and fans it out (which in turn refreshes the combat view). */
  saveCharacter(conn: C, id: string, data: Character, before: Character): void;
  publish(conn: C, entry: LogEntry): void;
}

type CombatMsg = Extract<ClientMessage, { type: `combat:${string}` }>;
type Msg<T extends CombatMsg['type']> = Extract<CombatMsg, { type: T }>;

export function isCombatMessage(msg: ClientMessage): msg is CombatMsg {
  return msg.type.startsWith('combat:');
}

const MONSTER_COLOR = '#c0392b';

// ---------- views ----------

type Characters = Map<string, CharacterRecord>;

/** Merges live character stats into their combatants and sorts everyone into initiative order. */
export function resolveCombatants(encounter: Encounter, characters: Characters, tokens: Map<string, Token>): StoredCombatant[] {
  const out: StoredCombatant[] = [];
  for (const c of encounter.combatants) {
    // A hidden token never gives itself away through the tracker.
    const hidden = c.hidden || Boolean(c.tokenId && tokens.get(c.tokenId)?.hidden);
    if (c.kind !== 'character') {
      out.push({ ...c, hidden });
      continue;
    }
    const rec = c.characterId ? characters.get(c.characterId) : undefined;
    if (!rec) continue; // deleted character
    const derived = computeCharacter(rec.data);
    const s = rec.data.state;
    out.push({
      ...c,
      hidden,
      name: rec.data.name,
      ownerUserId: rec.ownerUserId,
      initiativeBonus: derived.initiative,
      dex: derived.scores.dex,
      ac: derived.ac,
      hp: s.hp,
      hpMax: derived.hpMax,
      tempHp: s.tempHp,
      conditions: s.conditions,
    });
  }
  return out.sort(compareInitiative);
}

export interface Viewer {
  role: ClientRole;
  userId?: string;
}

/** Filters the encounter for one viewer: no hidden combatants, and only health statuses for others' creatures. */
export function combatView(encounter: Encounter, resolved: StoredCombatant[], viewer: Viewer): CombatView {
  const isGm = viewer.role === 'gm';
  const owns = (c: StoredCombatant) => viewer.userId !== undefined && c.ownerUserId === viewer.userId;
  const visible = resolved.filter((c) => isGm || !c.hidden || owns(c));
  const combatants = visible.map((c): CombatantView => {
    const view: CombatantView = {
      id: c.id,
      name: c.name,
      kind: c.kind,
      tokenId: c.tokenId,
      characterId: c.characterId,
      ownerUserId: c.ownerUserId,
      initiative: c.initiative,
      status: c.hpMax ? healthStatus(c.hp ?? 0, c.hpMax) : null,
      conditions: c.conditions,
      hidden: c.hidden,
    };
    // Party sheets are shared with every player anyway; table screens only get public info.
    if (isGm || owns(c) || (viewer.role === 'player' && c.kind === 'character')) {
      Object.assign(view, { initiativeBonus: c.initiativeBonus, ac: c.ac, hp: c.hp, hpMax: c.hpMax, tempHp: c.tempHp });
    }
    if (isGm && c.monsterId) view.monsterId = c.monsterId;
    return view;
  });
  return {
    round: encounter.round,
    activeId: visible.some((c) => c.id === encounter.activeId) ? encounter.activeId : null,
    combatants,
  };
}

/** Free top-left cells for `count` tokens of `size`, spiralling out from the middle of the map. */
function freeSpots(scene: SceneRecord, tokens: Token[], size: number, count: number): { col: number; row: number }[] {
  const { cols, rows } = gridGeometry(scene.grid, scene.width, scene.height);
  const boxes = tokens.map((t) => ({ col: t.col, row: t.row, size: t.size }));
  const fits = (col: number, row: number) =>
    col >= 0 &&
    row >= 0 &&
    col + size <= cols &&
    row + size <= rows &&
    !boxes.some((b) => col < b.col + b.size && b.col < col + size && row < b.row + b.size && b.row < row + size);
  const centre = { col: Math.floor((cols - size) / 2), row: Math.floor((rows - size) / 2) };
  const spots: { col: number; row: number }[] = [];
  for (let ring = 0; ring < Math.max(cols, rows) && spots.length < count; ring++) {
    for (let dr = -ring; dr <= ring && spots.length < count; dr++) {
      for (let dc = -ring; dc <= ring && spots.length < count; dc++) {
        if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
        const col = centre.col + dc;
        const row = centre.row + dr;
        if (!fits(col, row)) continue;
        spots.push({ col, row });
        boxes.push({ col, row, size });
      }
    }
  }
  // A crowded map: stack the rest in the middle rather than fail.
  while (spots.length < count) spots.push({ col: Math.max(0, centre.col), row: Math.max(0, centre.row) });
  return spots;
}

/** "Goblin Warrior" → "Goblin Warrior 2", "Goblin Warrior 3", … when others already share the name. */
function numberedNames(base: string, count: number, existing: string[]): string[] {
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?: (\\d+))?$`);
  const taken = existing.flatMap((n) => {
    const m = re.exec(n);
    return m ? [m[1] ? Number(m[1]) : 1] : [];
  });
  if (count === 1 && taken.length === 0) return [base];
  let next = taken.length ? Math.max(...taken) + 1 : 1;
  return Array.from({ length: count }, () => `${base} ${next++}`.slice(0, 40));
}

// ---------- actions ----------

/**
 * The initiative tracker. State lives in the store (one encounter per campaign); every change is
 * saved and then re-sent to each client filtered for its role.
 */
export class CombatTracker<C extends CombatConn> {
  constructor(
    private readonly store: Store,
    private readonly host: CombatHost<C>,
  ) {}

  private resolve(campaignId: string, encounter: Encounter): StoredCombatant[] {
    const characters: Characters = new Map(this.store.characters(campaignId).map((c) => [c.id, c]));
    const tokens = new Map<string, Token>();
    for (const c of encounter.combatants) {
      const t = c.tokenId ? this.store.getToken(c.tokenId) : undefined;
      if (t) tokens.set(t.id, t);
    }
    return resolveCombatants(encounter, characters, tokens);
  }

  viewFor(conn: C): CombatView | null {
    const encounter = this.store.getEncounter(conn.campaignId);
    if (!encounter) return null;
    return combatView(encounter, this.resolve(conn.campaignId, encounter), { role: conn.role, userId: conn.user?.id });
  }

  /** Re-sends the encounter to everyone in the campaign. */
  changed(campaignId: string): void {
    const encounter = this.store.getEncounter(campaignId);
    const resolved = encounter ? this.resolve(campaignId, encounter) : [];
    const views = new Map<string, CombatView>();
    this.host.broadcast(campaignId, (conn) => {
      if (!encounter) return { type: 'combat', combat: null };
      const key = conn.role === 'player' ? `player:${conn.user?.id}` : conn.role;
      let view = views.get(key);
      if (!view) views.set(key, (view = combatView(encounter, resolved, { role: conn.role, userId: conn.user?.id })));
      return { type: 'combat', combat: view };
    });
  }

  /** Character sheets changed: their HP and conditions show in the tracker. */
  charactersChanged(campaignId: string): void {
    if (this.store.getEncounter(campaignId)?.combatants.some((c) => c.kind === 'character')) this.changed(campaignId);
  }

  handle(conn: C & { user: User }, msg: CombatMsg): void {
    switch (msg.type) {
      case 'combat:start':
        return this.start(conn, msg.fromScene ?? false);
      case 'combat:end':
        return this.end(conn);
      case 'combat:add':
        return this.add(conn, msg);
      case 'combat:remove':
        return this.remove(conn, msg.combatantId);
      case 'combat:initiative':
        return this.initiative(conn, msg);
      case 'combat:roll-initiative':
        return this.rollAll(conn);
      case 'combat:turn':
        return this.turn(conn, msg.dir);
      case 'combat:hp':
        return this.hp(conn, msg);
      case 'combat:condition':
        return this.condition(conn, msg);
      case 'combat:update':
        return this.update(conn, msg);
    }
  }

  /** An initiative roll made from a character sheet: use it if that character is in the fight. */
  rolledInitiative(conn: C & { user: User }, characterId: string, total: number): void {
    const encounter = this.store.getEncounter(conn.campaignId);
    const c = encounter?.combatants.find((x) => x.characterId === characterId);
    if (!encounter || !c) return;
    const rec = this.store.getCharacter(characterId);
    if (conn.role !== 'gm' && rec?.ownerUserId !== conn.user.id) return;
    c.initiative = total;
    this.save(conn.campaignId, encounter);
  }

  // ---------- helpers ----------

  private requireGm(conn: C): void {
    if (conn.role !== 'gm') throw new GameError('Only the GM can do that');
  }

  private encounter(conn: C): Encounter {
    const encounter = this.store.getEncounter(conn.campaignId);
    if (!encounter) throw new GameError('No combat is running');
    return encounter;
  }

  private combatant(encounter: Encounter, id: string): StoredCombatant {
    const c = encounter.combatants.find((x) => x.id === id);
    if (!c) throw new GameError('That combatant is not in the fight');
    return c;
  }

  private character(conn: C, c: StoredCombatant): CharacterRecord {
    const rec = c.characterId ? this.store.getCharacter(c.characterId) : undefined;
    if (!rec || rec.campaignId !== conn.campaignId) throw new GameError('Character not found');
    return rec;
  }

  /** GMs may change anyone; players only their own character. */
  private checkControl(conn: C & { user: User }, c: StoredCombatant): void {
    if (conn.role === 'gm') return;
    if (c.kind !== 'character' || this.character(conn, c).ownerUserId !== conn.user.id) throw new GameError("That's not your character");
  }

  private save(campaignId: string, encounter: Encounter): void {
    this.store.saveEncounter(campaignId, encounter);
    this.changed(campaignId);
  }

  private log(conn: C & { user: User }, visibility: Visibility, payload: { text: string } | { label: string; roll: ReturnType<typeof rollDice> }): void {
    const kind = 'text' in payload ? 'chat' : 'roll';
    this.host.publish(conn, this.store.addLog(conn.campaignId, conn.user.id, kind, visibility, payload));
  }

  private blank(encounter: Encounter, fields: Partial<StoredCombatant> & Pick<StoredCombatant, 'name' | 'kind'>): StoredCombatant {
    return {
      id: randomUUID(),
      tokenId: null,
      characterId: null,
      monsterId: null,
      ownerUserId: null,
      initiative: null,
      initiativeBonus: 0,
      dex: 10,
      ac: null,
      hp: null,
      hpMax: null,
      tempHp: 0,
      conditions: [],
      hidden: false,
      seq: encounter.nextSeq++,
      ...fields,
    };
  }

  private addCharacter(encounter: Encounter, rec: CharacterRecord, tokenId: string | null): void {
    if (encounter.combatants.some((c) => c.characterId === rec.id)) throw new GameError(`${rec.data.name} is already in the fight`);
    // Live stats come from the sheet; these copies only keep the stored shape complete.
    encounter.combatants.push(this.blank(encounter, { name: rec.data.name, kind: 'character', characterId: rec.id, ownerUserId: rec.ownerUserId, tokenId }));
  }

  private addToken(conn: C, encounter: Encounter, token: Token): void {
    if (encounter.combatants.some((c) => c.tokenId === token.id)) throw new GameError(`${token.name} is already in the fight`);
    if (token.characterId) {
      const rec = this.store.getCharacter(token.characterId);
      if (rec && rec.campaignId === conn.campaignId) return this.addCharacter(encounter, rec, token.id);
    }
    encounter.combatants.push(
      this.blank(encounter, { name: token.name, kind: 'npc', tokenId: token.id, ownerUserId: token.ownerUserId, hidden: token.hidden }),
    );
  }

  private rollFor(conn: C & { user: User }, c: StoredCombatant): void {
    let expr = d20Expression(c.initiativeBonus);
    let visibility: Visibility = 'gm';
    if (c.kind === 'character') {
      const rec = this.character(conn, c);
      expr = d20Test(rec.data, 'check', computeCharacter(rec.data).initiative, 'dex').expr;
      visibility = 'public';
    }
    const roll = rollDice(expr);
    c.initiative = roll.total;
    this.log(conn, visibility, { label: `${c.name}: Initiative`.slice(0, 80), roll });
  }

  // ---------- handlers ----------

  private start(conn: C & { user: User }, fromScene: boolean): void {
    this.requireGm(conn);
    if (this.store.getEncounter(conn.campaignId)) throw new GameError('Combat is already running');
    const encounter: Encounter = { round: 1, activeId: null, nextSeq: 0, combatants: [] };
    if (fromScene) {
      const sceneId = this.host.sceneIdFor(conn);
      if (!sceneId) throw new GameError('There is no map to take tokens from');
      for (const token of this.store.tokens(sceneId)) {
        if (!encounter.combatants.some((c) => token.characterId && c.characterId === token.characterId)) this.addToken(conn, encounter, token);
      }
    }
    this.log(conn, 'public', { text: 'Combat begins. Roll initiative!' });
    this.save(conn.campaignId, encounter);
  }

  private end(conn: C & { user: User }): void {
    this.requireGm(conn);
    const encounter = this.encounter(conn);
    this.store.deleteEncounter(conn.campaignId);
    const rounds = encounter.activeId ? ` after ${encounter.round} ${encounter.round === 1 ? 'round' : 'rounds'}` : '';
    this.log(conn, 'public', { text: `Combat ends${rounds}.` });
    this.changed(conn.campaignId);
  }

  private add(conn: C & { user: User }, { source }: Msg<'combat:add'>): void {
    this.requireGm(conn);
    const encounter = this.encounter(conn);
    switch (source.kind) {
      case 'token': {
        const token = this.store.getToken(source.tokenId);
        const scene = token && this.store.getScene(token.sceneId);
        if (!token || scene?.campaignId !== conn.campaignId) throw new GameError('Token not found');
        this.addToken(conn, encounter, token);
        break;
      }
      case 'character': {
        const rec = this.store.getCharacter(source.characterId);
        if (!rec || rec.campaignId !== conn.campaignId) throw new GameError('Character not found');
        const sceneId = this.host.sceneIdFor(conn);
        const token = sceneId ? this.store.tokens(sceneId).find((t) => t.characterId === rec.id) : undefined;
        this.addCharacter(encounter, rec, token?.id ?? null);
        break;
      }
      case 'monster':
        this.addMonsters(conn, encounter, source);
        break;
      case 'custom':
        encounter.combatants.push(
          this.blank(encounter, { name: source.name, kind: 'npc', initiativeBonus: source.initiativeBonus ?? 0, hidden: source.hidden ?? false }),
        );
        break;
    }
    this.save(conn.campaignId, encounter);
  }

  private addMonsters(conn: C, encounter: Encounter, source: Extract<Msg<'combat:add'>['source'], { kind: 'monster' }>): void {
    const def = MONSTERS_BY_ID[source.monsterId];
    if (!def) throw new GameError('Unknown monster');
    const count = source.count ?? 1;
    const hidden = source.hidden ?? false;
    const names = numberedNames(def.name, count, encounter.combatants.map((c) => c.name));
    let scene: SceneRecord | undefined;
    let spots: { col: number; row: number }[] = [];
    if (source.placeToken) {
      const sceneId = this.host.sceneIdFor(conn);
      scene = sceneId ? this.store.getScene(sceneId) : undefined;
      if (!scene) throw new GameError('There is no map to place the token on');
      spots = freeSpots(scene, this.store.tokens(scene.id), SIZE_CELLS[def.size], count);
    }
    names.forEach((name, i) => {
      const hp = source.rollHp ? Math.max(1, rollDice(def.hpFormula).total) : def.hp;
      const token = scene
        ? this.store.createToken({
            sceneId: scene.id,
            name,
            color: MONSTER_COLOR,
            size: SIZE_CELLS[def.size],
            hidden,
            ownerUserId: null,
            characterId: null,
            ...spots[i]!,
          })
        : undefined;
      // The token sees with the monster's senses (darkvision, blindsight, truesight).
      const senses = monsterSenses(def);
      if (token && Object.keys(senses).length) this.store.setTokenVision(token.id, { senses });
      encounter.combatants.push(
        this.blank(encounter, {
          name,
          kind: 'monster',
          monsterId: def.id,
          tokenId: token?.id ?? null,
          initiativeBonus: monsterInitiative(def),
          dex: def.scores.dex,
          ac: def.ac,
          hp,
          hpMax: hp,
          hidden,
        }),
      );
    });
    if (scene) this.host.sceneChanged(conn.campaignId, scene.id);
  }

  private remove(conn: C & { user: User }, combatantId: string): void {
    this.requireGm(conn);
    const encounter = this.encounter(conn);
    const c = this.combatant(encounter, combatantId);
    if (encounter.activeId === c.id) {
      // The turn passes to whoever is next.
      const order = this.resolve(conn.campaignId, encounter).map((x) => x.id);
      const next = advanceTurn(order, encounter, 'next');
      Object.assign(encounter, next.activeId === c.id ? { activeId: null } : next);
    }
    encounter.combatants = encounter.combatants.filter((x) => x.id !== c.id);
    this.save(conn.campaignId, encounter);
  }

  private initiative(conn: C & { user: User }, msg: Msg<'combat:initiative'>): void {
    const encounter = this.encounter(conn);
    const c = this.combatant(encounter, msg.combatantId);
    this.checkControl(conn, c);
    if (msg.value === undefined) {
      this.rollFor(conn, this.withLiveName(conn, c));
    } else {
      c.initiative = msg.value;
      if (conn.role !== 'gm') this.log(conn, 'public', { text: `${this.withLiveName(conn, c).name} has initiative ${msg.value}.` });
    }
    this.save(conn.campaignId, encounter);
  }

  /** Character combatants store a copy of the name; use the sheet's current one in log lines. */
  private withLiveName(conn: C, c: StoredCombatant): StoredCombatant {
    if (c.kind === 'character') c.name = this.character(conn, c).data.name;
    return c;
  }

  private rollAll(conn: C & { user: User }): void {
    this.requireGm(conn);
    const encounter = this.encounter(conn);
    const pending = encounter.combatants.filter((c) => c.kind !== 'character' && c.initiative === null);
    if (pending.length === 0) throw new GameError('Every creature has rolled initiative');
    for (const c of pending) this.rollFor(conn, c);
    this.save(conn.campaignId, encounter);
  }

  private turn(conn: C & { user: User }, dir: 'next' | 'prev'): void {
    const encounter = this.encounter(conn);
    const resolved = this.resolve(conn.campaignId, encounter);
    const active = resolved.find((c) => c.id === encounter.activeId);
    const ownTurn = dir === 'next' && active !== undefined && active.ownerUserId === conn.user.id;
    if (conn.role !== 'gm' && !ownTurn) throw new GameError("It's not your turn");
    if (resolved.length === 0) throw new GameError('No one is in the fight yet');
    const next = advanceTurn(
      resolved.map((c) => c.id),
      encounter,
      dir,
    );
    if (next.round > encounter.round || (dir === 'next' && !encounter.activeId)) this.log(conn, 'public', { text: `Round ${next.round}` });
    Object.assign(encounter, next);
    this.save(conn.campaignId, encounter);
  }

  private hp(conn: C & { user: User }, msg: Msg<'combat:hp'>): void {
    const encounter = this.encounter(conn);
    const c = this.combatant(encounter, msg.combatantId);
    this.checkControl(conn, c);
    if (c.kind === 'character') {
      const rec = this.character(conn, c);
      const hpMax = computeCharacter(rec.data).hpMax;
      const s = rec.data.state;
      const state =
        msg.op === 'temp' ? { ...s, tempHp: Math.max(s.tempHp, msg.amount) } : applyHpChange(s, hpMax, msg.op === 'damage' ? -msg.amount : msg.amount);
      return this.host.saveCharacter(conn, rec.id, { ...rec.data, state }, rec.data);
    }
    if (c.hpMax === null) throw new GameError(`Set hit points for ${c.name} first`);
    const cur = { hp: c.hp ?? c.hpMax, tempHp: c.tempHp };
    // Temporary hit points don't stack: keep the higher value.
    const next = msg.op === 'temp' ? { ...cur, tempHp: Math.max(cur.tempHp, msg.amount) } : applyHp(cur, c.hpMax, msg.op === 'damage' ? -msg.amount : msg.amount);
    Object.assign(c, next);
    this.save(conn.campaignId, encounter);
  }

  private condition(conn: C & { user: User }, msg: Msg<'combat:condition'>): void {
    const encounter = this.encounter(conn);
    const c = this.combatant(encounter, msg.combatantId);
    this.checkControl(conn, c);
    const toggle = (list: ConditionId[]) => {
      const without = list.filter((x) => x !== msg.condition);
      return msg.on ? [...without, msg.condition as ConditionId] : without;
    };
    if (c.kind === 'character') {
      const rec = this.character(conn, c);
      return this.host.saveCharacter(conn, rec.id, { ...rec.data, state: { ...rec.data.state, conditions: toggle(rec.data.state.conditions) } }, rec.data);
    }
    c.conditions = toggle(c.conditions);
    this.save(conn.campaignId, encounter);
  }

  private update(conn: C & { user: User }, msg: Msg<'combat:update'>): void {
    this.requireGm(conn);
    const encounter = this.encounter(conn);
    const c = this.combatant(encounter, msg.combatantId);
    const token = c.tokenId ? this.store.getToken(c.tokenId) : undefined;
    if (msg.hidden !== undefined) c.hidden = msg.hidden;
    // Characters take their name and numbers from the sheet.
    if (c.kind !== 'character') {
      if (msg.name !== undefined) c.name = msg.name;
      if (msg.ac !== undefined) c.ac = msg.ac;
      if (msg.initiativeBonus !== undefined) c.initiativeBonus = msg.initiativeBonus;
      if (msg.hpMax !== undefined) {
        c.hpMax = msg.hpMax;
        c.hp = msg.hpMax === null ? null : Math.min(c.hp ?? msg.hpMax, msg.hpMax);
      }
      if (msg.hp !== undefined) {
        if (c.hpMax === null) throw new GameError(`Set maximum hit points for ${c.name} first`);
        c.hp = Math.min(msg.hp, c.hpMax);
      }
    }
    // Keep a linked token in step, so revealing a creature also reveals it on the map.
    if (token && (token.hidden !== c.hidden || (c.kind !== 'character' && token.name !== c.name))) {
      this.store.updateToken({ ...token, hidden: c.hidden, name: c.kind === 'character' ? token.name : c.name });
      this.host.sceneChanged(conn.campaignId, token.sceneId);
    }
    this.save(conn.campaignId, encounter);
  }
}
