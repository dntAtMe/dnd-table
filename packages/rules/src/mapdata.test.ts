import { describe, expect, it } from 'vitest';
import { FogMask } from './grid';
import { MapData, edgeBlocks, edgeCode, edgeFeature, resizeFog, terrainCode, type EdgeFeature } from './mapdata';

const wall = edgeCode({ kind: 'wall' });
const door = (state: 'open' | 'closed' | 'locked', secret = false) => edgeCode({ kind: 'door', state, secret });

describe('edge codes', () => {
  it('round-trips every feature and knows what blocks', () => {
    const features: EdgeFeature[] = [{ kind: 'wall' }];
    for (const state of ['open', 'closed', 'locked'] as const) {
      for (const secret of [false, true]) features.push({ kind: 'door', state, secret });
    }
    const codes = features.map(edgeCode);
    expect(new Set(codes).size).toBe(features.length);
    expect(codes.map(edgeFeature)).toEqual(features);
    expect(edgeFeature(0)).toBeNull();
    expect(edgeFeature(99)).toBeNull();
    expect(codes.map(edgeBlocks)).toEqual([true, false, false, true, true, true, true]);
  });
});

describe('MapData edges', () => {
  it('names every edge once, including the right and bottom borders', () => {
    const map = new MapData(3, 2);
    expect(map.top.length).toBe(9);
    expect(map.left.length).toBe(8);
    expect(map.edgeIndex({ side: 'top', col: 2, row: 2 })).toBe(8); // bottom border
    expect(map.edgeIndex({ side: 'left', col: 3, row: 1 })).toBe(7); // right border
    expect(map.edgeIndex({ side: 'top', col: 3, row: 0 })).toBe(-1);
    expect(map.edgeIndex({ side: 'left', col: 0, row: 2 })).toBe(-1);

    map.setEdge({ side: 'left', col: 3, row: 1 }, wall);
    map.setEdge({ side: 'top', col: 9, row: 9 }, wall); // ignored
    expect(map.blocks({ side: 'left', col: 3, row: 1 })).toBe(true);
    expect([...map.edges()]).toEqual([{ edge: { side: 'left', col: 3, row: 1 }, code: wall }]);
  });
});

describe('MapData serialisation', () => {
  it('encodes an empty map as an empty string', () => {
    expect(new MapData(30, 20).encode()).toBe('');
    expect(MapData.decode('', 30, 20).encode()).toBe('');
  });

  it('round-trips deterministically and compactly', () => {
    const map = new MapData(30, 20);
    for (let c = 0; c < 30; c++) map.setEdge({ side: 'top', col: c, row: 0 }, wall);
    map.setEdge({ side: 'left', col: 5, row: 5 }, door('locked', true));
    for (let i = 0; i < 600; i++) map.terrain[i] = terrainCode('rock');
    map.setTerrain(3, 3, terrainCode('water'));
    const text = map.encode();
    expect(text.length).toBeLessThan(40);
    const copy = MapData.decode(text, 30, 20);
    expect(copy.encode()).toBe(text);
    expect(copy.feature({ side: 'left', col: 5, row: 5 })).toEqual({ kind: 'door', state: 'locked', secret: true });
    expect(copy.terrainAt(3, 3)).toBe(terrainCode('water'));
    expect(copy.passable(0, 0)).toBe(false);
    expect(copy.blocks({ side: 'top', col: 29, row: 0 })).toBe(true);
  });

  it('ignores data for a different grid size or a garbled string', () => {
    const map = new MapData(4, 4);
    for (let i = 0; i < 16; i++) map.terrain[i] = 2;
    const text = map.encode();
    expect(MapData.decode(text, 2, 2).terrainAt(0, 0)).toBe(0);
    expect(MapData.decode('1|zz|!|', 4, 4).encode()).toBe('');
    expect(MapData.decode('9|1|1|1', 4, 4).encode()).toBe('');
  });
});

describe('MapData.forPlayers', () => {
  it('shows closed secret doors as walls and open ones as plain doors', () => {
    const map = new MapData(3, 3);
    map.setEdge({ side: 'left', col: 1, row: 0 }, door('closed', true));
    map.setEdge({ side: 'left', col: 1, row: 1 }, door('locked', true));
    map.setEdge({ side: 'left', col: 1, row: 2 }, door('open', true));
    map.setEdge({ side: 'top', col: 0, row: 1 }, door('locked'));
    const seen = map.forPlayers();
    expect(seen.feature({ side: 'left', col: 1, row: 0 })).toEqual({ kind: 'wall' });
    expect(seen.feature({ side: 'left', col: 1, row: 1 })).toEqual({ kind: 'wall' });
    expect(seen.feature({ side: 'left', col: 1, row: 2 })).toEqual({ kind: 'door', state: 'open', secret: false });
    expect(seen.feature({ side: 'top', col: 0, row: 1 })).toEqual({ kind: 'door', state: 'locked', secret: false });
    expect(map.feature({ side: 'left', col: 1, row: 0 })).toMatchObject({ secret: true }); // original untouched
    expect(seen.encode()).not.toMatch(/[5-7]/);
  });

  it('drops everything behind the fog', () => {
    const map = new MapData(3, 1);
    map.setEdge({ side: 'left', col: 1, row: 0 }, wall); // between revealed (0,0) and fogged (1,0)
    map.setEdge({ side: 'left', col: 2, row: 0 }, wall); // between two fogged cells
    map.setTerrain(0, 0, 3);
    map.setTerrain(2, 0, 2);
    const fog = new FogMask(3, 1);
    fog.set(0, 0, true);
    const seen = map.forPlayers(fog);
    expect(seen.blocks({ side: 'left', col: 1, row: 0 })).toBe(true);
    expect(seen.blocks({ side: 'left', col: 2, row: 0 })).toBe(false);
    expect(seen.terrainAt(0, 0)).toBe(3);
    expect(seen.terrainAt(2, 0)).toBe(0);
  });
});

describe('resizing', () => {
  it('shifts walls and terrain when rows/columns are added at the top and left', () => {
    const map = new MapData(3, 3);
    map.setEdge({ side: 'top', col: 0, row: 0 }, wall); // top border
    map.setEdge({ side: 'left', col: 3, row: 2 }, door('open')); // right border
    map.setTerrain(1, 1, 4);
    const grown = map.resized({ top: 1, left: 2, bottom: 0, right: 1 });
    expect([grown.cols, grown.rows]).toEqual([6, 4]);
    expect(grown.blocks({ side: 'top', col: 2, row: 1 })).toBe(true);
    expect(grown.feature({ side: 'left', col: 5, row: 3 })).toMatchObject({ kind: 'door', state: 'open' });
    expect(grown.terrainAt(3, 2)).toBe(4);
    expect([...grown.edges()]).toHaveLength(2);
  });

  it('keeps the edge on the new border and drops what falls off when shrinking', () => {
    const map = new MapData(3, 3);
    map.setEdge({ side: 'top', col: 1, row: 0 }, wall); // falls off
    map.setEdge({ side: 'top', col: 1, row: 1 }, wall); // becomes the new top border
    map.setEdge({ side: 'left', col: 2, row: 2 }, wall); // becomes the new right border
    map.setTerrain(0, 0, 2);
    map.setTerrain(1, 1, 3);
    const shrunk = map.resized({ top: -1, left: 0, bottom: 0, right: -1 });
    expect([shrunk.cols, shrunk.rows]).toEqual([2, 2]);
    expect([...shrunk.edges()]).toEqual([
      { edge: { side: 'top', col: 1, row: 0 }, code: wall },
      { edge: { side: 'left', col: 2, row: 1 }, code: wall },
    ]);
    expect(shrunk.terrainAt(1, 0)).toBe(3);
    expect([...shrunk.terrain].filter(Boolean)).toEqual([3]);
  });

  it('moves revealed fog with the map and fogs new cells', () => {
    const fog = new FogMask(2, 2);
    fog.fill(true);
    const grown = resizeFog(fog, { top: 1, left: 1, bottom: 0, right: 0 });
    expect(grown.isRevealed(0, 0)).toBe(false);
    expect(grown.isRevealed(1, 1)).toBe(true);
    expect(grown.isRevealed(2, 2)).toBe(true);
    expect(grown.isRevealed(0, 2)).toBe(false);
    const shrunk = resizeFog(grown, { top: 0, left: -1, bottom: 0, right: 0 });
    expect([shrunk.cols, shrunk.rows]).toEqual([2, 3]);
    expect(shrunk.isRevealed(0, 1)).toBe(true);
    expect(shrunk.isRevealed(0, 0)).toBe(false);
  });
});
