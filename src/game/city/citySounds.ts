// The city's own sounds, all made at runtime: rain on the street while it rains, gulls over the water by day, and
// Domkyrkan's bell striking the hours from its tower. The bell strikes on the shared clock, the same for everyone;
// the gulls come when they will, near the player, as birds do.

import { Spatial, loopNoise, type AudioOut } from '../sfx';
import type { WeatherState } from '../weatherFeed';
import { stockholm } from '../clock';
import { STREET_Y, toGame, type Pt } from './geo';

/** Domkyrkan's tower (Gustavi domkyrka), and the hours its bell strikes. */
const TOWER: Pt = toGame(57.70378, 11.96398);
const FIRST_HOUR = 7, LAST_HOUR = 22;
/** Where the gulls are, over the river and the canals: near these, by day. */
const WATER: Pt[] = [
  toGame(57.7058, 11.9568), // Stenpiren, on the river
  toGame(57.7093, 11.9655), // Lilla Bommen
  toGame(57.7066, 11.9672), // Stora Hamnkanalen at Brunnsparken
  toGame(57.7031, 11.9655), // Vallgraven by Kungsportsplatsen
  toGame(57.7012, 11.9592), // Rosenlundskanalen
];
const GULL_REACH = 160;

/**
 * A big bell struck once: the partials of a tuned bell (hum, prime, tierce, quint, nominal) over a 180 Hz prime, each
 * dying away at its own pace, the hum longest.
 */
function synthBell(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.ceil(rate * 7), rate);
  const data = buffer.getChannelData(0);
  const f = 180;
  const partials: Array<[number, number, number]> = [[0.5, 0.5, 0.35], [1, 0.8, 0.6], [1.2, 0.6, 0.9], [1.5, 0.35, 1.1], [2, 0.7, 1.4], [2.5, 0.25, 2.2], [3, 0.2, 2.8]];
  for (let i = 0; i < data.length; i++) {
    const t = i / rate;
    let v = 0;
    for (const [ratio, level, decay] of partials) v += level * Math.exp(-t * decay) * Math.sin(2 * Math.PI * f * ratio * t);
    data[i] = v * Math.min(1, t / 0.004) * 0.18;
  }
  return buffer;
}

/** A herring gull's cry, twice: a bright note falling away, with its harmonics and a waver, and a little breath. */
function synthGull(ctx: BaseAudioContext): AudioBuffer {
  const rate = ctx.sampleRate;
  const buffer = ctx.createBuffer(1, Math.ceil(rate * 1.3), rate);
  const data = buffer.getChannelData(0);
  for (const start of [0, 0.62]) {
    let phase = 0;
    const length = 0.42;
    for (let i = Math.floor(start * rate); i < Math.min(data.length, Math.floor((start + length) * rate)); i++) {
      const t = i / rate - start;
      const u = t / length;
      const f = 1900 - 850 * Math.pow(u, 0.6);
      phase += (2 * Math.PI * f) / rate;
      const env = Math.min(1, t / 0.02) * Math.pow(1 - u, 1.5);
      const waver = 1 + 0.25 * Math.sin(2 * Math.PI * 28 * t);
      data[i] += env * waver * (Math.sin(phase) + 0.55 * Math.sin(2 * phase) + 0.3 * Math.sin(3 * phase) + 0.12 * (Math.random() * 2 - 1)) * 0.2;
    }
  }
  return buffer;
}

export class CitySounds {
  private out: AudioOut | null = null;
  private rain: GainNode | null = null;
  private bell: AudioBuffer | null = null;
  private gull: AudioBuffer | null = null;
  private tower: Spatial | null = null;
  private struck = -1;
  private nextGull = 0;

  /**
   * Every frame, with sound on (`out`): the rain as heavy as the weather's, the bell at the hour (the epoch `time`), a
   * gull now and then by day near the water round the player at (`x`, `z`).
   */
  update(time: number, out: AudioOut | null, weather: WeatherState, daylight: number, x: number, z: number): void {
    if (!out) return;
    if (out !== this.out) this.start(out);
    const ctx = out.ctx;
    const wet = weather.kind === 'rain' || weather.kind === 'sleet' ? 0.25 + 0.75 * weather.intensity : 0;
    this.rain!.gain.setTargetAtTime(wet * 0.09, ctx.currentTime, 0.8);
    // The hour, struck as many times as it is (on a twelve-hour dial), from seven in the morning to ten at night.
    const c = stockholm(time);
    const hour = Math.floor(time / 3600);
    if (c.minute === 0 && c.second < 2 && hour !== this.struck) {
      this.struck = hour;
      if (c.hour >= FIRST_HOUR && c.hour <= LAST_HOUR) this.strike(c.hour % 12 || 12);
    }
    // A gull, now and then, near water within reach, by day.
    if (daylight > 0.3 && time > this.nextGull) {
      this.nextGull = time + 12 + Math.random() * 30;
      const water = WATER.filter(([wx, wz]) => Math.hypot(wx - x, wz - z) < GULL_REACH);
      if (water.length) this.cry(water[Math.floor(Math.random() * water.length)]);
    }
  }

  private start(out: AudioOut): void {
    this.out = out;
    const ctx = out.ctx;
    // Rain on the street all round: pink noise, its low end and its hiss taken off.
    this.rain = ctx.createGain();
    this.rain.gain.value = 0;
    const low = ctx.createBiquadFilter();
    low.type = 'highpass';
    low.frequency.value = 500;
    const high = ctx.createBiquadFilter();
    high.type = 'lowpass';
    high.frequency.value = 7000;
    loopNoise(out, 'pink').connect(low).connect(high).connect(this.rain).connect(out.bus);
    this.bell = synthBell(ctx);
    this.gull = synthGull(ctx);
    this.tower = new Spatial(out, 40, 0.8, 2000);
    this.tower.setPosition({ x: TOWER[0], y: STREET_Y + 45, z: TOWER[1] });
    this.tower.setLevel(1, 0.01);
  }

  /** The bell struck `n` times, a few seconds apart. */
  private strike(n: number): void {
    const ctx = this.out!.ctx;
    for (let k = 0; k < n; k++) {
      const src = ctx.createBufferSource();
      src.buffer = this.bell;
      src.connect(this.tower!.input);
      src.onended = () => src.disconnect();
      src.start(ctx.currentTime + k * 2.6);
    }
  }

  /** A gull crying somewhere over the water near `at`, high up. */
  private cry([wx, wz]: Pt): void {
    const out = this.out!;
    const spot = new Spatial(out, 8, 1.1, 300);
    const a = Math.random() * Math.PI * 2, r = 15 + Math.random() * 40;
    spot.setPosition({ x: wx + Math.cos(a) * r, y: STREET_Y + 12 + Math.random() * 18, z: wz + Math.sin(a) * r });
    spot.setLevel(0.6 + Math.random() * 0.4, 0.01);
    const src = out.ctx.createBufferSource();
    src.buffer = this.gull;
    src.playbackRate.value = 0.9 + Math.random() * 0.25;
    src.connect(spot.input);
    src.onended = () => {
      src.disconnect();
      spot.dispose();
    };
    src.start();
  }
}
