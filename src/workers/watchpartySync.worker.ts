/// <reference lib="webworker" />

import { PlaybackState, ScheduledPlaybackEvent, SyncProbeResult, SyncMode } from '../utils/watchparty';
import {
  clampPlaybackRate,
  LocalPlayerSnapshot,
  SYNC_PRO_HARD_THRESHOLD_SECONDS,
  SYNC_PRO_SOFT_THRESHOLD_SECONDS,
  SyncCommandMessage,
  SyncEngineMessage,
  SyncStatusMessage,
  WatchPartySyncWorkerInput,
  WatchPartySyncWorkerOutput
} from '../utils/watchpartySync';

declare const self: DedicatedWorkerGlobalScope;

interface WasmEngineModule {
  default: () => Promise<unknown>;
  WatchPartySyncEngine: new () => WasmEngine;
}

interface WasmEngine {
  reset(): void;
  set_mode(mode: string): unknown;
  ingest_master_state(state: unknown): unknown;
  ingest_schedule(event: unknown): unknown;
  update_clock_offset(result: unknown): unknown;
  tick(state: unknown): unknown;
  get_status(): string;
}

let mode: SyncMode = 'classic';
let masterState: PlaybackState | null = null;
let clockOffsetMs = 0;
let lastStatus: SyncStatusMessage['status'] = 'classic';
let scheduledActionTimer: number | null = null;
let lastRateSent = 1;
let lastHardSyncAt = 0;
let lastPlayPauseAt = 0;
const offsetSamples: number[] = [];
let wasmEngine: WasmEngine | null = null;

const postStatus = (status: SyncStatusMessage['status']) => {
  if (status === lastStatus) return;
  lastStatus = status;
  self.postMessage({ type: 'status', status } satisfies SyncStatusMessage);
};

const postCommand = (message: SyncCommandMessage) => {
  self.postMessage(message);
};

const forwardWorkerOutputs = (rawOutputs: unknown) => {
  if (!Array.isArray(rawOutputs)) return;

  rawOutputs.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;

    const typedEntry = entry as WatchPartySyncWorkerOutput;
    if (typedEntry.type === 'status') {
      postStatus(typedEntry.status);
      return;
    }

    if (typedEntry.type === 'command') {
      postCommand(typedEntry);
    }
  });
};

const clearScheduledAction = () => {
  if (scheduledActionTimer !== null) {
    clearTimeout(scheduledActionTimer);
    scheduledActionTimer = null;
  }
};

const tryLoadWasmBundle = async () => {
  try {
    const wasmEntryUrl = `${self.location.origin}/wasm/watchparty-sync/watchparty_sync.js`;
    const wasmModule = await import(/* @vite-ignore */ wasmEntryUrl) as WasmEngineModule;
    await wasmModule.default();
    wasmEngine = new wasmModule.WatchPartySyncEngine();
    forwardWorkerOutputs(wasmEngine.set_mode(mode));
    if (masterState) {
      forwardWorkerOutputs(wasmEngine.ingest_master_state(masterState));
    }
    self.postMessage({ type: 'engine', implementation: 'wasm' } satisfies SyncEngineMessage);
  } catch {
    wasmEngine = null;
    self.postMessage({ type: 'engine', implementation: 'js' } satisfies SyncEngineMessage);
  }
};

const resetEngine = () => {
  clearScheduledAction();
  masterState = null;
  clockOffsetMs = 0;
  offsetSamples.length = 0;
  lastRateSent = 1;
  lastHardSyncAt = 0;
  lastPlayPauseAt = 0;
  wasmEngine?.reset();
};

const setMode = (nextMode: SyncMode) => {
  mode = nextMode;
  clearScheduledAction();

  if (wasmEngine) {
    forwardWorkerOutputs(wasmEngine.set_mode(nextMode));
    return;
  }

  if (mode === 'classic') {
    lastRateSent = 1;
    postCommand({ type: 'command', action: 'resetPlaybackRate' });
    postStatus('classic');
    return;
  }

  postStatus(offsetSamples.length >= 3 ? 'adjusting' : 'calibrating');
};

const updateClockOffset = (result: SyncProbeResult) => {
  if (wasmEngine) {
    forwardWorkerOutputs(wasmEngine.update_clock_offset(result));
    return;
  }

  if (typeof result.clientReceivedAt !== 'number') return;

  const roundTripMs = result.clientReceivedAt - result.clientSentAt;
  const estimatedOffsetMs = result.serverSentAt - (result.clientSentAt + roundTripMs / 2);

  offsetSamples.push(estimatedOffsetMs);
  if (offsetSamples.length > 5) {
    offsetSamples.shift();
  }

  clockOffsetMs = offsetSamples.reduce((sum, sample) => sum + sample, 0) / offsetSamples.length;
  postStatus(offsetSamples.length >= 3 ? 'perfect' : 'calibrating');
};

const getExpectedPosition = (nowMs: number) => {
  if (!masterState) return null;

  const adjustedNow = nowMs + clockOffsetMs;
  if (!masterState.isPlaying) {
    return masterState.position;
  }

  return masterState.position + Math.max(0, adjustedNow - masterState.updatedAt) / 1000;
};

const handleSchedule = (event: ScheduledPlaybackEvent) => {
  if (mode !== 'pro') return;

  clearScheduledAction();

  masterState = {
    isPlaying: event.action === 'seek'
      ? masterState?.isPlaying ?? false
      : event.action !== 'pause',
    position: event.position,
    updatedAt: event.scheduledAt,
    updatedBy: event.updatedBy
  };

  if (wasmEngine) {
    forwardWorkerOutputs(wasmEngine.ingest_schedule(event));
  }

  const targetDelayMs = Math.max(0, event.scheduledAt - (Date.now() + clockOffsetMs));
  scheduledActionTimer = self.setTimeout(() => {
    scheduledActionTimer = null;
    if (event.action === 'seek') {
      postCommand({ type: 'command', action: 'seek', value: event.position });
      return;
    }

    if (event.action === 'play') {
      postCommand({ type: 'command', action: 'play' });
      return;
    }

    postCommand({ type: 'command', action: 'pause' });
  }, targetDelayMs);
};

const handleLocalState = (state: LocalPlayerSnapshot) => {
  if (wasmEngine) {
    forwardWorkerOutputs(wasmEngine.tick(state));
    return;
  }

  if (mode !== 'pro') {
    postStatus('classic');
    return;
  }

  if (!masterState) {
    postStatus(offsetSamples.length >= 3 ? 'adjusting' : 'calibrating');
    return;
  }

  const expectedPosition = getExpectedPosition(state.now);
  if (expectedPosition === null) return;

  if (masterState.isPlaying && !state.isPlaying && state.now - lastPlayPauseAt > 600) {
    lastPlayPauseAt = state.now;
    postCommand({ type: 'command', action: 'play' });
  } else if (!masterState.isPlaying && state.isPlaying && state.now - lastPlayPauseAt > 600) {
    lastPlayPauseAt = state.now;
    postCommand({ type: 'command', action: 'pause' });
  }

  const driftSeconds = expectedPosition - state.currentTime;
  const absDrift = Math.abs(driftSeconds);

  if (absDrift >= SYNC_PRO_HARD_THRESHOLD_SECONDS && state.now - lastHardSyncAt > 1200) {
    lastHardSyncAt = state.now;
    lastRateSent = 1;
    postStatus('unstable');
    postCommand({ type: 'command', action: 'seek', value: expectedPosition });
    postCommand({ type: 'command', action: 'resetPlaybackRate' });
    return;
  }

  if (!masterState.isPlaying || !state.isPlaying) {
    if (lastRateSent !== 1) {
      lastRateSent = 1;
      postCommand({ type: 'command', action: 'resetPlaybackRate' });
    }
    postStatus(absDrift < SYNC_PRO_SOFT_THRESHOLD_SECONDS ? 'perfect' : 'adjusting');
    return;
  }

  if (absDrift < 0.08) {
    if (lastRateSent !== 1) {
      lastRateSent = 1;
      postCommand({ type: 'command', action: 'resetPlaybackRate' });
    }
    postStatus('perfect');
    return;
  }

  const targetRate = clampPlaybackRate(1 + driftSeconds * 0.08);
  if (Math.abs(targetRate - lastRateSent) >= 0.005) {
    lastRateSent = targetRate;
    postCommand({ type: 'command', action: 'setPlaybackRate', value: targetRate });
  }

  postStatus(absDrift < 0.6 ? 'adjusting' : 'unstable');
};

self.addEventListener('message', (event: MessageEvent<WatchPartySyncWorkerInput>) => {
  const message = event.data;

  switch (message.type) {
    case 'init':
      resetEngine();
      masterState = message.state || null;
      void tryLoadWasmBundle();
      setMode(message.mode);
      break;
    case 'set-mode':
      setMode(message.mode);
      break;
    case 'master-state':
      masterState = message.state;
      break;
    case 'local-state':
      handleLocalState(message.state);
      break;
    case 'probe-result':
      updateClockOffset(message.result);
      break;
    case 'schedule':
      handleSchedule(message.event);
      break;
    case 'reset':
      resetEngine();
      setMode('classic');
      break;
    default:
      break;
  }
});
