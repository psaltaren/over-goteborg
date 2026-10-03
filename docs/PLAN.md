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
2. **No collisions, solved offline.** The GTFS script cuts the track graph into blocks: platform berths, the crossings and switches (Brunnsparken, Drottningtorget, Kungsportsplatsen) and plain track of about 60 m. A tram that finds a block taken waits longer at its previous stop. The result is baked into `schedule.json`.
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
| P1 Data | `scripts/gbg-osm.ts` (tiles and `tracks.json`), `scripts/gbg-gtfs.ts` (`schedule.json` with the block pass), a file of hand fixes to the track graph | `tracks.test.ts` (paths connected, stops within 3 m, radius at least 18 m) and `schedule.test.ts` (no block shared, every second of a day) green |
| P2 Walk | `city/boot.ts`, `city/world.ts`, `city/geo.ts`; Brunnsparken as a scene in `scripts/fps.ts`; `main.ts` loads the city; first removal of Stockholm code | Walk from Centralen to Järntorget on a phone, `--smoke` green, a new baseline accepted |
| P3 Trams | `city/tripTable.ts`, `city/path.ts`, `city/tram.ts`, `city/tramModel.ts` (one merged body per module, instanced doors, one sign atlas); rails in the tiles | No overlaps at rush hour, the purity test passes |
| P4 Ride | Board, ride and alight round curves; "Nästa hållplats" in the browser's voice; departure signs; the tram bell, gulls, rain, Kopparmärra, Domkyrkan's bells; landing page and README | Ride a line through the area; `release` green. **First public version** |
| P5 Live | `server/vasttrafik.ts` (OAuth token kept in the hub, the key a secret), a `vt` feed in `feedCore.ts`, `city/realTrams.ts`, Västtrafik's traffic disruptions as announcements and signs, a limit check in `worker-check.ts` | Live delays show, stale data falls back |
| P6 Västlänken | `city/underground.ts`: Centralen and the closed Haga station, with `stationSteps`/`tubeSteps`, reached by a shaft door | `bun run mem` clean |
| P7 Clean up | The last Stockholm-only code and its tests go | `release` green |

Later: a tram driver's mode.

## Risks

1. **Scope.** P4 is the first public version; P5 and P6 follow.
2. **The track graph in OSM** (double track as separate ways, switches, loops): routed offline, hand fixes in a file, tests that stop errors.
3. **Draw calls from trams on phones:** a merged model, interiors only within about 30 m, a new baseline each phase.
4. **Riding round curves** (Rapier against rotating colliders): while riding, the player lives in the tram's own frame and does not collide with it.
5. **Västtrafik's limits:** only the relay calls, only while someone plays, a few stop areas every 30 s, the timetable otherwise.
