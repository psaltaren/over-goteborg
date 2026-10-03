import { RIDE_LAYOUT } from './layout';

/** Small camera-only suspension movement, sampled by distance, never applied to physics. */
export function rideMotion(distance: number, speed: number, acceleration: number, yaw: number, enabled: boolean) {
  if (!enabled) return { y: 0, roll: 0, pitch: 0 };
  const strength = Math.min(1, Math.max(0, speed / 18));
  const lateral = Math.sin(distance * 0.24) * RIDE_LAYOUT.swayAngle * strength;
  const lean = Math.max(-1.2, Math.min(1.2, acceleration)) * RIDE_LAYOUT.accelerationLean;
  return {
    y: (Math.sin(distance * 0.48) + Math.sin(distance * 1.7) * 0.2) * RIDE_LAYOUT.bounce * strength,
    roll: lateral * Math.sin(yaw) + lean * Math.cos(yaw),
    pitch: lateral * Math.cos(yaw) - lean * Math.sin(yaw),
  };
}
