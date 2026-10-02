# dnd-table

A virtual tabletop for playing D&D 5e (2024 rules) around a real table. The GM runs the game from a
laptop, players use their phones, and a TV shows the battle map to the room. It runs on your own
computer over Wi-Fi: no subscription, no cloud account, and your campaign stays in one folder.

![The GM's screen during a fight](docs/screenshots/gm-combat.png)

## What it does

- **Live on every screen.** The GM, each player and any number of table displays join the same session
  over WebSockets. The server decides what each one may see: hidden rolls, hidden or fogged creatures,
  secret doors and GM notes never reach players' devices.
- **Battle maps.** Upload a map image or start from a blank grid. Calibrate the grid, draw walls,
  doors (including locked and secret ones) and terrain, paint fog of war, and set the light. Token
  vision shows each player only what their character can see.
- **Characters by the 2024 rules.** A step-by-step creator and level-up, and a sheet that works out
  every bonus, applies conditions and exhaustion to rolls, and tracks HP, spell slots, resources and
  rests. Tap any number to roll it.
- **Combat.** Initiative tracker, 341 SRD monsters with tap-to-roll stat blocks, HP and conditions
  synced with character sheets, encounter difficulty, and area templates that follow the 2024 grid
  rules. Click any token for its quick actions right on the map.
- **Knowledge base.** Every spell, monster, condition, item and rule is a link wherever it appears,
  with nested popups and related entries worked out from the SRD. Ctrl/⌘ K searches everything.
- **Campaign tools.** A campaign wiki with secret notes and per-player sharing, handouts shown
  full-screen on the TV, and a soundboard with music, ambience layers and effects synced to every
  screen.
- **Table display.** Any browser becomes a shared screen with a pairing code: the map, the turn order,
  recent rolls and handouts, big enough to read across the room.

| Player's sheet | Player's map | Table display |
| :---: | :---: | :---: |
| ![Character sheet on a phone](docs/screenshots/player-sheet.png) | ![Map and quick actions on a phone](docs/screenshots/player-map.png) | ![Table display](docs/screenshots/table-display.png) |

| Preparing a scene | Knowledge base | Campaign wiki |
| :---: | :---: | :---: |
| ![Editing a scene](docs/screenshots/gm-edit-scene.png) | ![Nested knowledge base popups](docs/screenshots/knowledge-base.png) | ![Campaign wiki](docs/screenshots/wiki.png) |

**New here? Read the [user guide](docs/user-guide.md)**: setting up a session, playing a character,
and everything the GM can do. The same docs are on the website: **https://dntatme.github.io/dnd-table/**.

## Running it

You need [Node.js](https://nodejs.org) 22.5 or newer (24 recommended) and
[pnpm](https://pnpm.io/installation). With Nix, `nix develop` provides both.

```bash
git clone https://github.com/dntAtMe/dnd-table.git
cd dnd-table
pnpm install
pnpm build
pnpm start
```

The server prints the addresses to open:

```
  dnd-table server listening on 0.0.0.0:3000 (data: …/dnd-table/data)
  Open on this computer:  http://localhost:3000
  Open on your network:   http://192.168.0.12:3000
```

Players on the same Wi-Fi open the network address on their phones. Create an account, start a
campaign (you become its GM) and share the invite code from the sidebar. The
[user guide](docs/user-guide.md#getting-started) covers the rest.

### Configuration

Set these as environment variables, e.g. `SIGNUP_CODE=dragons pnpm start`.

| Variable        | Default   | Meaning                                                                  |
| --------------- | --------- | ------------------------------------------------------------------------ |
| `PORT`          | `3000`    | HTTP port                                                                |
| `HOST`          | `0.0.0.0` | Interface to listen on (`127.0.0.1` keeps it off the network)            |
| `DATA_DIR`      | `data`    | Where the database and uploads live (relative to the repository)         |
| `SIGNUP_CODE`   | (none)    | If set, creating an account needs this code. Set it on any public server |
| `COOKIE_SECURE` | `false`   | Set to `true` when served over HTTPS                                     |
| `LOG_REQUESTS`  | `false`   | Log every HTTP request                                                   |

### Your data

Everything is in `data/`: one SQLite database (`dnd-table.db`) and uploaded images and audio
(`uploads/`). To back up, copy the folder while the server is stopped. To upgrade, pull the new
version, then run `pnpm install`, `pnpm build` and `pnpm start` again; the database is migrated
automatically on start.

### Hosting it online

For remote players, run it on a server behind an HTTPS reverse proxy that passes WebSockets through.
With [Caddy](https://caddyserver.com), which fetches certificates by itself:

```
table.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

```bash
HOST=127.0.0.1 COOKIE_SECURE=true SIGNUP_CODE=your-secret pnpm start
```

Uploads are limited to 30 MB per image and 50 MB per audio file, so allow request bodies that large
if your proxy limits them.

## Development

```bash
pnpm install
pnpm dev           # Vite on :5173 (open this) + API server on :3000, both reloading on change
pnpm test          # rules engine and server integration tests (vitest)
pnpm typecheck
pnpm screenshots   # regenerate docs/screenshots from a seeded demo campaign
pnpm site          # build the website (site/ and the docs) into _site/
```

`pnpm screenshots` builds the client, starts a throwaway server with a demo campaign and drives
headless Chromium through it. It needs Playwright's browser once:
`pnpm exec playwright install --only-shell chromium`.

```
apps/server        Fastify + WebSockets + SQLite (node:sqlite): accounts, campaigns, the live game
apps/web           React + Vite client: GM, player and table display views
packages/rules     The 2024 rules shared by client and server: dice, grid and fog, walls and movement,
                   vision, area templates, characters, combat, monsters, the knowledge base index
packages/protocol  REST bodies and WebSocket messages (zod schemas and types)
scripts            SRD import and screenshot tooling
```

The server is the source of truth. Clients send intents ("roll 2d20kh1+3, GM only", "move this token
here"); the server checks them, resolves them and sends each connection only what its role may see.
The database migrates itself on start-up (`PRAGMA user_version`).

## Rules content

All rules content (classes, subclasses, species, backgrounds, feats, equipment, 339 spells,
341 monsters, 262 magic items, conditions and more) comes from the System Reference Document 5.2,
via the 2024 dataset of [5e-database](https://github.com/5e-bits/5e-database). The rules glossary
(Advantage, Cover, Opportunity Attacks and 137 more) comes from the SRD 5.2.1, via
[dnd-5e-srd-markdown](https://github.com/downfallx/dnd-5e-srd-markdown), checked against the official
PDF. `scripts/import-srd.mjs` reads both at pinned commits (the glossary also by SHA-256) and writes
normalised JSON to `packages/rules/src/srd/data`, so the data is reproducible and reviewable:

```bash
pnpm import:srd    # same commit → byte-identical output
```

To update, change `COMMIT` in the script, re-run it and review the diff. The importer repairs encoding
glitches and hyphenation from the PDF, patches known gaps explicitly, and fails if the data stops
making sense.

The SRD includes one subclass per class and four backgrounds; other official options aren't part of
it.

> This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of the
> Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the Creative
> Commons Attribution 4.0 International License, available at
> https://creativecommons.org/licenses/by/4.0/legalcode.
>
> This work includes material from the System Reference Document 5.2.1 ("SRD 5.2.1") by Wizards of
> the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2.1 is licensed under the
> Creative Commons Attribution 4.0 International License, available at
> https://creativecommons.org/licenses/by/4.0/legalcode.

## Licence

The code is released under the [MIT Licence](LICENSE). The SRD content is under CC-BY-4.0 as noted
above.
