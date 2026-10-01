import type { MapTemplate, Token } from '@dnd/protocol';
import { AREA_SHAPE_LABELS, areaCells, areaPolygon, tokensInArea, type AreaShape, type GridGeometry } from '@dnd/rules';
import { useMemo } from 'react';
import './templates.css';

/** What the template tool places next. */
export interface TemplateSettings {
  shape: AreaShape;
  /** Feet (see Area in @dnd/rules). */
  size: number;
  /** Line width in feet. */
  width: number;
  /** Cylinder height in feet. */
  height: number;
  label: string;
  color: string;
  linger: boolean;
  /** GM only. */
  hidden: boolean;
  /** Turn in 45° steps. */
  snap: boolean;
}

export const TEMPLATE_COLORS = ['#e8743b', '#3d8bfd', '#3fb950', '#a371f7', '#f1c40f', '#e5534b'];

export const DEFAULT_TEMPLATE_SETTINGS: TemplateSettings = {
  shape: 'sphere',
  size: 20,
  width: 5,
  height: 20,
  label: '',
  color: TEMPLATE_COLORS[0]!,
  linger: false,
  hidden: false,
  snap: true,
};

/** Shapes that point somewhere and get a rotate handle. */
export function isDirectional(shape: AreaShape): boolean {
  return shape === 'cone' || shape === 'line' || shape === 'cube';
}

/** Tokens caught in a template on a scene grid (an Emanation never catches its own creature). */
export function caughtBy(t: MapTemplate, tokens: Token[], feetPerCell: number, geo: GridGeometry): Token[] {
  return tokensInArea(areaCells(t, feetPerCell, geo.cols, geo.rows), tokens, t.tokenId);
}

export function templateTitle(t: Pick<MapTemplate, 'label' | 'shape' | 'size'>): string {
  return `${t.label || AREA_SHAPE_LABELS[t.shape]} · ${t.size} ft`;
}

/** Where the rotate handle sits, in grid units: the far end of a Cone or Line, the far corner of a Cube. */
export function rotateHandle(t: MapTemplate, feetPerCell: number): { x: number; y: number } {
  const reach = (t.size / feetPerCell) * (t.shape === 'cube' ? Math.SQRT2 : 1);
  const r = (t.angle * Math.PI) / 180;
  return { x: t.x + Math.cos(r) * reach, y: t.y + Math.sin(r) * reach };
}

interface LayerProps {
  templates: MapTemplate[];
  tokens: Token[];
  geo: GridGeometry;
  /** Cell size in map pixels. */
  cell: number;
  feetPerCell: number;
  /** Camera zoom, for constant on-screen strokes and labels. */
  k: number;
  selectedId?: string | null;
  /** Whether this viewer may move, turn and remove the template. */
  canEdit: (t: MapTemplate) => boolean;
  /** Id of a template being placed or edited: drawn with its caught creatures listed. */
  draftId?: string;
  /** Draw the labels and handles (above the tokens) instead of the areas (under them). */
  overlay?: boolean;
}

/** Area templates: the areas go under the tokens, an overlay with labels and handles above them. */
export function TemplateLayer({ templates, tokens, geo, cell, feetPerCell, k, selectedId, canEdit, draftId, overlay = false }: LayerProps) {
  return (
    <g className={overlay ? 'templates templates--overlay' : 'templates'}>
      {templates.map((t) => (
        <TemplateShape
          key={t.id}
          t={t}
          tokens={tokens}
          geo={geo}
          cell={cell}
          feetPerCell={feetPerCell}
          k={k}
          selected={t.id === selectedId}
          editable={canEdit(t)}
          draft={t.id === draftId}
          overlay={overlay}
        />
      ))}
    </g>
  );
}

interface ShapeProps {
  t: MapTemplate;
  tokens: Token[];
  geo: GridGeometry;
  cell: number;
  feetPerCell: number;
  k: number;
  selected: boolean;
  editable: boolean;
  draft: boolean;
  overlay: boolean;
}

function TemplateShape({ t, tokens, geo, cell, feetPerCell, k, selected, editable, draft, overlay }: ShapeProps) {
  const px = (x: number) => geo.originX + x * cell;
  const py = (y: number) => geo.originY + y * cell;
  const { shape, size, width, x, y, angle, span } = t;
  const cells = useMemo(
    () => areaCells({ shape, size, width, x, y, angle, span }, feetPerCell, geo.cols, geo.rows),
    [shape, size, width, x, y, angle, span, feetPerCell, geo.cols, geo.rows],
  );
  const poly = useMemo(() => areaPolygon({ shape, size, width, x, y, angle, span }, feetPerCell), [shape, size, width, x, y, angle, span, feetPerCell]);
  const caught = useMemo(() => tokensInArea(cells, tokens, t.tokenId), [cells, tokens, t.tokenId]);
  const cellsD = cells.map((c) => `M${px(c.col)} ${py(c.row)}h${cell}v${cell}h${-cell}z`).join('');
  const round = shape === 'sphere' || shape === 'cylinder';
  const top = Math.min(...poly.map((p) => p.y));
  const midX = (Math.min(...poly.map((p) => p.x)) + Math.max(...poly.map((p) => p.x))) / 2;
  const handle = editable && selected && isDirectional(shape) ? rotateHandle(t, feetPerCell) : null;
  const names = caught.map((c) => c.name);
  const title = draft
    ? `${templateTitle(t)} · ${caught.length} caught${names.length ? `: ${names.slice(0, 4).join(', ')}${names.length > 4 ? '…' : ''}` : ''}`
    : templateTitle(t);

  const classes = ['template'];
  if (t.hidden) classes.push('template--hidden');
  if (selected) classes.push('template--selected');
  if (editable) classes.push('template--editable');
  if (draft) classes.push('template--draft');
  if (overlay) {
    return (
      <g className={classes.join(' ')} style={{ color: t.color }}>
        <TemplateLabel x={px(midX)} y={py(top)} k={k} text={title} />
        {editable && selected && !t.tokenId && (
          <g transform={`translate(${px(x)} ${py(y)}) scale(${1 / k})`} className="template__handle" data-template-handle="move">
            <circle r={14} />
            <path d="M0 -8v16M-8 0h16" />
          </g>
        )}
        {handle && (
          <g transform={`translate(${px(handle.x)} ${py(handle.y)}) scale(${1 / k})`} className="template__handle" data-template-handle="rotate">
            <circle r={14} />
            <path d="M-5 -6a8 8 0 1 0 10 0M5 -6l1 -5M5 -6l5 1" />
          </g>
        )}
      </g>
    );
  }
  return (
    <g className={classes.join(' ')} style={{ color: t.color }} data-template-id={editable && !draft ? t.id : undefined}>
      <path d={cellsD} className="template__cells" />
      {round ? (
        <circle cx={px(x)} cy={py(y)} r={(size / feetPerCell) * cell} className="template__outline" strokeWidth={2 / k} />
      ) : (
        <polygon points={poly.map((p) => `${px(p.x)},${py(p.y)}`).join(' ')} className="template__outline" strokeWidth={2 / k} />
      )}
      {caught.map((c) => (
        <circle
          key={c.id}
          cx={px(c.col + c.size / 2)}
          cy={py(c.row + c.size / 2)}
          r={(c.size * cell) / 2 + 3 / k}
          className="template__caught"
          strokeWidth={3 / k}
        />
      ))}
      {shape !== 'emanation' && <circle cx={px(x)} cy={py(y)} r={4 / k} className="template__origin" />}
    </g>
  );
}

function TemplateLabel({ x, y, k, text }: { x: number; y: number; k: number; text: string }) {
  const w = text.length * 7.4 + 16;
  return (
    <g transform={`translate(${x} ${y}) scale(${1 / k})`} className="map-label template__label" pointerEvents="none">
      <rect x={-w / 2} y={-30} width={w} height={22} rx={11} />
      <text x={0} y={-19}>
        {text}
      </text>
    </g>
  );
}
