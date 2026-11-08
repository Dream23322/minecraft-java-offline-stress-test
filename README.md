# bot farm

Real Minecraft clients for stress testing. Mineflayer bots that walk, look, jump,
swing, switch hotbar slots and occasionally talk. A tkinter panel drives them.

## Setup

```
npm i
python gui.py
```

Needs Node 18+ and Python 3.9+ with tkinter (bundled with the Windows installer).

## Use

Behaviour, packet toggles, chat speed and movement sliders update live — change
them while bots are connected and the next brain tick applies them. Count, host,
version, view distance and name settings apply on the next Start.

Profiles (idle lobby / casual / chaos + your own) live in `profiles.json`.
Bots can follow each other / real players, randomize their client identity
(locale, skin parts, hand, chat color), and accept or decline resource packs.
Set a name in *follow player* (e.g. a real player) to herd **all** bots to
them instantly — while set, every bot stays on them (follow chance is
bypassed); clear it to return to random follow. Movement uses vanilla mob
pathfinding (`WalkNodeEvaluator`-style): A\* with soft costs — water is
expensive (+8 per node, so bots detour but will wade), lava is avoided,
climbs and drops are limited. The minimap shows the planned route as a
solid violet line, the actual trail as dotted, and destinations as dashed.
Tick *pathfinding (A\*)* off for old straight-line steering.
Double-click a row or map dot for a live per-bot detail window. The Say box has
two selectors: *target bot* (which farm bot sends) and *server player*
(optional addressee — chat is prefixed with their name; `/commands` as-is,
e.g. `/tell Steve hi`).

1. Put the proxy address in **host** and **port**.
2. Set **count** and a **name prefix**. Names must be unique.
3. **stagger ms** is the gap between joins. 500ms = 20 bots per 10s. Lower it to
   hammer the join path, raise it if the host rate-limits you.
   Alternatively, enable **wait for previous bot to spawn** and set **after
   spawn (s)** to wait that many seconds after each bot spawns before starting
   the next one. In this mode, **stagger ms** is ignored.
4. **view dist** is what the bot tells the server it can see. `far` = 12 chunks,
   which is the vanilla client default. This is what drives chunk sending load.
5. Hit **Start**.

Chat is per bot: every *chat every (s)* seconds it rolls `randint < chance` and
posts one line from the message box. Default is 200s at 0.5, so roughly one
message per bot every 400s.

## Before you run it

- The proxy needs `online-mode = false` in `velocity.toml`, otherwise every bot
  fails auth. Flip it back when you're done, and firewall the port to your own IP
  for the duration. Offline mode lets anyone join as any name, staff included.
- Run the bots on a machine with real cores. Each bot parses every chunk it
  receives. A laptop will fall over before your server does.
- Bots now walk, look, jump, sprint and sneak with vanilla-like packet timing
  (tick_end + player_input + correct sprint/sneak actions), so Grim flags are
  drastically reduced. Occasional prediction flags may still appear on complex
  terrain, but constant setbacks should be gone.
- Names can be realistic (toggle in the GUI) and the Say box accepts commands
  (text starting with /) with per-bot targeting.
- Bots are clients, not players. They generate join storms, chunk sends,
  movement packets and chat. They don't fight, build, or use items.

## Files

- `engine.mjs` — bot farm, exposes a JSON API on `127.0.0.1:8765`
- `gui.py` — control panel, starts and stops the engine for you
- `engine.log` — engine stdout/stderr, written by the GUI

The GUI talks to the engine over HTTP, so you can also drive it from curl:

```
curl -s 127.0.0.1:8765/status
curl -s -X POST 127.0.0.1:8765/start -H 'content-type: application/json' \
  -d '{"host":"1.2.3.4","port":25565,"count":40,"version":"1.21.11","waitForPreviousSpawn":true,"spawnWaitSeconds":5}'
curl -s -X POST 127.0.0.1:8765/stop
```
