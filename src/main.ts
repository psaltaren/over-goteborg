import { usesTouchControls } from './device';
import { saveLang, type Lang } from './lang';
import { comingBack, reloadForNewer, reopening, savedPlace, staleBuild } from './place';

document.documentElement.classList.toggle('touch-device', usesTouchControls());
// Following the link to the other language is a choice, and the game's menus keep to it.
const langLink = document.querySelector<HTMLAnchorElement>('.menu-lang');
langLink?.addEventListener('click', () => saveLang(langLink.dataset.lang as Lang));

// The departures from Drottningtorget on the board under the title, live from the game's own timetable: a small
// separate chunk (the timetable, no three.js), loaded once the page has settled so it never competes with first paint.
const board = document.getElementById('departures')!;
const mountBoard = () =>
  import('./landing/departures').then(({ mountDepartures }) => mountDepartures(board)).catch((err) => {
    // Without its chunk (offline, say) the board keeps the departures it came with.
    console.error(err);
    board.classList.remove('is-pending');
  });
if ('requestIdleCallback' in window) requestIdleCallback(mountBoard, { timeout: 1500 });
else setTimeout(mountBoard, 300);

/**
 * The ways into the game. Built only with the game: the landing page alone (LANDING_ONLY=1) has a line saying it opens
 * soon instead, and none of this code, so the game is not in the build.
 */
function game(): void {
  const start = document.getElementById('start') as HTMLButtonElement;
  const resume = document.getElementById('continue') as HTMLButtonElement;
  // Back where the player last stood, if they have been out before.
  const place = savedPlace();
  if (place) {
    resume.hidden = false;
    resume.querySelector('small')!.textContent = place.station;
  }
  const buttons = [start, resume];
  const statusEl = document.getElementById('status') as HTMLParagraphElement;
  // The page carries its own copy of these, in its language.
  const { error, webgl } = statusEl.dataset;
  // A machine without WebGL (most often with hardware acceleration off) is told what to do about it.
  const failed = (err: unknown) => (/WebGL/.test(String(err)) ? webgl : error) ?? '';
  const menu = document.getElementById('menu') as HTMLElement;
  const game = document.getElementById('game') as HTMLDivElement;

  // The game (three.js + Rapier) is only downloaded once the player asks for it, which keeps the landing page tiny.
  const launch = async (again = false) => {
    const since = performance.now();
    // Disabling the buttons drops the focus; it goes back where it was if the game cannot start.
    const focused = document.activeElement as HTMLElement | null;
    for (const b of buttons) b.disabled = true;
    // No loading line here: the game's own loading screen takes over the whole page at once.
    statusEl.textContent = '';
    try {
      // Start physics alongside the game download instead of waiting for the large game chunk.
      const physicsReady = import('./game/physics').then(({ loadRapier }) => loadRapier());
      // Attach the rejection handler immediately; startGame still receives the original promise.
      void physicsReady.catch(() => {});
      const { startGame } = await import('./game/city/boot');
      menu.hidden = true;
      game.hidden = false;
      document.body.classList.add('is-playing');
      await startGame(game, { physicsReady, resume: again, since });
    } catch (err) {
      console.error(err);
      // A page left open across a deploy: the new build opens the game instead.
      if (staleBuild(err) && reloadForNewer({ again })) return;
      // Reported as the game would (`game/crash.ts`, a small chunk): a start that fails on someone's machine is known.
      void import('./game/crash').then(({ reportError }) => reportError(err, true)).catch(() => {});
      menu.hidden = false;
      game.hidden = true;
      document.body.classList.remove('is-playing');
      for (const b of buttons) b.disabled = false;
      statusEl.textContent = failed(err);
      focused?.focus();
    }
  };
  start.addEventListener('click', () => void launch());
  resume.addEventListener('click', () => void launch(true));
  // Loaded again for a newer build: what was being opened opens.
  const reopen = reopening();
  if (comingBack()) void launch(true);
  else if (reopen && !reopen.view) void launch(!!reopen.again);
}
if (__GAME__) game();

export {};
