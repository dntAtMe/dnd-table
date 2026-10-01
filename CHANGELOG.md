# Changelog

## 1.0.0 (2026-10-01)

The first release: everything a group needs to play D&D 5e (2024 rules) at the table with a GM
laptop, player phones and a TV.

### Table and session

- Accounts, campaigns and invite codes; the campaign's creator is its GM.
- Live sync over WebSockets with presence. The server decides what each screen may see.
- Server-side dice (`2d20kh1+3`, `4d6dl1`, `d%`, …) with public and GM-only rolls, chat and whispers.
- Table displays paired with a code: the map, turn order, recent rolls and handouts, no account
  needed.

### Maps

- Scenes from an uploaded image or a blank grid, prepared privately and shown when ready.
- Grid calibration and 2024 distances; tokens from Medium to Gargantuan, hidden tokens, pings and a
  movement-aware ruler.
- Map editor: walls, doors (open, closed, locked, secret) and terrain (rock, difficult, water), with
  movement blocked by walls and solid rock.
- Fog of war painted with a brush; table screens can follow the GM's camera.
- Lighting and token vision: scene light levels, light sources, darkvision, blindsight and
  truesight, line of sight through walls and doors, optional dynamic fog, and a per-player preview.
- Area templates (cone, cube, cylinder, emanation, line, sphere) with the 2024 coverage rule and spell
  areas read from the SRD.

### Characters and combat

- A character creator and level-up for every SRD class, species, background and feat.
- A character sheet derived from the rules: tap-to-roll bonuses, conditions and exhaustion applied
  to rolls, HP and death saves, spell slots, class resources, rests and inventory.
- Initiative tracker with SRD monsters, tap-to-roll stat blocks, HP and conditions synced with
  sheets, hidden creatures, health shown to players only as Healthy / Bloodied / Down, and 2024
  encounter difficulty.
- Quick actions on every token: HP, conditions, turn and initiative, attacks, checks and saves, and
  token settings, right beside it on the map.

### Campaign

- Handouts with text and images, shared with everyone or chosen players, shown full-screen on the TV.
- A campaign wiki with categories, aliases, tags, backlinks, per-player sharing and GM-only secret
  notes.
- A soundboard with music, ambience layers and effects, synced to every screen.

### Knowledge base

- The SRD 5.2 (classes, species, backgrounds, feats, equipment, 339 spells, 341 monsters, 262 magic
  items, rules terms) imported reproducibly from a pinned dataset.
- Every name is a link, with nested hover popups you can pin and move, a searchable Compendium,
  Ctrl/⌘ K quick search and related entries worked out from the data.
