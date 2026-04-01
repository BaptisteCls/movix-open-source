use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

const SOFT_THRESHOLD_SECONDS: f64 = 0.15;
const HARD_THRESHOLD_SECONDS: f64 = 1.0;
const MAX_RATE_DELTA: f64 = 0.05;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlaybackState {
    is_playing: bool,
    position: f64,
    updated_at: f64,
    updated_by: Option<String>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalPlayerSnapshot {
    now: f64,
    current_time: f64,
    is_playing: bool,
    playback_rate: f64,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct SyncProbeResult {
    probe_id: String,
    client_sent_at: f64,
    server_received_at: f64,
    server_sent_at: f64,
    client_received_at: Option<f64>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScheduledPlaybackEvent {
    action: String,
    position: f64,
    scheduled_at: f64,
    server_now: f64,
    updated_by: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerCommand {
    #[serde(rename = "type")]
    kind: &'static str,
    action: &'static str,
    value: Option<f64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkerStatus {
    #[serde(rename = "type")]
    kind: &'static str,
    status: &'static str,
}

#[derive(Serialize)]
#[serde(untagged)]
enum SerializedOutput {
    Command(WorkerCommand),
    Status(WorkerStatus),
}

#[wasm_bindgen]
pub struct WatchPartySyncEngine {
    mode: String,
    master_state: Option<PlaybackState>,
    clock_offset_ms: f64,
    offset_samples: Vec<f64>,
    last_rate_sent: f64,
    last_hard_sync_at: f64,
    last_play_pause_at: f64,
    last_status: String,
}

#[wasm_bindgen]
impl WatchPartySyncEngine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> WatchPartySyncEngine {
        WatchPartySyncEngine {
            mode: "classic".to_string(),
            master_state: None,
            clock_offset_ms: 0.0,
            offset_samples: Vec::new(),
            last_rate_sent: 1.0,
            last_hard_sync_at: 0.0,
            last_play_pause_at: 0.0,
            last_status: "classic".to_string(),
        }
    }

    #[wasm_bindgen]
    pub fn reset(&mut self) {
        self.master_state = None;
        self.clock_offset_ms = 0.0;
        self.offset_samples.clear();
        self.last_rate_sent = 1.0;
        self.last_hard_sync_at = 0.0;
        self.last_play_pause_at = 0.0;
        self.last_status = "classic".to_string();
    }

    #[wasm_bindgen]
    pub fn set_mode(&mut self, mode: String) -> Result<JsValue, JsValue> {
        if mode != "classic" && mode != "pro" {
            return Err(JsValue::from_str("Invalid sync mode"));
        }

        self.mode = mode.clone();
        self.last_rate_sent = 1.0;

        if mode == "classic" {
            self.last_status = "classic".to_string();
            return outputs_to_js(vec![
                Output::Status("classic"),
                Output::ResetPlaybackRate,
            ]);
        }

        let next_status = if self.offset_samples.len() >= 3 {
            "adjusting"
        } else {
            "calibrating"
        };
        self.last_status = next_status.to_string();
        outputs_to_js(vec![Output::Status(next_status)])
    }

    #[wasm_bindgen]
    pub fn ingest_master_state(&mut self, state: JsValue) -> Result<JsValue, JsValue> {
        let playback_state: PlaybackState = serde_wasm_bindgen::from_value(state)?;
        self.master_state = Some(playback_state);
        outputs_to_js(Vec::new())
    }

    #[wasm_bindgen]
    pub fn ingest_schedule(&mut self, event: JsValue) -> Result<JsValue, JsValue> {
        let schedule: ScheduledPlaybackEvent = serde_wasm_bindgen::from_value(event)?;
        let is_playing = if schedule.action == "seek" {
            self.master_state
                .as_ref()
                .map(|state| state.is_playing)
                .unwrap_or(false)
        } else {
            schedule.action != "pause"
        };

        self.master_state = Some(PlaybackState {
            is_playing,
            position: schedule.position,
            updated_at: schedule.scheduled_at,
            updated_by: schedule.updated_by,
        });

        outputs_to_js(Vec::new())
    }

    #[wasm_bindgen]
    pub fn update_clock_offset(&mut self, result: JsValue) -> Result<JsValue, JsValue> {
        let probe_result: SyncProbeResult = serde_wasm_bindgen::from_value(result)?;
        let client_received_at = match probe_result.client_received_at {
            Some(value) => value,
            None => return outputs_to_js(Vec::new()),
        };

        let round_trip_ms = client_received_at - probe_result.client_sent_at;
        let estimated_offset_ms =
            probe_result.server_sent_at - (probe_result.client_sent_at + round_trip_ms / 2.0);

        self.offset_samples.push(estimated_offset_ms);
        if self.offset_samples.len() > 5 {
            self.offset_samples.remove(0);
        }

        let sample_sum = self.offset_samples.iter().copied().sum::<f64>();
        self.clock_offset_ms = sample_sum / self.offset_samples.len() as f64;

        let next_status = if self.offset_samples.len() >= 3 {
            "perfect"
        } else {
            "calibrating"
        };

        self.last_status = next_status.to_string();
        outputs_to_js(vec![Output::Status(next_status)])
    }

    #[wasm_bindgen]
    pub fn tick(&mut self, snapshot: JsValue) -> Result<JsValue, JsValue> {
        let local_state: LocalPlayerSnapshot = serde_wasm_bindgen::from_value(snapshot)?;

        if self.mode != "pro" {
            self.last_status = "classic".to_string();
            return outputs_to_js(vec![Output::Status("classic")]);
        }

        let master_state = match self.master_state.clone() {
            Some(state) => state,
            None => {
                let next_status = if self.offset_samples.len() >= 3 {
                    "adjusting"
                } else {
                    "calibrating"
                };
                self.last_status = next_status.to_string();
                return outputs_to_js(vec![Output::Status(next_status)]);
            }
        };

        let expected_position = if master_state.is_playing {
            master_state.position
                + ((local_state.now + self.clock_offset_ms - master_state.updated_at).max(0.0) / 1000.0)
        } else {
            master_state.position
        };

        let drift_seconds = expected_position - local_state.current_time;
        let abs_drift = drift_seconds.abs();
        let mut outputs = Vec::new();

        if master_state.is_playing && !local_state.is_playing && local_state.now - self.last_play_pause_at > 600.0
        {
            self.last_play_pause_at = local_state.now;
            outputs.push(Output::Play);
        } else if !master_state.is_playing
            && local_state.is_playing
            && local_state.now - self.last_play_pause_at > 600.0
        {
            self.last_play_pause_at = local_state.now;
            outputs.push(Output::Pause);
        }

        if abs_drift >= HARD_THRESHOLD_SECONDS && local_state.now - self.last_hard_sync_at > 1200.0 {
            self.last_hard_sync_at = local_state.now;
            self.last_rate_sent = 1.0;
            self.last_status = "unstable".to_string();
            outputs.push(Output::Status("unstable"));
            outputs.push(Output::Seek(expected_position));
            outputs.push(Output::ResetPlaybackRate);
            return outputs_to_js(outputs);
        }

        if !master_state.is_playing || !local_state.is_playing {
            if (self.last_rate_sent - 1.0).abs() >= 0.001 {
                self.last_rate_sent = 1.0;
                outputs.push(Output::ResetPlaybackRate);
            }

            let status = if abs_drift < SOFT_THRESHOLD_SECONDS {
                "perfect"
            } else {
                "adjusting"
            };
            self.last_status = status.to_string();
            outputs.push(Output::Status(status));
            return outputs_to_js(outputs);
        }

        if abs_drift < 0.08 {
            if (self.last_rate_sent - 1.0).abs() >= 0.001 {
                self.last_rate_sent = 1.0;
                outputs.push(Output::ResetPlaybackRate);
            }

            self.last_status = "perfect".to_string();
            outputs.push(Output::Status("perfect"));
            return outputs_to_js(outputs);
        }

        let target_rate = clamp_playback_rate(1.0 + drift_seconds * 0.08);
        if (target_rate - self.last_rate_sent).abs() >= 0.005 {
            self.last_rate_sent = target_rate;
            outputs.push(Output::SetPlaybackRate(target_rate));
        }

        let status = if abs_drift < 0.6 {
            "adjusting"
        } else {
            "unstable"
        };
        self.last_status = status.to_string();
        outputs.push(Output::Status(status));

        outputs_to_js(outputs)
    }

    #[wasm_bindgen]
    pub fn get_status(&self) -> String {
        self.last_status.clone()
    }
}

fn clamp_playback_rate(rate: f64) -> f64 {
    rate.clamp(1.0 - MAX_RATE_DELTA, 1.0 + MAX_RATE_DELTA)
}

enum Output {
    Play,
    Pause,
    Seek(f64),
    SetPlaybackRate(f64),
    ResetPlaybackRate,
    Status(&'static str),
}

fn outputs_to_js(outputs: Vec<Output>) -> Result<JsValue, JsValue> {
    let serialized = outputs
        .into_iter()
        .map(|output| match output {
            Output::Play => SerializedOutput::Command(WorkerCommand {
                kind: "command",
                action: "play",
                value: None,
            }),
            Output::Pause => SerializedOutput::Command(WorkerCommand {
                kind: "command",
                action: "pause",
                value: None,
            }),
            Output::Seek(value) => SerializedOutput::Command(WorkerCommand {
                kind: "command",
                action: "seek",
                value: Some(value),
            }),
            Output::SetPlaybackRate(value) => SerializedOutput::Command(WorkerCommand {
                kind: "command",
                action: "setPlaybackRate",
                value: Some(value),
            }),
            Output::ResetPlaybackRate => SerializedOutput::Command(WorkerCommand {
                kind: "command",
                action: "resetPlaybackRate",
                value: None,
            }),
            Output::Status(status) => SerializedOutput::Status(WorkerStatus {
                kind: "status",
                status,
            }),
        })
        .collect::<Vec<_>>();

    serde_wasm_bindgen::to_value(&serialized).map_err(Into::into)
}
