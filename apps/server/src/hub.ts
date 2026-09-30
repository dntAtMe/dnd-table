import { DiceError, rollDice } from '@dnd/rules';
import {
  ClientMessage,
  type ClientRole,
  type DisplayInfo,
  type LogEntry,
  type Member,
  type ServerMessage,
  type User,
} from '@dnd/protocol';
import type { WebSocket } from 'ws';
import type { Display, Store } from './store';

const LOG_HISTORY = 100;
const HEARTBEAT_MS = 30_000;

interface Conn {
  socket: WebSocket;
  role: ClientRole;
  campaignId: string;
  user?: User;
  displayId?: string;
}

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
    });
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
    const msg = parsed.data;

    switch (msg.type) {
      case 'roll': {
        let roll;
        try {
          roll = rollDice(msg.expr);
        } catch (err) {
          if (err instanceof DiceError) return send(conn.socket, { type: 'error', message: err.message });
          throw err;
        }
        const label = msg.label || undefined;
        this.publish(conn, this.store.addLog(conn.campaignId, conn.user.id, 'roll', msg.visibility, { label, roll }));
        break;
      }
      case 'chat':
        this.publish(conn, this.store.addLog(conn.campaignId, conn.user.id, 'chat', msg.visibility, { text: msg.text }));
        break;
    }
  }

  private publish(from: Conn, entry: LogEntry): void {
    for (const conn of this.rooms.get(from.campaignId) ?? []) {
      if (canSee(conn, entry)) send(conn.socket, { type: 'log', entry });
    }
  }
}
