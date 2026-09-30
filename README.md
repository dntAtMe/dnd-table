# dnd-table

A shared virtual table for playing D&D 5e (2024 rules) with your group, in person or remote.
Every screen joins the same live session in its own role:

- **GM** (laptop/tablet): runs the game, sees hidden rolls and whispers, connects table screens.
- **Players** (phones/tablets): roll dice and chat. Character sheets are coming next.
- **Table display** (TV, projector, spare laptop): a shared view that needs no account. It pairs
  with a campaign using a code and shows public rolls big enough to read across the room.
  The battle map will live here too.

## Status

Phase 1 of the plan is done:

- [x] Accounts (username + password), campaigns, invite codes
- [x] Live sync over WebSockets, with presence (who's online)
- [x] Server-side dice: `1d20+5`, `2d20kh1` (advantage), `4d6dl1`, `d%`, with natural 20/1 detection
- [x] Public rolls, secret rolls (to the GM only), chat and whispers
- [x] Table display pairing with a spotlight for new rolls
- [ ] Phase 2: battle map (grid, tokens, fog of war, GM camera)
- [ ] Phase 3: character sheets (2024 rules) with tap-to-roll, a character creator and level-up
- [ ] Phase 4: combat (initiative, HP and conditions, monsters, encounter builder)
- [ ] Phase 5: handouts, scenes, AoE templates, lighting, audio

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

In dev, Vite (port 5173) serves the client and proxies `/api` and `/ws` to the API server (port 3000).

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

All state is in one SQLite file (`data/dnd-table.db`). Back it up by copying that file.

## Layout

```
apps/server       Fastify + WebSockets, SQLite (node:sqlite), authoritative game state
apps/web          React + Vite client: GM, player and table views
packages/rules    5e rules engine shared by client and server (dice so far)
packages/protocol REST and WebSocket message types
```

The server is the source of truth. Clients send intents (e.g. "roll 2d20kh1+3, GM only"),
the server resolves them and sends each connection only what its role may see. Hidden rolls
never reach player devices or table screens.

```bash
pnpm test        # vitest: dice engine + server integration tests
pnpm typecheck
```

## Content

Game content will come from the D&D System Reference Document 5.2 (CC-BY-4.0), plus a
homebrew editor for anything your group owns outside the SRD.
