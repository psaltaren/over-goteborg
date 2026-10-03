/**
 * Whether this build has the recorded announcements (`public/audio/`, the Utrop library). A build with RECORDINGS=0
 * (vite.config.ts) leaves them out while they await the rights holder's approval: every call is spoken by the
 * browser's Swedish voice, and the chime and the door warning are synthesized (`audio.ts`).
 */
export const RECORDINGS: boolean = __RECORDINGS__;

/** Original, unedited recordings from the user's Utrop library. */
export const ANNOUNCEMENT_SIGNAL_PATH = 'audio/ding.mp3';
export const SIGNAL_SPEECH_GAP = 0.1;
export const ALIGHTING_WARNING_PATH = 'audio/avstandet.mp3';
export const DOOR_WARNING_PATH = 'audio/buzz.mp3';

/** Silence after a station name before what follows it: "T-Centralen. Byte till ...". */
export const NAME_PAUSE = 0.35;
/** Silence between the station call and "Tänk på avståndet ...". */
export const WARNING_PAUSE = 0.7;
/** Silence between the warning and the station name on arrival. */
export const ARRIVAL_PAUSE = 1.2;

export interface Recording {
  /** Clip paths, in order, and seconds of silence between them. */
  parts: Array<string | number>;
  paths: string[];
  duration: number;
  speechDelay: number;
}

/** @param duration the clips' total length; pauses are added to it */
export const recording = (clips: Array<string | number>, duration: number): Recording => {
  const parts = clips.map((clip) => (typeof clip === 'number' ? clip : `audio/${clip}.mp3`));
  return {
    parts,
    paths: parts.filter((part): part is string => typeof part === 'string'),
    duration: duration + clips.reduce<number>((sum, clip) => sum + (typeof clip === 'number' ? clip : 0), 0),
    speechDelay: clips[0] === 'nasta' ? 0.8 : 0,
  };
};

/** A recording's key in a table of them (`stationRecordings.ts`). */
export type RecordedAnnouncement = string;
