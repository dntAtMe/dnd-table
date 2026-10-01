import { describe, expect, it } from 'vitest';
import { Compendium, coreCompendium, type IndexEntry } from './compendium';
import { backlinks, brokenLinks, completeLink, linkGraph, linkMarkup, linkQueryAt, linkSuggestions } from './wiki';

const pages: IndexEntry[] = [
  { kind: 'page', id: 'gundren', name: 'Gundren Rockseeker', aliases: ['Gundren'], summary: 'NPC' },
  { kind: 'page', id: 'phandalin', name: 'Phandalin', summary: 'Location' },
  { kind: 'page', id: 'redbrands', name: 'Redbrands', summary: 'Faction' },
  { kind: 'page', id: 'blinded', name: 'Blinded', summary: 'Lore · the GM named a page after a condition' },
];
const compendium = coreCompendium().with(pages);
const page = (id: string) => ({ kind: 'page' as const, id });

describe('linkGraph / backlinks', () => {
  const sources = [
    { ref: page('gundren'), body: 'A dwarf from Phandalin. Gundren hired the party.' },
    { ref: page('phandalin'), body: 'A frontier town. [[Gundren Rockseeker|Our employer]] has a claim nearby; the Redbrands run it.' },
    { ref: page('redbrands'), body: 'Thugs in red cloaks. They fear nobody.' },
    { ref: page('session-1'), body: 'Met Gundren at the inn, then [[phandalin]] and again Phandalin and Phandalin.' },
  ];

  it('finds explicit links and names linked automatically, never a page linking to itself', () => {
    const graph = linkGraph(compendium, sources);
    expect(graph.get('page:phandalin')).toEqual([page('gundren'), page('session-1')]);
    expect(graph.get('page:gundren')).toEqual([page('phandalin'), page('session-1')]);
    expect(graph.get('page:redbrands')).toEqual([page('phandalin')]);
    expect(backlinks(compendium, page('redbrands'), sources)).toEqual([page('phandalin')]);
    expect(backlinks(compendium, page('nobody'), sources)).toEqual([]);
  });

  it('follows what the reader can click: lowercase words and kind:id links', () => {
    const graph = linkGraph(compendium, [
      { ref: page('a'), body: 'the redbrands are just a word here' },
      { ref: page('b'), body: 'See [[page:redbrands|the gang]].' },
    ]);
    expect(graph.get('page:redbrands')).toEqual([page('b')]);
  });

  it('prefers a page over the rules entry with the same name', () => {
    expect(linkGraph(compendium, [{ ref: page('x'), body: 'Blinded by the light.' }]).get('page:blinded')).toEqual([page('x')]);
  });
});

describe('brokenLinks', () => {
  it('lists explicit links to missing pages once each', () => {
    expect(brokenLinks(compendium, '[[Sildar Hallwinter]] met [[Gundren]] and [[Sildar Hallwinter]] and [[Iarno|the wizard]].')).toEqual([
      'Sildar Hallwinter',
      'the wizard',
    ]);
  });
});

describe('[[ autocomplete', () => {
  it('finds the link being typed at the caret', () => {
    expect(linkQueryAt('Ask [[Gund', 10)).toEqual({ start: 4, query: 'Gund' });
    expect(linkQueryAt('Ask [[', 6)).toEqual({ start: 4, query: '' });
    expect(linkQueryAt('Ask [[Gundren]] now', 19)).toBeNull();
    expect(linkQueryAt('[[Gundren|the boss', 18)).toBeNull();
    expect(linkQueryAt('[[Gundren\nnext line', 19)).toBeNull();
    expect(linkQueryAt('No link here', 5)).toBeNull();
    // Caret in the middle of the text: only what's before it counts.
    expect(linkQueryAt('[[Pha]] and more', 5)).toEqual({ start: 0, query: 'Pha' });
  });

  it('suggests pages first when nothing is typed, then anything matching', () => {
    expect(linkSuggestions(compendium, '').every((e) => e.kind === 'page')).toBe(true);
    expect(linkSuggestions(compendium, 'gund')[0]).toMatchObject({ kind: 'page', id: 'gundren' });
    expect(linkSuggestions(compendium, 'frighten')[0]).toMatchObject({ kind: 'condition', id: 'frightened' });
  });

  it('writes [[Name]] when the name is unambiguous, kind:id otherwise', () => {
    expect(linkMarkup(compendium, compendium.get(page('phandalin'))!)).toBe('[[Phandalin]]');
    const condition = compendium.get({ kind: 'condition', id: 'blinded' })!;
    expect(linkMarkup(compendium, condition)).toBe('[[condition:blinded|Blinded]]');
    const odd = new Compendium([{ kind: 'page', id: 'p', name: 'The [Lost] Mine', summary: '' }]);
    expect(linkMarkup(odd, odd.get(page('p'))!)).toBe('[[page:p|The Lost Mine]]');
  });

  it('replaces the typed query with the finished link', () => {
    const text = 'Ask [[Gund about it';
    const q = linkQueryAt(text, 10)!;
    expect(completeLink(text, 10, q, '[[Gundren Rockseeker]]')).toEqual({ text: 'Ask [[Gundren Rockseeker]] about it', caret: 26 });
    // A closing ]] already typed after the caret is swallowed.
    const closed = 'Ask [[Gu]]!';
    expect(completeLink(closed, 8, linkQueryAt(closed, 8)!, '[[Gundren]]')).toEqual({ text: 'Ask [[Gundren]]!', caret: 15 });
  });
});
