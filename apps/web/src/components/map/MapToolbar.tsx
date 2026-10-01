import type { ReactNode } from 'react';
import type { MapTool } from './MapView';

const ICONS: Record<string, ReactNode> = {
  move: <path d="M12 3v18M3 12h18M12 3l-3 3m3-3 3 3M12 21l-3-3m3 3 3-3M3 12l3-3m-3 3 3 3M21 12l-3-3m3 3-3 3" />,
  reveal: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <circle cx="12" cy="12" r="3" />
    </>
  ),
  hide: (
    <>
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <path d="M4 4l16 16" />
    </>
  ),
  ruler: <path d="M3 17 17 3l4 4L7 21zM7 13l2 2M10 10l2 2M13 7l2 2" />,
  ping: (
    <>
      <circle cx="12" cy="12" r="3" />
      <circle cx="12" cy="12" r="8" />
    </>
  ),
  wall: <path d="M3 5h18v14H3zM3 12h18M9 5v7M15 12v7" />,
  door: (
    <>
      <path d="M5 21V3h14v18M3 21h18" />
      <circle cx="15" cy="12" r="1" />
    </>
  ),
  terrain: <path d="m3 19 6-10 4 6 3-4 5 8zM14 6.5a1.5 1.5 0 1 0 0-.01" />,
  erase: <path d="m8 20-5-5L14 4l7 7-7 7M20 20H8M9 9l7 7" />,
};

export interface ToolOption {
  tool: MapTool;
  label: string;
  /** Starts a new group of tools, with a separator before it. */
  group?: boolean;
}

interface Props {
  tools: ToolOption[];
  tool: MapTool;
  onTool: (tool: MapTool) => void;
  brush?: number;
  onBrush?: (brush: number) => void;
  children?: ReactNode;
}

export function MapToolbar({ tools, tool, onTool, brush, onBrush, children }: Props) {
  const brushTool = tool === 'reveal' || tool === 'hide' || tool === 'terrain';
  return (
    <div className="map-toolbar" role="toolbar" aria-label="Map tools">
      <div className="map-toolbar__tools">
        {tools.flatMap((t) => [
          t.group ? <span key={`${t.tool}-sep`} className="map-toolbar__sep" aria-hidden="true" /> : null,
          <button
            key={t.tool}
            type="button"
            className={`tool${tool === t.tool ? ' is-active' : ''}`}
            onClick={() => onTool(t.tool)}
            aria-pressed={tool === t.tool}
            title={t.label}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              {ICONS[t.tool]}
            </svg>
            <span className="tool__label">{t.label}</span>
          </button>,
        ])}
      </div>
      {brushTool && brush !== undefined && onBrush && (
        <div className="segmented" role="radiogroup" aria-label="Brush size">
          {[1, 3, 5].map((b) => (
            <button key={b} type="button" role="radio" aria-checked={brush === b} className={brush === b ? 'is-active' : ''} onClick={() => onBrush(b)}>
              {b}×
            </button>
          ))}
        </div>
      )}
      {children}
    </div>
  );
}
