import type { CameraRect, User } from '@dnd/protocol';
import { gridGeometry, pointToCell, type EntryRef, type TerrainId } from '@dnd/rules';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams } from 'react-router';
import { DiceTray } from '../components/DiceTray';
import { LogFeed } from '../components/LogFeed';
import { DisplaysPanel, InviteCode, PartyList } from '../components/Panels';
import { RollView } from '../components/RollView';
import { SecretDoorToggle, TerrainPicker } from '../components/map/MapEditorPanel';
import { SceneEditCard } from '../components/map/SceneEditCard';
import { MapToolbar, type ToolOption } from '../components/map/MapToolbar';
import { MapView, type MapTool } from '../components/map/MapView';
import type { VisionPreview } from '../components/map/VisionLayer';
import { TokenActions } from '../components/map/TokenActions';
import { DEFAULT_TEMPLATE_SETTINGS, type TemplateSettings } from '../components/map/TemplateLayer';
import { TemplateCard, TemplateOptions } from '../components/map/TemplatePanel';
import { ScenesPanel } from '../components/ScenePanels';
import { AddTokenMenu } from '../components/TokenPanels';
import { VisionPreviewPicker, sheetDarkvision } from '../components/TokenVision';
import { CharacterCreator } from '../components/character/CharacterCreator';
import { CharacterPanel } from '../components/character/CharacterSheet';
import { CombatPanel } from '../components/combat/CombatPanel';
import { InitiativeStrip } from '../components/combat/InitiativeStrip';
import { tokenDecorations } from '../components/combat/TokenDecor';
import { LevelUp } from '../components/character/LevelUp';
import { AudioControl, AudioUnlockPrompt } from '../components/audio/AudioControls';
import { SoundboardPanel } from '../components/audio/SoundboardPanel';
import { useAmbientAudio, useAudioPrefs } from '../components/audio/useAmbientAudio';
import { HandoutsPanel, ShowcaseStatus } from '../components/handouts/HandoutsPanel';
import { ShowcaseOverlay, useHandoutNotice, usePlayerShowcase } from '../components/handouts/Showcase';
import { WikiPanel } from '../components/wiki/WikiPanel';
import { PageEntryBody } from '../components/wiki/PageEntryBody';
import { useWikiOpenRequest, useWikiSync, useWikiUnreadCount } from '../components/wiki/wikiStore';
import { registerEntryRenderer } from '../components/knowledge/renderers';
import { CompendiumView } from '../components/knowledge/CompendiumView';
import { useEntryHistory } from '../components/knowledge/history';
import { PopupLayer } from '../components/knowledge/PopupLayer';
import { RichText } from '../components/knowledge/RichText';
import { QuickSearch, useQuickSearchShortcut } from '../components/knowledge/QuickSearch';
import { useGameSocket, type SocketStatus } from '../lib/useGameSocket';
import { useMediaQuery } from '../lib/useMediaQuery';
import { useStoredState } from '../lib/useStoredState';

const STATUS_TEXT: Record<SocketStatus, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  failed: 'Disconnected',
};

interface SectionProps {
  title: string;
  /** For a section that is the only one under a sidebar tab of the same name. */
  hideTitle?: boolean;
  children: ReactNode;
  className?: string;
  /** Which mobile tab shows this section. */
  tab?: Tab;
}

function Section({ title, hideTitle = false, children, className = '', tab }: SectionProps) {
  return (
    <section className={`panel ${className}`} data-tab={tab} aria-label={hideTitle ? title : undefined}>
      {!hideTitle && <h2 className="panel__title">{title}</h2>}
      {children}
    </section>
  );
}

/** 'combat', 'handouts', 'compendium' and 'wiki' share the second phone tab with the sheet (see MobileSwitch). */
type Tab = 'map' | 'sheet' | 'combat' | 'handouts' | 'compendium' | 'wiki' | 'dice' | 'log' | 'party';

const PLAYER_TOOLS: ToolOption[] = [
  { tool: 'move', label: 'Move' },
  { tool: 'ruler', label: 'Measure' },
  { tool: 'ping', label: 'Ping' },
  { tool: 'template', label: 'Area' },
];
const GM_TOOLS: ToolOption[] = [...PLAYER_TOOLS, { tool: 'reveal', label: 'Reveal' }, { tool: 'hide', label: 'Hide' }];
const EDIT_TOOLS: ToolOption[] = [
  { tool: 'move', label: 'Move' },
  { tool: 'wall', label: 'Wall', group: true },
  { tool: 'door', label: 'Door' },
  { tool: 'terrain', label: 'Terrain' },
  { tool: 'erase', label: 'Erase' },
];

const TAB_LABELS: Record<Tab, string> = {
  map: 'Map',
  sheet: 'Sheet',
  combat: 'Combat',
  handouts: 'Handouts',
  compendium: 'Compendium',
  wiki: 'Wiki',
  dice: 'Dice',
  log: 'Log',
  party: 'Party',
};
/** The GM sidebar's groups: what's in play, who's at the table, and sound. */
type SideTab = 'scenes' | 'party' | 'sound';
const SIDE_TABS: readonly SideTab[] = ['scenes', 'party', 'sound'];

/** Center views other than the map. */
const CENTER_VIEWS = new Set<Tab>(['sheet', 'combat', 'handouts', 'compendium', 'wiki']);

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
  const compendiumHistory = useEntryHistory();
  const showInCompendium = useCallback(
    (ref: EntryRef) => {
      setTab('compendium');
      compendiumHistory.go(ref);
    },
    [compendiumHistory],
  );
  const [searching, setSearching] = useState(false);
  const toggleSearch = useCallback(() => setSearching((s) => !s), []);
  useQuickSearchShortcut(toggleSearch);
  const [toast, setToast] = useState<string>();
  const [selectedTokenId, setSelectedTokenId] = useState<string | null>(null);
  const [tool, setTool] = useState<MapTool>('move');
  /** GM: playing (tokens, fog brush, areas) or editing the scene (walls, doors, terrain, settings). */
  const [mapMode, setMapMode] = useState<'play' | 'edit'>('play');
  const switchMapMode = (mode: 'play' | 'edit') => {
    setMapMode(mode);
    setTool(mode === 'edit' ? 'wall' : 'move');
  };
  const [brush, setBrush] = useState(3);
  const [terrain, setTerrain] = useState<TerrainId>('floor');
  const [secretDoors, setSecretDoors] = useState(false);
  const [templateSettings, setTemplateSettings] = useState<TemplateSettings>(DEFAULT_TEMPLATE_SETTINGS);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [levelingId, setLevelingId] = useState<string | null>(null);
  const [sheetId, setSheetId] = useState<string | null>(null);
  const [sideTab, setSideTab] = useStoredState<SideTab>('gm-side-tab', 'scenes', SIDE_TABS);
  const openSheet = useCallback((characterId: string) => {
    setSheetId(characterId);
    setTab('sheet');
  }, []);
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
  /** GM: whose vision the map previews (null = the GM's own view). */
  /** GM: whose eyes the map shows ("player:<userId>" or "token:<tokenId>"), or null for the GM's own view. */
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const darkvisionOf = useMemo(() => sheetDarkvision(state.characters), [state.characters]);
  const unreadHandouts = isGm ? 0 : state.handouts.filter((h) => h.unread).length;
  const [handoutNotice, dismissHandoutNotice] = useHandoutNotice(state.handouts, Boolean(hello) && !isGm);
  const [playerShowcase, closePlayerShowcase] = usePlayerShowcase(isGm ? null : state.showcase);
  const [audioPrefs, setAudioPrefs] = useAudioPrefs(isGm ? 'gm' : 'player');
  const ambient = useAmbientAudio({
    audio: state.audio,
    clockOffset: state.clockOffset,
    effect: state.effect,
    enabled: Boolean(hello) && audioPrefs.enabled,
    volume: audioPrefs.volume,
  });
  // Campaign wiki: publish pages to the wiki views and the knowledge base; follow "open this page" requests.
  useWikiSync({ campaignId: hello?.campaign.id ?? null, pages: state.wiki, isGm, userId: hello?.you.userId, members: state.members, send });
  const unreadWiki = useWikiUnreadCount();
  const wikiRequest = useWikiOpenRequest();
  // Campaign pages render with the wiki's own view in popups and the Compendium.
  useEffect(() => registerEntryRenderer('page', PageEntryBody), []);
  useEffect(() => {
    if (wikiRequest) setTab('wiki');
  }, [wikiRequest]);
  const selectedToken = scene?.tokens.find((t) => t.id === selectedTokenId) ?? null;
  const selectedTemplate = scene?.templates.find((t) => t.id === selectedTemplateId) ?? null;
  const canEditTemplate = Boolean(selectedTemplate && (isGm || selectedTemplate.ownerUserId === hello?.you.userId));
  const { combat } = state;
  const editingScene = isGm && mapMode === 'edit';
  const visionPreview = useMemo((): VisionPreview | null => {
    if (!isGm || !previewKey || !scene?.vision.enabled || editingScene) return null;
    const [kind, id = ''] = previewKey.split(':') as ['player' | 'token', string];
    if (kind === 'player' && state.members.some((m) => m.userId === id)) return { kind, userId: id, darkvision: darkvisionOf };
    if (kind === 'token' && scene.tokens.some((t) => t.id === id)) return { kind, tokenId: id, darkvision: darkvisionOf };
    return null;
  }, [isGm, previewKey, scene, editingScene, state.members, darkvisionOf]);
  const previewName =
    visionPreview?.kind === 'player'
      ? state.members.find((m) => m.userId === visionPreview.userId)?.name
      : visionPreview?.kind === 'token'
        ? scene?.tokens.find((t) => t.id === visionPreview.tokenId)?.name
        : undefined;
  /** Phone layout: the sidebar is a tab of its own, so scene editing happens on the map. */
  const phone = useMediaQuery('(max-width: 960px)');
  // Previewing a player shows other creatures' health as they'd see it (Bloodied, not HP bars).
  const previewPlayer = visionPreview?.kind === 'player' ? visionPreview.userId : null;
  const decorations = useMemo(
    () => tokenDecorations(combat, scene?.tokens ?? [], previewPlayer ? { isGm: false, userId: previewPlayer } : { isGm, userId: hello?.you.userId }),
    [combat, scene?.tokens, isGm, hello?.you.userId, previewPlayer],
  );
  const activeCombatant = combat?.combatants.find((c) => c.id === combat.activeId);
  const myTurn = Boolean(activeCombatant && !isGm && activeCombatant.ownerUserId === hello?.you.userId);

  // Escape lets go of the selected token (closing its quick actions); for the GM, Delete/Backspace removes it.
  useEffect(() => {
    if (!selectedToken) return;
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea, select, [contenteditable]')) return;
      if (isGm && (e.key === 'Delete' || e.key === 'Backspace')) {
        e.preventDefault();
        send({ type: 'token:delete', tokenId: selectedToken.id });
      } else if (e.key === 'Escape') {
        setSelectedTokenId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isGm, selectedToken, send]);

  // Delete/Backspace removes the selected template (its owner or the GM); Escape lets go of it.
  useEffect(() => {
    if (!selectedTemplate) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).closest('input, textarea, select, [contenteditable]')) return;
      if ((e.key === 'Delete' || e.key === 'Backspace') && canEditTemplate) {
        e.preventDefault();
        send({ type: 'template:delete', templateId: selectedTemplate.id });
      } else if (e.key === 'Escape') {
        setSelectedTemplateId(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedTemplate, canEditTemplate, send]);

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
          <button type="button" className="topbar__search" onClick={() => setSearching(true)} aria-label="Search the compendium" title="Search the compendium (Ctrl/⌘ K)">
            <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <circle cx="8.5" cy="8.5" r="5.5" />
              <path d="m13 13 4.5 4.5" />
            </svg>
          </button>
          <AudioControl
            audio={state.audio}
            prefs={audioPrefs}
            setPrefs={setAudioPrefs}
            unlock={ambient.unlock}
            label={isGm ? 'Also play table audio on this device' : 'Play table audio on this device'}
          />
          <span className={`status status--${state.status}`}>{STATUS_TEXT[state.status]}</span>
          <span className="muted topbar__user">{user.displayName}</span>
        </div>
      </header>

      <div className="campaign__grid">
        <aside className="campaign__side" data-tab="party">
          {editingScene && !phone && state.scene ? (
            <SceneEditCard variant="panel" scene={state.scene} isLive={isLive} send={send} onDone={() => switchMapMode('play')} />
          ) : isGm ? (
            <>
              <SideTabs value={sideTab} onChange={setSideTab} online={online} playing={state.audio.layers.some((l) => l.playing)} />
              <div className="side-pane" hidden={sideTab !== 'scenes'}>
                <Section title="Scenes" hideTitle>
                  <ScenesPanel
                    campaignId={hello.campaign.id}
                    scenes={state.scenes}
                    activeSceneId={state.activeSceneId}
                    openSceneId={state.scene?.id ?? null}
                    send={send}
                  />
                </Section>
              </div>
              <div className="side-pane" hidden={sideTab !== 'party'}>
                <Section title={`Party · ${online} online`}>
                  <PartyList members={state.members} />
                </Section>
                {hello.campaign.inviteCode && (
                  <Section title="Invite players">
                    <InviteCode code={hello.campaign.inviteCode} />
                    <p className="hint">Players join from their home screen with this code.</p>
                  </Section>
                )}
                <Section title="Table displays">
                  <DisplaysPanel campaignId={hello.campaign.id} displays={state.displays} />
                </Section>
              </div>
              <div className="side-pane" hidden={sideTab !== 'sound'}>
                <Section title="Soundboard" hideTitle>
                  <SoundboardPanel campaignId={hello.campaign.id} tracks={state.tracks} audio={state.audio} send={send} />
                </Section>
              </div>
            </>
          ) : (
            <>
              <Section title={`Party · ${online} online`}>
                <PartyList members={state.members} />
              </Section>
            </>
          )}
        </aside>

        <div className="campaign__center">
        <div className="center-switch" role="tablist" aria-label="Main view">
          <button type="button" role="tab" aria-selected={!CENTER_VIEWS.has(tab)} className={!CENTER_VIEWS.has(tab) ? 'is-active' : ''} onClick={() => setTab('map')}>
            Map
          </button>
          <button type="button" role="tab" aria-selected={tab === 'sheet'} className={tab === 'sheet' ? 'is-active' : ''} onClick={() => setTab('sheet')}>
            {isGm ? 'Characters' : 'Character'}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'combat'} className={tab === 'combat' ? 'is-active' : ''} onClick={() => setTab('combat')}>
            Combat
            {combat && <span className="center-switch__live" aria-label="in progress" />}
          </button>
          <button type="button" role="tab" aria-selected={tab === 'handouts'} className={tab === 'handouts' ? 'is-active' : ''} onClick={() => setTab('handouts')}>
            Handouts
            {unreadHandouts > 0 && <span className="center-switch__unread" aria-label={`${unreadHandouts} unread`}>{unreadHandouts}</span>}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'compendium' || tab === 'wiki'}
            className={tab === 'compendium' || tab === 'wiki' ? 'is-active' : ''}
            onClick={() => setTab(tab === 'wiki' ? 'wiki' : 'compendium')}
          >
            Compendium
            {unreadWiki > 0 && <span className="center-switch__unread" aria-label={`${unreadWiki} new wiki pages`}>{unreadWiki}</span>}
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
              visionPreview={visionPreview}
              templateTool={templateSettings}
              selectedTemplateId={selectedTemplateId}
              onSelectTemplate={setSelectedTemplateId}
              onTemplate={send}
              tokenPopup={(token) => (
                <TokenActions
                  token={token}
                  combat={combat}
                  characters={state.characters}
                  members={state.members}
                  isGm={isGm}
                  userId={hello.you.userId}
                  send={send}
                  onClose={() => setSelectedTokenId(null)}
                  onOpenSheet={openSheet}
                />
              )}
            >
              <MapToolbar
                tools={!isGm ? PLAYER_TOOLS : editingScene ? EDIT_TOOLS : scene.fogEnabled ? GM_TOOLS : PLAYER_TOOLS}
                tool={tool}
                onTool={setTool}
                brush={brush}
                onBrush={setBrush}
                lead={
                  isGm && (
                    <div className="segmented map-mode" role="radiogroup" aria-label="Map mode">
                      <button type="button" role="radio" aria-checked={!editingScene} className={editingScene ? '' : 'is-active'} onClick={() => switchMapMode('play')}>
                        Play
                      </button>
                      <button type="button" role="radio" aria-checked={editingScene} className={editingScene ? 'is-active' : ''} onClick={() => switchMapMode('edit')} title="Walls, doors, terrain, grid, fog and lighting">
                        Edit scene
                      </button>
                    </div>
                  )
                }
              >
                {editingScene && tool === 'terrain' && <TerrainPicker value={terrain} onChange={setTerrain} />}
                {editingScene && tool === 'door' && <SecretDoorToggle secret={secretDoors} onChange={setSecretDoors} />}
                {isGm && !editingScene && scene.vision.enabled && (
                  <VisionPreviewPicker members={state.members} tokens={scene.tokens} value={visionPreview ? previewKey : null} onChange={setPreviewKey} />
                )}
                {tool === 'template' && (
                  <TemplateOptions
                    value={templateSettings}
                    onChange={setTemplateSettings}
                    isGm={isGm}
                    onClear={scene.templates.length ? () => send({ type: 'template:clear', sceneId: scene.id }) : undefined}
                  />
                )}
                {isGm && !editingScene && <AddTokenMenu scene={scene} members={state.members} characters={state.characters} at={viewCentreCell} send={send} />}
                {isGm && !editingScene && isLive && state.displays.length > 0 && (
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
              {editingScene && phone && (
                <SceneEditCard variant="sheet" scene={scene} isLive={isLive} send={send} onDone={() => switchMapMode('play')} />
              )}
              {selectedTemplate && (
                <TemplateCard
                  key={selectedTemplate.id}
                  template={selectedTemplate}
                  scene={scene}
                  isGm={isGm}
                  canEdit={canEditTemplate}
                  send={send}
                  onClose={() => setSelectedTemplateId(null)}
                />
              )}
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
          {visionPreview ? (
            <div className="map-banner map-banner--preview" role="status">
              <span>
                {visionPreview.kind === 'player' ? `Viewing as ${previewName}: only what they can see is shown` : `Seeing through ${previewName}`}
              </span>
              <button type="button" className="btn btn--sm" onClick={() => setPreviewKey(null)}>
                GM view
              </button>
            </div>
          ) : isGm && state.scene && state.scene.id !== state.activeSceneId && (
            <div className="map-banner">
              <span>Preparing: players can't see this scene</span>
              <button type="button" className="btn btn--sm btn--primary" onClick={() => send({ type: 'scene:activate', sceneId: state.scene!.id })}>
                Show to players
              </button>
            </div>
          )}
          {isGm && state.showcase && <ShowcaseStatus showcase={state.showcase} send={send} className="showcase-status--map" />}
        </main>
        <section className="campaign__sheet" data-tab="sheet">
          <MobileSwitch tab={tab} setTab={setTab} live={Boolean(combat)} unread={unreadHandouts} />
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
              selectedId={sheetId}
              onSelect={setSheetId}
            />
          )}
        </section>
        <section className="campaign__combat" data-tab="combat">
          <MobileSwitch tab={tab} setTab={setTab} live={Boolean(combat)} unread={unreadHandouts} />
          <CombatPanel combat={combat} isGm={isGm} userId={hello.you.userId} characters={state.characters} scene={scene} send={send} />
        </section>
        <section className="campaign__handouts" data-tab="handouts">
          <MobileSwitch tab={tab} setTab={setTab} live={Boolean(combat)} unread={unreadHandouts} />
          <HandoutsPanel
            campaignId={hello.campaign.id}
            handouts={state.handouts}
            members={state.members}
            isGm={isGm}
            showcase={state.showcase}
            active={tab === 'handouts'}
            send={send}
          />
        </section>
        <section className="campaign__compendium" data-tab="compendium">
          <MobileSwitch tab={tab} setTab={setTab} live={Boolean(combat)} unread={unreadHandouts} />
          <KnowledgeModes tab={tab} setTab={setTab} unreadWiki={unreadWiki} />
          <CompendiumView history={compendiumHistory} />
        </section>
        <section className="campaign__wiki" data-tab="wiki">
          <MobileSwitch tab={tab} setTab={setTab} live={Boolean(combat)} unread={unreadHandouts} />
          <KnowledgeModes tab={tab} setTab={setTab} unreadWiki={unreadWiki} />
          <WikiPanel active={tab === 'wiki'} />
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
        {(['map', 'sheet', 'dice', 'log', 'party'] as const).map((t) => {
          // The second tab holds the sheet, combat, handouts and compendium: it's named after the one
          // showing, or leads to the fight while one is running.
          const inCenter = CENTER_VIEWS.has(tab);
          const center: Tab = inCenter ? (tab === 'wiki' ? 'compendium' : tab) : combat ? 'combat' : 'sheet';
          const label = t === 'party' && isGm ? 'Manage' : t === 'sheet' ? TAB_LABELS[center] : TAB_LABELS[t];
          return (
            <button
              key={t}
              type="button"
              className={tab === t || (t === 'sheet' && inCenter) ? 'is-active' : ''}
              onClick={() => setTab(t === 'sheet' ? (inCenter ? tab : center) : t)}
            >
              {label}
              {t === 'sheet' && combat && center !== 'combat' && <span className="center-switch__live" aria-label="combat in progress" />}
              {t === 'sheet' && (unreadHandouts > 0 || unreadWiki > 0) && <span className="tabbar__dot" aria-label="unread handouts or wiki pages" />}
            </button>
          );
        })}
      </nav>

      {ambient.blocked && <AudioUnlockPrompt onUnlock={ambient.unlock} />}

      <PopupLayer onShow={showInCompendium} />
      {searching && <QuickSearch onClose={() => setSearching(false)} />}

      {playerShowcase && <ShowcaseOverlay showcase={playerShowcase} onClose={closePlayerShowcase} />}

      {handoutNotice && tab !== 'handouts' && (
        <div className="handout-notice" role="status">
          <span className="handout-notice__text">
            <span>{handoutNotice.updated ? 'Handout updated: ' : 'New handout: '}</span>
            {handoutNotice.title}
          </span>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => {
              setTab('handouts');
              dismissHandoutNotice();
            }}
          >
            Open
          </button>
          <button type="button" className="btn btn--sm btn--ghost" onClick={dismissHandoutNotice} aria-label="Dismiss">
            ✕
          </button>
        </div>
      )}

      {toast && (
        <div className="toast" role="alert">
          {toast}
        </div>
      )}
    </div>
  );
}

function SideTabs({ value, onChange, online, playing }: { value: SideTab; onChange: (t: SideTab) => void; online: number; playing: boolean }) {
  const tab = (t: SideTab, label: ReactNode) => (
    <button type="button" role="tab" aria-selected={value === t} className={value === t ? 'is-active' : ''} onClick={() => onChange(t)}>
      {label}
    </button>
  );
  return (
    <div className="segmented segmented--full side-tabs" role="tablist" aria-label="Sidebar">
      {tab('scenes', 'Scenes')}
      {tab('party', <>Party <span className="side-tabs__count">{online}</span></>)}
      {tab('sound', <>Sound{playing && <span className="side-tabs__playing" aria-label="playing" />}</>)}
    </div>
  );
}

/** Phones: the sheet, the combat tracker, handouts and the compendium share a tab, with this switch at the top. */
function MobileSwitch({ tab, setTab, live, unread }: { tab: Tab; setTab: (t: Tab) => void; live: boolean; unread: number }) {
  const unreadWiki = useWikiUnreadCount();
  return (
    <div className="segmented segmented--full mobile-switch" role="tablist" aria-label="Sheet, combat, handouts or compendium">
      <button type="button" role="tab" aria-selected={tab === 'sheet'} className={tab === 'sheet' ? 'is-active' : ''} onClick={() => setTab('sheet')}>
        Sheet
      </button>
      <button type="button" role="tab" aria-selected={tab === 'combat'} className={tab === 'combat' ? 'is-active' : ''} onClick={() => setTab('combat')}>
        Combat
        {live && <span className="center-switch__live" aria-label="in progress" />}
      </button>
      <button type="button" role="tab" aria-selected={tab === 'handouts'} className={tab === 'handouts' ? 'is-active' : ''} onClick={() => setTab('handouts')}>
        Handouts
        {unread > 0 && <span className="center-switch__unread" aria-label={`${unread} unread`}>{unread}</span>}
      </button>
      <button
        type="button"
        role="tab"
        aria-selected={tab === 'compendium' || tab === 'wiki'}
        aria-label={unreadWiki > 0 ? `Compendium, ${unreadWiki} new wiki pages` : 'Compendium'}
        title="Compendium"
        className={`mobile-switch__icon${tab === 'compendium' || tab === 'wiki' ? ' is-active' : ''}`}
        onClick={() => setTab(tab === 'wiki' ? 'wiki' : 'compendium')}
      >
        <BookIcon />
        {unreadWiki > 0 && <span className="center-switch__live" aria-hidden="true" />}
      </button>
    </div>
  );
}

/** The Compendium's two modes: searching rules and visible pages, or managing the campaign wiki. */
function KnowledgeModes({ tab, setTab, unreadWiki }: { tab: Tab; setTab: (t: Tab) => void; unreadWiki: number }) {
  return (
    <div className="segmented knowledge-modes" role="tablist" aria-label="Compendium mode">
      <button type="button" role="tab" aria-selected={tab === 'compendium'} className={tab === 'compendium' ? 'is-active' : ''} onClick={() => setTab('compendium')}>
        Search
      </button>
      <button type="button" role="tab" aria-selected={tab === 'wiki'} className={tab === 'wiki' ? 'is-active' : ''} onClick={() => setTab('wiki')}>
        Campaign wiki
        {unreadWiki > 0 && <span className="center-switch__unread" aria-label={`${unreadWiki} new`}>{unreadWiki}</span>}
      </button>
    </div>
  );
}

function BookIcon() {
  return (
    <svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" aria-hidden="true">
      <path d="M10 5.5C8.2 4 5.6 3.6 2.5 4v11.5c3.1-.4 5.7 0 7.5 1.5 1.8-1.5 4.4-1.9 7.5-1.5V4c-3.1-.4-5.7 0-7.5 1.5Z" />
      <path d="M10 5.5V17" />
    </svg>
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
        {last.label && (
          <span className="entry__label">
            <RichText text={last.label} inline />
          </span>
        )}
        <span className="entry__expr">{last.roll.expression}</span>
      </div>
      <RollView roll={last.roll} />
    </div>
  );
}
