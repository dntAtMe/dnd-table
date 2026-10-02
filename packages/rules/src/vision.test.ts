import { describe, expect, it } from 'vitest';
import { SPELLS_BY_ID } from './srd/spells';
import { MapData, edgeCode, terrainCode, type Edge } from './mapdata';
import { lineBlock } from './movement';
import {
  BRIGHT,
  DARK,
  DIM,
  LIGHT_PRESETS,
  SightMap,
  computeSight,
  illuminate,
  lightPreset,
  spellLight,
  viewField,
  type Emitter,
  type Lighting,
  type Viewer,
} from './vision';

const WALL = edgeCode({ kind: 'wall' });
const ROCK = terrainCode('rock');

function mapWith(cols: number, rows: number, walls: Edge[] = [], code = WALL): MapData {
  const map = new MapData(cols, rows);
  for (const e of walls) map.setEdge(e, code);
  return map;
}

const viewer = (col: number, row: number, senses: Partial<Viewer> = {}): Viewer => ({
  col,
  row,
  size: 1,
  darkvision: 0,
  blindsight: 0,
  truesight: 0,
  ...senses,
});
const torch = (col: number, row: number): Emitter => ({ col, row, size: 1, ...lightPreset('torch')! });

/** Seen level of one cell for one viewer. */
function seen(map: MapData, lighting: Lighting, lights: Emitter[], v: Viewer, col: number, row: number): number {
  const sight = new SightMap(map);
  return viewField(sight, illuminate(sight, lighting, lights, 5), v, 5)[row * map.cols + col]!;
}

describe('SightMap.lineOfSight', () => {
  it('is blocked by walls and closed or locked doors, but not open doors', () => {
    const edge: Edge = { side: 'left', col: 3, row: 2 };
    const los = (code: number) => new SightMap(mapWith(6, 6, [edge], code)).lineOfSight(1, 2, 5, 2);
    expect(los(WALL)).toBe(false);
    expect(los(edgeCode({ kind: 'door', state: 'closed', secret: false }))).toBe(false);
    expect(los(edgeCode({ kind: 'door', state: 'locked', secret: true }))).toBe(false);
    expect(los(edgeCode({ kind: 'door', state: 'open', secret: false }))).toBe(true);
    expect(new SightMap(mapWith(6, 6, [edge])).lineOfSight(5, 2, 1, 2)).toBe(false);
    expect(new SightMap(mapWith(6, 6, [edge])).lineOfSight(1, 3, 5, 3)).toBe(true);
  });

  it('stops behind solid rock but sees the rock face itself', () => {
    const map = new MapData(6, 3);
    map.setTerrain(2, 1, ROCK);
    const sight = new SightMap(map);
    expect(sight.lineOfSight(0, 1, 2, 1)).toBe(true);
    expect(sight.lineOfSight(0, 1, 3, 1)).toBe(false);
    expect(sight.lineOfSight(0, 0, 5, 0)).toBe(true);
  });

  it('is conservative at grid corners', () => {
    // (0,0) → (2,2) passes exactly through the corner points (1,1) and (2,2).
    const arm = new SightMap(mapWith(3, 3, [{ side: 'left', col: 1, row: 1 }]));
    expect(arm.lineOfSight(0, 0, 2, 2)).toBe(false);
    // Rock on the way blocks, and so does rock on either side of a corner the line squeezes past...
    const map = new MapData(3, 3);
    map.setTerrain(1, 0, ROCK);
    expect(new SightMap(map).lineOfSight(0, 1, 2, 0)).toBe(false);
    map.setTerrain(1, 2, ROCK);
    map.setTerrain(2, 1, ROCK);
    expect(new SightMap(map).lineOfSight(1, 1, 2, 2)).toBe(false);
    // ...but the corner of a rock face itself is visible.
    expect(new SightMap(map).lineOfSight(0, 1, 1, 0)).toBe(true);
    map.setTerrain(2, 2, ROCK);
    expect(new SightMap(map).lineOfSight(1, 1, 2, 2)).toBe(true);
  });

  it('agrees with movement on walls and doors for every line on a walled map', () => {
    const walls: Edge[] = [
      { side: 'left', col: 3, row: 1 },
      { side: 'left', col: 3, row: 2 },
      { side: 'top', col: 1, row: 4 },
      { side: 'top', col: 5, row: 3 },
      { side: 'left', col: 6, row: 5 },
    ];
    const map = mapWith(8, 7, walls);
    const sight = new SightMap(map);
    for (let a = 0; a < 56; a++) {
      for (let b = 0; b < 56; b++) {
        const from = { col: a % 8, row: Math.floor(a / 8) };
        const to = { col: b % 8, row: Math.floor(b / 8) };
        expect(sight.lineOfSight(from.col, from.row, to.col, to.row)).toBe(lineBlock(map, from, to) === null);
      }
    }
  });
});

describe('illuminate', () => {
  it('fills the scene with its ambient light and adds bright and dim rings around lights', () => {
    const map = new MapData(20, 3);
    const sight = new SightMap(map);
    expect([...illuminate(sight, 'bright', [], 5)].every((l) => l === BRIGHT)).toBe(true);
    expect([...illuminate(sight, 'dim', [], 5)].every((l) => l === DIM)).toBe(true);
    // Torch: bright for 20 ft (4 cells), dim for 20 ft more.
    const light = illuminate(sight, 'dark', [torch(2, 1)], 5);
    const row = [...light.slice(20, 40)];
    expect(row).toEqual([2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
    // Grid distance: diagonals count like straight lines.
    expect(light[0 * 20 + 6]).toBe(BRIGHT);
    // In dim ambient light, a light source only adds its bright part.
    expect(illuminate(sight, 'dim', [torch(2, 1)], 5)[1 * 20 + 15]).toBe(DIM);
  });

  it('does not shine through walls or closed doors', () => {
    const map = mapWith(10, 3, [0, 1, 2].map((row) => ({ side: 'left', col: 4, row }) as Edge));
    const light = illuminate(new SightMap(map), 'dark', [torch(2, 1)], 5);
    expect(light[1 * 10 + 3]).toBe(BRIGHT);
    expect(light[1 * 10 + 4]).toBe(DARK);
  });

  it('measures light from the edge of a large creature', () => {
    const light = illuminate(new SightMap(new MapData(20, 4)), 'dark', [{ col: 0, row: 0, size: 3, bright: 5, dim: 0 }], 5);
    expect(light[2 * 20 + 3]).toBe(BRIGHT);
    expect(light[2 * 20 + 4]).toBe(DARK);
  });
});

describe('viewField', () => {
  const open = new MapData(30, 3);

  it('sees everything in line of sight in bright light, nothing in darkness', () => {
    expect(seen(open, 'bright', [], viewer(0, 1), 29, 1)).toBe(BRIGHT);
    expect(seen(open, 'dim', [], viewer(0, 1), 29, 1)).toBe(DIM);
    expect(seen(open, 'dark', [], viewer(0, 1), 1, 1)).toBe(0);
    expect(seen(open, 'dark', [], viewer(0, 1), 0, 1)).toBe(0);
  });

  it('sees cells lit by a distant light, but not past a wall', () => {
    expect(seen(open, 'dark', [torch(25, 1)], viewer(0, 1), 25, 1)).toBe(BRIGHT);
    expect(seen(open, 'dark', [torch(25, 1)], viewer(0, 1), 20, 1)).toBe(DIM);
    expect(seen(open, 'dark', [torch(25, 1)], viewer(0, 1), 10, 1)).toBe(0);
    const walled = mapWith(30, 3, [0, 1, 2].map((row) => ({ side: 'left', col: 15, row }) as Edge));
    expect(seen(walled, 'dark', [torch(25, 1)], viewer(0, 1), 25, 1)).toBe(0);
    expect(seen(walled, 'bright', [], viewer(0, 1), 14, 1)).toBe(BRIGHT);
    expect(seen(walled, 'bright', [], viewer(0, 1), 15, 1)).toBe(0);
  });

  it('applies darkvision: darkness as dim, dim as bright, within range only', () => {
    const elf = viewer(0, 1, { darkvision: 60 });
    expect(seen(open, 'dark', [], elf, 12, 1)).toBe(DIM);
    expect(seen(open, 'dark', [], elf, 13, 1)).toBe(0);
    expect(seen(open, 'dim', [], elf, 12, 1)).toBe(BRIGHT);
    expect(seen(open, 'dim', [], elf, 13, 1)).toBe(DIM);
    // A torch's dim ring is bright to darkvision.
    expect(seen(open, 'dark', [torch(0, 1)], elf, 7, 1)).toBe(BRIGHT);
    // Darkvision doesn't see through walls.
    const walled = mapWith(30, 3, [{ side: 'left', col: 3, row: 1 }]);
    expect(seen(walled, 'dark', [], elf, 5, 1)).toBe(0);
  });

  it('perceives darkness with blindsight and sees it plainly with truesight', () => {
    expect(seen(open, 'dark', [], viewer(0, 1, { blindsight: 10 }), 2, 1)).toBe(DIM);
    expect(seen(open, 'dark', [], viewer(0, 1, { blindsight: 10 }), 3, 1)).toBe(0);
    expect(seen(open, 'dark', [], viewer(0, 1, { truesight: 30 }), 6, 1)).toBe(BRIGHT);
    expect(seen(open, 'dark', [], viewer(0, 1, { truesight: 30, darkvision: 60 }), 7, 1)).toBe(DIM);
  });

  it('sees from every side of a large token', () => {
    const big = viewer(5, 0, { size: 3, darkvision: 10 });
    expect(seen(open, 'dark', [], big, 9, 2)).toBe(DIM);
    expect(seen(open, 'dark', [], big, 3, 2)).toBe(DIM);
    expect(seen(open, 'dark', [], big, 10, 2)).toBe(0);
  });
});

describe('computeSight', () => {
  it('merges what several viewers see, keeping the best light level', () => {
    const map = new MapData(30, 3);
    const { visible, dim } = computeSight({
      map,
      feetPerCell: 5,
      lighting: 'dark',
      lights: [torch(25, 1)],
      viewers: [viewer(0, 1, { darkvision: 60 }), viewer(29, 1)],
    });
    expect(visible.isRevealed(5, 1)).toBe(true);
    expect(dim.isRevealed(5, 1)).toBe(true);
    expect(visible.isRevealed(15, 1)).toBe(false);
    expect(visible.isRevealed(25, 1)).toBe(true);
    expect(dim.isRevealed(25, 1)).toBe(false);
    expect(dim.isRevealed(20, 1)).toBe(true);
  });

  it('is fast enough for big maps with many tokens and lights', () => {
    // 100×100 dungeon: a lattice of rooms with doorways, 20 torches and 20 viewers with darkvision.
    const map = new MapData(100, 100);
    for (let i = 0; i < 100; i++) {
      for (let k = 10; k < 100; k += 10) {
        if (i % 10 !== 5) {
          map.setEdge({ side: 'left', col: k, row: i }, WALL);
          map.setEdge({ side: 'top', col: i, row: k }, WALL);
        }
      }
    }
    const lights = Array.from({ length: 20 }, (_, i) => torch((i * 37) % 100, (i * 53) % 100));
    const viewers = Array.from({ length: 20 }, (_, i) => viewer((i * 41 + 3) % 100, (i * 29 + 7) % 100, { darkvision: 60 }));
    let start = performance.now();
    computeSight({ map, feetPerCell: 5, lighting: 'dark', lights, viewers });
    const dark = performance.now() - start;
    // The worst case: daylight on an open field, where every cell is visible from everywhere.
    start = performance.now();
    computeSight({ map: new MapData(100, 100), feetPerCell: 5, lighting: 'bright', lights: [], viewers });
    const open = performance.now() - start;
    start = performance.now();
    computeSight({ map, feetPerCell: 5, lighting: 'bright', lights: [], viewers });
    const walled = performance.now() - start;
    expect(dark).toBeLessThan(1000);
    expect(open).toBeLessThan(1000);
    expect(walled).toBeLessThan(1000);
  });
});

describe('spell lights', () => {
  /** Bright and dim distances as the SRD spell text gives them. */
  function fromText(text: string): { bright: number; dim: number } | null {
    const both = /Bright Light in a (\d+)-foot radius and Dim Light for an additional (\d+) feet/.exec(text);
    if (both) return { bright: Number(both[1]), dim: Number(both[2]) };
    const sphere = /(\d+)-foot-radius Sphere[^.]*\.[^.]*Bright Light and sheds Dim Light for an additional (\d+) feet/.exec(text);
    if (sphere) return { bright: Number(sphere[1]), dim: Number(sphere[2]) };
    const dimOnly = /Dim Light in a (\d+)-?\s?foot radius/.exec(text);
    return dimOnly ? { bright: 0, dim: Number(dimOnly[1]) } : null;
  }

  it("match the distances in each spell's SRD text", () => {
    const spellPresets = LIGHT_PRESETS.filter((p) => 'spell' in p);
    expect(spellPresets.length).toBe(8);
    for (const p of spellPresets) {
      const spell = SPELLS_BY_ID[(p as { spell: string }).spell];
      expect(spell, p.id).toBeDefined();
      expect(fromText(spell!.description), p.id).toEqual({ bright: p.bright, dim: p.dim });
    }
  });

  it('give the light for a spell, and nothing for spells that light something else', () => {
    expect(spellLight('light')).toEqual({ preset: 'light', bright: 20, dim: 20 });
    expect(spellLight('daylight')).toEqual({ preset: 'daylight', bright: 60, dim: 60 });
    expect(spellLight('faerie-fire')).toBeNull();
    expect(spellLight('fireball')).toBeNull();
  });
});
