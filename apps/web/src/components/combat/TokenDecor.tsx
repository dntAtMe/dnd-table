import type { CombatView, Token } from '@dnd/protocol';
import type { HealthStatus } from '@dnd/rules';
import './combat.css';

/** Combat information drawn on a map token. */
export interface TokenDecoration {
  /** It's this creature's turn. */
  active?: boolean;
  /** Hit points for the bar (only for viewers allowed to see the numbers). */
  hp?: { value: number; max: number; temp: number };
  status?: HealthStatus | null;
}

interface Viewer {
  isGm: boolean;
  userId?: string;
}

/**
 * Per-token decorations from the combat view: the active turn ring for everyone, HP bars for the
 * GM (and a player's own tokens), and Bloodied/Down markers otherwise.
 */
export function tokenDecorations(combat: CombatView | null, tokens: Token[], viewer: Viewer): Record<string, TokenDecoration> {
  const out: Record<string, TokenDecoration> = {};
  if (!combat) return out;
  for (const c of combat.combatants) {
    const token = tokens.find((t) => t.id === c.tokenId) ?? (c.characterId ? tokens.find((t) => t.characterId === c.characterId) : undefined);
    if (!token) continue;
    const mine = viewer.userId !== undefined && (c.ownerUserId === viewer.userId || token.ownerUserId === viewer.userId);
    const showBar = (viewer.isGm || mine) && c.hp != null && c.hpMax != null;
    out[token.id] = {
      active: combat.activeId === c.id,
      hp: showBar ? { value: c.hp!, max: c.hpMax!, temp: c.tempHp ?? 0 } : undefined,
      status: c.status,
    };
  }
  return out;
}

/** Drawn inside a token's group; `d` is the token's diameter in map pixels. */
export function TokenDecor({ decoration, d, cell }: { decoration: TokenDecoration; d: number; cell: number }) {
  const { active, hp, status } = decoration;
  const barW = d * 0.8;
  const barH = Math.max(4, cell * 0.1);
  const pct = hp ? Math.max(0, Math.min(1, hp.value / Math.max(1, hp.max))) : 0;
  const badge = Math.max(7, cell * 0.16);
  return (
    <g className="token-decor" pointerEvents="none">
      {active && <circle cx={d / 2} cy={d / 2} r={d / 2 + Math.max(4, cell * 0.1)} className="token-decor__turn" />}
      {hp && (
        <g transform={`translate(${(d - barW) / 2} ${-barH - Math.max(2, cell * 0.05)})`} className={`token-decor__bar token-decor__bar--${status ?? 'healthy'}`}>
          <rect width={barW} height={barH} rx={barH / 2} className="token-decor__track" />
          <rect width={barW * pct} height={barH} rx={barH / 2} className="token-decor__fill" />
          {hp.temp > 0 && <rect width={barW} height={barH} rx={barH / 2} className="token-decor__temp" />}
        </g>
      )}
      {!hp && (status === 'bloodied' || status === 'down') && (
        <g transform={`translate(${d - badge * 0.9} ${badge * 0.9})`} className={`token-decor__badge token-decor__badge--${status}`}>
          <title>{status === 'down' ? 'Down' : 'Bloodied'}</title>
          <circle r={badge} />
          {status === 'down' ? (
            <path d={`M${-badge * 0.45} ${-badge * 0.45}L${badge * 0.45} ${badge * 0.45}M${badge * 0.45} ${-badge * 0.45}L${-badge * 0.45} ${badge * 0.45}`} />
          ) : (
            <path d={`M0 ${-badge * 0.6}C${badge * 0.5} 0 ${badge * 0.5} ${badge * 0.55} 0 ${badge * 0.55}C${-badge * 0.5} ${badge * 0.55} ${-badge * 0.5} 0 0 ${-badge * 0.6}Z`} />
          )}
        </g>
      )}
    </g>
  );
}
