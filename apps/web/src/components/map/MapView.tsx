import type { CameraRect, MapMessage, MapTemplate, SceneView, TemplateMessage, Token } from '@dnd/protocol';
import {
  FogMask,
  MapData,
  brushCells,
  edgeCode,
  gridGeometry,
  measureMove,
  moveBlock,
  normalizeAngle,
  pointToCell,
  snapAngle,
  snapOrigin,
  terrainCode,
  type DoorState,
  type Edge,
  type EdgeFeature,
  type TerrainId,
} from '@dnd/rules';
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useElementSize } from '../../lib/useElementSize';
import type { Ping } from '../../lib/useGameSocket';
import { TokenDecor, type TokenDecoration } from '../combat/TokenDecor';
import { fitRect, screenToMap, visibleRect, zoomAt, type Camera } from './camera';
import { fogPath } from './fogPath';
import { TerrainLayer, TerrainPatterns, WallLayer } from './MapFeatures';
import { TemplateLayer, type TemplateSettings } from './TemplateLayer';
import { VisionLayer, type VisionPreview } from './VisionLayer';
import { edgeKey, edgesBetween, nearestEdge, nearestVertex, parseEdgeKey, type Vertex } from './wallPath';

export type MapTool = 'move' | 'reveal' | 'hide' | 'ruler' | 'ping' | 'wall' | 'door' | 'terrain' | 'erase' | 'template';

export interface MapViewProps {
  scene: SceneView;
  /** GMs see through fog (dimmed) and see hidden tokens. */
  isGm: boolean;
  /** Table screens are driven by the GM's camera instead of by input. */
  interactive?: boolean;
  /** External framing (table screens). Null/undefined fits the whole map. */
  camera?: CameraRect | null;
  /** Called with the visible map area whenever the view moves. */
  onViewChange?: (rect: CameraRect) => void;
  userId?: string;
  selectedTokenId?: string | null;
  onSelectToken?: (id: string | null) => void;
  onMoveToken?: (id: string, col: number, row: number) => void;
  tool?: MapTool;
  /** Fog brush diameter in cells. */
  brush?: number;
  onPaintFog?: (cells: number[], reveal: boolean) => void;
  pings?: Ping[];
  onPing?: (x: number, y: number) => void;
  /** Terrain painted by the terrain tool. */
  terrain?: TerrainId;
  /** New doors placed with the door tool are secret. */
  secretDoors?: boolean;
  /** Map editor messages (walls, doors, terrain) and door toggles; sceneId is filled in. */
  onMapEdit?: (msg: MapMessage) => void;
  /** Combat markers per token id (active turn, HP bar, Bloodied). */
  decorations?: Record<string, TokenDecoration>;
  /** What the template tool places. */
  templateTool?: TemplateSettings;
  selectedTemplateId?: string | null;
  onSelectTemplate?: (id: string | null) => void;
  /** Places, moves and turns area templates. */
  onTemplate?: (msg: TemplateMessage) => void;
  /** Overlay controls drawn above the map (toolbars). */
  children?: ReactNode;
  /** GM only: preview what one player's tokens see. */
  visionPreview?: VisionPreview | null;
}

/** Pointer travel (px) before a press on a token becomes a drag rather than a click. */
const DRAG_THRESHOLD = 4;
/** How long to show a moved token at its new spot before trusting the server's copy again. */
const PENDING_MOVE_MS = 1500;
/** Fog, terrain and wall strokes are sent in batches while painting so others see them appear. */
const FOG_FLUSH_MS = 150;
/** How close (in cells) the pointer must come to a grid corner for a wall stroke to reach it. */
const VERTEX_SNAP = 0.35;
const WALL = edgeCode({ kind: 'wall' });
const NEXT_DOOR_STATE: Record<DoorState, DoorState> = { open: 'closed', closed: 'locked', locked: 'open' };
/** Id of the template being placed, until the server gives it a real one. */
const DRAFT_TEMPLATE = 'draft';

type Gesture =
  /**
   * `door` is set when the press started on a door: a click (no drag) opens or closes it.
   * `template` likewise selects the area template under the press.
   */
  | { kind: 'pan'; pointerId: number; sx: number; sy: number; cam: Camera; moved: boolean; door?: Edge; template?: string }
  | {
      kind: 'token';
      pointerId: number;
      tokenId: string;
      movable: boolean;
      /** Grab point relative to the token's top-left, in map pixels. */
      dx: number;
      dy: number;
      sx: number;
      sy: number;
      moved: boolean;
    }
  | { kind: 'paint'; layer: 'fog' | 'terrain'; pointerId: number; last: { col: number; row: number }; unsent: Set<number>; sentAt: number }
  | {
      kind: 'edges';
      pointerId: number;
      erase: boolean;
      /** Where the press started, for a click that places a single edge. */
      start: { x: number; y: number };
      vertex: Vertex;
      drew: boolean;
      unsent: Map<string, Edge>;
      sentAt: number;
    }
  | { kind: 'ruler'; pointerId: number }
  | {
      /** Placing a new area template (aiming it), or moving or turning the selected one. */
      kind: 'template';
      pointerId: number;
      mode: 'place' | 'move' | 'rotate';
      /** Grab point relative to the origin, in grid units (moves). */
      dx: number;
      dy: number;
      sx: number;
      sy: number;
      moved: boolean;
    }
  | { kind: 'pinch'; dist: number; cx: number; cy: number; cam: Camera };

type CellPos = { col: number; row: number };

/** Text drawn at a constant on-screen size regardless of zoom. */
function MapLabel({ x, y, k, text, className = '' }: { x: number; y: number; k: number; text: string; className?: string }) {
  const w = text.length * 8 + 16;
  return (
    <g transform={`translate(${x} ${y}) scale(${1 / k})`} className={`map-label ${className}`} pointerEvents="none">
      <rect x={-w / 2} y={-30} width={w} height={22} rx={11} />
      <text x={0} y={-19}>
        {text}
      </text>
    </g>
  );
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/);
  return (words.length > 1 ? words[0]![0]! + words[1]![0]! : name.slice(0, 2)).toUpperCase();
}

interface TokenShapeProps {
  token: Token;
  cell: number;
  x: number;
  y: number;
  selected?: boolean;
  mine?: boolean;
  movable?: boolean;
  dragging?: boolean;
  decoration?: TokenDecoration;
}

function TokenShape({ token, cell, x, y, selected, mine, movable, dragging, decoration }: TokenShapeProps) {
  const d = token.size * cell;
  const r = d / 2 - Math.max(2, cell * 0.06);
  const classes = ['token'];
  if (token.hidden) classes.push('token--hidden');
  if (selected) classes.push('token--selected');
  if (mine) classes.push('token--mine');
  if (movable) classes.push('token--movable');
  if (dragging) classes.push('token--dragging');
  return (
    <g className={classes.join(' ')} transform={`translate(${x} ${y})`} data-token-id={token.id}>
      {(selected || mine) && <circle cx={d / 2} cy={d / 2} r={r + Math.max(3, cell * 0.07)} className="token__ring" />}
      <circle cx={d / 2} cy={d / 2} r={r} fill={token.color} className="token__disc" />
      <text x={d / 2} y={d / 2} className="token__initials" fontSize={r * 0.8}>
        {initials(token.name)}
      </text>
      <text x={d / 2} y={d + cell * 0.08} className="token__name" fontSize={Math.max(10, cell * 0.22)}>
        {token.name}
      </text>
      {decoration && <TokenDecor decoration={decoration} d={d} cell={cell} />}
    </g>
  );
}

export function MapView({
  scene,
  isGm,
  interactive = true,
  camera,
  onViewChange,
  userId,
  selectedTokenId,
  onSelectToken,
  onMoveToken,
  tool = 'move',
  brush = 1,
  onPaintFog,
  pings = [],
  onPing,
  terrain = 'floor',
  secretDoors = false,
  onMapEdit,
  decorations,
  templateTool,
  selectedTemplateId,
  onSelectTemplate,
  onTemplate,
  children,
  visionPreview,
}: MapViewProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const size = useElementSize(wrapRef);
  const [cam, setCam] = useState<Camera | null>(null);
  const camRef = useRef<Camera | null>(null);
  camRef.current = cam;
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const gesture = useRef<Gesture | null>(null);
  const fittedScene = useRef<string | null>(null);
  /** Token being dragged, at its unsnapped top-left in map pixels. */
  const [drag, setDrag] = useState<{ tokenId: string; x: number; y: number } | null>(null);
  /** Moves sent but not yet confirmed, so the token doesn't snap back while the server replies. */
  const [pending, setPending] = useState<Record<string, { col: number; row: number }>>({});

  useEffect(() => setPending({}), [scene.tokens]);
  const [ruler, setRuler] = useState<{ from: CellPos; to: CellPos } | null>(null);
  /** Cells painted in the current stroke, shown before the server echoes them back. */
  const [stroke, setStroke] = useState<{ reveal: boolean; cells: Set<number> } | null>(null);
  useEffect(() => {
    if (gesture.current?.kind !== 'paint') setStroke(null);
  }, [scene.fog]);
  /** Map edits not yet echoed by the server: edge overrides by key, and the terrain stroke. */
  const [edgeEdits, setEdgeEdits] = useState<Map<string, { edge: Edge; code: number }> | null>(null);
  const [terrainStroke, setTerrainStroke] = useState<{ code: number; cells: Set<number> } | null>(null);
  useEffect(() => {
    if (gesture.current?.kind !== 'edges') setEdgeEdits(null);
    if (gesture.current?.kind !== 'paint') setTerrainStroke(null);
  }, [scene.map]);
  /** Template being placed, moved or turned; shown instead of the server's copy until it answers. */
  const [templateDraft, setTemplateDraft] = useState<MapTemplate | null>(null);
  /** The direction of the last template placed, for templates placed with a click. */
  const lastAngle = useRef(0);
  useEffect(() => {
    if (gesture.current?.kind !== 'template') setTemplateDraft(null);
  }, [scene.templates]);
  useEffect(() => {
    if (!templateDraft || gesture.current?.kind === 'template') return;
    const t = setTimeout(() => setTemplateDraft(null), PENDING_MOVE_MS);
    return () => clearTimeout(t);
  }, [templateDraft]);
  useEffect(() => {
    if (Object.keys(pending).length === 0) return;
    const t = setTimeout(() => setPending({}), PENDING_MOVE_MS);
    return () => clearTimeout(t);
  }, [pending]);

  const { grid } = scene;
  const geo = useMemo(() => gridGeometry(grid, scene.width, scene.height), [grid, scene.width, scene.height]);
  const serverFog = useMemo(
    () => (scene.fogEnabled ? (scene.fog ? FogMask.decode(scene.fog, geo.cols, geo.rows) : new FogMask(geo.cols, geo.rows)) : null),
    [scene.fogEnabled, scene.fog, geo.cols, geo.rows],
  );
  const fog = useMemo(() => {
    if (!serverFog || !stroke) return serverFog;
    const copy = new FogMask(serverFog.cols, serverFog.rows, serverFog.bits.slice());
    for (const i of stroke.cells) copy.setIndex(i, stroke.reveal);
    return copy;
  }, [serverFog, stroke]);
  const fogD = useMemo(() => (fog ? fogPath(fog, geo, grid.size) : ''), [fog, geo, grid.size]);
  const serverMap = useMemo(() => MapData.decode(scene.map, geo.cols, geo.rows), [scene.map, geo.cols, geo.rows]);
  const map = useMemo(() => {
    if (!edgeEdits && !terrainStroke) return serverMap;
    const copy = serverMap.clone();
    for (const { edge, code } of edgeEdits?.values() ?? []) copy.setEdge(edge, code);
    for (const i of terrainStroke?.cells ?? []) copy.terrain[i] = terrainStroke!.code;
    return copy;
  }, [serverMap, edgeEdits, terrainStroke]);

  const fullMap: CameraRect = { x: 0, y: 0, w: scene.width, h: scene.height };
  const minZoom = size ? Math.min(size.width / scene.width, size.height / scene.height) * 0.5 : 0.05;

  // Interactive views fit the map when a new scene opens; table screens follow the GM's framing.
  useEffect(() => {
    if (!size) return;
    if (!interactive) {
      setCam(camera ? fitRect(camera, size.width, size.height, 0, 'area') : fitRect(fullMap, size.width, size.height, 24));
    } else if (fittedScene.current !== scene.id || !camRef.current) {
      fittedScene.current = scene.id;
      setCam(fitRect(fullMap, size.width, size.height, 24));
    }
  }, [size, scene.id, scene.width, scene.height, interactive, camera]);

  useEffect(() => {
    if (cam && size && onViewChange) onViewChange(visibleRect(cam, size.width, size.height));
  }, [cam, size, onViewChange]);

  // Wheel / trackpad zoom. Needs a non-passive listener to stop the page from scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg || !interactive) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const c = camRef.current;
      if (!c) return;
      const rect = svg.getBoundingClientRect();
      // Trackpad pinch arrives as ctrl+wheel with small deltas.
      const factor = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
      setCam(zoomAt(c, factor, e.clientX - rect.left, e.clientY - rect.top, minZoom));
    };
    svg.addEventListener('wheel', onWheel, { passive: false });
    return () => svg.removeEventListener('wheel', onWheel);
  }, [interactive, minZoom]);

  const local = (e: { clientX: number; clientY: number }) => {
    const rect = svgRef.current!.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  };

  const startPinch = () => {
    const [a, b] = [...pointers.current.values()];
    if (!a || !b || !camRef.current) return;
    gesture.current = {
      kind: 'pinch',
      dist: Math.hypot(a.x - b.x, a.y - b.y),
      cx: (a.x + b.x) / 2,
      cy: (a.y + b.y) / 2,
      cam: camRef.current,
    };
  };

  const painting = isGm && (tool === 'reveal' || tool === 'hide') && Boolean(serverFog);
  const editing = isGm && (tool === 'wall' || tool === 'door' || tool === 'terrain' || tool === 'erase');

  /** Paints the brush along the line from the last cell to this one, so fast strokes leave no gaps. */
  const paintTo = (g: Extract<Gesture, { kind: 'paint' }>, to: { col: number; row: number }, first = false) => {
    const steps = first ? 0 : Math.max(Math.abs(to.col - g.last.col), Math.abs(to.row - g.last.row));
    const added: number[] = [];
    for (let i = 0; i <= steps; i++) {
      const t = steps === 0 ? 1 : i / steps;
      const col = Math.round(g.last.col + (to.col - g.last.col) * t);
      const row = Math.round(g.last.row + (to.row - g.last.row) * t);
      for (const idx of brushCells(geo.cols, geo.rows, col, row, brush)) {
        g.unsent.add(idx);
        added.push(idx);
      }
    }
    g.last = to;
    if (g.layer === 'terrain') {
      setTerrainStroke((prev) => ({ code: terrainCode(terrain), cells: new Set([...(prev?.cells ?? []), ...added]) }));
      return;
    }
    setStroke((prev) => {
      const cells = new Set(prev?.cells);
      for (const idx of added) cells.add(idx);
      return { reveal: tool === 'reveal', cells };
    });
  };

  const flushPaint = (g: Extract<Gesture, { kind: 'paint' }>) => {
    if (g.unsent.size === 0) return;
    if (g.layer === 'terrain') onMapEdit?.({ type: 'map:terrain', sceneId: scene.id, cells: [...g.unsent], terrain });
    else onPaintFog?.([...g.unsent], tool === 'reveal');
    g.unsent = new Set();
    g.sentAt = Date.now();
  };

  /** Adds edges to a wall/erase stroke and shows them straight away. */
  const strokeEdges = (g: Extract<Gesture, { kind: 'edges' }>, edges: Edge[]) => {
    const valid = edges.filter((e) => map.edgeIndex(e) >= 0);
    if (valid.length === 0) return;
    for (const e of valid) g.unsent.set(edgeKey(e), e);
    setEdgeEdits((prev) => {
      const next = new Map(prev);
      for (const e of valid) next.set(edgeKey(e), { edge: e, code: g.erase ? 0 : WALL });
      return next;
    });
  };

  const flushEdges = (g: Extract<Gesture, { kind: 'edges' }>) => {
    const edges = [...g.unsent.values()];
    for (let i = 0; i < edges.length; i += 2000) {
      onMapEdit?.({ type: 'map:walls', sceneId: scene.id, edges: edges.slice(i, i + 2000), wall: !g.erase });
    }
    g.unsent = new Map();
    g.sentAt = Date.now();
  };

  const showEdge = (edge: Edge, feature: EdgeFeature) =>
    setEdgeEdits((prev) => new Map(prev).set(edgeKey(edge), { edge, code: edgeCode(feature) }));

  /** Door tool: place a door, or cycle an existing one's state (Shift/Alt toggles secret instead). */
  const placeDoor = (edge: Edge, toggleSecret: boolean) => {
    if (map.edgeIndex(edge) < 0) return;
    const f = map.feature(edge);
    const next: EdgeFeature =
      f?.kind === 'door'
        ? toggleSecret
          ? { ...f, secret: !f.secret }
          : { ...f, state: NEXT_DOOR_STATE[f.state] }
        : { kind: 'door', state: 'closed', secret: secretDoors };
    if (next.kind !== 'door') return;
    showEdge(edge, next);
    onMapEdit?.({ type: 'map:door', sceneId: scene.id, edge, state: next.state, secret: next.secret });
  };

  /** Move tool click on a door: open or close it. Only the GM's clicks are shown before the server agrees. */
  const toggleDoor = (edge: Edge) => {
    const f = map.feature(edge);
    if (f?.kind !== 'door') return;
    if (isGm) showEdge(edge, { ...f, state: f.state === 'open' ? 'closed' : 'open' });
    onMapEdit?.({ type: 'door:toggle', sceneId: scene.id, edge });
  };

  const canMove = (t: Token) => isGm || (userId !== undefined && t.ownerUserId === userId);
  const canEditTemplate = (t: MapTemplate) => isGm || (userId !== undefined && t.ownerUserId === userId);
  /** Map pixels to grid units (see Area in @dnd/rules). */
  const toGrid = (m: { x: number; y: number }) => ({ x: (m.x - geo.originX) / grid.size, y: (m.y - geo.originY) / grid.size });

  const cellOf = (x: number, y: number) => ({
    col: Math.round((x - geo.originX) / grid.size),
    row: Math.round((y - geo.originY) / grid.size),
  });

  const onPointerDown = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!interactive || !camRef.current) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    e.currentTarget.setPointerCapture(e.pointerId);
    if (pointers.current.size === 2) {
      const g = gesture.current;
      if (g?.kind === 'paint') flushPaint(g);
      if (g?.kind === 'edges') flushEdges(g);
      if (g?.kind === 'template') setTemplateDraft(null);
      setDrag(null);
      return startPinch();
    }
    if (pointers.current.size > 2) return;

    if ((painting || (editing && tool === 'terrain')) && e.button === 0) {
      const m = screenToMap(camRef.current, p.x, p.y);
      const cell = pointToCell(geo, grid.size, m.x, m.y);
      const layer = tool === 'terrain' ? 'terrain' : 'fog';
      const g: Gesture = { kind: 'paint', layer, pointerId: e.pointerId, last: cell, unsent: new Set(), sentAt: Date.now() };
      gesture.current = g;
      if (layer === 'fog') setStroke(null);
      else setTerrainStroke(null);
      paintTo(g, cell, true);
      return;
    }

    if (editing && (tool === 'wall' || tool === 'erase' || tool === 'door') && e.button === 0) {
      const m = screenToMap(camRef.current, p.x, p.y);
      if (tool === 'door') {
        placeDoor(nearestEdge(geo, grid.size, m.x, m.y), e.shiftKey || e.altKey);
        gesture.current = null;
        return;
      }
      const vertex = nearestVertex(geo, grid.size, m.x, m.y);
      gesture.current = {
        kind: 'edges',
        pointerId: e.pointerId,
        erase: tool === 'erase',
        start: m,
        vertex,
        drew: false,
        unsent: new Map(),
        sentAt: Date.now(),
      };
      return;
    }

    // Area templates: the selected one's handles (or body) move and turn it; the template tool places new ones.
    const selectedTemplate = scene.templates.find((t) => t.id === selectedTemplateId);
    if (e.button === 0 && onTemplate && selectedTemplate && canEditTemplate(selectedTemplate)) {
      const target = e.target as Element;
      const handle = target.closest('[data-template-handle]')?.getAttribute('data-template-handle');
      const onBody = target.closest('[data-template-id]')?.getAttribute('data-template-id') === selectedTemplate.id;
      if (handle || (onBody && tool === 'move' && !selectedTemplate.tokenId)) {
        const at = toGrid(screenToMap(camRef.current, p.x, p.y));
        gesture.current = {
          kind: 'template',
          pointerId: e.pointerId,
          mode: handle === 'rotate' ? 'rotate' : 'move',
          dx: at.x - selectedTemplate.x,
          dy: at.y - selectedTemplate.y,
          sx: p.x,
          sy: p.y,
          moved: false,
        };
        setTemplateDraft(selectedTemplate);
        return;
      }
    }
    if (tool === 'template' && templateTool && onTemplate && e.button === 0) {
      const s = templateTool;
      const at = toGrid(screenToMap(camRef.current, p.x, p.y));
      const tokenId = (e.target as Element).closest('[data-token-id]')?.getAttribute('data-token-id');
      // An Emanation pressed on one of your creatures follows it around.
      const host = s.shape === 'emanation' ? scene.tokens.find((t) => t.id === tokenId && canMove(t)) : undefined;
      setTemplateDraft({
        id: DRAFT_TEMPLATE,
        sceneId: scene.id,
        shape: s.shape,
        size: s.size,
        ...(s.shape === 'line' && { width: s.width }),
        ...(s.shape === 'cylinder' && { height: s.height }),
        ...(host ? { x: host.col, y: host.row, span: host.size } : snapOrigin(s.shape, at.x, at.y)),
        angle: lastAngle.current,
        color: s.color,
        label: s.label,
        ownerUserId: userId ?? null,
        tokenId: host?.id ?? null,
        hidden: isGm && s.hidden,
        linger: s.linger,
      });
      gesture.current = { kind: 'template', pointerId: e.pointerId, mode: 'place', dx: 0, dy: 0, sx: p.x, sy: p.y, moved: false };
      return;
    }

    if ((tool === 'ruler' || tool === 'ping') && e.button === 0) {
      const m = screenToMap(camRef.current, p.x, p.y);
      if (tool === 'ping') {
        onPing?.(m.x, m.y);
        gesture.current = null;
        return;
      }
      const cell = pointToCell(geo, grid.size, m.x, m.y);
      setRuler({ from: cell, to: cell });
      gesture.current = { kind: 'ruler', pointerId: e.pointerId };
      return;
    }

    const doorKey = tool === 'move' ? (e.target as Element).closest('[data-door]')?.getAttribute('data-door') : null;
    const door = doorKey ? parseEdgeKey(doorKey) ?? undefined : undefined;
    const tokenId = (e.target as Element).closest('[data-token-id]')?.getAttribute('data-token-id');
    const token = tokenId ? scene.tokens.find((t) => t.id === tokenId) : undefined;
    if (token && e.button === 0) {
      const m = screenToMap(camRef.current, p.x, p.y);
      const pos = pending[token.id] ?? token;
      gesture.current = {
        kind: 'token',
        pointerId: e.pointerId,
        tokenId: token.id,
        movable: canMove(token),
        dx: m.x - (geo.originX + pos.col * grid.size),
        dy: m.y - (geo.originY + pos.row * grid.size),
        sx: p.x,
        sy: p.y,
        moved: false,
      };
      return;
    }
    const templateId = tool === 'move' ? (e.target as Element).closest('[data-template-id]')?.getAttribute('data-template-id') : null;
    gesture.current = {
      kind: 'pan',
      pointerId: e.pointerId,
      sx: p.x,
      sy: p.y,
      cam: camRef.current,
      moved: false,
      door,
      template: templateId ?? undefined,
    };
  };

  const onPointerMove = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (!pointers.current.has(e.pointerId)) return;
    const p = local(e);
    pointers.current.set(e.pointerId, p);
    const g = gesture.current;
    if (!g) return;
    if (g.kind === 'pan' && g.pointerId === e.pointerId) {
      if (Math.hypot(p.x - g.sx, p.y - g.sy) > DRAG_THRESHOLD) g.moved = true;
      setCam({ ...g.cam, x: g.cam.x + p.x - g.sx, y: g.cam.y + p.y - g.sy });
    } else if (g.kind === 'ruler' && g.pointerId === e.pointerId) {
      const m = screenToMap(camRef.current!, p.x, p.y);
      const to = pointToCell(geo, grid.size, m.x, m.y);
      setRuler((r) => (r && (r.to.col !== to.col || r.to.row !== to.row) ? { ...r, to } : r));
    } else if (g.kind === 'paint' && g.pointerId === e.pointerId) {
      const m = screenToMap(camRef.current!, p.x, p.y);
      const cell = pointToCell(geo, grid.size, m.x, m.y);
      if (cell.col !== g.last.col || cell.row !== g.last.row) paintTo(g, cell);
      if (Date.now() - g.sentAt > FOG_FLUSH_MS) flushPaint(g);
    } else if (g.kind === 'edges' && g.pointerId === e.pointerId) {
      const m = screenToMap(camRef.current!, p.x, p.y);
      const v = nearestVertex(geo, grid.size, m.x, m.y);
      if (v.dist <= VERTEX_SNAP && (v.x !== g.vertex.x || v.y !== g.vertex.y)) {
        strokeEdges(g, edgesBetween(g.vertex, v));
        g.vertex = v;
        g.drew = true;
      }
      if (Date.now() - g.sentAt > FOG_FLUSH_MS) flushEdges(g);
    } else if (g.kind === 'token' && g.pointerId === e.pointerId) {
      if (!g.movable) return;
      if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) <= DRAG_THRESHOLD) return;
      g.moved = true;
      const m = screenToMap(camRef.current!, p.x, p.y);
      setDrag({ tokenId: g.tokenId, x: m.x - g.dx, y: m.y - g.dy });
    } else if (g.kind === 'template' && g.pointerId === e.pointerId) {
      if (!g.moved && Math.hypot(p.x - g.sx, p.y - g.sy) <= DRAG_THRESHOLD) return;
      g.moved = true;
      const at = toGrid(screenToMap(camRef.current!, p.x, p.y));
      const snap = templateTool?.snap ?? true;
      setTemplateDraft((d) => {
        if (!d) return d;
        if (g.mode === 'move') return { ...d, ...snapOrigin(d.shape, at.x - g.dx, at.y - g.dy) };
        if (Math.hypot(at.x - d.x, at.y - d.y) < 0.25) return d;
        const angle = (Math.atan2(at.y - d.y, at.x - d.x) * 180) / Math.PI;
        return { ...d, angle: snap ? snapAngle(angle) : normalizeAngle(Math.round(angle)) };
      });
    } else if (g.kind === 'pinch' && pointers.current.size >= 2) {
      const [a, b] = [...pointers.current.values()];
      const dist = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      const cx = (a!.x + b!.x) / 2;
      const cy = (a!.y + b!.y) / 2;
      const zoomed = zoomAt(g.cam, dist / g.dist, g.cx, g.cy, minZoom);
      setCam({ ...zoomed, x: zoomed.x + cx - g.cx, y: zoomed.y + cy - g.cy });
    }
  };

  const onPointerUp = (e: ReactPointerEvent<SVGSVGElement>) => {
    pointers.current.delete(e.pointerId);
    const g = gesture.current;
    if (g?.kind === 'pinch') {
      // Lifting one finger of a pinch continues as a pan with the other.
      const [id, p] = [...pointers.current.entries()][0] ?? [];
      gesture.current = id !== undefined && p && camRef.current
        ? { kind: 'pan', pointerId: id, sx: p.x, sy: p.y, cam: camRef.current, moved: true }
        : null;
      return;
    }
    if (g?.kind === 'paint' && g.pointerId === e.pointerId) {
      flushPaint(g);
    } else if (g?.kind === 'edges' && g.pointerId === e.pointerId) {
      // A click without reaching another corner places (or erases) the single nearest edge.
      if (!g.drew) strokeEdges(g, [nearestEdge(geo, grid.size, g.start.x, g.start.y)]);
      flushEdges(g);
    } else if (g?.kind === 'token' && g.pointerId === e.pointerId) {
      if (g.moved && drag) {
        const { col, row } = cellOf(drag.x, drag.y);
        const token = scene.tokens.find((t) => t.id === g.tokenId);
        // Players can't pass walls they can see; the server would refuse anyway (and checks the rest).
        const blocked = !isGm && token && moveBlock(map, token, { col, row }, token.size);
        if (token && !blocked && (col !== token.col || row !== token.row)) {
          setPending((prev) => ({ ...prev, [g.tokenId]: { col, row } }));
          onMoveToken?.(g.tokenId, col, row);
        }
      } else if (!g.moved) {
        onSelectToken?.(isGm || g.movable ? g.tokenId : null);
        onSelectTemplate?.(null);
      }
      setDrag(null);
    } else if (g?.kind === 'template' && g.pointerId === e.pointerId) {
      const d = templateDraft;
      if (d && g.mode === 'place') {
        lastAngle.current = d.angle;
        const { id: _, ownerUserId: __, span: ___, tokenId, ...fields } = d;
        onTemplate?.({ type: 'template:place', ...fields, ...(tokenId && { tokenId }) });
      } else if (d && g.moved) {
        onTemplate?.({ type: 'template:update', templateId: d.id, ...(g.mode === 'move' ? { x: d.x, y: d.y } : { angle: d.angle }) });
      }
      // Keep showing it where it was dropped until the server's copy arrives.
      if (d && (g.mode === 'place' || g.moved)) setTemplateDraft({ ...d });
      else setTemplateDraft(null);
    } else if (g?.kind === 'pan' && !g.moved && g.pointerId === e.pointerId) {
      if (g.door) toggleDoor(g.door);
      else {
        onSelectToken?.(null);
        onSelectTemplate?.(g.template ?? null);
      }
    }
    if (pointers.current.size === 0) gesture.current = null;
  };

  const zoomBy = (factor: number) => {
    if (!cam || !size) return;
    setCam(zoomAt(cam, factor, size.width / 2, size.height / 2, minZoom));
  };

  const k = cam?.k ?? 1;
  const cellCentre = (c: CellPos) => ({
    x: geo.originX + (c.col + 0.5) * grid.size,
    y: geo.originY + (c.row + 0.5) * grid.size,
  });
  const dragToken = drag ? scene.tokens.find((t) => t.id === drag.tokenId) : undefined;
  const dragCell = drag ? cellOf(drag.x, drag.y) : undefined;
  const dragMove = dragToken && dragCell ? measureMove(map, dragToken, dragCell, grid.feetPerCell, dragToken.size) : undefined;
  const rulerMove = ruler ? measureMove(map, ruler.from, ruler.to, grid.feetPerCell) : undefined;
  /** "30 ft", plus the movement cost when difficult terrain makes it dearer, and whether a wall is in the way. */
  const moveText = (m: ReturnType<typeof measureMove>) =>
    `${m.feet} ft${m.cost !== m.feet ? ` (${m.cost} ft move)` : ''}${m.block ? ` · ${m.block === 'wall' ? 'blocked' : 'impassable'}` : ''}`;
  const transform = cam ? `translate(${cam.x}px, ${cam.y}px) scale(${cam.k})` : undefined;
  /** Templates as shown: the one being edited replaced by its draft, Emanations following dragged tokens. */
  const shownTemplates = scene.templates.map((t) => {
    if (t.id === templateDraft?.id) return templateDraft;
    const pos = drag && t.tokenId === drag.tokenId ? cellOf(drag.x, drag.y) : t.tokenId ? pending[t.tokenId] : undefined;
    return pos ? { ...t, x: pos.col, y: pos.row } : t;
  });
  if (templateDraft?.id === DRAFT_TEMPLATE) shownTemplates.push(templateDraft);
  const terrainId = `terrain-${scene.id}`;

  return (
    <div className={`map${interactive ? '' : ' map--display'}${scene.imageUrl ? '' : ' map--blank'}`} ref={wrapRef}>
      <svg
        ref={svgRef}
        className={`map__svg${painting || editing || (interactive && tool === 'template') ? ' map__svg--paint' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onContextMenu={(e) => e.preventDefault()}
        onDoubleClick={(e) => {
          if (!interactive || !camRef.current || tool !== 'move') return;
          if ((e.target as Element).closest('[data-token-id]')) return;
          const p = local(e);
          const m = screenToMap(camRef.current, p.x, p.y);
          onPing?.(m.x, m.y);
        }}
      >
        <defs>
          <clipPath id={`clip-${scene.id}`}>
            <rect width={scene.width} height={scene.height} />
          </clipPath>
          <pattern
            id={`grid-${scene.id}`}
            x={geo.originX}
            y={geo.originY}
            width={grid.size}
            height={grid.size}
            patternUnits="userSpaceOnUse"
          >
            <path d={`M${grid.size} 0H0V${grid.size}`} className="map__grid-line" strokeWidth={Math.max(1 / k, grid.size / 60)} />
          </pattern>
          <TerrainPatterns id={terrainId} size={grid.size} />
        </defs>
        {cam && (
          <g className="map__world" style={{ transform, transformOrigin: '0 0' }}>
            {scene.imageUrl ? (
              <image href={scene.imageUrl} width={scene.width} height={scene.height} preserveAspectRatio="none" />
            ) : (
              <rect width={scene.width} height={scene.height} className="map__blank" />
            )}
            <TerrainLayer map={map} geo={geo} size={grid.size} id={terrainId} />
            {grid.visible && <rect width={scene.width} height={scene.height} fill={`url(#grid-${scene.id})`} pointerEvents="none" />}
            <WallLayer map={map} geo={geo} size={grid.size} />
            {fog && (
              <path d={fogD} className={`map__fog${isGm ? ' map__fog--gm' : ''}`} clipPath={`url(#clip-${scene.id})`} pointerEvents="none" />
            )}
            <VisionLayer scene={scene} map={map} geo={geo} size={grid.size} isGm={isGm} k={k} clipPath={`url(#clip-${scene.id})`} preview={visionPreview} />
            <TemplateLayer
              templates={shownTemplates}
              tokens={scene.tokens}
              geo={geo}
              cell={grid.size}
              feetPerCell={grid.feetPerCell}
              k={k}
              selectedId={interactive ? selectedTemplateId : null}
              canEdit={(t) => interactive && Boolean(onTemplate) && canEditTemplate(t)}
              draftId={templateDraft?.id}
            />
            {drag && (
              <rect
                className={`map__drop${dragMove?.block ? ' map__drop--blocked' : ''}`}
                x={geo.originX + cellOf(drag.x, drag.y).col * grid.size}
                y={geo.originY + cellOf(drag.x, drag.y).row * grid.size}
                width={(scene.tokens.find((t) => t.id === drag.tokenId)?.size ?? 1) * grid.size}
                height={(scene.tokens.find((t) => t.id === drag.tokenId)?.size ?? 1) * grid.size}
                strokeWidth={2 / k}
              />
            )}
            {scene.tokens.map((t) => {
              const dragging = drag?.tokenId === t.id;
              const pos = pending[t.id] ?? t;
              return (
                <TokenShape
                  key={t.id}
                  token={t}
                  cell={grid.size}
                  x={dragging ? drag.x : geo.originX + pos.col * grid.size}
                  y={dragging ? drag.y : geo.originY + pos.row * grid.size}
                  selected={t.id === selectedTokenId}
                  mine={!isGm && userId !== undefined && t.ownerUserId === userId}
                  movable={interactive && canMove(t)}
                  dragging={dragging}
                  decoration={decorations?.[t.id]}
                />
              );
            })}
            <rect width={scene.width} height={scene.height} className="map__frame" strokeWidth={2 / k} />
            <TemplateLayer
              overlay
              templates={shownTemplates}
              tokens={scene.tokens}
              geo={geo}
              cell={grid.size}
              feetPerCell={grid.feetPerCell}
              k={k}
              selectedId={interactive ? selectedTemplateId : null}
              canEdit={(t) => interactive && Boolean(onTemplate) && canEditTemplate(t)}
              draftId={templateDraft?.id}
            />
            {dragToken && dragCell && dragMove && (dragCell.col !== dragToken.col || dragCell.row !== dragToken.row) && (
              <MapLabel
                x={geo.originX + (dragCell.col + dragToken.size / 2) * grid.size}
                y={geo.originY + dragCell.row * grid.size}
                k={k}
                text={moveText(dragMove)}
                className={dragMove.block ? 'map-label--blocked' : ''}
              />
            )}
            {ruler && rulerMove && (
              <g className={`ruler${rulerMove.block ? ' ruler--blocked' : ''}`} pointerEvents="none">
                <line
                  x1={cellCentre(ruler.from).x}
                  y1={cellCentre(ruler.from).y}
                  x2={cellCentre(ruler.to).x}
                  y2={cellCentre(ruler.to).y}
                  strokeWidth={3 / k}
                />
                <circle cx={cellCentre(ruler.from).x} cy={cellCentre(ruler.from).y} r={5 / k} />
                <circle cx={cellCentre(ruler.to).x} cy={cellCentre(ruler.to).y} r={5 / k} />
                <MapLabel
                  x={cellCentre(ruler.to).x}
                  y={cellCentre(ruler.to).y - 6 / k}
                  k={k}
                  text={moveText(rulerMove)}
                  className={rulerMove.block ? 'map-label--blocked' : ''}
                />
              </g>
            )}
            {pings
              .filter((p) => p.sceneId === scene.id)
              .map((p) => (
                <g key={p.id} transform={`translate(${p.x} ${p.y}) scale(${1 / k})`} className={`ping ping--${p.role}`} pointerEvents="none">
                  <circle r={10} className="ping__dot" />
                  <circle r={10} className="ping__wave" />
                  <circle r={10} className="ping__wave ping__wave--late" />
                  <text y={-22}>{p.name}</text>
                </g>
              ))}
          </g>
        )}
      </svg>
      {children}
      {interactive && (
        <div className="map__zoom">
          <button type="button" onClick={() => zoomBy(1.25)} aria-label="Zoom in">
            +
          </button>
          <button type="button" onClick={() => zoomBy(0.8)} aria-label="Zoom out">
            −
          </button>
          <button
            type="button"
            onClick={() => size && setCam(fitRect(fullMap, size.width, size.height, 24))}
            aria-label="Fit map"
            title="Fit map"
          >
            ⤢
          </button>
        </div>
      )}
    </div>
  );
}

