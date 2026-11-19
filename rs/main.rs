mod acp;
mod conversations;
mod models;
mod receipts;
mod security;
mod storage;
mod telemetry;
mod workspaces;

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        ConnectInfo, DefaultBodyLimit, Multipart, Path as AxumPath, Query, State,
    },
    http::{header, HeaderMap, StatusCode},
    middleware,
    response::{Html, IntoResponse, Response},
    routing::{delete, get, post},
    Json, Router,
};
use chrono::Local;
use conversations::ConversationManager;
use futures_util::{SinkExt, StreamExt};
use security::{
    derive_pin, get_settings, is_owner_request, load_token, save_settings, security_middleware,
};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Command,
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use telemetry::TelemetryMonitor;
use tokio::sync::broadcast;
use tower_http::services::ServeDir;
use workspaces::WorkspaceState;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

pub struct AppState {
    pub root: PathBuf,
    pub monitor: TelemetryMonitor,
    pub conv_mgr: ConversationManager,
    pub ws_state: WorkspaceState,
    git_actions: tokio::sync::Mutex<()>,
    pub tx: broadcast::Sender<String>,
    pairing_epoch: tokio::sync::watch::Sender<()>,
    pub task_queue: Mutex<Vec<Value>>,
    pub active_tasks: Mutex<HashMap<String, Value>>,
    pub current_active_task: Mutex<Option<Value>>,
    pub acp_clients: tokio::sync::Mutex<HashMap<String, Arc<acp::Client>>>,
}

impl AppState {
    async fn refresh_native_conversation(&self, cid: &str) -> bool {
        let metadata = self.conv_mgr.metadata(cid);
        if metadata["native_transport"] != "rpc" {
            return false;
        }
        let Some(id) = metadata["ide_conversation_id"].as_str() else {
            return false;
        };
        if !ConversationManager::valid_id(id) {
            return false;
        }
        let task_id = self.running_task_id(cid);
        let Ok(body) = self
            .monitor
            .rpc("GetCascadeTrajectory", &json!({"cascadeId":id}))
            .await
        else {
            return false;
        };
        let Ok(changed) = self.conv_mgr.store_native_trajectory(cid, &body) else {
            return false;
        };
        if body["status"] == "CASCADE_RUN_STATUS_IDLE" {
            if let Some(task_id) = task_id {
                let failed = body["trajectory"]["steps"]
                    .as_array()
                    .and_then(|steps| steps.last())
                    .is_some_and(|step| step["type"] == "CORTEX_STEP_TYPE_ERROR_MESSAGE");
                self.finish_observed_task(cid, &task_id, failed);
            }
        }
        changed
    }

    fn running_task_id(&self, cid: &str) -> Option<String> {
        let tasks = self.active_tasks.lock().ok()?;
        let task = tasks.get(cid).filter(|task| task["status"] == "running")?;
        task["id"].as_str().map(str::to_owned)
    }

    fn finish_observed_task(&self, cid: &str, task_id: &str, failed: bool) {
        let mut tasks = self.active_tasks.lock().unwrap_or_else(|e| e.into_inner());
        if !tasks
            .get(cid)
            .is_some_and(|t| t["id"] == task_id && t["status"] == "running")
        {
            return;
        }
        tasks.remove(cid);
        let mut current = self
            .current_active_task
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if current.as_ref().is_some_and(|t| t["id"] == task_id) {
            *current = None;
        }
        self.broadcast_json(json!({"type":"TASK_FINISHED","task_id":task_id,"conversation_id":cid,
            "message":if failed { "Antigravity reported an error. Check the conversation." } else { "Antigravity finished this task." }}));
    }

    fn selected_workspace(&self) -> PathBuf {
        self.conv_mgr
            .get_active_id()
            .and_then(|id| {
                self.conv_mgr.metadata(&id)["workspace_path"]
                    .as_str()
                    .map(PathBuf::from)
            })
            .unwrap_or_else(|| self.ws_state.get_active_path())
    }
    fn persist_queue(&self, queue: &[Value]) -> std::io::Result<()> {
        storage::atomic_write(
            &self.root.join("data/task_queue.json"),
            &serde_json::to_vec(queue)?,
        )
    }
    pub fn broadcast_json(&self, val: Value) {
        if let Ok(s) = serde_json::to_string(&val) {
            let _ = self.tx.send(s);
        }
    }
}

#[tokio::main]
async fn main() {
    let root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let port: u16 = std::env::var("BRIDGE_PORT")
        .ok()
        .and_then(|s| s.parse().ok())
        .unwrap_or(8000);

    let _ = fs::create_dir_all(root.join("data"));
    let _ = fs::create_dir_all(root.join("uploads"));
    let _ = fs::create_dir_all(root.join("conversations"));
    let _ = fs::create_dir_all(root.join("logs"));

    let queue_path = root.join("data/task_queue.json");
    let mut saved_queue: Vec<Value> = match fs::read(&queue_path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .expect("Invalid data/task_queue.json; restore it before starting the bridge"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Vec::new(),
        Err(e) => panic!("Cannot read saved task queue: {e}"),
    };
    for item in &mut saved_queue {
        if item["status"] == "dispatching" {
            item["status"] = json!("queued");
        }
    }
    let (tx, _rx) = broadcast::channel::<String>(256);
    let state = Arc::new(AppState {
        root: root.clone(),
        monitor: TelemetryMonitor::new(root.clone(), port),
        conv_mgr: ConversationManager::new(root.clone()),
        ws_state: WorkspaceState::new(root.clone()),
        git_actions: tokio::sync::Mutex::new(()),
        tx,
        pairing_epoch: tokio::sync::watch::channel(()).0,
        task_queue: Mutex::new(saved_queue),
        active_tasks: Mutex::new(HashMap::new()),
        current_active_task: Mutex::new(None),
        acp_clients: tokio::sync::Mutex::new(HashMap::new()),
    });

    // A restarted bridge cannot prove the outcome of an interrupted ACP turn.
    for entry in fs::read_dir(root.join("conversations"))
        .into_iter()
        .flatten()
        .flatten()
    {
        let name = entry.file_name().to_string_lossy().to_string();
        let Some(cid) = name.strip_suffix("_meta.json") else {
            continue;
        };
        let metadata = state.conv_mgr.metadata(cid);
        if metadata["native_transport"] == "acp" && metadata["acp_turn_pending"] == true {
            let conv = state.conv_mgr.get_conversation(cid).unwrap_or(Value::Null);
            let reply = conv["messages"]
                .as_array()
                .and_then(|m| m.iter().find(|m| m["id"] == metadata["acp_turn_id"]));
            let text = format!("{}\n\nThe bridge restarted before AGY confirmed completion. Check the native session before sending another message.", reply.and_then(|m| m["text"].as_str()).unwrap_or(""));
            let _ = state.conv_mgr.store_cli_reply(
                cid,
                metadata["acp_turn_id"]
                    .as_str()
                    .unwrap_or("acp-interrupted"),
                &text,
                "error",
            );
            let _ = state.conv_mgr.update_metadata(
                cid,
                json!({"delivery_uncertain":true,"acp_turn_pending":false}),
            );
        }
    }

    // Startup banner
    let token = load_token(&root, false);
    let pin = derive_pin(&token);
    let primary_url = state.monitor.get_primary_access_url();
    println!("============================================================");
    println!(" ANTIGRAVITY MOBILE COMMAND BRIDGE [RUST NATIVE ENGINE v2.0]");
    println!(
        " -> URL : {}",
        primary_url
            .as_deref()
            .unwrap_or("Unavailable. Open Connect on the laptop.")
    );
    println!(" -> Pairing PIN : {}", pin);
    println!("============================================================");

    // Spawn lightweight background transcript watcher (checks active transcript mtime/size every 2s)
    let watcher_state = state.clone();
    tokio::spawn(async move {
        let mut last_seen: HashMap<String, (u64, u64)> = HashMap::new();
        loop {
            tokio::time::sleep(Duration::from_secs(2)).await;
            if watcher_state.tx.receiver_count() == 0
                && watcher_state
                    .active_tasks
                    .lock()
                    .map(|t| t.is_empty())
                    .unwrap_or(true)
            {
                continue;
            }
            let mut watched = watcher_state
                .active_tasks
                .lock()
                .map(|tasks| tasks.keys().cloned().collect::<Vec<_>>())
                .unwrap_or_default();
            if let Some(selected) = watcher_state.conv_mgr.get_active_id() {
                watched.push(selected);
            }
            watched.sort();
            watched.dedup();
            last_seen.retain(|cid, _| watched.contains(cid));
            for cid in watched {
                let metadata = watcher_state.conv_mgr.metadata(&cid);
                if metadata["native_transport"] == "acp" {
                    continue;
                }
                let native = metadata["native_transport"] == "rpc";
                let legacy_task = if native {
                    None
                } else {
                    watcher_state.running_task_id(&cid)
                };
                let changed = if native {
                    watcher_state.refresh_native_conversation(&cid).await
                } else {
                    let tf = watcher_state.conv_mgr.resolve_transcript_path(&cid);
                    if let Ok(meta) = fs::metadata(&tf) {
                        let mtime = meta
                            .modified()
                            .ok()
                            .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                            .map(|d| d.as_nanos() as u64)
                            .unwrap_or(0);
                        let stamp = (mtime, meta.len());
                        last_seen.insert(cid.clone(), stamp) != Some(stamp)
                    } else {
                        false
                    }
                };
                if changed {
                    if let Some(conv) = watcher_state.conv_mgr.get_conversation(&cid) {
                        let is_proc = conv
                            .get("is_processing")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        if !is_proc {
                            if let Some(task_id) = legacy_task {
                                watcher_state.finish_observed_task(
                                    &cid,
                                    &task_id,
                                    conv["execution_error"].is_string(),
                                );
                            }
                        }
                        watcher_state.broadcast_json(json!({
                            "type": "CONVERSATION_UPDATED",
                            "conversation_id": cid,
                            "conversation": conv,
                            "is_processing": is_proc,
                        }));
                    }
                }
            }
        }
    });

    let static_dir = root.join("static");
    let uploads_dir = root.join("uploads");

    let app = Router::new()
        .route("/", get(serve_index))
        .route("/sw.js", get(serve_sw))
        .route("/healthz", get(healthz))
        .route("/ws", get(ws_handler))
        // Connection & Security
        .route("/api/connection", get(api_connection))
        .route("/api/settings", post(api_settings))
        .route("/api/pairing/reset", post(api_pairing_reset))
        .route("/api/qr", get(api_qr))
        // Telemetry, Quota & Account
        .route("/api/status", get(api_status))
        .route("/api/tokens", get(api_tokens))
        .route("/api/account", get(api_account))
        .route("/api/account/logout", post(api_account_logout))
        .route("/api/account/switch", post(api_account_switch))
        .route("/api/account/add", post(api_account_add))
        .route("/api/account/remove", post(api_account_remove))
        .route("/api/account/login", post(api_account_login))
        // Models & Skills
        .route("/api/models", get(api_models))
        .route("/api/skills", get(api_skills))
        .route("/api/skills/recommend", post(api_skills_recommend))
        // Workspaces & Git Changes
        .route("/api/workspaces", get(api_workspaces))
        .route("/api/workspaces/browse", get(api_workspaces_browse))
        .route("/api/workspaces/select", post(api_workspaces_select))
        .route("/api/workspaces/open-in-ide", post(api_workspaces_open_ide))
        .route("/api/changes", get(api_changes))
        .route("/api/changes/accept", post(api_changes_accept))
        .route("/api/changes/reject", post(api_changes_reject))
        // Conversations
        .route(
            "/api/conversations",
            get(api_conversations_list).post(api_conversations_create),
        )
        .route("/api/conversations/new", post(api_conversations_create))
        .route(
            "/api/conversations/active-tasks",
            get(api_conversations_active_tasks),
        )
        .route("/api/conversations/select", post(api_conversations_select))
        .route("/api/conversations/answer", post(api_conversations_answer))
        .route(
            "/api/conversations/:conv_id",
            get(api_conversation_get).delete(api_conversation_delete),
        )
        // Tasks & Queue
        .route("/api/tasks/submit", post(api_tasks_submit))
        .route("/api/tasks/active", get(api_tasks_active))
        .route("/api/tasks/active/stop", post(api_tasks_active_stop))
        .route("/api/tasks/pending", get(api_tasks_pending))
        .route("/api/tasks/approve", post(api_tasks_approve))
        .route("/api/tasks/reject", post(api_tasks_reject))
        .route("/api/queue", get(api_queue_list))
        .route("/api/queue/clear", post(api_queue_clear))
        .route("/api/queue/:task_id", delete(api_queue_delete))
        .route("/api/queue/:task_id/dispatch", post(api_queue_dispatch))
        // IDE, Sound, Command, Upload, Clipboard
        .route("/api/antigravity/launch", post(api_ide_launch))
        .route("/api/antigravity/open-file", post(api_ide_open_file))
        .route("/api/sound/test", post(api_sound))
        .route("/api/sound/laptop", post(api_sound))
        .route("/api/command/exec", post(api_command_exec))
        .route("/api/upload", post(api_upload))
        .route("/api/upload/:filename", delete(api_upload_delete))
        .route(
            "/api/clipboard",
            get(api_clipboard_get).post(api_clipboard_set),
        )
        .nest_service("/static", ServeDir::new(static_dir))
        .nest_service("/uploads", ServeDir::new(uploads_dir))
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(middleware::from_fn(security_middleware))
        .with_state(state.clone());

    let host = std::env::var("BRIDGE_HOST").unwrap_or_else(|_| "0.0.0.0".into());
    let addr = SocketAddr::new(
        host.parse().expect("BRIDGE_HOST must be an IP address"),
        port,
    );
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .expect("Failed to bind port 8000");
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = tokio::signal::ctrl_c().await;
        for (_, client) in state.acp_clients.lock().await.drain() {
            client.shutdown().await;
        }
    })
    .await
    .expect("Server error");
}

async fn healthz() -> Json<Value> {
    Json(json!({"ok": true, "engine": "rust-axum"}))
}

async fn serve_sw(State(state): State<Arc<AppState>>) -> Response {
    let sw_path = state.root.join("static").join("sw.js");
    let body = fs::read_to_string(sw_path).unwrap_or_else(|_| "// empty sw".to_string());
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/javascript"),
            (header::CACHE_CONTROL, "no-cache"),
            (
                header::HeaderName::from_static("service-worker-allowed"),
                "/",
            ),
        ],
        body,
    )
        .into_response()
}

async fn serve_index(State(state): State<Arc<AppState>>) -> Response {
    let index_path = state.root.join("static").join("index.html");
    let mut html = fs::read_to_string(index_path)
        .unwrap_or_else(|_| "<h1>Antigravity Mobile Command</h1>".to_string());

    let active_id = state.conv_mgr.get_active_id();
    let active_conv = active_id
        .as_deref()
        .and_then(|cid| state.conv_mgr.get_conversation(cid));
    let convs = state.conv_mgr.list_conversations();
    let token_quota = state.monitor.get_token_quota_stats().await;

    let init_payload = json!({
        "active_id": active_id,
        "active_conversation": active_conv,
        "conversations": convs,
        "token_quota": token_quota,
    });
    if let Ok(serialized) = serde_json::to_string(&init_payload) {
        let safe_json = serialized.replace('<', "\\u003c");
        let tag = format!(
            r#"<script id="__INITIAL_DATA__" type="application/json">{}</script>"#,
            safe_json
        );
        if let Some(pos) = html.find("</head>") {
            html.insert_str(pos, &format!("{}\n", tag));
        }
    }

    (
        StatusCode::OK,
        [(
            header::CACHE_CONTROL,
            "no-store, no-cache, must-revalidate, max-age=0",
        )],
        Html(html),
    )
        .into_response()
}

// ─── Connection & Pairing Endpoints ──────────────────────────

async fn api_connection(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Json<Value> {
    let s = get_settings(&state.root);
    let owner = is_owner_request(addr, &headers);
    let ts = state.monitor.get_tailscale_info();
    let ips = state.monitor.get_local_ips();
    let lan_url = ips
        .first()
        .map(|ip| format!("http://{}:{}", ip, state.monitor.port));
    let tok = load_token(&state.root, false);
    let pin = derive_pin(&tok);

    let primary = state.monitor.access_url(&s.remote_mode, &ips, &ts);
    let reason = primary
        .is_none()
        .then(|| TelemetryMonitor::unavailable_reason(&s.remote_mode));
    let pair_url = primary
        .as_ref()
        .filter(|_| owner)
        .map(|url| format!("{url}/?t={pin}"));
    let qr = pair_url
        .as_deref()
        .and_then(|url| state.monitor.get_qr_data_url(url));

    Json(json!({
        "settings": s,
        "owner": owner,
        "lan_url": lan_url,
        "tailscale": ts,
        "primary_url": primary,
        "unavailable_reason": reason,
        "pair_url": pair_url,
        "pin": if owner { Some(pin) } else { None },
        "qr_data_url": qr,
        "shell_enabled": s.allow_shell,
        "engine": "rust-axum",
    }))
}

async fn api_settings(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    if !is_owner_request(addr, &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"detail": "Change this setting on the laptop, not from the phone."})),
        )
            .into_response();
    }
    let updated = match save_settings(&state.root, payload) {
        Ok(settings) => settings,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"detail":e.to_string()})),
            )
                .into_response()
        }
    };
    state.monitor.invalidate_qr_cache();
    Json(json!(updated)).into_response()
}

async fn api_pairing_reset(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if !is_owner_request(addr, &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"detail": "Only the laptop can unpair devices."})),
        )
            .into_response();
    }
    load_token(&state.root, true);
    state.pairing_epoch.send_replace(());
    if let Err(e) = save_settings(&state.root, json!({"require_lan_pin":true})) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"detail":e.to_string()})),
        )
            .into_response();
    }
    state.monitor.invalidate_qr_cache();
    Json(json!({
        "ok": true,
        "message": "All phones unpaired. Scan the new QR code to pair again.",
    }))
    .into_response()
}

async fn api_qr(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> Response {
    if !is_owner_request(addr, &headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"detail":"Pair new devices from the laptop."})),
        )
            .into_response();
    }
    let tok = load_token(&state.root, false);
    let pin = derive_pin(&tok);
    let primary = state.monitor.get_primary_access_url();
    let pair = primary.as_ref().map(|url| format!("{url}/?t={pin}"));
    let qr = pair
        .as_deref()
        .and_then(|url| state.monitor.get_qr_data_url(url));
    Json(json!({
        "url": primary,
        "pair_url": pair,
        "pin": pin,
        "qr_data_url": qr,
    }))
    .into_response()
}

// ─── Telemetry, Quota & Account Endpoints ────────────────────

async fn api_status(State(state): State<Arc<AppState>>) -> Json<Value> {
    let mut t = state.monitor.get_telemetry();
    let q = state.monitor.get_token_quota_stats().await;
    if let Some(obj) = t.as_object_mut() {
        obj.insert("token_quota".to_string(), q);
    }
    Json(t)
}

async fn api_tokens(State(state): State<Arc<AppState>>) -> Json<Value> {
    Json(state.monitor.get_token_quota_stats().await)
}

async fn api_account(State(state): State<Arc<AppState>>) -> Json<Value> {
    let acc = state.monitor.get_user_account_info().await;
    let tq = state.monitor.get_token_quota_stats().await;
    Json(json!({
        "success": true,
        "account": acc,
        "token_quota": tq,
    }))
}

async fn api_account_add(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let email = payload
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    if !email.contains('@') || !email.contains('.') {
        return Json(json!({
            "success": false,
            "message": "Enter a valid Google email address.",
        }));
    }
    let name = payload
        .get("name")
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| email.split('@').next().unwrap_or("User").replace('.', " "));
    let plan = payload
        .get("plan")
        .and_then(|v| v.as_str())
        .unwrap_or("Google AI Pro")
        .to_string();

    let mut accounts = state.monitor.load_saved_accounts();
    let mut found = false;
    for a in &mut accounts {
        if let Some(obj) = a.as_object_mut() {
            let existing = obj
                .get("email")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_lowercase();
            if existing == email {
                obj.insert("name".to_string(), json!(name));
                obj.insert("plan".to_string(), json!(plan));
                obj.insert("is_active".to_string(), json!(true));
                obj.insert(
                    "last_used".to_string(),
                    json!(Local::now().format("%Y-%m-%d %H:%M:%S").to_string()),
                );
                found = true;
            } else {
                obj.insert("is_active".to_string(), json!(false));
            }
        }
    }
    if !found {
        accounts.push(json!({
            "email": email,
            "name": name,
            "avatar_url": "",
            "plan": plan,
            "tier_id": "g1-pro-tier",
            "last_used": Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            "is_active": true,
        }));
    }
    state.monitor.save_accounts_registry(&accounts);
    state.monitor.invalidate_account_caches();

    let acc = state.monitor.get_user_account_info().await;
    let tq = state.monitor.get_token_quota_stats().await;
    let msg = format!("Account {} added and activated.", email);
    state.broadcast_json(json!({
        "type": "ACCOUNT_CHANGED",
        "message": msg,
        "account": acc,
        "token_quota": tq,
    }));
    Json(json!({
        "success": true,
        "message": msg,
        "account": acc,
        "token_quota": tq,
    }))
}

async fn api_account_switch() -> Response {
    (StatusCode::NOT_IMPLEMENTED, Json(json!({"detail":"Account switching must be completed in Antigravity on the laptop. The Rust engine has no credential switch integration."}))).into_response()
}

async fn api_account_remove(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let email = payload
        .get("email")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_lowercase();
    let accounts = state.monitor.load_saved_accounts();
    let mut filtered: Vec<Value> = accounts
        .into_iter()
        .filter(|a| {
            !a.get("email")
                .and_then(|v| v.as_str())
                .map(|s| s.eq_ignore_ascii_case(&email))
                .unwrap_or(false)
        })
        .collect();
    let has_active = filtered.iter().any(|a| {
        a.get("is_active")
            .and_then(|v| v.as_bool())
            .unwrap_or(false)
    });
    if !has_active {
        if let Some(first) = filtered.first_mut().and_then(|v| v.as_object_mut()) {
            first.insert("is_active".to_string(), json!(true));
        }
    }
    state.monitor.save_accounts_registry(&filtered);
    state.monitor.invalidate_account_caches();

    let acc = state.monitor.get_user_account_info().await;
    let tq = state.monitor.get_token_quota_stats().await;
    let msg = format!("Account {} removed from saved accounts.", email);
    state.broadcast_json(json!({
        "type": "ACCOUNT_CHANGED",
        "message": msg,
        "account": acc,
        "token_quota": tq,
    }));
    Json(json!({
        "success": true,
        "message": msg,
        "account": acc,
        "token_quota": tq,
    }))
}

async fn api_account_logout() -> Response {
    (StatusCode::NOT_IMPLEMENTED, Json(json!({"detail":"Sign out inside Antigravity on the laptop. The Rust engine cannot revoke the IDE login."}))).into_response()
}

async fn api_account_login() -> Response {
    (StatusCode::NOT_IMPLEMENTED, Json(json!({"detail":"Open Antigravity on the laptop and use its sign-in flow. Opening a Google page does not authenticate the IDE."}))).into_response()
}

#[derive(Deserialize)]
struct ModelQuery {
    target: Option<String>,
    conversation_id: Option<String>,
    #[serde(default)]
    refresh: bool,
}

async fn api_models(
    State(state): State<Arc<AppState>>,
    Query(query): Query<ModelQuery>,
) -> Json<Value> {
    let metadata = query
        .conversation_id
        .as_deref()
        .and_then(|id| state.conv_mgr.get_conversation(id))
        .unwrap_or(Value::Null);
    let target = bound_target(&metadata)
        .or(query.target.as_deref())
        .unwrap_or("auto");
    if !matches!(target, "auto" | "ide" | "cli") {
        return Json(json!({"connected":false,"models":[],"message":"Invalid execution target."}));
    }
    let mut catalog = models::catalog(&state.monitor, target, query.refresh).await;
    if bound_target(&metadata).is_some() {
        catalog["session_bound"] = json!(true);
        if catalog["connected"] != true && target == "ide" {
            catalog["message"] = json!("This conversation uses the Antigravity app, which is disconnected. Open the app on the laptop or start a new conversation to use AGY CLI.");
        }
    }
    Json(catalog)
}

fn bound_target(metadata: &Value) -> Option<&str> {
    match metadata["native_transport"].as_str() {
        Some("acp") => Some("cli"),
        Some("rpc") => Some("ide"),
        _ if metadata["ide_conversation_id"].is_string() => Some("ide"),
        _ if metadata["source"] == "antigravity_ide" => Some("ide"),
        _ => None,
    }
}

async fn api_skills() -> Json<Value> {
    let skills = WorkspaceState::discover_skills();
    Json(json!({
        "count": skills.len(),
        "skills": skills,
    }))
}

async fn api_skills_recommend(Json(payload): Json<Value>) -> Json<Value> {
    let prompt = payload
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_lowercase();
    let all = WorkspaceState::discover_skills();
    let mut rec = Vec::new();
    for s in all {
        let id = s.get("id").and_then(|v| v.as_str()).unwrap_or("");
        let desc = s.get("description").and_then(|v| v.as_str()).unwrap_or("");
        let mut score = 0;
        for word in id.split('-') {
            if word.len() > 2 && prompt.contains(word) {
                score += 6;
            }
        }
        if score > 0 {
            rec.push(json!({
                "skill_id": id,
                "name": id,
                "description": desc,
                "score": score,
            }));
        }
    }
    Json(json!({
        "recommended_skills": rec,
    }))
}

// ─── Workspaces & Git Changes Endpoints ──────────────────────

async fn api_workspaces(State(state): State<Arc<AppState>>) -> Json<Value> {
    let act = state.ws_state.get_active_path();
    Json(json!({
        "active": WorkspaceState::workspace_info(&act),
        "folders": state.ws_state.list_accessible_folders(),
    }))
}

#[derive(Deserialize)]
struct BrowseQuery {
    target_dir: Option<String>,
    path: Option<String>,
}

async fn api_workspaces_browse(
    State(state): State<Arc<AppState>>,
    Query(q): Query<BrowseQuery>,
) -> Json<Value> {
    let target = q.target_dir.as_deref().or(q.path.as_deref());
    Json(state.ws_state.browse_directory(target))
}

async fn api_workspaces_select(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let path = payload.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let res = state.ws_state.set_active_workspace(path);
    if res.get("status").and_then(|v| v.as_str()) == Some("ok") {
        let ws_name = res
            .get("workspace")
            .and_then(|w| w.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        state.broadcast_json(json!({
            "type": "WORKSPACE_CHANGED",
            "workspace": res.get("workspace"),
            "workspace_name": ws_name,
        }));
    }
    Json(res)
}

async fn api_workspaces_open_ide(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let target = payload
        .get("path")
        .and_then(|v| v.as_str())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.ws_state.get_active_path());
    if !state.ws_state.permits(&target) {
        return Json(
            json!({"status":"error", "message":"Folder is outside the allowed project directories."}),
        );
    }
    if let Err(e) = launch_antigravity_ide(Some(&target)) {
        return Json(json!({"status":"error", "message":e}));
    }
    let msg = format!(
        "Opened {} in Antigravity on the laptop.",
        target.to_string_lossy()
    );
    state.broadcast_json(json!({
        "type": "NOTIFICATION",
        "title": "Antigravity IDE",
        "message": msg,
    }));
    Json(json!({
        "status": "ok",
        "message": msg,
    }))
}

#[derive(Deserialize)]
struct ChangesQuery {
    workspace_path: Option<String>,
}

async fn api_changes(
    State(state): State<Arc<AppState>>,
    Query(q): Query<ChangesQuery>,
) -> Response {
    let target = q
        .workspace_path
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| state.selected_workspace());
    if !state.ws_state.permits(&target) {
        return (StatusCode::BAD_REQUEST, Json(
            json!({"status":"error", "message":"Workspace is outside the allowed project directories."}),
        )).into_response();
    }
    let snapshot = WorkspaceState::get_git_changes(&target);
    let status = if snapshot["availability"] == "unavailable" {
        StatusCode::SERVICE_UNAVAILABLE
    } else {
        StatusCode::OK
    };
    (status, Json(snapshot)).into_response()
}

#[derive(Clone, Copy)]
enum GitChangeScope<'a> {
    All,
    File(&'a str),
}

fn parse_git_change_scope(payload: &Value) -> Result<GitChangeScope<'_>, &'static str> {
    let scope = match payload.get("scope") {
        None | Some(Value::Null) => None,
        Some(v) => match v.as_str() {
            Some(s @ ("all" | "file")) => Some(s),
            _ => return Err("Invalid scope. Expected 'file' or 'all'."),
        },
    };

    if scope == Some("all") {
        let has_file_path = payload
            .get("file_path")
            .is_some_and(|v| !v.is_null() && v.as_str() != Some(""));
        if has_file_path {
            return Err("Do not pass file_path when scope is 'all'.");
        }
        return Ok(GitChangeScope::All);
    }

    let Some(file_path) = payload
        .get("file_path")
        .and_then(Value::as_str)
        .filter(|s| workspaces::safe_git_path(s))
    else {
        return Err("Provide a valid file_path or set scope to 'all'.");
    };
    Ok(GitChangeScope::File(file_path))
}

async fn apply_git_change(state: &Arc<AppState>, payload: &Value, accept: bool) -> Response {
    let scope = match parse_git_change_scope(payload) {
        Ok(scope) => scope,
        Err(message) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"status":"error","message":message})),
            )
                .into_response();
        }
    };
    let target = match payload.get("workspace_path") {
        None => state.selected_workspace(),
        Some(Value::String(path)) if !path.trim().is_empty() => PathBuf::from(path),
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"status":"error","message":"Provide a valid workspace path."})),
            )
                .into_response()
        }
    };
    if !state.ws_state.permits(&target) {
        return Json(
            json!({"status":"error", "message":"Workspace is outside the allowed project directories."}),
        )
        .into_response();
    }
    let commit_msg = payload.get("commit_message").and_then(|v| v.as_str());
    let _git_action = state.git_actions.lock().await;
    let snapshot = WorkspaceState::get_git_changes(&target);
    if snapshot["is_git"] == false {
        return (StatusCode::BAD_REQUEST, Json(json!({"status":"error","code":"invalid_git_workspace","message":"Select a Git repository root to review its changes."}))).into_response();
    }
    if snapshot["availability"] != "ready" {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"status":"error","code":"git_unavailable","message":snapshot["message"]})),
        )
            .into_response();
    }
    let Some(revision) = payload["revision"].as_str().filter(|s| !s.is_empty()) else {
        return (StatusCode::PRECONDITION_REQUIRED, Json(json!({"status":"error","code":"review_required","message":"Refresh Changes and confirm the action again."}))).into_response();
    };
    if snapshot["revision"] != revision {
        return (StatusCode::CONFLICT, Json(json!({"status":"error","code":"stale_review","message":"The project changed since this review. Check the refreshed changes and confirm again."}))).into_response();
    }
    let (res, event_key, target_label) = match (accept, scope) {
        (false, GitChangeScope::All) => (
            WorkspaceState::reject_all_git_changes(&target),
            "rejected_file",
            "all",
        ),
        (false, GitChangeScope::File(fp)) => (
            WorkspaceState::reject_git_change(
                &target,
                fp,
                snapshot["files"]
                    .as_array()
                    .and_then(|files| files.iter().find(|f| f["path"] == fp))
                    .is_some_and(|f| f["status"] == "untracked"),
            ),
            "rejected_file",
            fp,
        ),
        (true, GitChangeScope::All) => (
            WorkspaceState::accept_all_git_changes(&target, commit_msg),
            "accepted_file",
            "all",
        ),
        (true, GitChangeScope::File(fp)) => (
            WorkspaceState::accept_git_change(&target, fp, commit_msg),
            "accepted_file",
            fp,
        ),
    };
    if res["status"] != "ok" {
        let status = match res["code"].as_str() {
            Some("invalid_file_change" | "invalid_git_workspace") => StatusCode::BAD_REQUEST,
            Some(
                "restore_would_overwrite"
                | "missing_head"
                | "no_worktree_changes"
                | "divergent_index"
                | "git_commit_failed"
                | "stale_review",
            ) => StatusCode::CONFLICT,
            _ => StatusCode::OK,
        };
        return (status, Json(res)).into_response();
    }
    let updated = WorkspaceState::get_git_changes(&target);
    state.broadcast_json(json!({
        "type": "CHANGES_UPDATED",
        "changes": updated,
        event_key: target_label,
        "scope": if matches!(scope, GitChangeScope::All) { "all" } else { "file" },
        "message": res.get("message"),
    }));
    Json(json!({
        "status": "ok",
        "message": res.get("message"),
        "changes": updated,
    }))
    .into_response()
}

async fn api_changes_reject(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    apply_git_change(&state, &payload, false).await
}

async fn api_changes_accept(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    apply_git_change(&state, &payload, true).await
}

// ─── Conversations Endpoints ─────────────────────────────────

async fn api_conversations_list(State(state): State<Arc<AppState>>) -> Json<Value> {
    let list = state.conv_mgr.list_conversations();
    let active_id = state.conv_mgr.get_active_id();
    Json(json!({
        "active_id": active_id,
        "conversations": list,
    }))
}

async fn api_conversations_active_tasks(State(state): State<Arc<AppState>>) -> Json<Value> {
    let tasks = state
        .active_tasks
        .lock()
        .map(|m| m.clone())
        .unwrap_or_default();
    Json(json!({
        "active_tasks": tasks,
        "count": tasks.len(),
    }))
}

async fn api_conversations_create(
    State(state): State<Arc<AppState>>,
    payload: Option<Json<Value>>,
) -> Json<Value> {
    let body = payload.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let title = body
        .get("title")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let initial_prompt = body
        .get("initial_prompt")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let skills: Vec<String> = body
        .get("skills")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();

    let workspace = body["workspace_path"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(|| state.ws_state.get_active_path());
    if !workspace.is_dir() || !state.ws_state.permits(&workspace) {
        return Json(json!({"status":"error","message":"The draft project is unavailable."}));
    }
    let offline_id = match body.get("offline_draft_id") {
        None => None,
        Some(v) => match v.as_str().and_then(|v| uuid::Uuid::parse_str(v).ok()) {
            Some(id) => Some(id),
            None => return Json(json!({"status":"error","message":"Invalid draft identifier."})),
        },
    };
    let mut conv =
        state
            .conv_mgr
            .create_conversation(title, &workspace, skills, initial_prompt, offline_id);
    let cid = conv
        .get("id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if cid.is_empty() {
        return Json(conv);
    }
    if let Err(e) = state.conv_mgr.update_metadata(
        &cid,
        json!({"workspace_path":conv["workspace_path"], "workspace":conv["workspace"], "title":conv["title"]}),
    ) {
        return Json(json!({"status":"error","message":e.to_string()}));
    }
    conv = state.conv_mgr.get_conversation(&cid).unwrap_or(conv);
    let updated = state.conv_mgr.list_conversations();

    state.broadcast_json(json!({
        "type": "CONVERSATION_CREATED",
        "conversation": conv,
        "active_id": cid,
        "conversations": updated,
    }));
    Json(conv)
}

async fn api_conversation_get(
    State(state): State<Arc<AppState>>,
    AxumPath(conv_id): AxumPath<String>,
) -> Response {
    state.refresh_native_conversation(&conv_id).await;
    if let Some(conv) = state.conv_mgr.get_conversation(&conv_id) {
        Json(conv).into_response()
    } else {
        (
            StatusCode::NOT_FOUND,
            Json(json!({"detail": "Conversation not found"})),
        )
            .into_response()
    }
}

async fn api_conversation_delete(
    State(state): State<Arc<AppState>>,
    AxumPath(conv_id): AxumPath<String>,
) -> Json<Value> {
    if state.conv_mgr.metadata(&conv_id)["native_transport"] == "acp" {
        if state
            .active_tasks
            .lock()
            .is_ok_and(|tasks| tasks.contains_key(&conv_id))
        {
            return Json(
                json!({"status":"error","message":"Stop the AGY task before deleting this conversation."}),
            );
        }
        if let Some(client) = state.acp_clients.lock().await.remove(&conv_id) {
            client.shutdown().await;
        }
    }
    let ok = state.conv_mgr.delete_conversation(&conv_id);
    let list = state.conv_mgr.list_conversations();
    let active_id = state.conv_mgr.get_active_id();
    state.broadcast_json(json!({
        "type": "CONVERSATION_DELETED",
        "deleted_id": conv_id,
        "active_id": active_id,
        "conversations": list,
    }));
    Json(json!({
        "status": if ok { "ok" } else { "error" },
        "deleted_id": conv_id,
        "active_id": active_id,
        "conversations": list,
    }))
}

async fn api_conversations_select(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    let cid = payload
        .get("conversation_id")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let Some(conv) = state.conv_mgr.get_conversation(&cid) else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"detail": "Conversation not found"})),
        )
            .into_response();
    };
    if let Ok(mut act) = state.conv_mgr.active_id.lock() {
        *act = Some(cid.clone());
    }
    state.broadcast_json(json!({
        "type": "CONVERSATION_SELECTED",
        "conversation_id": cid,
        "conversation": conv,
    }));
    Json(json!({
        "status": "ok",
        "conversation": conv,
    }))
    .into_response()
}

async fn api_conversations_answer(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    let cid = payload
        .get("conversation_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| state.conv_mgr.get_active_id())
        .unwrap_or_else(|| "default".to_string());
    let answer = payload
        .get("answer")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if answer.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"detail": "Enter an answer before continuing."})),
        )
            .into_response();
    }

    if state.conv_mgr.get_conversation(&cid).is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"detail":"Conversation not found"})),
        )
            .into_response();
    }
    let metadata = state.conv_mgr.metadata(&cid);
    if metadata["native_transport"] == "acp" {
        let response = api_tasks_submit(
            State(state.clone()),
            Json(json!({"conversation_id":cid,"prompt":answer,
            "execution_target":"cli","request_id":payload["request_id"]})),
        )
        .await;
        if !response.status().is_success() {
            return response;
        }
        return Json(json!({"status":"ok","answer":answer,"conversation":state.conv_mgr.get_conversation(&cid)})).into_response();
    }
    // An answer can resume a native turn waiting for user input, so it must not
    // enter the new-task overlap guard. It still verifies the same IDE account
    // and known session model immediately before delivery.
    let catalog = models::catalog(&state.monitor, "ide", true).await;
    let model = metadata["requested_model_id"].as_str().unwrap_or("");
    let native_model = match models::validate_selection(&catalog, model) {
        Ok(model) => model,
        Err(message) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({"detail":message,"code":"model_unavailable"})),
            )
                .into_response();
        }
    };
    let result = dispatch_prompt_to_antigravity(
        &state,
        &json!({"prompt":answer,"execution_target":"ide","_use_rpc":true,
            "model":model,"_native_model":native_model}),
        &cid,
    )
    .await;
    if result["status"] != "ok" {
        return (
            StatusCode::BAD_GATEWAY,
            Json(json!({"detail":result["message"]})),
        )
            .into_response();
    }
    state
        .conv_mgr
        .add_message(&cid, "user", &answer, "sent_to_ide", vec![], vec![]);

    let updated = state.conv_mgr.get_conversation(&cid);
    state.broadcast_json(json!({
        "type": "USER_ANSWER_SUBMITTED",
        "conversation_id": cid,
        "answer": answer,
        "conversation": updated,
    }));
    Json(json!({
        "status": "ok",
        "answer": answer,
        "conversation": updated,
    }))
    .into_response()
}

// ─── Task Submission & Queue Endpoints ───────────────────────

async fn dispatch_prompt_to_antigravity(
    state: &Arc<AppState>,
    payload: &Value,
    conv_id: &str,
) -> Value {
    if payload["execution_target"] == "cli" {
        return prepare_cli_session(state, payload, conv_id).await;
    }
    // Use the existing agentapi protocol directly, without shell parsing or Python.
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let candidates = [
        PathBuf::from(&home).join(r"AppData\Local\Programs\antigravity\resources\bin\language_server.exe"),
        PathBuf::from(&home).join(r"AppData\Local\Programs\Antigravity IDE\resources\app\extensions\antigravity\bin\language_server_windows_x64.exe"),
    ];
    let override_exe = std::env::var_os("BRIDGE_AGENTAPI_EXE").map(PathBuf::from);
    let Some((address, csrf)) = state.monitor.find_language_server().await else {
        return json!({"status":"error", "message":"Antigravity language server is unavailable. Open the IDE on the laptop."});
    };
    let mut prompt = format!(
        "<USER_REQUEST>\n{}\n</USER_REQUEST>",
        payload["prompt"].as_str().unwrap_or("")
    );
    if let Some(skills) = payload["skills"].as_array().filter(|a| !a.is_empty()) {
        prompt.push_str(&format!(
            "\n\nRequested skills: {}",
            skills
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    if let Some(images) = payload["images"].as_array().filter(|a| !a.is_empty()) {
        prompt.push_str("\n\nRead the attached image files:\n");
        for image in images.iter().filter_map(Value::as_str) {
            prompt.push_str(image);
            prompt.push('\n');
        }
    }
    let metadata = state.conv_mgr.metadata(conv_id);
    let workspace = metadata
        .get("workspace_path")
        .or_else(|| payload.get("workspace_path"))
        .and_then(Value::as_str)
        .map(PathBuf::from)
        .unwrap_or_else(|| state.ws_state.get_active_path());
    if !state.ws_state.permits(&workspace) {
        return json!({"status":"error", "message":"Workspace is outside the allowed project directories."});
    }
    let conv = state
        .conv_mgr
        .get_conversation(conv_id)
        .unwrap_or(Value::Null);
    let native_id = metadata["ide_conversation_id"].as_str().unwrap_or(conv_id);
    let is_new = conv["source"] == "mobile_bridge" && metadata["ide_conversation_id"].is_null();
    prompt.push_str(&format!(
        "\n\nRequested project directory: {}. Keep file changes inside this project.",
        workspace.display()
    ));
    let explicit_model = payload["model"].as_str().filter(|s| !s.is_empty());
    if explicit_model.is_some() || payload["_use_rpc"] == true {
        // Select by native model ID in the actual execution config, never by a
        // prompt directive or a display-name/tier approximation.
        let mut native_id = native_id.to_string();
        if is_new {
            let uri = match reqwest::Url::from_directory_path(&workspace) {
                Ok(uri) => uri.to_string(),
                Err(_) => return json!({"status":"error","message":"Invalid project directory."}),
            };
            let started = state
                .monitor
                .rpc(
                    "StartCascade",
                    &json!({"workspaceUris":[uri],
                    "source":"CORTEX_TRAJECTORY_SOURCE_AGENT_API",
                    "trajectoryType":"CORTEX_TRAJECTORY_TYPE_CASCADE"}),
                )
                .await;
            let response = match started {
                Ok(response) => response,
                Err(message) => {
                    return json!({"status":"error","code":"delivery_uncertain","message":message})
                }
            };
            let Some(id) = native_conversation_id(&response) else {
                return json!({"status":"error","code":"delivery_uncertain","message":"Antigravity did not return a valid session ID. Check the IDE before retrying."});
            };
            if let Err(e) = state
                .conv_mgr
                .update_metadata(conv_id, json!({"ide_conversation_id":id}))
            {
                return json!({"status":"error","code":"delivery_uncertain","message":format!("Could not save the native session: {e}")});
            }
            native_id = id;
        }
        if let Err(e) = state.conv_mgr.update_metadata(
            conv_id,
            json!({"native_transport":"rpc","ide_conversation_id":native_id}),
        ) {
            return json!({"status":"error","message":format!("Could not save the native transport: {e}")});
        }
        let planner = explicit_model
            .map(|model_id| json!({"modelName":model_id,"planModel":payload["_native_model"]}))
            .unwrap_or_else(|| json!({}));
        return match state
            .monitor
            .rpc(
                "SendUserCascadeMessage",
                &json!({
                    "cascadeId":native_id,"items":[{"text":prompt}],
                    "cascadeConfig":{"plannerConfig":planner}
                }),
            )
            .await
        {
            Ok(_) => {
                let _ = state
                    .conv_mgr
                    .update_metadata(conv_id, json!({"requested_model_id":explicit_model}));
                json!({"status":"ok","logs":["Antigravity acknowledged the message with the requested native model ID."]})
            }
            Err(message) => json!({"status":"error","code":"delivery_uncertain","message":message}),
        };
    }
    let Some(exe) = override_exe
        .as_ref()
        .or_else(|| candidates.iter().find(|p| p.is_file()))
        .filter(|p| p.is_file())
    else {
        return json!({"status":"error", "message":"Antigravity agentapi executable not found. Install and open Antigravity on the laptop."});
    };
    let mut cmd = tokio::process::Command::new(exe);
    cmd.arg("agentapi");
    if is_new {
        cmd.args([
            "new-conversation",
            &format!(
                "--title={}",
                conv["title"].as_str().unwrap_or("Remote task")
            ),
            &prompt,
        ]);
    } else {
        cmd.args(["send-message", "--title=Remote task", native_id, &prompt]);
    }
    cmd.env("ANTIGRAVITY_LS_ADDRESS", address)
        .env("ANTIGRAVITY_CSRF_TOKEN", csrf)
        .current_dir(workspace)
        .kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let child = match cmd
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(e) => {
            return json!({"status":"error","code":"delivery_not_started","message":format!("Could not start Antigravity agentapi: {e}")})
        }
    };
    match tokio::time::timeout(Duration::from_secs(25), child.wait_with_output()).await {
        Ok(Ok(out)) => {
            let result = parse_agentapi_output(&out.stdout, &out.stderr, out.status.success());
            match result {
                Ok(response) => {
                    if is_new {
                        let Some(id) = native_conversation_id(&response) else {
                            return json!({"status":"error","code":"delivery_uncertain","message":"Antigravity acknowledged creation without a valid session ID. Check the IDE before retrying."});
                        };
                        if let Err(e) = state
                            .conv_mgr
                            .update_metadata(conv_id, json!({"ide_conversation_id":id}))
                        {
                            return json!({"status":"error","code":"delivery_uncertain","message":format!("Session was created but its mapping could not be saved: {e}")});
                        }
                    }
                    json!({"status":"ok","agentapi_success":true,"logs":["Antigravity acknowledged the message."]})
                }
                Err(message) => {
                    json!({"status":"error","code":"delivery_uncertain","message":message})
                }
            }
        }
        Ok(Err(e)) => {
            json!({"status":"error","code":"delivery_uncertain","message":format!("Could not read the Antigravity acknowledgement: {e}")})
        }
        Err(_) => {
            json!({"status":"error","code":"delivery_uncertain","message":"Antigravity did not acknowledge within 25 seconds. Check the IDE before retrying."})
        }
    }
}

fn parse_agentapi_output(stdout: &[u8], stderr: &[u8], success: bool) -> Result<Value, String> {
    let data = serde_json::from_slice::<Value>(stdout).ok();
    let error = data
        .as_ref()
        .and_then(|v| v.get("error"))
        .filter(|v| !v.is_null() && v.as_str() != Some(""));
    if !success || error.is_some() {
        let message = error
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| String::from_utf8_lossy(stderr).to_string());
        return Err(format!(
            "Antigravity rejected the message: {}",
            message.chars().take(2000).collect::<String>()
        ));
    }
    Ok(data.unwrap_or_else(|| json!({})))
}

fn native_conversation_id(data: &Value) -> Option<String> {
    let response = data.get("response").unwrap_or(data);
    [
        "conversation_id",
        "conversationId",
        "cascadeId",
        "cascade_id",
        "id",
    ]
    .iter()
    .filter_map(|key| response.get(key).and_then(Value::as_str))
    .find_map(|id| uuid::Uuid::parse_str(id).ok().map(|id| id.to_string()))
}

async fn prepare_cli_session(state: &Arc<AppState>, payload: &Value, cid: &str) -> Value {
    let metadata = state.conv_mgr.metadata(cid);
    let Some(workspace) = payload["workspace_path"].as_str() else {
        return json!({"status":"error","message":"The session project is unavailable."});
    };
    // Reload the same native session in a fresh process so sign-in changes do not
    // leave a long-lived authenticated subprocess attached to the previous account.
    let previous = state.acp_clients.lock().await.remove(cid);
    if let Some(previous) = previous {
        previous.shutdown().await;
    }
    let client = match acp::Client::connect(workspace, metadata["acp_session_id"].as_str()).await {
        Ok(client) => client,
        Err(message) => return json!({"status":"error","message":message}),
    };
    let resolved = match client.validate_model(
        payload["model"].as_str().unwrap_or(""),
        &payload["_allowed_model_ids"],
    ) {
        Ok(model) => model,
        Err(message) => {
            client.shutdown().await;
            return json!({"status":"error","message":message,"code":"model_unavailable"});
        }
    };
    if let Some(model) = payload["model"].as_str().filter(|m| !m.is_empty()) {
        if let Err(message) = client
            .request(
                "session/set_model",
                json!({"sessionId":client.session_id(),"modelId":model}),
                Duration::from_secs(20),
            )
            .await
        {
            client.shutdown().await;
            return json!({"status":"error","message":message,"code":"model_unavailable"});
        }
    }
    if let Err(e) = state.conv_mgr.update_metadata(
        cid,
        json!({"native_transport":"acp",
        "execution_target":"cli","acp_session_id":client.session_id(),"workspace_path":workspace,
        "requested_model_id":payload["model"],"resolved_model_id":resolved}),
    ) {
        client.shutdown().await;
        return json!({"status":"error","message":format!("Could not save the AGY session: {e}")});
    }
    state
        .acp_clients
        .lock()
        .await
        .insert(cid.to_string(), client);
    json!({"status":"ok","logs":["Connected to AGY CLI through ACP."]})
}

async fn run_cli_turn(
    state: Arc<AppState>,
    cid: String,
    task_id: String,
    prompt: String,
    payload: Value,
) {
    let client = state.acp_clients.lock().await.get(&cid).cloned();
    let Some(client) = client else { return };
    let mut events = client.events.lock().await;
    // Loading a saved session replays its history. The bridge already has that transcript.
    while events.try_recv().is_ok() {}
    let mut prompt = prompt;
    if let Some(skills) = payload["skills"].as_array().filter(|a| !a.is_empty()) {
        prompt.push_str(&format!(
            "\n\nRequested skills: {}",
            skills
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }
    let mut content = vec![json!({"type":"text","text":prompt})];
    content.extend(
        payload["_acp_images"]
            .as_array()
            .into_iter()
            .flatten()
            .cloned(),
    );
    let reply_id = format!("acp-{task_id}");
    let mut text = String::new();
    let mut permission_required = false;
    let request = client.request(
        "session/prompt",
        json!({"sessionId":client.session_id(),"prompt":content}),
        Duration::from_secs(24 * 60 * 60),
    );
    tokio::pin!(request);
    let mut result = loop {
        tokio::select! {
            result = &mut request => break result,
            event = events.recv() => {
                let Some(event) = event else { break Err("AGY disconnected during delivery. Check the native session before retrying.".into()) };
                if event["permissions_changed"] == true {
                    state.broadcast_json(json!({"type":"PERMISSIONS_CHANGED"}));
                }
                if event["permission_required"] == true { permission_required = true; }
                if event["sessionId"] == client.session_id() && event["update"]["sessionUpdate"] == "agent_message_chunk" {
                    if let Some(chunk) = event["update"]["content"]["text"].as_str() {
                        if text.len().saturating_add(chunk.len()) > 4 * 1024 * 1024 { let _ = client.cancel().await; break Err("AGY reply exceeded the supported size.".into()); }
                        text.push_str(chunk);
                        if let Err(error) = state.conv_mgr.store_cli_reply(&cid, &reply_id, &text, "streaming") {
                            let _ = client.cancel().await;
                            break Err(format!("Could not save the AGY reply: {error}"));
                        }
                        state.broadcast_json(json!({"type":"CONVERSATION_UPDATED","conversation_id":cid,
                            "conversation":state.conv_mgr.get_conversation(&cid),"is_processing":true}));
                    }
                }
            }
        }
    };
    // Notifications are queued before the final JSON-RPC reply. Drain the last chunks.
    while let Ok(event) = events.try_recv() {
        if event["permission_required"] == true {
            permission_required = true;
        }
        if event["sessionId"] == client.session_id()
            && event["update"]["sessionUpdate"] == "agent_message_chunk"
        {
            if let Some(chunk) = event["update"]["content"]["text"].as_str() {
                if text.len().saturating_add(chunk.len()) > 4 * 1024 * 1024 {
                    result = Err("AGY reply exceeded the supported size.".into());
                    break;
                }
                text.push_str(chunk);
            }
        }
    }
    client.cancel_confirmed.store(
        result
            .as_ref()
            .is_ok_and(|v| v["stopReason"] == "cancelled"),
        std::sync::atomic::Ordering::SeqCst,
    );
    drop(events);
    client.shutdown().await;
    state.acp_clients.lock().await.remove(&cid);
    state.broadcast_json(json!({"type":"PERMISSIONS_CHANGED"}));
    let status = match result {
        Err(error) => {
            text.push_str(&format!("\n\n{error}"));
            let _ = state
                .conv_mgr
                .update_metadata(&cid, json!({"delivery_uncertain":true}));
            "error"
        }
        Ok(ref result) if result["stopReason"] == "cancelled" => "cancelled",
        Ok(_) if permission_required => {
            text.push_str("\n\nAGY sent a permission request without supported choices or sufficient tool details. Review it on the laptop.");
            "error"
        }
        Ok(_) => "completed",
    };
    let saved = state
        .conv_mgr
        .store_cli_reply(&cid, &reply_id, &text, status)
        .is_ok();
    if saved {
        let _ = state
            .conv_mgr
            .update_metadata(&cid, json!({"acp_turn_pending":false}));
    }
    if let Ok(mut tasks) = state.active_tasks.lock() {
        tasks.remove(&cid);
    }
    if let Ok(mut current) = state.current_active_task.lock() {
        if current.as_ref().and_then(|t| t["id"].as_str()) == Some(&task_id) {
            *current = None;
        }
    }
    state.broadcast_json(json!({"type":"CONVERSATION_UPDATED","conversation_id":cid,
        "conversation":state.conv_mgr.get_conversation(&cid),"is_processing":false}));
    state.broadcast_json(json!({"type":"TASK_FINISHED","conversation_id":cid,
        "message":if !saved { "Could not save the AGY reply. Check available storage on the laptop." } else if status == "error" { "AGY reported an error. Check the conversation." } else { "AGY finished this task." }}));
}

async fn api_tasks_submit(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    let Some(id) = payload.get("request_id").and_then(Value::as_str) else {
        return api_tasks_submit_inner(State(state), Json(payload)).await;
    };
    let Ok(uuid) = uuid::Uuid::parse_str(id) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"detail":"request_id must be a UUID."})),
        )
            .into_response();
    };
    let id = uuid.to_string();
    let path = match receipts::claim(&state.root, &id, &payload) {
        Ok(receipts::Claim::New(path)) => path,
        Ok(receipts::Claim::Replay(status, mut body)) => {
            body["replayed"] = json!(true);
            if body["status"] == "ok" {
                body["active_task"] = state
                    .active_tasks
                    .lock()
                    .ok()
                    .and_then(|tasks| {
                        payload["conversation_id"]
                            .as_str()
                            .and_then(|cid| tasks.get(cid).cloned())
                    })
                    .unwrap_or(Value::Null);
            }
            return (
                StatusCode::from_u16(status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR),
                Json(body),
            )
                .into_response();
        }
        Ok(receipts::Claim::Conflict(message)) => {
            return (
                StatusCode::CONFLICT,
                Json(json!({"detail":message,"code":"delivery_uncertain","request_id":id})),
            )
                .into_response()
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"detail":format!("Cannot record delivery: {e}")})),
            )
                .into_response()
        }
    };
    let response = api_tasks_submit_inner(State(state), Json(payload)).await;
    let status = response.status();
    let body = axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024).await;
    if let Ok(bytes) = body {
        if let Ok(mut result) = serde_json::from_slice::<Value>(&bytes) {
            result["request_id"] = json!(id);
            if receipts::complete(&path, status.as_u16(), &result).is_ok() {
                return (status, Json(result)).into_response();
            }
        }
    }
    (StatusCode::SERVICE_UNAVAILABLE, Json(json!({"detail":"Delivery outcome could not be saved. Check the IDE before retrying.","code":"delivery_uncertain","request_id":id}))).into_response()
}

async fn api_tasks_submit_inner(
    State(state): State<Arc<AppState>>,
    Json(mut payload): Json<Value>,
) -> Response {
    if !payload.is_object() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"detail":"Expected a JSON object."})),
        )
            .into_response();
    }
    if payload.get("auto_execute").and_then(Value::as_bool) == Some(false) {
        return (StatusCode::NOT_IMPLEMENTED, Json(json!({"detail":"Review-before-execution is not implemented in the Rust engine. No task was sent."}))).into_response();
    }
    let prompt = payload
        .get("prompt")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let attachments = match acp::resolve_images(&state.root, &payload["images"]) {
        Ok(images) => images,
        Err(message) => {
            return (StatusCode::BAD_REQUEST, Json(json!({"detail":message}))).into_response()
        }
    };
    let images: Vec<String> = attachments
        .iter()
        .map(|(path, _)| path.to_string_lossy().into_owned())
        .collect();
    payload["images"] = json!(images);
    if prompt.is_empty() && images.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"detail": "Write a message or attach an image first"})),
        )
            .into_response();
    }

    let cid = payload
        .get("conversation_id")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| state.conv_mgr.get_active_id())
        .unwrap_or_else(|| "default".to_string());

    if state.conv_mgr.get_conversation(&cid).is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"detail":"Select an existing conversation before sending a task."})),
        )
            .into_response();
    }
    let metadata = state.conv_mgr.metadata(&cid);
    let workspace = metadata["workspace_path"]
        .as_str()
        .map(PathBuf::from)
        .unwrap_or_else(|| state.ws_state.get_active_path());
    if !state.ws_state.permits(&workspace) || !workspace.is_dir() {
        return (StatusCode::BAD_REQUEST, Json(json!({"detail":"The session project is unavailable or outside the allowed folders."}))).into_response();
    }
    let workspace = match workspace.canonicalize() {
        Ok(path) => workspaces::strip_windows_prefix(path),
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"detail":e.to_string()})),
            )
                .into_response()
        }
    };
    if metadata["workspace_path"] != json!(workspace) {
        if let Err(e) = state
            .conv_mgr
            .update_metadata(&cid, json!({"workspace_path":workspace}))
        {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"detail":e.to_string()})),
            )
                .into_response();
        }
    }
    payload["workspace_path"] = json!(workspace);

    if payload
        .get("model")
        .is_some_and(|value| !value.is_null() && !value.is_string())
        || payload
            .get("execution_target")
            .is_some_and(|value| !value.is_string())
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"detail":"Model and execution target must be strings."})),
        )
            .into_response();
    }
    let requested_target = payload["execution_target"].as_str().unwrap_or("auto");
    if !matches!(requested_target, "auto" | "ide" | "cli") {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"detail":"Invalid execution target"})),
        )
            .into_response();
    }
    // Bind existing sessions and queued work to their original native transport.
    let session = state
        .conv_mgr
        .get_conversation(&cid)
        .unwrap_or(metadata.clone());
    let bound = bound_target(&session);
    if bound.is_some_and(|bound| requested_target != "auto" && requested_target != bound) {
        return (StatusCode::CONFLICT, Json(json!({"detail":"This conversation belongs to a different AGY runtime. Choose its models or start a new conversation.","code":"target_mismatch"}))).into_response();
    }
    let target = bound.unwrap_or(requested_target);
    let catalog = models::catalog(&state.monitor, target, true).await;
    let execution_target = if catalog["connected"] != true && payload["queue_mode"] == "queue" {
        target
    } else {
        catalog["target"].as_str().unwrap_or(target)
    }
    .to_string();
    payload["execution_target"] = json!(execution_target);
    payload["_use_rpc"] = json!(catalog["connected"] == true && execution_target == "ide");
    if execution_target == "cli" {
        match acp::image_blocks(&attachments) {
            Ok(images) => payload["_acp_images"] = json!(images),
            Err(message) => {
                return (StatusCode::BAD_REQUEST, Json(json!({"detail":message}))).into_response()
            }
        }
    }
    let mut model = payload
        .get("model")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if model.is_empty() && execution_target == "ide" {
        if let Some(previous) = metadata["requested_model_id"]
            .as_str()
            .filter(|id| !id.is_empty())
        {
            model = previous.to_string();
            payload["model"] = json!(model);
        }
    }
    // An offline default task may be saved as a draft, but delivery always
    // verifies the account's current catalog, including a native default.
    if !model.is_empty() || payload["queue_mode"] != "queue" {
        match models::validate_selection(&catalog, &model) {
            Ok(native_model) => payload["_native_model"] = native_model,
            Err(message) => {
                return (
                    StatusCode::CONFLICT,
                    Json(json!({"detail":message,"code":"model_unavailable"})),
                )
                    .into_response()
            }
        }
    }
    payload["_allowed_model_ids"] = json!(catalog["models"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|model| model["disabled"] == false)
        .filter_map(|model| model["id"].as_str())
        .collect::<Vec<_>>());
    let performance = payload
        .get("performance")
        .and_then(|v| v.as_str())
        .unwrap_or("High")
        .to_string();
    let queue_mode = payload
        .get("queue_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .to_string();

    if queue_mode == "queue" {
        let task_id = format!("q-{}", &uuid::Uuid::new_v4().simple().to_string()[..6]);
        let item = json!({
            "id": task_id,
            "prompt": prompt,
            "images": images,
            "model": model,
            "performance": performance,
            "execution_target": execution_target,
            "skills": payload.get("skills").cloned().unwrap_or_else(|| json!([])),
            "workspace_path": workspace,
            "dispatch_request_id": uuid::Uuid::new_v4().to_string(),
            "conversation_id": cid,
            "created_at": Local::now().format("%H:%M:%S").to_string(),
            "status": "queued",
        });
        let (q_snapshot, q_len) = {
            let mut q = state.task_queue.lock().unwrap();
            if q.len() >= 100 {
                return (
                    StatusCode::CONFLICT,
                    Json(json!({"detail":"Task queue is full (100 tasks)."})),
                )
                    .into_response();
            }
            q.push(item.clone());
            if let Err(e) = state.persist_queue(&q) {
                q.pop();
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"detail":e.to_string()})),
                )
                    .into_response();
            }
            (q.clone(), q.len())
        };
        let conv = state.conv_mgr.get_conversation(&cid);
        state.broadcast_json(json!({
            "type": "TASK_QUEUED",
            "task": item,
            "conversation_id": cid,
            "queue": q_snapshot,
            "queue_count": q_len,
            "conversation": conv,
            "message": format!("Message queued at position #{}.", q_len),
        }));
        return Json(json!({
            "status": "queued",
            "task_id": task_id,
            "queue_position": q_len,
            "queue_count": q_len,
            "message": format!("Message queued (#{}).", q_len),
        }))
        .into_response();
    }

    let task_id = format!("task-{}", &uuid::Uuid::new_v4().simple().to_string()[..6]);
    let now_ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64();
    let mut task_info = json!({
        "id": task_id,
        "prompt": prompt,
        "conversation_id": cid,
        "images": images,
        "model": model,
        "performance": performance,
        "execution_target": execution_target,
        "workspace_path": workspace,
        "started_at": Local::now().format("%H:%M:%S").to_string(),
        "started_timestamp": now_ts,
        "current_action": "Sending to Antigravity...",
        "active_tool": "thinking",
        "status": "dispatching",
    });

    {
        if let Ok(mut act) = state.active_tasks.lock() {
            if act.contains_key(&cid)
                || act.values().any(|task| {
                    task["workspace_path"]
                        .as_str()
                        .and_then(|p| Path::new(p).canonicalize().ok())
                        .is_some_and(|p| {
                            let p = workspaces::strip_windows_prefix(p);
                            p.starts_with(&workspace) || workspace.starts_with(p)
                        })
                })
            {
                return (StatusCode::CONFLICT, Json(json!({"code":"workspace_busy","detail":"A task is already using this project. Queue the next task to avoid overlapping edits."}))).into_response();
            }
            act.insert(cid.clone(), task_info.clone());
        }
        if let Ok(mut cur) = state.current_active_task.lock() {
            *cur = Some(task_info.clone());
        }
    }

    let dispatch_res = dispatch_prompt_to_antigravity(&state, &payload, &cid).await;

    if dispatch_res["status"] != "ok" {
        if let Ok(mut active) = state.active_tasks.lock() {
            active.remove(&cid);
        }
        if let Ok(mut current) = state.current_active_task.lock() {
            if current.as_ref().and_then(|t| t["id"].as_str()) == Some(task_id.as_str()) {
                *current = None;
            }
        }
        state.broadcast_json(json!({"type":"TASK_DISPATCH_FAILED", "conversation_id":cid, "message":dispatch_res["message"]}));
        return (
            if dispatch_res["code"] == "model_unavailable" { StatusCode::CONFLICT } else { StatusCode::BAD_GATEWAY },
            Json(json!({"detail":dispatch_res["message"], "status":"error", "code":dispatch_res.get("code").cloned().unwrap_or_else(|| json!("delivery_not_started"))})),
        )
            .into_response();
    }

    if execution_target == "cli" {
        let pending = state.conv_mgr.update_metadata(
            &cid,
            json!({"acp_turn_pending":true,
            "acp_turn_id":format!("acp-{task_id}"),"delivery_uncertain":false}),
        );
        if let Err(error) = pending {
            let client = state.acp_clients.lock().await.remove(&cid);
            if let Some(client) = client {
                client.shutdown().await;
            }
            if let Ok(mut tasks) = state.active_tasks.lock() {
                tasks.remove(&cid);
            }
            if let Ok(mut current) = state.current_active_task.lock() {
                *current = None;
            }
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"detail":format!("Could not save the AGY turn: {error}")})),
            )
                .into_response();
        }
    }
    task_info["status"] = json!("running");
    if let Ok(mut tasks) = state.active_tasks.lock() {
        tasks.insert(cid.clone(), task_info.clone());
    }
    if let Ok(mut current) = state.current_active_task.lock() {
        *current = Some(task_info.clone());
    }
    let user_msg =
        state
            .conv_mgr
            .add_message(&cid, "user", &prompt, "sent_to_ide", images.clone(), vec![]);

    let conv_data = state.conv_mgr.get_conversation(&cid);
    let active_map = state
        .active_tasks
        .lock()
        .map(|m| m.clone())
        .unwrap_or_default();
    let q_list = state
        .task_queue
        .lock()
        .map(|q| q.clone())
        .unwrap_or_default();

    state.broadcast_json(json!({
        "type": "TASK_SENT_TO_IDE",
        "task_id": task_id,
        "prompt": prompt,
        "sound": "incoming",
        "message": "Message sent to Antigravity on the laptop",
        "conversation_id": cid,
        "ide_conversation_id": state.conv_mgr.metadata(&cid)["ide_conversation_id"].as_str().unwrap_or(&cid),
        "new_message": user_msg,
        "conversation": conv_data,
        "active_task": task_info,
        "active_tasks": active_map,
        "active_tasks_count": active_map.len(),
        "queue": q_list,
        "queue_count": q_list.len(),
    }));

    if execution_target == "cli" {
        let state = state.clone();
        let cid = cid.clone();
        let prompt = prompt.clone();
        let task_id = task_id.clone();
        tokio::spawn(async move {
            run_cli_turn(state, cid, task_id, prompt, payload).await;
        });
    }

    Json(json!({
        "status": "ok",
        "message": "Message sent to Antigravity on the laptop",
        "task_id": task_id,
        "conversation_id": cid,
        "active_task": task_info,
        "active_tasks": active_map,
        "queue_count": q_list.len(),
        "execution_target": execution_target,
        "logs": dispatch_res.get("logs").cloned().unwrap_or_else(|| json!([])),
    }))
    .into_response()
}

async fn api_tasks_active(State(state): State<Arc<AppState>>) -> Json<Value> {
    let cur = state
        .current_active_task
        .lock()
        .ok()
        .and_then(|c| c.clone());
    let q_len = state.task_queue.lock().map(|q| q.len()).unwrap_or(0);
    Json(json!({
        "active_task": cur,
        "is_processing": cur.is_some(),
        "queue_count": q_len,
    }))
}

async fn api_tasks_active_stop(
    State(state): State<Arc<AppState>>,
    payload: Option<Json<Value>>,
) -> Response {
    let body = payload.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let cid = body
        .get("conversation_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string())
        .or_else(|| state.conv_mgr.get_active_id());

    if let Some(ref c) = cid {
        let metadata = state.conv_mgr.metadata(c);
        if metadata["native_transport"] == "acp" {
            let client = state.acp_clients.lock().await.get(c).cloned();
            let Some(client) = client else {
                return (StatusCode::BAD_GATEWAY, Json(json!({"detail":"The AGY session is disconnected. Check the laptop before stopping or retrying."}))).into_response();
            };
            if client.cancel().await.is_err() {
                return (
                    StatusCode::BAD_GATEWAY,
                    Json(json!({"detail":"AGY did not receive the cancellation request."})),
                )
                    .into_response();
            }
            let acknowledged = tokio::time::timeout(Duration::from_secs(10), async {
                while state
                    .active_tasks
                    .lock()
                    .map(|tasks| tasks.contains_key(c))
                    .unwrap_or(true)
                {
                    tokio::time::sleep(Duration::from_millis(50)).await;
                }
            })
            .await
            .is_ok()
                && client
                    .cancel_confirmed
                    .load(std::sync::atomic::Ordering::SeqCst);
            if !acknowledged {
                return (StatusCode::BAD_GATEWAY, Json(json!({"detail":"AGY has not confirmed cancellation. The turn may still be running."}))).into_response();
            }
        } else {
            let native_id = metadata["ide_conversation_id"].as_str().unwrap_or(c);
            let result = state
                .monitor
                .rpc("ForceStopCascadeTree", &json!({"cascadeId": native_id}))
                .await;
            if result.is_err() {
                return (StatusCode::BAD_GATEWAY, Json(json!({"detail":"Antigravity did not acknowledge the stop request. The task may still be running."}))).into_response();
            }
        }
    } else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"detail":"No Antigravity session is available to stop."})),
        )
            .into_response();
    }

    let prev = {
        let mut cur = state.current_active_task.lock().unwrap();
        if cur.as_ref().and_then(|t| t["conversation_id"].as_str()) == cid.as_deref() {
            cur.take()
        } else {
            None
        }
    };
    if let Some(ref c) = cid {
        if let Ok(mut act) = state.active_tasks.lock() {
            act.remove(c);
        }
    }
    let q_list = state
        .task_queue
        .lock()
        .map(|q| q.clone())
        .unwrap_or_default();

    state.broadcast_json(json!({
        "type": "TASK_STOPPED",
        "conversation_id": cid,
        "stopped_task": prev,
        "active_task": Value::Null,
        "is_processing": false,
        "queue": q_list,
        "queue_count": q_list.len(),
        "sound": "alert",
        "message": "Task stopped.",
    }));

    Json(json!({
        "status": "ok",
        "message": "Task stopped.",
        "stopped_task": prev,
    }))
    .into_response()
}

async fn pending_permissions(state: &AppState) -> Vec<Value> {
    let clients = state.acp_clients.lock().await.clone();
    let mut tasks = Vec::new();
    for (cid, client) in clients {
        let mut requests = client.permission_requests().await;
        if requests.is_empty() {
            continue;
        }
        let metadata = state.conv_mgr.metadata(&cid);
        for view in &mut requests {
            view["conversation_id"] = json!(cid);
            view["workspace"] = metadata["workspace_path"].clone();
            view["conversation_title"] = metadata["title"].clone();
        }
        tasks.extend(requests);
    }
    tasks
}

async fn api_tasks_pending(State(state): State<Arc<AppState>>) -> Json<Value> {
    let tasks = pending_permissions(&state).await;
    Json(json!({"count":tasks.len(),"tasks":tasks}))
}

async fn decide_permission(state: &AppState, body: &Value, approve: bool) -> Response {
    let failure = |status, message| (status, Json(json!({"detail": message}))).into_response();
    let (Some(cid), Some(request)) = (
        body["conversation_id"].as_str(),
        body["request_id"].as_str(),
    ) else {
        return failure(
            StatusCode::BAD_REQUEST,
            "Select a current conversation permission request.",
        );
    };
    let option = match body.get("option_id") {
        Some(Value::String(id)) if !id.is_empty() => Some(id.as_str()),
        Some(Value::Null) | None if !approve => None,
        _ => {
            return failure(
                StatusCode::BAD_REQUEST,
                "Choose an option offered by Antigravity.",
            )
        }
    };
    let client = state.acp_clients.lock().await.get(cid).cloned();
    let stale = || {
        failure(
            StatusCode::CONFLICT,
            "This permission request is no longer pending.",
        )
    };
    let Some(client) = client else { return stale() };
    match client.decide(request, option, approve).await {
        Ok(()) => {
            state.broadcast_json(json!({"type":"PERMISSIONS_CHANGED"}));
            Json(json!({"status":"ok","message":"Decision sent to Antigravity."})).into_response()
        }
        Err(acp::DecisionError::InvalidOption) => failure(
            StatusCode::BAD_REQUEST,
            "Choose an option offered for this request.",
        ),
        Err(acp::DecisionError::Stale) => stale(),
        Err(acp::DecisionError::Disconnected) => {
            client.shutdown().await;
            state.broadcast_json(json!({"type":"PERMISSIONS_CHANGED"}));
            failure(
                StatusCode::BAD_GATEWAY,
                "The decision could not be confirmed. Check the session on the laptop.",
            )
        }
    }
}

async fn api_tasks_approve(
    State(state): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Response {
    decide_permission(&state, &body, true).await
}

async fn api_tasks_reject(State(state): State<Arc<AppState>>, Json(body): Json<Value>) -> Response {
    decide_permission(&state, &body, false).await
}

async fn api_queue_list(State(state): State<Arc<AppState>>) -> Json<Value> {
    let q = state
        .task_queue
        .lock()
        .map(|q| q.clone())
        .unwrap_or_default();
    let cur = state
        .current_active_task
        .lock()
        .ok()
        .and_then(|c| c.clone());
    Json(json!({
        "count": q.len(),
        "queue": q,
        "active_task": cur,
    }))
}

async fn api_queue_clear(State(state): State<Arc<AppState>>) -> Response {
    if let Ok(mut q) = state.task_queue.lock() {
        if q.iter().any(|item| item["status"] == "dispatching") {
            return (
                StatusCode::CONFLICT,
                Json(json!({"detail":"Wait for dispatch to finish before clearing the queue."})),
            )
                .into_response();
        }
        if let Err(e) = state.persist_queue(&[]) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"detail":e.to_string()})),
            )
                .into_response();
        }
        q.clear();
    }
    state.broadcast_json(json!({
        "type": "QUEUE_UPDATED",
        "queue": [],
        "queue_count": 0,
    }));
    Json(json!({"status": "ok", "queue_count": 0})).into_response()
}

async fn api_queue_delete(
    State(state): State<Arc<AppState>>,
    AxumPath(task_id): AxumPath<String>,
) -> Response {
    let q_list = {
        let mut q = state.task_queue.lock().unwrap();
        if q.iter()
            .any(|t| t["id"].as_str() == Some(task_id.as_str()) && t["status"] == "dispatching")
        {
            return (
                StatusCode::CONFLICT,
                Json(json!({"detail":"Wait for this task's dispatch to finish."})),
            )
                .into_response();
        }
        let previous = q.clone();
        q.retain(|t| t.get("id").and_then(|v| v.as_str()) != Some(&task_id));
        if let Err(e) = state.persist_queue(&q) {
            *q = previous;
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"detail":e.to_string()})),
            )
                .into_response();
        }
        q.clone()
    };
    state.broadcast_json(json!({
        "type": "QUEUE_UPDATED",
        "queue": q_list,
        "queue_count": q_list.len(),
    }));
    Json(json!({"status": "ok", "queue_count": q_list.len()})).into_response()
}

async fn api_queue_dispatch(
    State(state): State<Arc<AppState>>,
    AxumPath(task_id): AxumPath<String>,
) -> Response {
    let target = {
        let mut q = state.task_queue.lock().unwrap();
        if let Some(pos) = q
            .iter()
            .position(|t| t.get("id").and_then(|v| v.as_str()) == Some(&task_id))
        {
            if q[pos]["status"] == "dispatching" {
                return (
                    StatusCode::CONFLICT,
                    Json(json!({"detail":"This task is already being dispatched."})),
                )
                    .into_response();
            }
            q[pos]["status"] = json!("dispatching");
            if let Err(e) = state.persist_queue(&q) {
                q[pos]["status"] = json!("queued");
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"detail":e.to_string()})),
                )
                    .into_response();
            }
            Some(q[pos].clone())
        } else {
            None
        }
    };
    let Some(task) = target else {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({"detail": "Queued task not found"})),
        )
            .into_response();
    };
    let mut dispatch_payload = task.clone();
    dispatch_payload["queue_mode"] = json!("send_now");
    if let Some(id) = task["dispatch_request_id"].as_str() {
        dispatch_payload["request_id"] = json!(id);
    }
    let response = api_tasks_submit(State(state.clone()), Json(dispatch_payload)).await;
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), 8 * 1024 * 1024)
        .await
        .unwrap_or_default();
    let body: Value = serde_json::from_slice(&bytes).unwrap_or_else(
        |_| json!({"detail":"Could not read dispatch response.","code":"delivery_uncertain"}),
    );
    let response = (status, Json(body.clone())).into_response();
    {
        let mut queue = state.task_queue.lock().unwrap_or_else(|e| e.into_inner());
        if response.status().is_success() {
            queue.retain(|t| t["id"].as_str() != Some(task_id.as_str()));
        } else {
            if let Some(item) = queue
                .iter_mut()
                .find(|t| t["id"].as_str() == Some(task_id.as_str()))
            {
                item["status"] = json!("queued");
                // Pre-upgrade receipts stored some pre-dispatch failures without a code.
                let old_pre_dispatch = body["code"].is_null()
                    && body["detail"].as_str().is_some_and(|s| {
                        s.starts_with("A task is already using this project.")
                            || s.starts_with("Antigravity language server is unavailable.")
                            || s.starts_with("Antigravity agentapi executable not found.")
                    });
                if old_pre_dispatch
                    || matches!(
                        body["code"].as_str(),
                        Some("model_unavailable" | "workspace_busy" | "delivery_not_started")
                    )
                {
                    item["dispatch_request_id"] = json!(uuid::Uuid::new_v4().to_string());
                }
            }
            if let Err(e) = state.persist_queue(&queue) {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(json!({"detail":format!("Could not save the queue retry state: {e}")})),
                )
                    .into_response();
            }
            return response;
        }
        if let Err(e) = state.persist_queue(&queue) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({"detail":format!("Task was dispatched but queue persistence failed: {e}. Check the IDE before retrying.")}))).into_response();
        }
    }
    let q_list = state
        .task_queue
        .lock()
        .map(|q| q.clone())
        .unwrap_or_default();
    state.broadcast_json(json!({
        "type": "QUEUE_DISPATCHED",
        "task": task,
        "queue": q_list,
        "queue_count": q_list.len(),
    }));
    Json(json!({
        "status": "ok",
        "task": task,
        "queue_count": q_list.len(),
    }))
    .into_response()
}

// ─── IDE, Sound, Command, Upload & Clipboard Endpoints ──────

fn launch_antigravity_ide(workspace: Option<&Path>) -> Result<(), String> {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    let candidates = [
        PathBuf::from(&home).join(r"AppData\Local\Programs\antigravity\Antigravity.exe"),
        PathBuf::from(&home).join(r"AppData\Local\Programs\Antigravity IDE\Antigravity IDE.exe"),
    ];
    for c in candidates {
        if c.exists() {
            let mut cmd = Command::new(c);
            if let Some(w) = workspace {
                cmd.arg(w);
            }
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            return cmd.spawn().map(|_| ()).map_err(|e| e.to_string());
        }
    }
    Err("Antigravity IDE executable not found.".into())
}

async fn api_ide_launch(State(state): State<Arc<AppState>>) -> Json<Value> {
    let ws = state.selected_workspace();
    if let Err(e) = launch_antigravity_ide(Some(&ws)) {
        return Json(json!({"status":"error", "message":e}));
    }
    let msg = "Antigravity opened on the laptop.";
    state.broadcast_json(json!({
        "type": "NOTIFICATION",
        "title": "Antigravity IDE",
        "message": msg,
        "level": "INFO",
    }));
    Json(json!({"status": "ok", "message": msg}))
}

async fn api_ide_open_file(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Json<Value> {
    let fp = payload
        .get("filepath")
        .and_then(|v| v.as_str())
        .unwrap_or("");
    let workspace = state.selected_workspace();
    let path = workspace.join(fp);
    if fp.is_empty()
        || !path
            .canonicalize()
            .ok()
            .zip(workspace.canonicalize().ok())
            .is_some_and(|(p, w)| p.starts_with(w))
        || !state.ws_state.permits(&path)
    {
        return Json(
            json!({"status":"error", "message":"File is missing or outside the allowed project directories."}),
        );
    }
    if let Err(e) = launch_antigravity_ide(Some(&path)) {
        return Json(json!({"status":"error", "message":e}));
    }
    Json(json!({
        "status": "ok",
        "message": format!("File opened in Antigravity on the laptop: {}", fp),
    }))
}

async fn api_sound() -> Response {
    (StatusCode::NOT_IMPLEMENTED, Json(json!({"detail":"Laptop audio is not implemented in the Rust engine. Phone audio remains available."}))).into_response()
}

async fn api_command_exec(
    State(state): State<Arc<AppState>>,
    Json(payload): Json<Value>,
) -> Response {
    let s = get_settings(&state.root);
    if !s.allow_shell {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"detail": "Remote terminal is disabled."})),
        )
            .into_response();
    }
    let command = payload
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    if command.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"detail": "Enter a command first"})),
        )
            .into_response();
    }
    let started = std::time::Instant::now();
    let mut cmd = tokio::process::Command::new("powershell");
    cmd.args(["-NoProfile", "-Command", command])
        .current_dir(state.selected_workspace());
    cmd.kill_on_drop(true);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    let out = match tokio::time::timeout(Duration::from_secs(30), cmd.output()).await {
        Ok(out) => out,
        Err(_) => {
            return (
                StatusCode::GATEWAY_TIMEOUT,
                Json(json!({"detail":"Command exceeded 30 seconds."})),
            )
                .into_response()
        }
    };
    let duration = (started.elapsed().as_secs_f64() * 100.0).round() / 100.0;
    let (code, stdout, stderr) = match out {
        Ok(o) => (
            o.status.code().unwrap_or(0),
            String::from_utf8_lossy(&o.stdout).to_string(),
            String::from_utf8_lossy(&o.stderr).to_string(),
        ),
        Err(e) => (1, String::new(), e.to_string()),
    };
    let res = json!({
        "status": if code == 0 { "ok" } else { "error" },
        "command": command,
        "returncode": code,
        "duration_seconds": duration,
        "stdout": stdout,
        "stderr": stderr,
    });
    state.broadcast_json(json!({
        "type": "COMMAND_RESULT",
        "command": command,
        "duration_seconds": duration,
        "result": res,
    }));
    Json(res).into_response()
}

fn validate_image_magic_bytes(bytes: &[u8]) -> bool {
    if bytes.len() < 8 {
        return false;
    }
    bytes.starts_with(b"\x89PNG\r\n\x1a\n")
        || bytes.starts_with(b"\xff\xd8\xff")
        || (bytes.starts_with(b"RIFF") && bytes.len() >= 12 && &bytes[8..12] == b"WEBP")
        || bytes.starts_with(b"GIF87a")
        || bytes.starts_with(b"GIF89a")
}

async fn api_upload(State(state): State<Arc<AppState>>, mut multipart: Multipart) -> Response {
    let field = match multipart.next_field().await {
        Ok(Some(field)) => field,
        Ok(None) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"detail":"No image was uploaded."})),
            )
                .into_response()
        }
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"detail":e.to_string()})),
            )
                .into_response()
        }
    };
    let data = match field.bytes().await {
        Ok(data) => data,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({"detail":e.to_string()})),
            )
                .into_response()
        }
    };
    if data.len() > 12 * 1024 * 1024 {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"detail": "File size exceeds the 12 MiB limit."})),
        )
            .into_response();
    }
    if !validate_image_magic_bytes(&data) {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"detail": "Upload a valid image file (PNG, JPEG, WebP or GIF)."})),
        )
            .into_response();
    }
    let extension = if data.starts_with(b"\x89PNG") {
        "png"
    } else if data.starts_with(b"\xff\xd8\xff") {
        "jpg"
    } else if data.starts_with(b"RIFF") {
        "webp"
    } else {
        "gif"
    };
    let fname = format!("{}.{}", uuid::Uuid::new_v4().simple(), extension);
    let save_path = state.root.join("uploads").join(&fname);
    if let Err(e) = fs::write(&save_path, &data) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({"detail":format!("Could not save image: {e}")})),
        )
            .into_response();
    }
    Json(json!({
        "status": "ok",
        "filename": fname,
        "file_url": format!("/uploads/{}", fname),
        "file_path": save_path.to_string_lossy(),
    }))
    .into_response()
}

async fn api_upload_delete(
    State(state): State<Arc<AppState>>,
    AxumPath(filename): AxumPath<String>,
) -> Json<Value> {
    let safe_name = Path::new(&filename)
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("");
    let target = state.root.join("uploads").join(safe_name);
    let deleted = fs::remove_file(target).is_ok();
    Json(json!({"status": "ok", "deleted": deleted, "filename": safe_name}))
}

async fn api_clipboard_get() -> Response {
    (
        StatusCode::NOT_IMPLEMENTED,
        Json(json!({"detail":"Windows clipboard access is not implemented in the Rust engine."})),
    )
        .into_response()
}

async fn api_clipboard_set() -> Response {
    api_clipboard_get().await
}

// ─── WebSocket Endpoint (/ws) ────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
    axum::Extension(token): axum::Extension<security::WsPairingToken>,
) -> impl IntoResponse {
    ws.max_message_size(64 * 1024)
        .max_frame_size(64 * 1024)
        .on_upgrade(move |socket| handle_ws(socket, state, token.0))
}

async fn handle_ws(socket: WebSocket, state: Arc<AppState>, connected_token: String) {
    let mut pairing_epoch = state.pairing_epoch.subscribe();
    if load_token(&state.root, false) != connected_token {
        return;
    }
    let (mut sender, mut receiver) = socket.split();
    let mut bcast_rx = state.tx.subscribe();

    // Send INITIAL_STATE immediately on connect
    let active_id = state.conv_mgr.get_active_id();
    let active_conv = active_id
        .as_deref()
        .and_then(|cid| state.conv_mgr.get_conversation(cid));
    let init_changes = WorkspaceState::get_git_changes(&state.selected_workspace());
    let telemetry = state.monitor.get_telemetry();
    let token_quota = state.monitor.get_token_quota_stats().await;
    let account = state.monitor.get_user_account_info().await;
    let skills = WorkspaceState::discover_skills();
    let convs = state.conv_mgr.list_conversations();
    let q_list = state
        .task_queue
        .lock()
        .map(|q| q.clone())
        .unwrap_or_default();

    let init_msg = json!({
        "type": "INITIAL_STATE",
        "telemetry": telemetry,
        "token_quota": token_quota,
        "account": account,
        "pending_tasks": [],
        "permissions": pending_permissions(&state).await,
        "skills": skills,
        "conversations": convs,
        "active_id": active_id,
        "active_conversation": active_conv,
        "queue": q_list,
        "queue_count": q_list.len(),
        "changes": init_changes,
    });
    if pairing_epoch.has_changed().unwrap_or(true) {
        return;
    }
    if let Ok(s) = serde_json::to_string(&init_msg) {
        let _ = sender.send(Message::Text(s)).await;
    }

    let state_for_recv = state.clone();
    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    let mut last_pong = tokio::time::Instant::now();
    loop {
        tokio::select! {
            biased;
            _ = pairing_epoch.changed() => break,
            _ = heartbeat.tick() => {
                if load_token(&state.root, false) != connected_token || last_pong.elapsed() > Duration::from_secs(45) { break; }
                if sender.send(Message::Ping(Vec::new())).await.is_err() { break; }
            }
            Ok(msg_str) = bcast_rx.recv() => {
                if sender.send(Message::Text(msg_str)).await.is_err() {
                    break;
                }
            }
            incoming = receiver.next() => {
                let msg = match incoming {
                    Some(Ok(Message::Close(_))) | Some(Err(_)) | None => break,
                    Some(Ok(Message::Pong(_))) => { last_pong = tokio::time::Instant::now(); continue; },
                    Some(Ok(msg)) => msg,
                };
                if let Message::Text(txt) = msg {
                    if let Ok(data) = serde_json::from_str::<Value>(&txt) {
                        let mtype = data.get("type").and_then(|v| v.as_str()).unwrap_or("");
                        match mtype {
                            "PING" => {
                                let pong = json!({
                                    "type": "PONG",
                                    "telemetry": state_for_recv.monitor.get_telemetry(),
                                    "token_quota": state_for_recv.monitor.get_token_quota_stats().await,
                                    "account": state_for_recv.monitor.get_user_account_info().await,
                                });
                                if let Ok(s) = serde_json::to_string(&pong) {
                                    let _ = sender.send(Message::Text(s)).await;
                                }
                            }
                            "GET_CHANGES" => {
                                let c = WorkspaceState::get_git_changes(&state_for_recv.selected_workspace());
                                let reply = json!({"type": "CHANGES_UPDATED", "changes": c});
                                if let Ok(s) = serde_json::to_string(&reply) {
                                    let _ = sender.send(Message::Text(s)).await;
                                }
                            }
                            "GET_ACCOUNT" => {
                                let reply = json!({
                                    "type": "ACCOUNT_UPDATED",
                                    "account": state_for_recv.monitor.get_user_account_info().await,
                                    "token_quota": state_for_recv.monitor.get_token_quota_stats().await,
                                });
                                if let Ok(s) = serde_json::to_string(&reply) {
                                    let _ = sender.send(Message::Text(s)).await;
                                }
                            }
                            "LAUNCH_IDE" => {
                                let result = launch_antigravity_ide(Some(&state_for_recv.selected_workspace()));
                                let reply = json!({"type": "NOTIFICATION", "message": result.err().unwrap_or_else(|| "Antigravity opened on the laptop.".into())});
                                if let Ok(s) = serde_json::to_string(&reply) {
                                    let _ = sender.send(Message::Text(s)).await;
                                }
                            }
                            _ => {}
                        }
                    }
                }
            }
            else => break,
        }
    }
}

#[cfg(test)]
mod agent_protocol_tests {
    use super::*;
    #[test]
    fn stdout_errors_cannot_be_treated_as_acknowledgments() {
        assert!(parse_agentapi_output(
            br#"{"response":{},"error":"model unavailable"}"#,
            b"",
            true
        )
        .unwrap_err()
        .contains("model unavailable"));
        assert!(parse_agentapi_output(br#"{"response":{"accepted":true}}"#, b"", true).is_ok());
    }
    #[test]
    fn only_valid_native_session_ids_are_persisted() {
        let id = "11111111-2222-4333-8444-555555555555";
        assert_eq!(
            native_conversation_id(&json!({"response":{"conversation_id":id}})).as_deref(),
            Some(id)
        );
        assert!(
            native_conversation_id(&json!({"response":{"conversation_id":"../private"}})).is_none()
        );
    }

    #[test]
    fn changes_scope_requires_explicit_bulk_or_valid_file_path() {
        assert!(matches!(
            parse_git_change_scope(&json!({"file_path": "all"})),
            Ok(GitChangeScope::File("all"))
        ));
        assert!(matches!(
            parse_git_change_scope(&json!({"scope": "file", "file_path": "all"})),
            Ok(GitChangeScope::File("all"))
        ));
        assert!(matches!(
            parse_git_change_scope(&json!({"scope": "all"})),
            Ok(GitChangeScope::All)
        ));
        assert!(matches!(
            parse_git_change_scope(&json!({"scope": "all", "file_path": null})),
            Ok(GitChangeScope::All)
        ));

        for (invalid, expected) in [
            (
                json!({}),
                "Provide a valid file_path or set scope to 'all'.",
            ),
            (
                json!({"file_path": null}),
                "Provide a valid file_path or set scope to 'all'.",
            ),
            (
                json!({"file_path": ""}),
                "Provide a valid file_path or set scope to 'all'.",
            ),
            (
                json!({"file_path": "../escape"}),
                "Provide a valid file_path or set scope to 'all'.",
            ),
            (
                json!({"scope": "all", "file_path": "foo.txt"}),
                "Do not pass file_path when scope is 'all'.",
            ),
            (
                json!({"scope": "all", "file_path": "all"}),
                "Do not pass file_path when scope is 'all'.",
            ),
            (
                json!({"scope": "bogus", "file_path": "foo.txt"}),
                "Invalid scope. Expected 'file' or 'all'.",
            ),
        ] {
            assert_eq!(parse_git_change_scope(&invalid).err(), Some(expected));
        }
    }
}
