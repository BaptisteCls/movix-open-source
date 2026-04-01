import { ParticipantSyncStatus, PlaybackState, ScheduledPlaybackEvent, SyncMode, SyncProbeResult } from './watchparty';

export const SYNC_PRO_HOST_INTERVAL_MS = 250;
export const CLASSIC_HOST_INTERVAL_MS = 1000;
export const SYNC_PRO_SOFT_THRESHOLD_SECONDS = 0.15;
export const SYNC_PRO_HARD_THRESHOLD_SECONDS = 1;
export const SYNC_PRO_MAX_RATE_DELTA = 0.05;

export interface LocalPlayerSnapshot {
  now: number;
  currentTime: number;
  isPlaying: boolean;
  playbackRate: number;
}

export interface SyncStatusMessage {
  type: 'status';
  status: ParticipantSyncStatus | 'classic' | 'calibrating';
}

export interface SyncCommandMessage {
  type: 'command';
  action: 'play' | 'pause' | 'seek' | 'setPlaybackRate' | 'resetPlaybackRate';
  value?: number;
}

export interface SyncEngineMessage {
  type: 'engine';
  implementation: 'js' | 'wasm';
}

export type WatchPartySyncWorkerOutput =
  | SyncStatusMessage
  | SyncCommandMessage
  | SyncEngineMessage;

export type WatchPartySyncWorkerInput =
  | { type: 'init'; mode: SyncMode; state?: PlaybackState | null }
  | { type: 'set-mode'; mode: SyncMode }
  | { type: 'master-state'; state: PlaybackState }
  | { type: 'local-state'; state: LocalPlayerSnapshot }
  | { type: 'probe-result'; result: SyncProbeResult }
  | { type: 'schedule'; event: ScheduledPlaybackEvent }
  | { type: 'reset' };

export const clampPlaybackRate = (rate: number) => {
  return Math.max(1 - SYNC_PRO_MAX_RATE_DELTA, Math.min(1 + SYNC_PRO_MAX_RATE_DELTA, rate));
};
