// Över Göteborg's game: the inner city at street level, built round the player square by square (`CityWorld`), in
// daylight or at night, rain or shine, on the shared clock. What it does is Joel's game's start (`game/boot.ts`) less
// the metro: the loading card, the renderer, physics and the player, the pause menu, settings, touch and gamepad, the
// adaptive resolution, the sky and the weather (everything here is open air), the crash card and the telemetry, and
// `window.__us` under `?debug` for the measuring scripts. The trams come in P3.

import '../gfx/roundRect';
import { usesTouchControls } from '../../device';
import { chosenLang, saveLang } from '../../lang';
import { comeBack, savedPlace, savePlace } from '../../place';
import { Color, Fog, HemisphereLight, PerspectiveCamera, Scene, Vector3, WebGLRenderer, WebGLRenderTarget, type Object3D } from 'three';
import { Audio } from '../audio';
import { formatClock, stockholm, stockholmEpoch } from '../clock';
import { crashFacts, reportError, watchErrors } from '../crash';
import { Footsteps } from '../footsteps';
import { nextFrame } from '../frames';
import { Gamepads } from '../gamepad';
import { Hud } from '../hud';
import sv from '../i18n/sv.json';
import { lang, setLang, text } from '../i18n/text';
import { loadRapier, Physics, type Rapier } from '../physics';
import { Player } from '../player';
import { relayUrl } from '../relay';
import { AdaptiveResolution, RENDER_SCALES } from '../resolution';
import { settings } from '../settings';
import { SettingsPanel } from '../settingsPanel';
import { placeListener } from '../sfx';
import { gpuName, Telemetry } from '../telemetry';
import { TouchControls } from '../touchControls';
import { Warnings } from '../warnings';
import { daylight, OpenAirWeather, Weather } from '../weather';
import { setDaylight } from '../world/section';
import { Sky } from '../world/sky';
import { TRAM_FLOOR, TRAM_WIDTH } from '../layout';
import { stepAside } from './aside';
import { grow, PLACES, placeNear, PLAY, STREET_Y, yawToward, type Pt } from './geo';
import { loadTramData } from './tramData';
import { CitySounds } from './citySounds';
import { Landmarks } from './landmarks';
import { Stops } from './stops';
import { Trams, type Aboard } from './trams';
import { BUILD_REACH, CityWorld } from './world';

/** Seconds the build screen stays up at least, so its text can be read. */
const LOADING_MIN = 4.5;
/** Larger clock differences jump instead of slewing. */
const CLOCK_JUMP = 20;
/** Below this the player has fallen out of the world. */
const FALL_Y = STREET_Y - 10;
/** The most frames drawn a second, and in battery saver. */
const FPS_MOST = 60;
const FPS_BATTERY = 30;
/** How early a screen's tick may come and still count as a whole frame. */
const FRAME_SLACK_MS = 2.5;
/** How long a lost WebGL context is waited for before the page comes back without it, in ms. */
const CONTEXT_WAIT = 4000;
/** The open air's fog: from near to far, and the camera's reach just past it (as the metro's game out in the open). */
const FOG = { near: 80, far: 410 };
/** Where the game starts: on Drottningtorget, before Centralstationen, looking down toward Brunnsparken. */
const START: { at: Pt; toward: Pt } = { at: PLACES.Drottningtorget, toward: PLACES.Brunnsparken };

/** What the landing page passes (`main.ts`). */
export interface GameOptions {
  /** Physics can download while the game module itself is still loading. */
  physicsReady?: Promise<Rapier>;
  /** Start where the player last stood, if that was in the city. */
  resume?: boolean;
  /** When the player clicked to start, `performance.now()`, so the time to playing counts the download too. */
  since?: number;
}

/** The time a debug run is set to: `clock=HH:MM` (today, Stockholm time) or `clock=YYYY-MM-DDTHH:MM`, else now. */
function startClock(params: URLSearchParams, debug: boolean, now = Date.now() / 1000): number {
  const clock = debug ? params.get('clock') : null;
  const m = clock?.match(/^(?:(\d{4})-(\d{2})-(\d{2})T)?(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return now;
  const today = stockholm(now);
  const [y, mo, d] = m[1] ? [Number(m[1]), Number(m[2]), Number(m[3])] : [today.year, today.month, today.day];
  return stockholmEpoch(y, mo, d, Number(m[4]), Number(m[5]), Number(m[6] ?? 0));
}

export async function startGame(root: HTMLElement, options: GameOptions = {}): Promise<void> {
  const touchMode = usesTouchControls();
  // Menus, help and settings in the player's language; the world stays Swedish.
  setLang(chosenLang());
  root.classList.toggle('is-touch', touchMode);
  const params = new URLSearchParams(location.search);
  const debug = params.has('debug');
  watchErrors();

  // The loading card, with a bar that never runs ahead of the clock, so its text can be read.
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.setAttribute('role', 'progressbar');
  loading.setAttribute('aria-valuemin', '0');
  loading.setAttribute('aria-valuemax', '100');
  loading.setAttribute('aria-label', text.loading.title);
  loading.innerHTML = `<div class="loading-card"><p class="loading-title">${text.loading.title}</p><div class="loading-bar"><div class="loading-fill"></div></div><p class="loading-note">${text.loading.note}</p></div>`;
  root.appendChild(loading);
  const loadingFill = loading.querySelector<HTMLElement>('.loading-fill')!;
  const loadStart = performance.now();
  const loadMin = debug ? 0 : LOADING_MIN * 1000;
  let built = 0;
  const showProgress = () => {
    const shown = loadMin ? Math.min(built, (performance.now() - loadStart) / loadMin) : built;
    const pct = Math.round(Math.min(1, Math.max(0, shown)) * 100);
    loadingFill.style.transform = `scaleX(${pct / 100})`;
    loading.setAttribute('aria-valuenow', String(pct));
  };
  const setProgress = async (fraction: number) => {
    built = fraction;
    showProgress();
    await nextFrame();
  };
  await setProgress(0);
  // The physics binary is most of the download: the city's ground is laid while it still comes in, queued until it is up.
  const physics = new Physics();
  const physicsUp = (options.physicsReady ?? loadRapier()).then((R) => physics.attach(R));
  void physicsUp.catch(() => {});

  // Battery saver asks for the power-saving GPU: on a laptop with two, the other one is what starts the fans.
  const renderer = new WebGLRenderer({ antialias: true, powerPreference: settings.value.battery ? 'low-power' : 'high-performance' });
  renderer.domElement.className = 'game-canvas';
  renderer.domElement.setAttribute('aria-label', 'Över Göteborg game view');
  root.appendChild(renderer.domElement);
  const scene = new Scene();
  scene.background = new Color(0x9fb0c0);
  scene.fog = new Fog(0x9fb0c0, FOG.near, FOG.far);
  const hemisphere = new HemisphereLight(0xe9efff, 0x3b342c, 2.4);
  scene.add(hemisphere);

  let time = startClock(params, debug);
  const followClock = !debug || !params.has('clock');
  /** How lit the city's windows are: none by day, all at night (as the metro's streets have them, `weather.ts`). */
  const windowLight = () => Math.min(1, (1 - daylight(time)) * 1.4);
  const world = new CityWorld(physics, windowLight);
  scene.add(world.group);
  // The trams' tracks and timetable, fetched alongside the rest; offline, the city opens without them.
  // The squares lay the tracks in their streets, and wait for them (not for the timetable).
  const tramsUp = loadTramData(time, (links) => world.tiles.setTracks(links)).catch((err) => {
    console.warn('No trams:', err);
    return null;
  });
  const sky = new Sky();
  scene.add(sky.mesh);
  await setProgress(0.1);

  // Lazily built squares are drawn once into a 1x1 target before their first real frame, so their buffers are on the GPU.
  const warmTarget = new WebGLRenderTarget(1, 1);
  const warmCamera = new PerspectiveCamera(60, 1, 0.1, 10);
  const warmScene = new Scene();
  warmScene.fog = scene.fog;
  warmScene.add(new HemisphereLight(0xe9efff, 0x3b342c, 2.4));
  world.warm = (object: Object3D) => {
    const parent = object.parent;
    const index = parent?.children.indexOf(object) ?? -1;
    const target = renderer.getRenderTarget();
    const restore: Array<[Object3D, boolean, boolean]> = [];
    object.traverse((o) => {
      restore.push([o, o.visible, o.frustumCulled]);
      o.visible = true;
      o.frustumCulled = false;
    });
    warmScene.add(object);
    try {
      renderer.setRenderTarget(warmTarget);
      renderer.render(warmScene, warmCamera);
    } finally {
      warmScene.remove(object);
      // three.js keeps the last frame's render list, which would hold the object after it is taken down: an empty
      // frame lets go of it.
      renderer.render(warmScene, warmCamera);
      renderer.setRenderTarget(target);
      if (parent) {
        parent.add(object);
        parent.children.splice(parent.children.indexOf(object), 1);
        parent.children.splice(index, 0, object);
      }
      for (const [o, visible, culled] of restore) {
        o.visible = visible;
        o.frustumCulled = culled;
      }
    }
  };

  // The player needs Rapier itself.
  await physicsUp;
  await setProgress(0.2);
  const hud = new Hud(root, null, touchMode);
  // What the pause menu and the HUD have for the metro has no use in the city yet: its modes (driving, the tour, a
  // life, the network, the screensaver), its discovery book, other players and people's voices.
  for (const b of [hud.realButton, hud.bookButton, hud.ghostButton, hud.voiceButton, ...hud.crowdButtons]) b.hidden = true;
  for (const el of root.querySelectorAll<HTMLElement>('.hud-map, .pause-modes')) el.hidden = true;
  hud.setLine('Göteborg');
  root.querySelector('.hud')?.classList.add('is-city');
  // The help with the city's keys, and on a phone without seats to sit on.
  root.querySelector('.pause-touch-help')?.setAttribute('data-t', 'touch.helpCity');
  hud.city = true;
  hud.relabel();
  // The metro's feedback address and its maker's tip jar are Joel's: none here until the city has its own.
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a.pause-support')) a.hidden = true;
  const audio = new Audio();
  const footsteps = new Footsteps();
  // The sway of a tram ridden, unless the system or the player asks for less motion (as on the metro).
  let motion = !window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  try { const saved = localStorage.getItem('under-stockholm:motion'); if (saved !== null) motion = saved === 'on'; } catch { /* Keep system preference. */ }
  hud.setMotion(motion);
  const toggleMotion = () => {
    motion = !motion;
    hud.setMotion(motion);
    hud.say(motion ? text.motionOn : text.motionOff, 2);
    try { localStorage.setItem('under-stockholm:motion', motion ? 'on' : 'off'); } catch { /* Session preference still works. */ }
  };
  hud.motionButtons.forEach((button) => button.addEventListener('click', (event) => { event.stopPropagation(); toggleMotion(); }));
  const tramData = await tramsUp;
  const trams = tramData ? new Trams(physics, tramData.table, tramData.runs, tramData.links) : null;
  if (trams) scene.add(trams.group);
  // The stops: platforms, shelters, names, and the next trams on their displays.
  const stops = tramData ? new Stops(physics, tramData.table, tramData.runs, tramData.links) : null;
  if (stops) scene.add(stops.group);
  // Kopparmärra, and the city's sounds: rain, gulls, Domkyrkan's bell.
  scene.add(new Landmarks(physics).group);
  const sounds = new CitySounds();
  let listening = debug;

  // Where the player starts: where they last stood, if that was in the city, else on Drottningtorget.
  const startFeet = new Vector3(START.at[0], STREET_Y + 0.05, START.at[1]);
  const player = new Player(physics, startFeet, yawToward(START.at, START.toward));
  const inCity = (x: number, z: number) => x > PLAY.x0 && x < PLAY.x1 && z > PLAY.z0 && z < PLAY.z1;
  const place = options.resume ? savedPlace() : null;
  if (place && inCity(place.x, place.z)) player.teleport(new Vector3(place.x, STREET_Y + 0.05, place.z), place.yaw);
  let boundKeys = '';
  settings.on((s) => {
    if (player.camera.fov !== s.fov) {
      player.camera.fov = s.fov;
      player.camera.updateProjectionMatrix();
    }
    audio.setVolumes(s.volume);
    const keys = JSON.stringify(s.keys);
    if (keys !== boundKeys) {
      boundKeys = keys;
      hud.relabel();
    }
  });
  const settingsPanel = new SettingsPanel(hud.settingsPanel, () => hud.showSettings(false), touchMode);
  // Esc in the settings goes back to the pause menu (while rebinding, the panel takes it first).
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Escape' && hud.closePanel()) {
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  }, { capture: true });

  const weather = new Weather(scene, [], debug ? params.get('weather') : null, time);
  const openWeather = new OpenAirWeather(scene);
  const warnings = new Warnings(debug ? params.get('warning') : null);

  let renderNeeded = true;
  let pixel = false;
  const resolution = new AdaptiveResolution();
  let batteryTold = false;
  /** The last frame's own work, from its start to the end of the render call. */
  let workMs = 0;
  const resize = () => {
    renderNeeded = true;
    const w = root.clientWidth || window.innerWidth;
    const h = root.clientHeight || window.innerHeight;
    const most = settings.value.battery ? 1 : touchMode ? 1.5 : 2;
    renderer.setPixelRatio(pixel ? 0.42 : Math.min(window.devicePixelRatio, most) * resolution.scale);
    renderer.setSize(w, h, true);
    renderer.domElement.classList.toggle('is-pixel', pixel);
    player.camera.aspect = w / h;
    player.camera.updateProjectionMatrix();
  };
  resize();
  window.addEventListener('resize', resize);

  // The baked city lives only on the GPU, so a lost context cannot be filled again: the page comes back instead,
  // where the player stood.
  const canvas = renderer.domElement;
  canvas.addEventListener('webglcontextlost', (event) => {
    event.preventDefault();
    reportError(new Error('WebGL context lost'), false);
    try { rememberPlace(); } catch { /* The page comes back to the last place kept. */ }
    window.setTimeout(() => { comeBack(); location.reload(); }, CONTEXT_WAIT);
  });
  canvas.addEventListener('webglcontextrestored', () => {
    rememberPlace();
    comeBack();
    location.reload();
  });

  let paused = !debug;
  let respawning = false;
  let touch: TouchControls | null = null;
  const setPaused = (value: boolean) => {
    renderNeeded = true;
    paused = value;
    player.enabled = listening = !value;
    hud.setPaused(value);
    touch?.setEnabled(!value);
    if (value) {
      player.resetInput();
      audio.suspend();
    }
  };
  const resume = () => {
    audio.start();
    hud.resumeButton.blur();
    if (touchMode) { setPaused(false); return; }
    if (debug) {
      // Debug never pauses, so headless screenshots work, but a click still takes the mouse for looking around.
      setPaused(false);
      try { void (canvas.requestPointerLock() as Promise<void> | undefined)?.catch(() => {}); } catch { /* Keyboard only. */ }
      return;
    }
    if (typeof canvas.requestPointerLock !== 'function') { setPaused(true); return; }
    try {
      const result = canvas.requestPointerLock() as Promise<void> | undefined;
      void result?.catch(() => setPaused(true));
    } catch { setPaused(true); }
  };
  const pause = () => {
    setPaused(true);
    if (document.pointerLockElement === canvas) document.exitPointerLock();
  };
  const toggleSound = () => {
    const muted = audio.toggleMute();
    hud.setOption(hud.soundButton, !muted);
    hud.say(muted ? text.soundOff : text.soundOn, 2);
  };
  const togglePixels = () => {
    pixel = !pixel;
    hud.setOption(hud.pixelButton, pixel);
    resize();
  };
  hud.resumeButton.addEventListener('click', resume);
  hud.langButton.addEventListener('click', (event) => {
    event.stopPropagation();
    const next = lang() === 'sv' ? 'en' : 'sv';
    setLang(next);
    saveLang(next);
    hud.relabel();
    touch?.relabel();
    settingsPanel.render(touchMode);
  });
  hud.soundButton.addEventListener('click', toggleSound);
  hud.pixelButton.addEventListener('click', togglePixels);
  hud.setOption(hud.batteryButton, settings.value.battery);
  hud.batteryButton.addEventListener('click', (event) => {
    event.stopPropagation();
    settings.change((s) => { s.battery = !s.battery; });
    hud.setOption(hud.batteryButton, settings.value.battery);
    resize();
  });
  hud.unstuckButton.addEventListener('click', (event) => {
    event.stopPropagation();
    respawn(text.unstuck.done);
    resume();
  });
  canvas.addEventListener('click', () => { if (!touchMode) resume(); });
  document.addEventListener('pointerlockchange', () => {
    if (!touchMode && !debug) setPaused(document.pointerLockElement !== canvas);
  });
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  window.addEventListener('blur', () => { if (touchMode) pause(); });
  const nothing = () => {};
  if (touchMode) touch = new TouchControls(root, canvas, {
    move: (forward, side) => player.setTouchMovement(forward, side),
    look: (dx, dy) => player.look(dx, dy),
    run: (enabled) => player.setTouchRunning(enabled),
    jump: () => player.jump(), sit: nothing, climb: nothing, use: nothing,
    throttle: nothing, doors: nothing,
    pause, map: nothing, activateAudio: () => audio.start(),
  });
  // No map of the network in the city yet.
  root.querySelector<HTMLElement>('.touch-toolbar [data-action="map"]')?.setAttribute('hidden', '');
  setPaused(!debug);

  // Keys go through the player's bindings (`settings.ts`); Escape always pauses and the arrows always walk.
  window.addEventListener('keydown', (e) => {
    if (e.repeat || settingsPanel.capturing || (e.target instanceof HTMLElement && e.target.closest('button, input, select, textarea, a'))) return;
    if (e.code === 'Escape') { pause(); return; }
    const action = settings.action(e.code);
    if (action === 'mute') toggleSound();
    if (action === 'pixels') togglePixels();
    if (action === 'help') hud.toggleHelp();
    if (action === 'motion') toggleMotion();
  });
  // A gamepad, polled every frame: it can also resume from the menu without the mouse.
  const pads = new Gamepads({
    move: (forward, side, running) => player.setPadMovement(forward, side, running),
    look: (dx, dy) => { if (player.enabled) player.look(dx, dy); },
    jump: () => player.jump(),
    use: nothing, sit: nothing, map: nothing,
    help: () => hud.toggleHelp(),
    pause: () => {
      if (!paused) { pause(); return; }
      audio.start();
      setPaused(false);
    },
    throttle: nothing, doors: nothing, brake: nothing, stopDriving: nothing,
    connected: (on) => hud.say(on ? text.settings.gamepadOn : text.settings.gamepadOff, 3),
  });

  // Where the player stands is kept every few seconds, for "continue where you were" on the landing page.
  let placeTimer = 0;
  function rememberPlace(): void {
    if (debug || respawning) return;
    savePlace({ x: player.feet.x, y: player.feet.y, z: player.feet.z, yaw: player.yaw, station: placeNear(player.feet.x, player.feet.z).name, at: Date.now() });
  }

  /** Back on the street, at the nearest named place: out of a fall, or when stuck. */
  function respawn(message: string): void {
    if (respawning) return;
    respawning = true;
    void hud
      .blackout(() => {
        const near = PLACES[placeNear(player.feet.x, player.feet.z).name];
        player.teleport(new Vector3(near[0], STREET_Y + 0.05, near[1]));
        hud.say(message, 6);
      })
      .then(() => (respawning = false));
  }

  /** When a tram last rang at the player (performance.now), so a tram coming on rings once, not every frame. */
  let rang = -Infinity;
  /**
   * A tram about to run into the player: it rings, and they step aside to the nearest spot clear of the tracks and the
   * trams (`aside.ts`), else go to the nearest named place. Trams keep their timetable and cannot stop.
   */
  function outOfTheWay(): void {
    const hit = trams!.inTheWay(player.feet.x, player.feet.z);
    if (!hit || respawning || player.feet.y > STREET_Y + 1.5) return;
    if (performance.now() - rang > 3000) {
      rang = performance.now();
      audio.bell();
      hud.say(text.tram.aside, 4);
    }
    const to = stepAside(player.feet.x, player.feet.z, hit.section, trams!.obstacles(), trams!.tracksNear(player.feet.x, player.feet.z, 30), TRAM_WIDTH / 2,
      (x, z) => physics.free(x, STREET_Y, z, player.collider));
    if (to) player.teleport(new Vector3(to[0], STREET_Y + 0.05, to[1]));
    else respawn(text.tram.aside);
  }

  /** Where the player stands in a tram, judged before the trams move each frame; null on foot. */
  let aboard: Aboard | null = null;
  /** The tram ridden and the stop last announced on it, so each is called once. */
  let called = { id: -1, next: -2 };
  let lastSpeed = 0;
  const carried = new Vector3();

  /** Moves the player with the tram they stand in, round its curves (turning the view as the tram turns). */
  function ride(dt: number): void {
    if (!aboard || !trams) return;
    const moved = trams.carry(aboard);
    // Off the edge of the inner city with it, or the tram gone (it has left): off at the nearest place.
    if (!moved || !inside(player.feet.x, player.feet.z)) {
      aboard = null;
      respawn(text.tram.alight);
      return;
    }
    player.carry(carried.set(moved.dx - player.feet.x, 0, moved.dz - player.feet.z));
    player.yaw += moved.turn;
    const tram = trams.tram(aboard.id)!;
    const st = tram.state;
    player.setRide(st.s, st.speed, dt > 0 ? (st.speed - lastSpeed) / dt : 0, motion);
    lastSpeed = st.speed;
    const run = tramData!.runs[st.run];
    const nextName = st.next >= 0 ? run.stops[st.next].name : '';
    // On the way from a stop: the next one called, with the chime, in the browser's Swedish voice.
    if (st.line && st.speed > 0.5 && (called.id !== st.id || called.next !== st.next)) {
      called = { id: st.id, next: st.next };
      const message = nextName ? sv.tram.next.replace('{stop}', nextName) : sv.tram.last;
      audio.announce(message, () => hud.say(message, 6), () => {}, true);
    }
    trams.showDisplay(st.id, st.line, st.headsign, nextName ? sv.tram.display.replace('{stop}', nextName) : sv.tram.last);
  }
  const playable = grow(PLAY, 10);
  const inside = (x: number, z: number) => x > playable.x0 && x < playable.x1 && z > playable.z0 && z < playable.z1;

  /** When each tram last rang at the player, so a tram rings once as it comes, not every frame. */
  const warned = new Map<number, number>();
  /**
   * A tram coming at someone standing near its track ahead (not yet in its way): it rings its bell, once, as a driver
   * would.
   */
  function warn(): void {
    const now = performance.now();
    for (const tram of trams!.drawn) {
      if (tram.distance > 45) break;
      const speed = Math.abs(tram.state.speed);
      if (speed < 2 || (warned.get(tram.state.id) ?? -Infinity) > now - 8000) continue;
      const f = tram.sections[0];
      const ux = player.feet.x - f.x, uz = player.feet.z - f.z;
      const along = ux * f.dx + uz * f.dz, across = -ux * f.dz + uz * f.dx;
      if (along > f.hl && along < f.hl + 10 + speed * 1.5 && Math.abs(across) < TRAM_WIDTH / 2 + 1.8) {
        warned.set(tram.state.id, now);
        audio.bell(0.8);
      }
    }
    if (warned.size > 64) warned.clear();
  }

  /** The nearest tram, heard: its rumble and whine by how near and fast it is, and its brakes squealing as it slows. */
  let heard: { id: number; speed: number } | null = null;
  function tramSound(dt: number): void {
    const near = trams!.nearest();
    if (!near || near.distance > 120) {
      if (heard) {
        // Quiet, the brakes too (they would squeal on at the last tram's pitch).
        audio.setStreetNoise(0, 0);
        audio.updateJourney({ trainId: null, distance: 0, speed: 0, braking: 0, loudness: 0, aboard: false });
      }
      heard = null;
      return;
    }
    const v = Math.min(1, near.speed / 16);
    const loudness = Math.min(1, (0.12 + 0.88 * v) / (1 + near.distance / 10));
    audio.setStreetNoise(loudness, v);
    const braking = heard?.id === near.id && dt > 0 ? (heard.speed - near.speed) / dt : 0;
    audio.updateJourney({ trainId: null, distance: 0, speed: near.speed, braking, loudness, aboard: false });
    heard = { id: near.id, speed: near.speed };
  }

  let last = performance.now();
  let secondTimer = 0;
  /** The anonymous performance report, once the game is up (`telemetry.ts`). */
  let telemetry: Telemetry | null = null;
  /** Debug: a fixed step for frames run by hand (`__us.step`), which also run while the page is hidden. */
  let manualDt: number | null = null;
  /** In debug, how long each part of the frame takes, summed over frames, for `__us.laps()`. */
  const laps = new Map<string, number>();
  const frameLaps: Array<[string, number]> = [];
  const slowLog: Array<{ at: number; ms: number; parts: Record<string, number>; where: string }> = [];
  let lapAt = 0;
  const lap = debug ? (name: string) => {
    const t = performance.now();
    laps.set(name, (laps.get(name) ?? 0) + t - lapAt);
    frameLaps.push([name, t - lapAt]);
    lapAt = t;
  } : () => {};

  function frame(): void {
    const now = performance.now();
    lapAt = now;
    frameLaps.length = 0;
    const dt = manualDt ?? Math.min((now - last) / 1000, 1 / 20);
    const frameMs = now - last;
    last = now;
    if (document.hidden && manualDt === null) return;
    pads.poll(dt, !paused && player.enabled, false);
    if (paused) {
      if (renderNeeded) {
        renderer.render(scene, player.camera);
        renderNeeded = false;
      }
      return;
    }
    if (manualDt === null) {
      resolution.heldMs = settings.value.battery ? 1000 / FPS_BATTERY : 0;
      if (resolution.frame(frameMs, workMs, now)) {
        resize();
        // At the lowest notch the machine is struggling: say once that battery saver makes it lighter.
        if (resolution.level === RENDER_SCALES.length - 1 && !settings.value.battery && !batteryTold) {
          batteryTold = true;
          hud.tip(text.battery.tip, 8);
        }
      }
      telemetry?.frame(frameMs, workMs, settings.value.battery);
    }
    time += dt;
    if (followClock) {
      // Follow the wall clock: slew gently, jump if far off.
      const error = Date.now() / 1000 - time;
      if (Math.abs(error) > CLOCK_JUMP) time += error;
      else time += Math.max(-0.05 * dt, Math.min(0.05 * dt, error));
    }

    if (trams) {
      // Who stands in which tram is judged before they move; then they move, and the rider with them.
      aboard = respawning ? null : trams.aboard(player.feet);
      trams.update(time, player.feet.x, player.feet.z, sky.daylight);
      if (!aboard) {
        outOfTheWay();
        warn();
        player.setRide(0, 0, 0, false);
        trams.showDisplay(null, '', '', '');
      }
      lap('trams');
    }
    physics.step(dt);
    lap('physics');
    ride(dt);
    // A doorway whose doors close on the player: in or out, whichever is nearer.
    const doorway = trams?.doorway(player.feet);
    if (doorway) player.teleport(new Vector3(doorway[0], player.feet.y + 0.02, doorway[1]));
    player.update(dt);
    world.keepUp(player.feet.x, player.feet.z, 6);
    lap('build');
    if (player.feet.y < FALL_Y) respawn(text.unstuck.done);

    // The place the player is nearest, in the status bar.
    const near = placeNear(player.feet.x, player.feet.z);
    const riding = aboard && trams?.tram(aboard.id)?.state;
    hud.setStatus(near.name, riding && riding.line ? text.tram.line.replace('{line}', riding.line).replace('{headsign}', riding.headsign) : '');
    const out = listening ? audio.output : null;
    if (out) placeListener(out, player.camera.position, player.yaw);
    weather.update(dt, time, null, out);
    warnings.update(dt);
    // All of it in the open: the sky, daylight, the far fog, and rain or snow down to the street.
    sky.update(player.camera.position, time, weather.state);
    setDaylight(sky.daylight);
    const fog = scene.fog as Fog;
    fog.color.copy(sky.horizon);
    (scene.background as Color).copy(fog.color);
    if (Math.abs(player.camera.far - (FOG.far + 10)) > 4) {
      player.camera.far = FOG.far + 10;
      player.camera.updateProjectionMatrix();
    }
    hemisphere.intensity = 2.4 * (1 + Math.max(0, sky.daylight - 0.4));
    openWeather.update(dt, time, weather.state, player.camera.position, 1, STREET_Y);
    lap('sky');
    if (trams) tramSound(dt);
    sounds.update(time, out, weather.state, sky.daylight, player.feet.x, player.feet.z);
    if (player.stepped > 0) footsteps.update(player.stepped, player.running, 'stone', out);
    else footsteps.rest();
    secondTimer -= dt;
    if (secondTimer <= 0) {
      secondTimer = 1;
      hud.setClock(formatClock(time));
      if (++placeTimer % 5 === 0) rememberPlace();
      stops?.update(time, player.feet.x, player.feet.z);
      // The next service day's timetable, fetched a couple of minutes before it starts.
      if (placeTimer % 60 === 0) void tramData?.ensure(time + 120);
    }
    lap('hud');
    renderer.render(scene, player.camera);
    lap('render');
    workMs = performance.now() - now;
    if (debug && workMs > 40) {
      slowLog.push({ at: Math.round(time), ms: Math.round(workMs), parts: Object.fromEntries(frameLaps.filter(([, v]) => v > 2).map(([k, v]) => [k, Math.round(v)])), where: `${near.name} x=${Math.round(player.feet.x)} z=${Math.round(player.feet.z)}` });
      if (slowLog.length > 40) slowLog.shift();
    }
  }

  /** `window.__us` under `?debug`, set once the loading card is down: a script that waits for it finds the game ready. */
  let debugApi: object | null = null;
  if (debug) {
    // Optional camera pose, for screenshots: ?debug&x=..&y=..&z=..&yaw=..&pitch=..
    const num = (k: string) => (params.has(k) ? Number(params.get(k)) : undefined);
    const px = num('x'), py = num('y'), pz = num('z');
    if (px !== undefined || py !== undefined || pz !== undefined) player.teleport(new Vector3(px ?? player.feet.x, py ?? player.feet.y, pz ?? player.feet.z), num('yaw'));
    const pp = num('pitch');
    if (pp !== undefined) player.pitch = pp;
    const api = {
      physics,
      player,
      world,
      weather,
      warnings,
      renderer,
      /** No trams to ride yet (P4): the measuring scripts walk the trains they are given. */
      services: [] as unknown[],
      /** The trams drawn this frame, nearest first, and every tram in the area. */
      trams,
      tramStates: () => trams?.states ?? [],
      /** The stops' platforms, shelters and displays. */
      stops,
      /** The sound, and the city's own (rain, gulls, the bell). */
      audio,
      sounds,
      /** Aboard the nearest tram standing at a stop with its doors open (else the nearest), in its second section's aisle, facing ahead. */
      ride() {
        const tram = trams?.drawn.find((t) => t.state.doors > 0.5 && t.state.line) ?? trams?.drawn[0];
        if (!tram) return null;
        const f = tram.sections[1];
        player.teleport(new Vector3(f.x, STREET_Y + TRAM_FLOOR + 0.02, f.z), Math.atan2(-f.dx, -f.dz));
        return { line: tram.state.line, headsign: tram.state.headsign, id: tram.state.id };
      },
      /** Where the player stands in a tram, if they do. */
      aboard: () => aboard,
      get time() {
        return time;
      },
      set time(t: number) {
        time = t;
      },
      jump(t: number) {
        time = t;
      },
      /** Stands the player on a named place (`PLACES`), looking toward another, with what is near built. */
      place(name: string, toward?: string) {
        const at = PLACES[name];
        if (!at) throw new Error(`No place called ${name}: ${Object.keys(PLACES).join(', ')}`);
        const look = toward ? PLACES[toward] : null;
        player.teleport(new Vector3(at[0], STREET_Y + 0.05, at[1]), look ? yawToward(at, look) : undefined);
        world.ensureBuilt(at[0], at[1]);
        return this.info();
      },
      /**
       * As `place`, from a clean slate: everything built is taken down, and everything within reach of the place is
       * fetched and built before it returns. The measuring scripts' scenes, the same whichever scene ran before.
       */
      async go(name: string, toward?: string) {
        world.clear();
        this.place(name, toward);
        await world.settle(player.feet.x, player.feet.z, 30_000, BUILD_REACH);
        return this.info();
      },
      step(seconds = 1, rate = 30) {
        manualDt = 1 / rate;
        try { for (let i = 0; i < seconds * rate; i++) frame(); } finally { manualDt = null; }
        return this.info();
      },
      info() {
        return { renderer: renderer.info.render, memory: renderer.info.memory, feet: player.feet.toArray(), where: placeNear(player.feet.x, player.feet.z), clock: formatClock(time), building: !!world.building, missing: world.missing(player.feet.x, player.feet.z) };
      },
      /** Times frames, logic and render apart (the render waited for with a one-pixel read). */
      perf(seconds = 3, rate = 30) {
        const gl = renderer.getContext();
        const pixel = new Uint8Array(4);
        const render = renderer.render.bind(renderer);
        let renderMs = 0;
        renderer.render = (s, c) => {
          const t = performance.now();
          render(s, c);
          gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
          renderMs += performance.now() - t;
        };
        const t0 = performance.now();
        try { this.step(seconds, rate); } finally { renderer.render = render; }
        const frames = seconds * rate;
        const total = performance.now() - t0;
        const round = (v: number) => Math.round(v * 100) / 100;
        return {
          frameMs: round(total / frames), logicMs: round((total - renderMs) / frames), renderMs: round(renderMs / frames),
          calls: renderer.info.render.calls, triangles: renderer.info.render.triangles,
          geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures, programs: renderer.info.programs?.length ?? 0,
        };
      },
      /** The slowest recent frames (over 40 ms), with how long each part of them took. */
      slowFrames(clear = false) {
        const out = [...slowLog];
        if (clear) slowLog.length = 0;
        return out;
      },
      /** Back to full resolution, as at the start, for timing a scene. */
      resetResolution() {
        resolution.reset();
        resize();
        return renderer.getPixelRatio();
      },
      /** How long each part of the frame takes, in milliseconds per frame, over `seconds` of frames run by hand. */
      laps(seconds = 2, rate = 15) {
        laps.clear();
        this.step(seconds, rate);
        const frames = seconds * rate;
        return Object.fromEntries([...laps].map(([k, v]) => [k, Math.round((v / frames) * 100) / 100]));
      },
    };
    debugApi = api;
  }

  // Build what lies round the player before the card comes down, waiting for the squares' files.
  player.update(0);
  await world.settle(player.feet.x, player.feet.z);
  await setProgress(0.95);
  await renderer.compileAsync(scene, player.camera);
  renderer.render(scene, player.camera);
  renderNeeded = false;
  await setProgress(1);
  const loadS = (performance.now() - (options.since ?? loadStart)) / 1000;
  while (performance.now() - loadStart < loadMin) {
    showProgress();
    await nextFrame();
  }
  showProgress();
  loading.classList.add('is-done');
  window.setTimeout(() => loading.remove(), debug ? 0 : 400);
  if (debugApi) Object.assign(window, { __us: debugApi });
  last = performance.now();

  // A frame that throws would throw again on every frame after it: the loop stops, the error is reported
  // (`crash.ts`), and a card offers the page back where the player stood.
  let crashed = false;
  const crash = (err: unknown) => {
    if (crashed) return;
    crashed = true;
    renderer.setAnimationLoop(null);
    console.error(err);
    reportError(err, true);
    try { rememberPlace(); } catch { /* Where the player stands may be what broke. */ }
    try { audio.suspend(); } catch { /* The page reloads anyway. */ }
    player.enabled = listening = false;
    if (document.pointerLockElement) document.exitPointerLock();
    const card = document.createElement('div');
    card.className = 'loading crash';
    card.setAttribute('role', 'alertdialog');
    card.setAttribute('aria-labelledby', 'crash-title');
    card.setAttribute('aria-describedby', 'crash-note');
    card.innerHTML = `<div class="loading-card"><p class="loading-title" id="crash-title"></p><p class="loading-note" id="crash-note"></p>
      <button type="button" class="crash-reload"></button><p class="crash-links"><a class="crash-home"></a><a class="crash-mail"></a></p></div>`;
    card.querySelector('#crash-title')!.textContent = text.crash.title;
    card.querySelector('#crash-note')!.textContent = text.crash.note;
    const reload = card.querySelector<HTMLButtonElement>('.crash-reload')!;
    reload.textContent = text.crash.reload;
    reload.addEventListener('click', () => { comeBack(); location.reload(); });
    const home = card.querySelector<HTMLAnchorElement>('.crash-home')!;
    home.textContent = text.crash.home;
    home.href = location.pathname;
    // The error is reported already (`reportError`); the metro's address to mail it to is Joel's, so none is offered.
    card.querySelector<HTMLAnchorElement>('.crash-mail')!.hidden = true;
    root.appendChild(card);
    reload.focus();
  };
  // At most 60 frames a second (30 in battery saver), the time over a whole frame carried, as the metro's game does.
  let ranAt = -Infinity;
  renderer.setAnimationLoop((now: number) => {
    const interval = 1000 / (settings.value.battery ? FPS_BATTERY : FPS_MOST);
    const since = now - ranAt;
    if (manualDt === null && since < interval - FRAME_SLACK_MS) return;
    ranAt = since >= interval && since < interval * 3 ? now - (since % interval) : now;
    try { frame(); } catch (err) { crash(err); }
  });
  crashFacts(() => ({ where: placeNear(player.feet.x, player.feet.z).name, gpu: gpuName(renderer.getContext()) }));
  // Not in debug: the measuring scripts drive the game there, and their frames are not a player's.
  telemetry = new Telemetry(debug ? null : relayUrl(), () => ({ touch: touchMode, scale: resolution.level, pixelRatio: renderer.getPixelRatio(), loadS, real: false, passengers: false, gpu: gpuName(renderer.getContext()) }));
  window.addEventListener('pagehide', () => telemetry?.leave());
  window.addEventListener('pagehide', () => rememberPlace());
  document.addEventListener('visibilitychange', () => { if (document.hidden) rememberPlace(); });
}
