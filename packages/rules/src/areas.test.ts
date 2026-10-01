import { describe, expect, it } from 'vitest';
import {
  areaCells,
  areaPolygon,
  coveredFraction,
  normalizeAngle,
  parseSpellArea,
  snapAngle,
  snapOrigin,
  tokensInArea,
  type Area,
} from './areas';
import type { CellPos } from './movement';
import { SPELLS_BY_ID } from './srd/spells';

/** Renders covered cells as rows of '#' and '.' over a bounding box, for readable expectations. */
function picture(cells: CellPos[], c0: number, r0: number, c1: number, r1: number): string[] {
  const set = new Set(cells.map((c) => `${c.col},${c.row}`));
  const rows: string[] = [];
  for (let r = r0; r <= r1; r++) {
    let line = '';
    for (let c = c0; c <= c1; c++) line += set.has(`${c},${r}`) ? '#' : '.';
    rows.push(line);
  }
  return rows;
}

const area = (shape: Area['shape'], size: number, x: number, y: number, angle = 0, extra: Partial<Area> = {}): Area => ({
  shape,
  size,
  x,
  y,
  angle,
  ...extra,
});
const key = (cells: CellPos[]) => cells.map((c) => `${c.col},${c.row}`).sort();

describe('coveredFraction', () => {
  it('measures the exact share of a square inside a polygon', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 2, y: 0 },
      { x: 2, y: 2 },
      { x: 0, y: 2 },
    ];
    expect(coveredFraction(square, 1, 1)).toBeCloseTo(1);
    expect(coveredFraction(square, 2, 1)).toBe(0);
    const triangle = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ];
    expect(coveredFraction(triangle, 0, 0)).toBeCloseTo(0.5);
  });
});

describe('areaCells: spheres and cylinders', () => {
  it('covers the four squares around an intersection with a 5-foot radius', () => {
    expect(key(areaCells(area('sphere', 5, 2, 2), 5))).toEqual(['1,1', '1,2', '2,1', '2,2']);
  });

  it('covers a square only when at least half of it is inside', () => {
    // 10-foot radius: the diagonal squares are only ~31% covered.
    expect(picture(areaCells(area('sphere', 10, 5, 5), 5), 3, 3, 6, 6)).toEqual(['.##.', '####', '####', '.##.']);
  });

  it('covers the classic 52 squares for a Fireball', () => {
    const cells = areaCells(area('sphere', 20, 10, 10), 5);
    expect(cells).toHaveLength(52);
    expect(picture(cells, 6, 6, 13, 13)).toEqual([
      '..####..',
      '.######.',
      '########',
      '########',
      '########',
      '########',
      '.######.',
      '..####..',
    ]);
  });

  it('is symmetric under quarter turns and ignores direction', () => {
    const cells = areaCells(area('sphere', 30, 20, 20, 17), 5);
    const set = new Set(key(cells));
    for (const c of cells) {
      // Rotate 90° about the intersection (20, 20): cell (c, r) maps to (40 - 1 - r, c).
      expect(set.has(`${39 - c.row},${c.col}`)).toBe(true);
    }
    expect(key(cells)).toEqual(key(areaCells(area('sphere', 30, 20, 20, 0), 5)));
  });

  it('gives a Cylinder the same footprint as a Sphere of its radius', () => {
    expect(key(areaCells(area('cylinder', 10, 4, 4), 5))).toEqual(key(areaCells(area('sphere', 10, 4, 4), 5)));
  });

  it('scales with the feet per cell of the grid', () => {
    expect(key(areaCells(area('sphere', 20, 5, 5), 10))).toEqual(key(areaCells(area('sphere', 10, 5, 5), 5)));
  });

  it('stops at the map border', () => {
    expect(key(areaCells(area('sphere', 5, 0, 0), 5, 10, 10))).toEqual(['0,0']);
    const cells = areaCells(area('sphere', 20, 9, 1), 5, 10, 8);
    expect(cells.every((c) => c.col >= 0 && c.col < 10 && c.row >= 0 && c.row < 8)).toBe(true);
    expect(cells.length).toBeLessThan(52);
  });
});

describe('areaCells: cubes', () => {
  it('extends from its origin corner along the diagonal direction', () => {
    expect(picture(areaCells(area('cube', 15, 2, 2, 45), 5), 1, 1, 5, 5)).toEqual(['.....', '.###.', '.###.', '.###.', '.....']);
    // Pointing up and to the left instead.
    expect(key(areaCells(area('cube', 10, 4, 4, 225), 5))).toEqual(['2,2', '2,3', '3,2', '3,3']);
  });

  it('turns into a diamond when the diagonal follows a grid line', () => {
    expect(picture(areaCells(area('cube', 15, 10, 10, 0), 5), 10, 8, 13, 11)).toEqual(['.##.', '####', '####', '.##.']);
  });
});

describe('areaCells: lines', () => {
  it('runs straight down a row from the middle of a cell edge', () => {
    expect(key(areaCells(area('line', 30, 1, 2.5, 0), 5))).toEqual(['1,2', '2,2', '3,2', '4,2', '5,2', '6,2']);
    expect(key(areaCells(area('line', 15, 3.5, 4, 270), 5))).toEqual(['3,1', '3,2', '3,3']);
  });

  it('covers both rows when it runs along a grid line (each square is exactly half covered)', () => {
    expect(areaCells(area('line', 30, 1, 2, 0), 5)).toHaveLength(12);
  });

  it('follows diagonals and arbitrary angles', () => {
    expect(picture(areaCells(area('line', 30, 10, 10, 45), 5), 10, 10, 13, 13)).toEqual(['#...', '.#..', '..#.', '...#']);
    expect(picture(areaCells(area('line', 30, 10, 10, 30), 5), 10, 10, 14, 12)).toEqual(['##...', '..##.', '...##']);
  });

  it('honours the width', () => {
    expect(areaCells(area('line', 60, 0, 5, 0, { width: 10 }), 5)).toHaveLength(24);
  });
});

describe('areaCells: cones', () => {
  it('widens to its length at the far end', () => {
    // From the middle of a cell edge: 1, 1, then 3 squares (the first is exactly half covered).
    expect(picture(areaCells(area('cone', 15, 10, 10.5, 0), 5), 10, 9, 12, 11)).toEqual(['..#', '###', '..#']);
    expect(picture(areaCells(area('cone', 15, 10, 10, 45), 5), 10, 10, 12, 12)).toEqual(['##.', '###', '.#.']);
  });

  it('rotates with its direction', () => {
    const east = areaCells(area('cone', 30, 10, 10.5, 0), 5);
    const south = areaCells(area('cone', 30, 9.5, 10, 90), 5);
    // A quarter turn about (10, 10) maps cell (c, r) to (20 - 1 - r, c).
    expect(key(south)).toEqual(key(east.map((c) => ({ col: 19 - c.row, row: c.col }))));
    expect(east).toHaveLength(18);
  });

  it('is cut off by the map edge', () => {
    expect(areaCells(area('cone', 30, 0, 0.5, 180), 5, 10, 10)).toEqual([]);
  });
});

describe('areaCells: emanations', () => {
  it('rings the creature space with every square within the distance', () => {
    const cells = areaCells(area('emanation', 10, 5, 5, 0, { span: 1 }), 5);
    expect(cells).toHaveLength(24);
    expect(key(cells)).not.toContain('5,5');
  });

  it('extends from the whole space of a large creature', () => {
    const cells = areaCells(area('emanation', 5, 3, 3, 0, { span: 2 }), 5);
    expect(picture(cells, 2, 2, 5, 5)).toEqual(['####', '#..#', '#..#', '####']);
  });

  it('stops at the map border', () => {
    expect(key(areaCells(area('emanation', 5, 0, 0, 0, { span: 1 }), 5, 10, 10))).toEqual(['0,1', '1,0', '1,1']);
  });

  it('has a square outline around the ring', () => {
    expect(areaPolygon(area('emanation', 15, 4, 4, 0, { span: 2 }), 5)).toEqual([
      { x: 1, y: 1 },
      { x: 9, y: 1 },
      { x: 9, y: 9 },
      { x: 1, y: 9 },
    ]);
  });
});

describe('tokensInArea', () => {
  const tokens = [
    { id: 'caster', col: 5, row: 5, size: 1 },
    { id: 'goblin', col: 7, row: 5, size: 1 },
    { id: 'ogre', col: 8, row: 7, size: 2 },
    { id: 'far', col: 15, row: 15, size: 1 },
  ];

  it('catches a creature when any of its squares is covered', () => {
    const cells = areaCells(area('sphere', 10, 9, 6), 5);
    expect(tokensInArea(cells, tokens).map((t) => t.id)).toEqual(['goblin', 'ogre']);
    expect(tokensInArea([], tokens)).toEqual([]);
  });

  it("doesn't catch the creature an emanation comes from", () => {
    const cells = areaCells(area('emanation', 15, 5, 5, 0, { span: 1 }), 5);
    expect(tokensInArea(cells, tokens, 'caster').map((t) => t.id)).toEqual(['goblin', 'ogre']);
  });
});

describe('origins and angles', () => {
  it('snaps spheres and cubes to intersections, cones and lines also to edge midpoints', () => {
    expect(snapOrigin('sphere', 2.4, 3.6)).toEqual({ x: 2, y: 4 });
    expect(snapOrigin('cube', 2.6, 3.4)).toEqual({ x: 3, y: 3 });
    expect(snapOrigin('line', 2.1, 3.45)).toEqual({ x: 2, y: 3.5 });
    expect(snapOrigin('cone', 2.55, 3.1)).toEqual({ x: 2.5, y: 3 });
    expect(snapOrigin('cone', 2.1, 2.9)).toEqual({ x: 2, y: 3 });
    expect(snapOrigin('emanation', 2.9, 3.1)).toEqual({ x: 2, y: 3 });
  });

  it('normalises and snaps angles', () => {
    expect(normalizeAngle(-90)).toBe(270);
    expect(normalizeAngle(720)).toBe(0);
    expect(snapAngle(100)).toBe(90);
    expect(snapAngle(-30)).toBe(315);
    expect(snapAngle(-20)).toBe(0);
    expect(snapAngle(350)).toBe(0);
  });
});

describe('parseSpellArea', () => {
  const of = (id: string) => parseSpellArea(SPELLS_BY_ID[id]!.description);

  it('reads the area from SRD spell text', () => {
    expect(of('fireball')).toEqual({ shape: 'sphere', size: 20 });
    expect(of('burning-hands')).toEqual({ shape: 'cone', size: 15 });
    expect(of('thunderwave')).toEqual({ shape: 'cube', size: 15 });
    expect(of('lightning-bolt')).toEqual({ shape: 'line', size: 100, width: 5 });
    expect(of('sunbeam')).toEqual({ shape: 'line', size: 60, width: 5 });
    expect(of('gust-of-wind')).toEqual({ shape: 'line', size: 60, width: 10 });
    expect(of('spirit-guardians')).toEqual({ shape: 'emanation', size: 15 });
    expect(of('moonbeam')).toEqual({ shape: 'cylinder', size: 5, height: 40 });
    expect(of('sleet-storm')).toEqual({ shape: 'cylinder', size: 20, height: 40 });
    expect(of('call-lightning')).toEqual({ shape: 'cylinder', size: 60, height: 10 });
  });

  it("ignores size limits and spells without an area", () => {
    expect(of('minor-illusion')).toBeNull();
    expect(of('magic-missile')).toBeNull();
    expect(parseSpellArea('fills a 20-foot Cube within range')).toEqual({ shape: 'cube', size: 20 });
  });
});
