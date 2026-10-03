# Över Göteborg

**Gothenburg's inner city in your browser: walk its streets and ride its trams, on the real timetable.**

Under construction. Över Göteborg is a fork of Joel Hägvall's [Under Stockholm](https://github.com/joelhagvall/under-stockholm), the whole Stockholm metro in the browser, and takes its method up to the street: game time is Unix time, so every visitor sees the same trams, live data reaches the game only through a relay of its own, and a quality gate that the coding agent cannot get past keeps the build fast and whole. The plan, its phases and what is done is in [PLAN.md](docs/PLAN.md). Until the city is in, the game is still Joel's Stockholm metro, with Gothenburg's weather, warnings and news.

TypeScript, three.js and Rapier, no game engine. Made by [Fredrik Carlsson](https://www.linkedin.com/in/fredrik-carlsson-0b829a40), on the shoulders of Under Stockholm by [Joel Hägvall](https://joelhagvall.com/) ([Hägvall Labs](https://hagvall-labs.com/)).

## Play

```bash
bun install
bun run dev
```

Open http://localhost:5180. Keys are in [GAMEPLAY.md](docs/GAMEPLAY.md), hosting in [DRIFT.md](docs/DRIFT.md).

## Development

| Script | What it does |
| --- | --- |
| `bun run dev` | Dev server with hot reload, plus the relay; both pick free ports |
| `bun run build` | Type-check and build to `dist/` |
| `bun run typecheck` | Type-check only |
| `bun run serve:prod` | Serve `dist/` with gzip on port 4173 (use this for audits) |
| `bun run ghosts` | Ghost relay and shared notes on their own, on a free port (or `PORT`) |
| `bun test` | Unit tests (Silverpilen, the power cut, the relay, i18n, the line map and more) |
| `bun run check` | The quality gate: types, tests, build budgets, leaks, frame rates, time to playing, Lighthouse and pa11y, against floors and the committed baseline, in levels (`--quick`, `--smoke`, `--perf`, `--web`, plus `--device` and `--accept`). `git push` runs the quick and smoke levels |
| `bun run release` | All of the gate, on its own |
| `bun run deploy` | The only way to go live, to understockholm.com: a clean, pushed tree, the whole gate, then the production build and the upload (`--dry-run` stops before it). `--landing` puts out the landing page alone, without the game |
| `bun run nightly` | All of the gate on what was pushed, in a worktree of its own; `--install` would run it every night on this Mac (off for now), `--trend` shows past nights |
| `bun run mem` | Leak check in headless Chrome: travel the network, a life and the cab, fail if anything is left behind (needs `bun run dev`) |
| `bun run fps` | Real frame rates in headless Chrome on this machine's GPU, as a desktop and as a phone; `--device` adds an Android phone over USB (needs `bun run dev`) |
| `bun run load` | Time from click to playing, desktop and slow 4G phone (needs `bun run serve:prod`) |

The build fails if the landing page or the game grows past its compressed budget, and `bun run check` fails if it got slower than the numbers in `perf/baseline.json`. After launch, the relay's `/perf` page shows how the game runs for players: one anonymous report per visit (frame times, resolution, loading, class of device; no identifiers), and `/errors` what went wrong in their games.

`?debug` never pauses and exposes `window.__us`. `?natet` opens the network view, `?liv` a life on the blue line and `?debug&stromavbrott` a power cut a few seconds in. URL params for time, weather and Silverpilen, plus the relay and how to add a station, are in [FEATURES.md](docs/FEATURES.md#debug-and-the-relay).

## Data and credits

Live data reaches the game only through the relay (a Cloudflare Worker in production, [DRIFT.md](docs/DRIFT.md)), which asks each source once per interval for every player. Browsers never call them.

| Source | Used for | Licence |
| --- | --- | --- |
| [SL](https://www.trafiklab.se/api/our-apis/sl/) via Trafiklab: Transport and Deviations | Live departures, disruptions, broken escalators | SL's open data terms |
| [Trafiklab GTFS Regional](https://www.trafiklab.se/api/gtfs-datasets/gtfs-regional/), Samtrafiken | Live trains on all three lines | CC0 1.0 |
| [Open-Meteo](https://open-meteo.com/) | The weather at the exits | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| [SMHI](https://www.smhi.se/) | Weather warnings for Västra Götaland County | SMHI's open data terms, source named in the game |
| [Sveriges Radio](https://www.sverigesradio.se/), P4 Göteborg | Headlines in the game's newspapers | [SR's API terms](https://www.sverigesradio.se/artikel/api-villkor) |
| [OpenStreetMap](https://www.openstreetmap.org/copyright), © OpenStreetMap contributors | Buildings round the open-air stations, streets out of the exits, the city in the network view | [ODbL](https://opendatacommons.org/licenses/odbl/) |
| [Copernicus DEM GLO-30](https://registry.opendata.aws/copernicus-dem/) | The ground's heights in the network view | © DLR e.V. 2010-2014 and © Airbus Defence and Space GmbH 2014-2018, provided under COPERNICUS by the European Union and ESA, all rights reserved |
| Albert Guillaumes' [station plans](http://stations.albertguillaumes.cat/) | Where each station's halls, inclined lifts and long passages lie | Reference only, no drawings in the repository |
| Wikimedia Commons and Freesound | A sneeze, a sigh and bottles clinking | Public domain and CC0 ([sources](public/audio/sfx/README.md)) |

The map data lives in `src/game/world/osm/`, `src/network/city/` and `src/network/terrain.json`, fetched by `scripts/osm.ts`, `scripts/osm-streets.ts`, `scripts/osm-city.ts` and `scripts/terrain.ts`. Built with [three.js](https://threejs.org) (MIT) and [Rapier](https://rapier.rs) (Apache 2.0).

## Disclaimer

A fan project. Not affiliated with or endorsed by Västtrafik, Göteborgs Spårvägar, SL, Region Stockholm, Sveriges Radio or SMHI, nor by Joel Hägvall.

## License

The code is MIT ([LICENSE](LICENSE)), Under Stockholm's by Joel Hägvall and the changes by Fredrik Carlsson. It covers the projects' own work, not Västtrafik's, SL's or Region Stockholm's names and marks, nor the data above, which keeps its own licence. The recorded C20 announcements are not part of the repository ([why](public/audio/README.md)).
