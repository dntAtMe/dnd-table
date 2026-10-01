# dnd-table

A shared virtual table for playing D&D 5e (2024 rules) with your group, in person or remote.
Every screen joins the same live session in its own role:

- **GM** (laptop/tablet): runs the game, sees hidden rolls and whispers, connects table screens.
- **Players** (phones/tablets): build and play their character sheet, see the map, move their own
  tokens, measure, ping, roll dice and chat.
- **Table display** (TV, projector, spare laptop): a shared view that needs no account. It pairs
  with a campaign using a code and shows the battle map plus public rolls big enough to read
  across the room. It can follow the GM's camera.

## Status

Phases 1–3 are done:

- [x] Accounts (username + password), campaigns, invite codes
- [x] Live sync over WebSockets, with presence (who's online)
- [x] Server-side dice: `1d20+5`, `2d20kh1` (advantage), `4d6dl1`, `d%`, with natural 20/1 detection
- [x] Public rolls, secret rolls (to the GM only), chat and whispers
- [x] Table display pairing with a spotlight for new rolls
- [x] Battle map: upload a map image or use a blank grid; the GM prepares scenes and shows one to players
- [x] Grid calibration (cells across, cell size, X/Y shift), 5e 2024 distances (every square is 5 ft)
- [x] Tokens: drag to move (players move their own), sizes Medium–Gargantuan, hidden tokens
- [x] Fog of war painted with a brush; hidden or fogged tokens never reach player devices
- [x] Measuring tool, pings, and table screens that follow the GM's camera
- [x] Map editor: walls, doors (open/closed/locked, secret), terrain (rock, difficult, water) and
      resizable blank grids; players can't walk through walls, and the ruler counts difficult terrain
- [x] Character creator (class → background → species → ability scores → choices → equipment)
- [x] Character sheet computed from the 2024 rules: tap any bonus to roll; conditions and exhaustion
      apply automatically; HP, death saves, spell slots, class resources, rests, inventory, SRD spells
- [x] Level-up: HP, subclass, ASI/feats, Epic Boons, Expertise, Weapon Masteries, Fighting Style
- [x] Characters place linked tokens on the map
- [x] Phase 4: combat: initiative tracker, HP and conditions synced with sheets, SRD monsters with
      stat blocks and tap-to-roll attacks, hidden creatures, HP bars and turn markers on the map,
      2024 encounter difficulty
- [x] Handouts (text and images) shared with everyone or chosen players, shown full-screen on the TV
- [x] Ambient audio: a GM soundboard with music, ambience layers and effects, synced to every screen
- [ ] Phase 5: scenes, AoE templates, lighting

## Running locally

You need Node.js 22.5+ (24 recommended) and pnpm. With Nix, `nix develop` provides both.

```bash
pnpm install
pnpm dev
```

- Open http://localhost:5173 and create an account. The first person to create a campaign is its GM.
- Players on the same Wi-Fi open the **network URL** the server prints (e.g. `http://192.168.0.12:5173`),
  create their own accounts, and join with the campaign's invite code.
- On the TV or shared screen, open `/table` and enter the code it shows under **Table displays** on the GM's screen.

In dev, Vite (port 5173) serves the client and proxies `/api`, `/ws` and `/files` to the API server (port 3000).

### Running a map

1. As GM, create a scene in the sidebar: upload a map image, or leave it empty for a blank grid.
2. Line the grid up under **Scene settings**: set *Cells across* to the number of squares printed
   across the map, then nudge *Shift X/Y* until the lines match.
3. Add tokens with **+ Token** (creatures, hidden creatures, or one per player). Select a token to
   rename it, resize it, hide it or give a player control of it.
4. Draw the map with the editor tools (GM only):
   - **Wall**: drag along grid lines; a click places one edge. **Erase** removes walls and doors.
   - **Door**: click an edge to add a door, click again to cycle open → closed → locked.
     Shift-click (or the *Secret door* toggle) makes it secret: players and the TV see a plain wall
     until it is opened.
   - **Terrain**: paint floor, solid rock (impassable), difficult terrain or water (both cost an extra
     5 ft per square). On a blank scene, *Fill with rock* under **Map editor** and carve rooms with floor.
   - **Map editor** in the sidebar adds or removes rows and columns on each side of a blank scene;
     tokens, fog, walls and terrain stay put.
   - With **Move**, click a door to open or close it. Players can open and close unlocked doors next
     to their token, and can't move their token through walls, closed doors or solid rock.
5. Turn on fog of war and paint with **Reveal**/**Hide** (right-drag or two fingers still pan).
6. Press **Show** to put the scene in front of players and table screens. **Table follows me** makes
   the TV show what you're looking at.

Map controls: drag to pan, scroll or pinch to zoom, double-click to ping. **Measure** shows the
movement cost through difficult terrain ("30 ft (40 ft move)") and turns red when a wall is in the way.

### Running combat

1. Open **Combat** (next to Map; on phones it shares the Sheet tab) and start, either with every
   token on the current map or empty. Add party members, map tokens or SRD monsters (searchable,
   filtered by CR); monsters can drop their own tokens on the map, optionally hidden.
2. **Roll for creatures** rolls initiative for monsters as GM-only rolls. Players roll from their
   sheet's Initiative button or the tracker, or type in a physical roll.
3. **Next turn** walks the order and announces each round. Players can end their own turn.
4. Expand a row (or select its token) to apply damage, healing and temporary HP, or toggle
   conditions. Characters' HP and conditions are their sheet's, so both stay in sync.
5. Players and table screens see the order and whose turn it is, but never hidden creatures, and
   only Healthy / Bloodied / Down for creatures that aren't theirs.

### Handouts

1. Open **Handouts** (next to Combat) and write one: a title, an optional image and plain text
   (a blank line starts a new paragraph). **Preview** shows it as players will see it.
2. Choose who gets it: **Draft** (only you), **Everyone**, or **Some players**. Players find shared
   handouts in their own Handouts view, newest first, with a dot until they've read them, and get a
   notice when a new one arrives. Changing a shared handout marks it unread again; switching back to
   Draft takes it away. Players never receive handouts that aren't shared with them.
3. **Show on table** puts a handout full-screen over the map on the table screens (tick *Also pop it
   up on players' screens* to show it to everyone). With no handout selected you can put any image
   up straight away. **Back to map** (in the Handouts view or on the map) takes it down.

### Ambient audio

1. In the GM sidebar, open **Soundboard** → **Add track** and upload MP3, OGG, WAV, M4A/AAC or FLAC
   (up to 50 MB). Pick a kind: **Music** (one at a time; starting another crossfades), **Ambience**
   (layers that play together, e.g. rain over tavern chatter) or **Effects** (one-shots).
2. Press play/pause/stop on any track and mix with each layer's slider and the master volume.
   Click a track's name to rename it, change its kind, loop and default volume, or delete it.
3. Table screens play the audio and show what's playing in their header (click it to mute that
   screen). Browsers only allow sound after an interaction, so the first time a TV needs a click or
   key press; for a kiosk, start Chrome with `--autoplay-policy=no-user-gesture-required`.
4. Players switch audio on for their device with the speaker button in the top bar (off by default
   on phones and tablets) and set their own volume. The GM can turn it on too, to hear the mix.

Playback state lives on the server: someone joining mid-song starts at the same point as everyone
else (to within a second or so).

### Single-port production mode

```bash
pnpm build
pnpm start          # serves the client and API on http://0.0.0.0:3000
```

| Variable        | Default | Meaning                                                           |
| --------------- | ------- | ----------------------------------------------------------------- |
| `PORT`          | `3000`  | HTTP port                                                         |
| `HOST`          | `0.0.0.0` | Interface to bind (`127.0.0.1` to hide it from the LAN)         |
| `DATA_DIR`      | `data`  | Where the SQLite database lives (relative to the repo root)       |
| `SIGNUP_CODE`   | —       | If set, creating an account requires this code. Use it on any internet-facing server |
| `COOKIE_SECURE` | `false` | Set `true` when served over HTTPS                                 |
| `LOG_REQUESTS`  | `false` | Log every HTTP request                                            |

All state is in `data/`: one SQLite file (`dnd-table.db`) plus uploaded images and audio in `uploads/`.
Back it up by copying that folder.

## Layout

```
apps/server       Fastify + WebSockets, SQLite (node:sqlite), authoritative game state
apps/web          React + Vite client: GM, player and table views
packages/rules    5e rules shared by client and server: dice, grid & fog, walls/doors/terrain and
                  movement, SRD data, character model and derived stats, creator and level-up logic
packages/protocol REST and WebSocket message types
```

The server is the source of truth. Clients send intents (e.g. "roll 2d20kh1+3, GM only"),
the server resolves them and sends each connection only what its role may see. Hidden rolls,
hidden or fogged tokens, secret doors and walls or terrain under fog never reach player devices or
table screens.

```bash
pnpm test        # vitest: dice engine + server integration tests
pnpm typecheck
```

## Content (SRD 5.2)

All rules content (classes, subclasses, species, backgrounds, feats, equipment, 339 spells, 341 monsters) comes
from the D&D System Reference Document 5.2, via the [5e-database](https://github.com/5e-bits/5e-database)
project's 2024 dataset. `scripts/import-srd.mjs` fetches it at a **pinned commit** and writes
normalised JSON to `packages/rules/src/srd/data`, so the data is reproducible and reviewable:

```bash
pnpm import:srd                 # same commit → byte-identical output
```

To update, bump `COMMIT` in the script, re-run, and review the diff. The importer repairs encoding
glitches and PDF line-break hyphenation, patches known source gaps explicitly, and fails if the
data stops making sense (missing features, levels, weapons…).

> This work includes material from the System Reference Document 5.2 ("SRD 5.2") by Wizards of
> the Coast LLC, available at https://www.dndbeyond.com/srd. The SRD 5.2 is licensed under the
> Creative Commons Attribution 4.0 International License, available at
> https://creativecommons.org/licenses/by/4.0/legalcode.

The SRD has one subclass per class and four backgrounds; a homebrew editor for content your group
owns is planned.
