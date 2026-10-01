import { describe, expect, it } from 'vitest';
import { formatCr, monsterInitiative, monsterSave, monsterSkill, SIZE_CELLS, damageExpression, describeDamage } from '../monsters';
import { parseDice } from '../dice';
import { CONDITION_IDS, DAMAGE_TYPES, SKILL_IDS } from './index';
import { MONSTERS, MONSTERS_BY_ID } from './monsters';

describe('SRD monsters', () => {
  it('has the SRD 5.2 bestiary with complete core stats', () => {
    expect(MONSTERS.length).toBeGreaterThanOrEqual(300);
    for (const m of MONSTERS) {
      expect(m.hp, m.id).toBeGreaterThan(0);
      expect(m.ac, m.id).toBeGreaterThan(0);
      expect(SIZE_CELLS[m.size], m.id).toBeDefined();
      expect(() => parseDice(m.hpFormula), m.id).not.toThrow();
      for (const s of Object.keys(m.skills)) expect(SKILL_IDS, m.id).toContain(s);
      // Exhaustion isn't one of the tracked toggle conditions, but monsters can be immune to it.
      for (const c of m.conditionImmunities) expect([...CONDITION_IDS, 'exhaustion'], m.id).toContain(c);
    }
  });

  it('parses attacks into rollable data', () => {
    const attacks = MONSTERS.flatMap((m) => [...m.actions, ...m.bonusActions, ...m.reactions, ...m.legendaryActions]).flatMap((a) => (a.attack ? [a.attack] : []));
    expect(attacks.length).toBeGreaterThan(400);
    for (const a of attacks) {
      for (const d of [...a.damage, ...(a.riders ?? [])]) {
        expect(DAMAGE_TYPES).toContain(d.type);
        expect(() => parseDice(d.dice), d.dice).not.toThrow();
      }
    }
  });

  it('reads a goblin warrior stat block', () => {
    const g = MONSTERS_BY_ID['goblin-warrior']!;
    expect(g).toMatchObject({ name: 'Goblin Warrior', size: 'Small', ac: 15, hp: 10, hpFormula: '3d6', cr: 0.25, xp: 50, speed: { walk: 30 } });
    expect(formatCr(g.cr)).toBe('1/4');
    expect(monsterSkill(g, 'stealth')).toBe(6);
    expect(monsterSkill(g, 'perception')).toBe(-1);
    expect(monsterInitiative(g)).toBe(2);
    const scimitar = g.actions.find((a) => a.name === 'Scimitar')!;
    expect(scimitar.attack).toMatchObject({ kind: 'melee', bonus: 4, reach: '5 ft.', damage: [{ dice: '1d6 + 2', type: 'slashing', average: 5 }] });
    expect(scimitar.attack!.riders).toEqual([{ average: 2, dice: '1d4', type: 'slashing', note: 'if the attack roll had Advantage' }]);
  });

  it('reads saves, multi-type damage, save actions and spell lists', () => {
    const dragon = MONSTERS_BY_ID['adult-red-dragon']!;
    expect(monsterSave(dragon, 'dex')).toBe(dragon.saves.dex);
    expect(monsterSave(dragon, 'str')).toBe(8); // STR 27, not proficient
    const rend = dragon.actions.find((a) => a.name === 'Rend')!.attack!;
    expect(damageExpression(rend.damage)).toBe('1d10 + 8 + 2d4');
    expect(describeDamage(rend.damage)).toBe('13 (1d10 + 8) Slashing plus 5 (2d4) Fire');
    const breath = dragon.actions.find((a) => a.name === 'Fire Breath')!;
    expect(breath).toMatchObject({ usage: 'Recharge 5–6', save: { ability: 'dex', dc: 21, half: true, damage: [{ dice: '17d6', type: 'fire' }] } });
    const spells = dragon.actions.find((a) => a.name === 'Spellcasting')!;
    expect(spells.description).toMatch(/\nAt will: Command, Detect Magic, Scorching Ray\n1\/Day each: Fireball$/);
    expect(spells.spells).toContain('fireball');
    expect(dragon.legendaryActions.length).toBeGreaterThan(0);
    expect(MONSTERS_BY_ID['jackal']!.actions[0]!.attack!.damage[0]!.dice).toBe('1d4 - 1');
  });
});
