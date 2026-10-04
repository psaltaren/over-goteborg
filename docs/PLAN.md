# The plan

Över Göteborg takes Under Stockholm's method up to the street: Gothenburg's inner city, from Centralstationen and Brunnsparken by Drottningtorget, Kungsportsplatsen, Domkyrkan and Grönsakstorget to Järntorget (about 1.5 by 1 km), with every tram line that passes through it on the real timetable. Under it lies one hidden place: Västlänken's station Centralen (opening December 2026) and the tunnel toward Haga, whose station stays closed until about 2030.

## Data

| Source | Used for | Licence |
| --- | --- | --- |
| Trafiklab GTFS Regional, Västtrafik (`vt`), static | The timetable: routes, trips, stop times, shapes | CC0 1.0 |
| Västtrafik's Planera Resa v4 | Live departures (`estimatedTime`, `isCancelled`), positions in an area | CC0 1.0. The key stays in the relay, calls are kept to what is needed, no Västtrafik marks |
| OpenStreetMap | Tram rails (`railway=tram`), buildings, streets | ODbL |
| Open-Meteo, SMHI, Sveriges Radio P4 Göteborg | Weather, warnings for Västra Götalands län, headlines | As in the README |

GTFS Regional carries no realtime for Västtrafik (September 2026), so live data comes from Västtrafik's own API, through the relay alone.

## Architecture

1. **A timetable of real trips.** Joel's `Timetable` is one closed loop that every train runs offset in time, so it cannot hold GTFS trips. A new `TripTable` places a tram from the clock and the static schedule (per hop, a trapezoid fitted to the scheduled time with `hopAt` from `src/game/timetable.ts`). It stays a pure function of time.
2. **No collisions, solved offline.** The track graph is cut into blocks of at most 10 m, one tram per block, with a list of the pairs of blocks that conflict (two tracks closer than a car's width: a switch, a crossing), built by `scripts/gbg-osm.ts` into `tracks.json`. Pairs rather than one block per junction: a block per junction joined Drottningtorget into one 570 m block, one tram at a time through the busiest place in the city. The GTFS script then runs the day: a tram that finds a block taken, or a conflicting one, waits longer at its previous stop. The result is baked into `schedule.json`.
3. **Live data only as longer dwells.** A delay lengthens a stop, never a hop, as in `realService.ts`. Trips are matched through `/departures` (line, stop and planned time). Stale data falls back to the timetable.
4. **One projected frame** for the whole area (`src/game/city/geo.ts`), turned so Västlänken's tunnel runs along +x, so Joel's station and tunnel builders work unchanged. Street level lies above the underground's rail top at y = 0.
5. **The city in 250 m tiles,** each built by `streetOsmSteps` (`src/game/world/streetOsm.ts`), near ones built and far ones taken down by a 2D `CityWorld` after `World.later`.
6. **Trams that turn.** Paths are 2D polylines with a heading, each module of a tram has its own pose, and the player is carried round curves (`Player.carry` with a rotation). A new `Tram` replaces the C20.
7. **Edges out of sight.** Paths run about 200 m past the playable area, beyond the fog, so trams come and go unseen, as Under Stockholm's turnbacks hide its trains.
8. **Kept as it is:** the relay and the hub, the quality gate and its hooks, physics, the player, the HUD, sound, telemetry, crash reports, adaptive resolution, other players, Swedish and English, touch and gamepad, the tour and the capture scripts.

## Phases

Each phase has its own branch and is merged into `main` when its gate is green.

| Phase | What | Done when |
| --- | --- | --- |
| P0 Fork | Renamed, hosting on Cloudflare's free plan, weather, warnings and news from Gothenburg, the secrets guard | `check --quick` green |
| P1 Data | `scripts/gbg-osm.ts` (tiles and `tracks.json`: the track graph eased to 18 m, switch toes moved, double track spaced, blocks and conflicts), `scripts/gbg-gtfs.ts` (`schedule.json`: each route's shape matched to the tracks as runs through the area, a weekday, a Saturday and a Sunday of trips, the block pass), hand fixes in `scripts/gbg-track-fixes.ts` | `tracks.test.ts` (paths connected, radius at least 18 m, double track a car's width apart) and `schedule.test.ts` (runs connected, stops in order and beside the track: most within 3 m, Västtrafik's platform points up to 8 m off; no block shared, every second of each day) green |
| P2 Walk | `city/boot.ts`, `city/world.ts` (2D lazy builds of the squares), `city/tiles.ts`, `city/geo.ts` (`STREET_Y`, `PLACES`); the city's squares and a run through it as scenes in `scripts/fps.ts`, a walk across it in `scripts/mem.ts`; `main.ts` loads the city; first removal of Stockholm code: out of the build and the gate (the files go in P7). Left for P4: the help line and pause menu still name metro keys, small buildings get windows as big ones do | Walk from Centralen to Järntorget on a phone, `--smoke` green, a new baseline accepted |
| P3 Trams | `city/serviceDay.ts` (the timetable a date runs, holidays and all), `city/tripTable.ts`, `city/path.ts`, `city/tramModel.ts` (the M34, the 45 m Flexity, in four sections), `city/trams.ts` (every tram in nine draw calls: one instanced mesh per part, one sign atlas; the bell and stepping aside, `city/aside.ts`), `city/rails.ts` (rails in setts, the contact wire and its poles, in the squares); the game's packed timetable in `osm/trams/`, fetched when it starts (about 30 kB); no tram starts or ends in the area (a trip that ends there goes on as the next, or out of service to the edge). Not done: pulling up behind another tram at a long platform (the data has no platform lengths; the holds are reworked with live delays in P5) | No overlaps at rush hour, the purity test passes |
| P4 Ride | Board, ride and alight round curves (the tram's boxes with its doorways, carried and turned in its section's frame, off at the inner city's edge); the next stop called in the browser's voice and on the display over the aisle; platforms with shelters, names and departure displays from the timetable (`city/stops.ts`); the bell at someone near the track, rain, gulls, Domkyrkan's bell (`city/citySounds.ts`), Kopparmärra (`city/landmarks.ts`); the help and pause menu with the city's keys; landing page (live departures from Drottningtorget, `src/landing/departures.ts`), preview cards, icon, README. Not done: sitting down; other players (the relay still takes metro poses only); a feedback address of the city's own (GitHub issues are off) | Ride a line through the area; `release` green. **First public version** |
| P5 Live | `server/vasttrafik.ts` (the token kept a day, in the hub's storage; the key a secret; at most 12 calls a minute, the busiest stop area split by platform so a list holds the 40 minutes asked for), the `vt` and `situations` feeds in `feedCore.ts`, `city/liveTrams.ts`, `city/liveMatch.ts` (departures to trips by platform, planned second, line and way: `<day>.holds.json` says where the block pass held each trip, fetched only with live data), `city/livePlan.ts` (the next half hour planned with the delays, cleared by the timetable's own block pass, now `city/blocks.ts`, fixed once a tram sets out out of sight), Västtrafik's traffic situations on the stops' displays and in the calls, how late the tram ridden is, a pause menu switch; a stand-in for Västtrafik (`scripts/vt-standin.ts`) and a limit check against it in `worker-check.ts`. Not done: the landing page's board keeps to the timetable; checked against the stand-in, the real key still to come | Live delays show, stale data falls back |
| P6 Västlänken | `city/underground.ts`: station Centralen before its opening, the throat, the tunnel along OSM's line (`city/sweep.ts`) with rails as far as the first stage, and Haga's rock hall being dug; reached by the construction hoist at the works by Rosenlund, left by the emergency exit on Nils Ericsonsgatan; `CityWorld` builds and shows one level at a time. Joel's `stationSteps` turned out to bring the metro's data and SL's look with it, and his tubes run only straight: built on the generic `Section` and builders instead. Not done: trains (Centralen opens 13 December 2026 as a terminus, Västtågen to Alingsås and Älvängen); Centralen's halls and exits; the snake at Haga (about 2030) | `bun run mem` clean |
| P7 Clean up | The last Stockholm-only code and its tests go | `release` green |

Later: a tram driver's mode.

## Risks

1. **Scope.** P4 is the first public version; P5 and P6 follow.
2. **The track graph in OSM** (double track as separate ways, switches, loops): routed offline, hand fixes in a file, tests that stop errors.
3. **Draw calls from trams on phones:** a merged model, interiors only within about 30 m, a new baseline each phase.
4. **Riding round curves** (Rapier against rotating colliders): while riding, the player lives in the tram's own frame and does not collide with it.
5. **Västtrafik's limits:** only the relay calls, only while someone plays, at most 12 calls a minute (each stop area about once a minute, the situations every five), the timetable otherwise. Västtrafik names no number; watch the portal's statistics once the key is in.
