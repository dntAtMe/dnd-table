import type { CameraRect, User } from '@dnd/protocol';
import { gridGeometry, pointToCell, type TerrainId } from '@dnd/rules';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { DiceTray } from '../components/DiceTray';
import { LogFeed } from '../components/LogFeed';
import { DisplaysPanel, InviteCode, PartyList } from '../components/Panels';
import { RollView } from '../components/RollView';
import { MapEditorPanel, SecretDoorToggle, TerrainPicker } from '../components/map/MapEditorPanel';
import { MapToolbar, type ToolOption } from '../components/map/MapToolbar';
import { MapView, type MapTool } from '../components/map/MapView';
import { SceneSettings, ScenesPanel } from '../components/ScenePanels';
import { AddTokenMenu, TokenInspector } from '../components/TokenPanels';
import { LightPicker } from '../components/TokenVision';
import { CharacterCreator } from '../components/character/CharacterCreator';
import { CharacterPanel } from '../components/character/CharacterSheet';
import { CombatPanel } from '../components/combat/CombatPanel';
import { InitiativeStrip } from '../components/combat/InitiativeStrip';
import { CombatantCard } from '../components/combat/InitiativeTracker';
import { tokenDecorations } from '../components/combat/TokenDecor';
import { LevelUp } from '../components/character/LevelUp';
import { useGameSocket, type SocketStatus } from '../lib/useGameSocket';

const STATUS_TEXT: Record<SocketStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  failed: 'Disconnected',
};

interface SectionProps {
  title: string;
  children: ReactNode;
  className?: string;
  /** Which mobile tab shows this section. */
  tab?: Tab;
}

function Section({ title, children, className = '', tab }: SectionProps) {
  return (
    <section className={`panel ${className}`} data-tab={tab}>
      <h2 className="panel__title">{title}</h2>
      {children}
    </section>
  );
}

/** 'combat' shares the second phone tab with the sheet (see MobileSwitch). */
type Tab = 'map' | 'sheet' | 'combat' | 'dice' | 'log' | 'party';

const PLAYER_TOOLS: ToolOption[] = [
  { tool: 'move', label: 'Move' },
  { tool: 'ruler', label: 'Measure' },
  { tool: 'ping', label: 'Ping' },
];
const GM_TOOLS: ToolOption[] = [...PLAYER_TOOLS, { tool: 'reveal', label: 'Reveal' }, { tool: 'hide', label: 'Hide' }];
const EDIT_TOOLS: ToolOption[] = [
  { tool: 'wall', label: 'Wall', group: true },
  { tool: 'door', label: 'Door' },
  { tool: 'terrain', label: 'Terrain' },
  { tool: 'erase', label: 'Erase' },
];

const TAB_LABELS: Record<Tab, string> = { map: 'Map', sheet: 'Sheet', combat: 'Combat', dice: 'Dice', log: 'Log', party: 'Party' };

function MapEmpty({ isGm }: { isGm: boolean }) {
  return (
    <div className="map-empty">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <path d="M6 14 22 8l20 6 16-6v42l-16 6-20-6-16 6z" />
        <path d="M22 8v42M42 14v42" />
      </svg>
      <p>{isGm ? 'Create a scene in the sidebar to get started.' : 'No map in play yet.'}</p>
    </div>
  );
}

export function Campaign({ user }: { user: User }) {
  const { id = '' } = useParams();
  const { state, send } = useGameSocket(`campaign=${encodeURIComponent(id)}`);
  const [tab, setTab] = useState<Tab>('map');
  const [toast, setToast] = useState<string>();
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [tool, setTool] = useState<MapTool>('move');
  const [brush, setBrush] = useState(3);
  const [terrain, setTerrain] = useState<TerrainId>('floor');
  const [secretDoors, setSecretDoors] = useState(false);
  const [creating, setCreating] = useState(false);
  const [levelingId, setLevelingId] = useState<string | null>(null);
  const leveling = state.characters.find((c) => c.id === levelingId);
  const viewRect = useRef<CameraRect | null>(null);
  const [followTable, setFollowTable] = useState(false);
  const { hello, scene } = state;
  const isLive = Boolean(scene && scene.id === state.activeSceneId);
  const tableFollows = followTable && isLive;

  // While "table follows me" is on, stream the GM's view to table screens (throttled).
  const cameraTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const lastCameraSent = useRef(0);
  const sendCamera = useCallback(() => {
    const rect = viewRect.current;
    if (!rect || !scene) return;
    lastCameraSent.current = Date.now();
    send({ type: 'camera', sceneId: scene.id, rect });
  }, [scene, send]);
  const onViewChange = useCallback(
    (rect: CameraRect) => {
      viewRect.current = rect;
      if (!tableFollows) return;
      clearTimeout(cameraTimer.current);
      const wait = 150 - (Date.now() - lastCameraSent.current);
      if (wait <= 0) sendCamera();
      else cameraTimer.current = setTimeout(sendCamera, wait);
    },
    [tableFollows, sendCamera],
  );
  useEffect(() => {
    if (tableFollows) sendCamera();
  }, [tableFollows, sendCamera]);
  const isGm = hello?.you.role === 'gm';
  const selectedToken = scene?.tokens.find((t) => t.id === selectedTokenId) ?? null;
  const { combat } = state;
  const decorations = useMemo(
    () => tokenDecorations(combat, scene?.tokens ?? [], { isGm, userId: hello?.you.userId }),
    [combat, scene?.tokens, isGm, hello?.you.userId],
  );
  const activeCombatant = combat?.combatants.find((c) => c.id === combat.activeId);
  const myTurn = Boolean(activeCombatant && !isGm && activeCombatant.ownerUserId === hello?.you.userId);
  const selectedCombatant = selectedToken
    ? combat?.combatants.find((c) => c.tokenId === selectedToken.id || (c.characterId !== null && c.characterId === selectedToken.characterId))
    : undefined;

  // GM shortcut: Delete/Backspace removes the selected token.
  useEffect(() => {
    if (!isGm || !selectedToken) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]')) return;
      if (e.key === 'Delete' || e.key === 'Backspace') {
        e.preventDefault();
        send({ type: 'token:delete', tokenId: selectedToken.id });
      } else if (e.key === 'Escape') {
        setSelectedTokenId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isGm, selectedToken, send]);

  /** Cell at the centre of what the GM is looking at, for dropping new tokens. */
  const viewCentreCell = () => {
    if (!scene) return { col: 0, row: 0 };
    const r = viewRect.current ?? { x: 0, y: 0, w: scene.width, h: scene.height };
    const geo = gridGeometry(scene.grid, scene.width, scene.height);
    const centre = pointToCell(geo, scene.grid.size, r.x + r.w / 2, r.y + r.h / 2);
    // Spiral outwards to the nearest cell no token covers, so new tokens don't stack.
    const taken = (c: number, rr: number) =>
      scene.tokens.some((t) => c >= t.col && c < t.col + t.size && rr >= t.row && rr < t.row + t.size);
    for (let ring = 0; ring < 20; ring++) {
      for (let dr = -ring; dr <= ring; dr++) {
        for (let dc = -ring; dc <= ring; dc++) {
          if (Math.max(Math.abs(dc), Math.abs(dr)) !== ring) continue;
          const col = centre.col + dc;
          const row = centre.row + dr;
          if (col >= 0 && row >= 0 && col < geo.cols && row < geo.rows && !taken(col, row)) return { col, row };
        }
      }
    }
    return centre;
  };

  useEffect(() => {
    if (!state.error) return;
    setToast(state.error.message);
    const t = setTimeout(() => setToast(undefined), 4000);
    return () => clearTimeout(t);
  }, [state.error]);

  useEffect(() => {
    if (hello) document.title = `${hello.campaign.name} · dnd-table`;
  }, [hello]);

  if (state.failure) {
    return (
      <div className="centered">
        <div className="card stack">
          <h2>Can't open this campaign</h2>
          <p className="muted">{state.failure.reason || 'You may not be a member of it.'}</p>
          <Link to="/" className="btn">
            Back to campaigns
          </Link>
        </div>
      </div>
    );
  }

  if (!hello) return <div className="page-loading">{STATUS_TEXT[state.status]}</div>;

  const online = state.members.filter((m) => m.online).length;

  return (
    <div className={`campaign campaign--${isGm ? 'gm' : 'player'}`} data-active-tab={tab}>
      <header className="topbar">
        <Link to="/" className="topbar__back" aria-label="All campaigns">
          ←
        </Link>
        <h1 className="topbar__title">{hello.campaign.name}</h1>
        <span className={`badge ${isGm ? 'badge--gm' : ''}`}>{isGm ? 'GM' : 'Player'}</span>
        <div className="topbar__right">
          <span className={`status status--${state.status}`}>{STATUS_TEXT[state.status]}</span>
          <span className="muted topbar__user">{user.displayName}</span>
        </div>
      </header>

      <div className="campaign__grid">
        <aside className="campaign__side" data-tab="party">
          <Section title={`Party · ${online} online`}>
            <PartyList members={state.members} />
          </Section>
          {isGm && (
            <Section title="Scenes">
              <ScenesPanel
                campaignId={hello.campaign.id}
                scenes={state.scenes}
                activeSceneId={state.activeSceneId}
                openSceneId={state.scene?.id ?? null}
                send={send}
              />
            </Section>
          )}
          {isGm && selectedToken && (
            <Section title="Token">
              <TokenInspector key={selectedToken.id} token={selectedToken} members={state.members} characters={state.characters} send={send} />
            </Section>
          )}
          {!isGm && selectedToken && selectedToken.ownerUserId === hello.you.userId && (
            <Section title={selectedToken.name}>
              <LightPicker token={selectedToken} send={send} />
            </Section>
          )}
          {isGm && selectedCombatant && (
            <Section title="In combat">
              <CombatantCard key={selectedCombatant.id} combatant={selectedCombatant} send={send} />
            </Section>
          )}
          {isGm && state.scene && (
            <Section title="Scene settings">
              <SceneSettings key={state.scene.id} scene={state.scene} isLive={state.scene.id === state.activeSceneId} send={send} />
            </Section>
          )}
          {isGm && state.scene && (
            <Section title="Map editor">
              <MapEditorPanel key={state.scene.id} scene={state.scene} send={send} />
            </Section>
          )}
          {isGm && hello.campaign.inviteCode && (
            <Section title="Invite players">
              <InviteCode code={hello.campaign.inviteCode} />
              <p className="hint">Players join from their home screen with this code.</p>
            </Section>
          )}
          {isGm && (
            <Section title="Table displays">
              <DisplaysPanel campaignId={hello.campaign.id} displays={state.displays} />
            </Section>
          )}
        </aside>

        <div className="campaign__center">
        <div className="center-switch" role="tablist" aria-label="Main view">
          <button type="button" role="tab" aria-selected={tab !== 'sheet' && tab !== 'combat'} className={tab !== 'sheet' && tab !== 'combat' ? 'is-active' : ''} onClick={() => setTab('map')}>
            Map
          </button>
          <button type="button" role="tab" aria-selected={tab === 'sheet'} className={tab === 'sheet' ? 'is-active' : ''} onClick={() => setTab('sheet')}>
            {isGm ? 'Characters' : 'Character'}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'combat'} className={tab === 'combat' ? 'is-active' : ''} onClick={() => setTab('combat')}>
            Combat
            {combat && <span className="center-switch__live" aria-label="in progress" />}
          </button>
        </div>
        <main className="campaign__map" data-tab="map">
          {scene ? (
            <MapView
              scene={scene}
              isGm={isGm}
              userId={hello.you.userId}
              selectedTokenId={selectedTokenId}
              onSelectToken={setSelectedTokenId}
              onMoveToken={(tokenId, col, row) => send({ type: 'token:move', tokenId, col, row })}
              onViewChange={onViewChange}
              tool={tool}
              brush={brush}
              onPaintFog={(cells, reveal) => send({ type: 'fog:paint', sceneId: scene.id, cells, reveal })}
              pings={state.pings}
              onPing={(x, y) => send({ type: 'ping', sceneId: scene.id, x, y })}
              terrain={terrain}
              secretDoors={secretDoors}
              onMapEdit={send}
              decorations={decorations}
            >
              <MapToolbar
                tools={isGm ? [...(scene.fogEnabled ? GM_TOOLS : PLAYER_TOOLS), ...EDIT_TOOLS] : PLAYER_TOOLS}
                tool={tool}
                onTool={setTool}
                brush={brush}
                onBrush={setBrush}
              >
                {isGm && tool === 'terrain' && <TerrainPicker value={terrain} onChange={setTerrain} />}
                {isGm && tool === 'door' && <SecretDoorToggle secret={secretDoors} onChange={setSecretDoors} />}
                {isGm && <AddTokenMenu scene={scene} members={state.members} characters={state.characters} at={viewCentreCell} send={send} />}
                {isGm && isLive && state.displays.length > 0 && (
                  <button
                    type="button"
                    className={`toggle toggle--sm${followTable ? ' toggle--on' : ''}`}
                    onClick={() => setFollowTable((f) => !f)}
                    aria-pressed={followTable}
                    title="Table screens show what you're looking at"
                  >
                    Table follows me
                  </button>
                )}
              </MapToolbar>
            </MapView>
          ) : (
            <MapEmpty isGm={isGm} />
          )}
          {combat && combat.combatants.length > 0 && (
            <div className="map-initiative">
              <InitiativeStrip
                combat={combat}
                onOpen={() => setTab('combat')}
                action={
                  isGm || myTurn ? (
                    <button type="button" className="btn btn--sm btn--primary" onClick={() => send({ type: 'combat:turn', dir: 'next' })}>
                      {isGm ? (combat.activeId ? 'Next' : 'Start') : 'End turn'}
                    </button>
                  ) : undefined
                }
              />
            </div>
          )}
          {isGm && state.scene && state.scene.id !== state.activeSceneId && (
            <div className="map-banner">
              <span>Preparing: players can't see this scene</span>
              <button type="button" className="btn btn--sm btn--primary" onClick={() => send({ type: 'scene:activate', sceneId: state.scene!.id })}>
                Show to players
              </button>
            </div>
          )}
        </main>
        <section className="campaign__sheet" data-tab="sheet">
          <MobileSwitch tab={tab} setTab={setTab} live={Boolean(combat)} />
          {creating ? (
            <CharacterCreator send={send} onDone={() => setCreating(false)} />
          ) : leveling ? (
            <LevelUp key={leveling.id} record={leveling} send={send} onDone={() => setLevelingId(null)} />
          ) : (
            <CharacterPanel
              characters={state.characters}
              members={state.members}
              userId={hello.you.userId}
              isGm={isGm}
              send={send}
              onCreate={() => setCreating(true)}
              onLevelUp={(record) => setLevelingId(record.id)}
            />
          )}
        </section>
        <section className="campaign__combat" data-tab="combat">
          <MobileSwitch tab={tab} setTab={setTab} live={Boolean(combat)} />
          <CombatPanel combat={combat} isGm={isGm} userId={hello.you.userId} characters={state.characters} scene={scene} send={send} />
        </section>
        </div>

        <div className="campaign__right">
          <Section title="Dice" className="campaign__dice" tab="dice">
            <DiceTray isGm={isGm} disabled={state.status !== 'open'} onRoll={send} />
            <div className="campaign__last">
              <LastRoll state={state} userId={hello.you.userId} />
            </div>
          </Section>

          <Section title="Log" className="campaign__log" tab="log">
            <LogFeed log={state.log} myUserId={hello.you.userId} isGm={isGm} onSend={send} />
          </Section>
        </div>
      </div>

      <nav className="tabbar" aria-label="Sections">
        {(['map', 'sheet', 'dice', 'log', 'party'] as const).map((t) => (
          <button
            key={t}
            type="button"
            className={tab === t || (t === 'sheet' && tab === 'combat') ? 'is-active' : ''}
            onClick={() => setTab(t === 'sheet' && combat && tab !== 'sheet' ? 'combat' : t)}
          >
            {t === 'party' && isGm ? 'Manage' : t === 'sheet' && combat ? 'Combat' : TAB_LABELS[t]}
          </button>
        ))}
      </nav>

      {toast && (
        <div className="toast" role="alert">
          {toast}
        </div>
      )}
    </div>
  );
}

/** Phones: the sheet and the combat tracker share a tab, with this switch at the top. */
function MobileSwitch({ tab, setTab, live }: { tab: Tab; setTab: (t: Tab) => void; live: boolean }) {
  return (
    <div className="segmented segmented--full mobile-switch" role="tablist" aria-label="Sheet or combat">
      <button type="button" role="tab" aria-selected={tab === 'sheet'} className={tab === 'sheet' ? 'is-active' : ''} onClick={() => setTab('sheet')}>
        Sheet
      </button>
      <button type="button" role="tab" aria-selected={tab === 'combat'} className={tab === 'combat' ? 'is-active' : ''} onClick={() => setTab('combat')}>
        Combat
        {live && <span className="center-switch__live" aria-label="in progress" />}
      </button>
    </div>
  );
}

/** On phones the log lives on another tab, so show your latest roll right under the tray. */
function LastRoll({ state, userId }: { state: ReturnType<typeof useGameSocket>['state']; userId?: string }) {
  const last = [...state.log].reverse().find((e) => e.kind === 'roll' && e.author.userId === userId);
  if (!last || last.kind !== 'roll') return null;
  return (
    <div className="last-roll" key={last.id}>
      <div className="last-roll__head">
        <span>Your last roll</span>
        {last.label && <span className="entry__label">{last.label}</span>}
        <span className="entry__expr">{last.roll.expression}</span>
      </div>
      <RollView roll={last.roll} />
    </div>
  );
}
