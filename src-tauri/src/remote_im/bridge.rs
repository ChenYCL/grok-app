//! Bridge runtime: **in-process Rust** multi-IM connectors (no Node / agent-connect).

use super::config;
use super::runtime::{self, RuntimeHandle};
use super::{BridgeStatusDto, ConnectedChannelDto};
use parking_lot::Mutex;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::OnceLock;
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;

struct RuntimeSlot {
    handle: Option<RuntimeHandle>,
    connected: Vec<ConnectedChannelDto>,
}

impl Default for RuntimeSlot {
    fn default() -> Self {
        Self {
            handle: None,
            connected: vec![],
        }
    }
}

fn runtime_slot() -> &'static AsyncMutex<RuntimeSlot> {
    static SLOT: OnceLock<AsyncMutex<RuntimeSlot>> = OnceLock::new();
    SLOT.get_or_init(|| AsyncMutex::new(RuntimeSlot::default()))
}

/// Restart backoff attempt counter (process-wide).
static RESTART_ATTEMPTS: AtomicU32 = AtomicU32::new(0);

#[derive(Debug)]
pub struct BridgeRuntime {
    pub enabled: bool,
    pub lifecycle: String,
    pub allow_remote_yolo: bool,
    pub last_error: Option<String>,
    connected_cache: Mutex<Vec<ConnectedChannelDto>>,
    running: Mutex<bool>,
    /// Transient UI phase: starting | listening | stopped | error | degraded
    phase: Mutex<String>,
}

impl Default for BridgeRuntime {
    fn default() -> Self {
        let cfg = config::load_bridge_config();
        Self {
            enabled: cfg.enabled,
            lifecycle: if cfg.lifecycle.is_empty() {
                "attached".into()
            } else {
                cfg.lifecycle
            },
            allow_remote_yolo: cfg.allow_remote_yolo,
            last_error: None,
            connected_cache: Mutex::new(Vec::new()),
            running: Mutex::new(false),
            phase: Mutex::new("stopped".into()),
        }
    }
}

impl BridgeRuntime {
    fn persist_config(&self) {
        let cfg = config::BridgePersistedConfig {
            enabled: self.enabled,
            lifecycle: if self.lifecycle.is_empty() {
                "attached".into()
            } else {
                self.lifecycle.clone()
            },
            allow_remote_yolo: self.allow_remote_yolo,
        };
        if let Err(e) = config::save_bridge_config(&cfg) {
            tracing::warn!("remote_im: persist bridge config failed: {e}");
        }
    }

    pub fn status_dto(&self) -> BridgeStatusDto {
        let running = *self.running.lock();
        let phase = self.phase.lock().clone();
        let connected = if running {
            self.connected_cache.lock().clone()
        } else if self.enabled {
            // Configured / bound channels — not proof of listening.
            config::list_instances()
                .into_iter()
                .filter(|i| i.enabled && i.has_credentials)
                .map(|i| ConnectedChannelDto {
                    channel: i.channel,
                    instance_id: i.id,
                    name: i.name,
                })
                .collect()
        } else {
            vec![]
        };
        // Prefer phase when set; map running → listening for honest UI.
        let state = if running {
            "listening".into()
        } else if phase == "starting" {
            "starting".into()
        } else if self.last_error.is_some() {
            "error".into()
        } else if self.enabled && !connected.is_empty() {
            // Enabled with credentials but not running yet (boot gap / crash).
            "degraded".into()
        } else {
            "stopped".into()
        };
        BridgeStatusDto {
            state,
            enabled: self.enabled,
            lifecycle: if self.lifecycle.is_empty() {
                "attached".into()
            } else {
                self.lifecycle.clone()
            },
            allow_remote_yolo: self.allow_remote_yolo,
            connected_channels: connected,
            last_error: self.last_error.clone(),
            mock: false,
            remote_bridge_path: Some("rust://in-process".into()),
            backend: Some("rust".into()),
        }
    }

    pub fn set_config(
        &mut self,
        enabled: Option<bool>,
        lifecycle: Option<String>,
        allow_remote_yolo: Option<bool>,
    ) -> Result<(), String> {
        if let Some(e) = enabled {
            self.enabled = e;
        }
        if let Some(l) = lifecycle {
            self.lifecycle = l;
        }
        if let Some(y) = allow_remote_yolo {
            self.allow_remote_yolo = y;
        }
        self.persist_config();
        Ok(())
    }

    pub async fn start_async(&mut self) -> Result<(), String> {
        self.enabled = true;
        self.last_error = None;
        *self.phase.lock() = "starting".into();
        self.persist_config();
        let _ = self.stop_async_inner(false).await;
        *self.phase.lock() = "starting".into();

        match runtime::start_runtime(self.allow_remote_yolo).await {
            Ok((handle, connected)) => {
                let dtos: Vec<ConnectedChannelDto> = connected
                    .into_iter()
                    .map(|c| ConnectedChannelDto {
                        channel: c.channel,
                        instance_id: c.instance_id,
                        name: c.name,
                    })
                    .collect();
                *self.connected_cache.lock() = dtos.clone();
                *self.running.lock() = true;
                *self.phase.lock() = "listening".into();
                RESTART_ATTEMPTS.store(0, Ordering::SeqCst);
                {
                    let mut slot = runtime_slot().lock().await;
                    slot.handle = Some(handle);
                    slot.connected = dtos;
                }
                tracing::info!(
                    channels = ?self.connected_cache.lock().iter().map(|c| c.channel.as_str()).collect::<Vec<_>>(),
                    "remote_im: Rust in-process bridge started"
                );
                Ok(())
            }
            Err(e) => {
                tracing::error!(error = %e, "remote_im: bridge start failed");
                self.last_error = Some(e.clone());
                *self.running.lock() = false;
                *self.phase.lock() = "error".into();
                Err(e)
            }
        }
    }

    async fn stop_async_inner(&mut self, clear_enabled: bool) -> Result<(), String> {
        {
            let mut slot = runtime_slot().lock().await;
            if let Some(h) = slot.handle.take() {
                h.stop().await;
            }
            slot.connected.clear();
        }
        *self.running.lock() = false;
        self.connected_cache.lock().clear();
        *self.phase.lock() = if clear_enabled {
            "stopped".into()
        } else {
            "stopped".into()
        };
        if clear_enabled {
            self.enabled = false;
            self.persist_config();
        }
        Ok(())
    }

    pub async fn stop_async(&mut self) -> Result<(), String> {
        self.stop_async_inner(true).await
    }

    /// Called on App launch: if Bridge was enabled (or ready channels exist), start connectors.
    pub async fn try_autostart_async(&mut self) -> Result<(), String> {
        if *self.running.lock() {
            return Ok(());
        }
        if !self.enabled && !config::has_ready_instances() {
            return Ok(());
        }
        // Prefer explicit enabled; also start when bound channels exist (user expectation).
        if !self.enabled && config::has_ready_instances() {
            self.enabled = true;
            self.persist_config();
        }
        if !self.enabled {
            return Ok(());
        }
        tracing::info!("remote_im: auto-starting bridge (enabled + ready instances)");
        self.start_async().await
    }

    pub async fn reload_async(&mut self, _channel: &str, _instance_id: &str) -> Result<(), String> {
        // Always (re)start after save/connect so channels actually receive messages.
        self.enabled = true;
        self.persist_config();
        self.start_async().await?;
        Ok(())
    }

    pub async fn drop_instance_async(&mut self, _instance_id: &str) {
        if self.enabled || *self.running.lock() {
            if config::has_ready_instances() {
                let _ = self.start_async().await;
            } else {
                let _ = self.stop_async_inner(true).await;
            }
        }
    }

    /// Detect dead runtime while still marked running (connector tasks finished).
    async fn reconcile_running_flag(&mut self) {
        if !*self.running.lock() {
            return;
        }
        let dead = {
            let slot = runtime_slot().lock().await;
            match &slot.handle {
                None => true,
                Some(h) => h.is_finished(),
            }
        };
        if dead {
            tracing::warn!("remote_im: runtime handle finished while enabled — marking not running");
            {
                let mut slot = runtime_slot().lock().await;
                slot.handle = None;
                slot.connected.clear();
            }
            *self.running.lock() = false;
            self.connected_cache.lock().clear();
            if self.last_error.is_none() {
                self.last_error = Some("bridge connectors exited unexpectedly".into());
            }
            *self.phase.lock() = "degraded".into();
        }
    }

    /// One watchdog tick: recover enabled bridge that is not listening.
    pub async fn health_tick_async(&mut self) {
        if !self.enabled {
            return;
        }
        self.reconcile_running_flag().await;
        if *self.running.lock() {
            return;
        }
        if !config::has_ready_instances() {
            return;
        }
        let attempt = RESTART_ATTEMPTS.fetch_add(1, Ordering::SeqCst);
        // Exponential backoff: 2^attempt seconds, capped at 60s (tick is 15s so we skip).
        let delay_secs = 2u64.saturating_pow(attempt.min(5));
        if attempt > 0 {
            tracing::info!(
                attempt,
                delay_secs,
                "remote_im: backoff before restart"
            );
            tokio::time::sleep(Duration::from_secs(delay_secs.min(60))).await;
        }
        if !self.enabled {
            return;
        }
        match self.start_async().await {
            Ok(()) => {
                tracing::info!(attempt, "remote_im: watchdog restart ok");
            }
            Err(e) => {
                tracing::warn!(attempt, error = %e, "remote_im: watchdog restart failed");
            }
        }
    }
}

/// Spawn bridge health / crash-recovery loop (call once from app setup after try_autostart).
pub fn start_health_watchdog(state: std::sync::Arc<super::RemoteImState>) {
    tauri::async_runtime::spawn(async move {
        // First recovery window after boot autostart.
        tokio::time::sleep(Duration::from_secs(20)).await;
        loop {
            {
                let mut rt = state.inner.lock().await;
                rt.health_tick_async().await;
            }
            tokio::time::sleep(Duration::from_secs(15)).await;
        }
    });
}

pub fn doctor_report() -> serde_json::Value {
    let instances = config::list_instances();
    let enabled_with_creds = instances
        .iter()
        .filter(|i| i.enabled && i.has_credentials)
        .count();
    let channel_protocols: serde_json::Map<String, serde_json::Value> =
        super::channels::CATALOG_CHANNELS
            .iter()
            .map(|ch| {
                (
                    (*ch).to_string(),
                    serde_json::json!({
                        "protocol": super::channels::protocol_for(ch),
                        "real": super::channels::is_real_protocol(ch),
                    }),
                )
            })
            .collect();
    serde_json::json!({
        "backend": "rust",
        "inProcess": true,
        "externalAgentConnect": false,
        "nodeRemoteBridge": false,
        "instances": instances.len(),
        "enabledWithCreds": enabled_with_creds,
        "channelsSupported": super::channels::CATALOG_CHANNELS,
        "channelProtocols": channel_protocols,
        "scanSupported": ["feishu", "lark", "weixin"],
    })
}
