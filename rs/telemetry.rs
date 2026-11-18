use crate::security::get_settings;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use chrono::Local;
use qrcode::{Color, QrCode};
use serde_json::{json, Value};
use std::{
    fs,
    io::{Read, Seek, SeekFrom},
    net::UdpSocket,
    path::PathBuf,
    process::Command,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use sysinfo::System;

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;

type LanguageServerCache = Option<(Instant, Option<(String, String)>)>;

#[derive(Debug)]
pub struct RpcFailure {
    pub message: String,
    pub unavailable: bool,
}

impl From<String> for RpcFailure {
    fn from(message: String) -> Self {
        Self {
            message,
            unavailable: false,
        }
    }
}

impl From<&str> for RpcFailure {
    fn from(message: &str) -> Self {
        message.to_string().into()
    }
}

fn runtime_credentials(
    name: &str,
    args: &[String],
    parent: Option<&str>,
) -> Option<(String, bool)> {
    let name = name.to_lowercase();
    let hub = matches!(name.as_str(), "agy.exe" | "agy")
        && args.iter().any(|arg| arg == "--hub")
        && parent.is_some_and(|name| name.to_lowercase().contains("antigravity"));
    if !name.contains("language_server") && !hub {
        return None;
    }
    let csrf = args.iter().enumerate().find_map(|(index, arg)| {
        if arg == "--csrf_token" {
            args.get(index + 1).cloned()
        } else {
            arg.strip_prefix("--csrf_token=").map(String::from)
        }
    })?;
    Some((csrf, hub || args.iter().any(|arg| arg == "--standalone")))
}

fn advertised_desktop_address(log: &str) -> Option<String> {
    // Standalone Antigravity advertises its dynamically allocated port here.
    // Read only loopback URLs, then authenticate against the live process token.
    let line = log
        .lines()
        .rev()
        .find(|line| line.contains("Local:") && line.contains("https://127.0.0.1:"))?;
    let start = line.find("https://127.0.0.1:")?;
    let port: String = line[start + "https://127.0.0.1:".len()..]
        .chars()
        .take_while(char::is_ascii_digit)
        .collect();
    let port = port.parse::<u16>().ok().filter(|p| *p > 0)?;
    Some(format!("https://127.0.0.1:{port}"))
}

pub struct TelemetryMonitor {
    pub root: PathBuf,
    pub port: u16,
    pub start_instant: Instant,
    sys: Mutex<System>,
    ls_cache: Mutex<LanguageServerCache>,
    quota_cache: Mutex<Option<(Instant, Value)>>,
    account_cache: Mutex<Option<(Instant, Value)>>,
    qr_cache: Mutex<Option<(String, String)>>,
    pub model_cache: tokio::sync::Mutex<std::collections::HashMap<String, (Instant, Value)>>,
    client: reqwest::Client,
}

impl TelemetryMonitor {
    pub fn new(root: PathBuf, port: u16) -> Self {
        let mut sys = System::new_all();
        sys.refresh_cpu_usage();
        sys.refresh_memory();
        let client = reqwest::Client::builder()
            .timeout(Duration::from_millis(2000))
            // Only used against process-owned loopback RPC endpoints. Standalone
            // Antigravity serves HTTPS with a locally generated certificate.
            .danger_accept_invalid_certs(true)
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .unwrap_or_default();
        Self {
            root,
            port,
            start_instant: Instant::now(),
            sys: Mutex::new(sys),
            ls_cache: Mutex::new(None),
            quota_cache: Mutex::new(None),
            account_cache: Mutex::new(None),
            qr_cache: Mutex::new(None),
            model_cache: tokio::sync::Mutex::new(std::collections::HashMap::new()),
            client,
        }
    }

    pub fn get_local_ips(&self) -> Vec<String> {
        let mut ips = Vec::new();
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            if sock.connect("8.8.8.8:80").is_ok() {
                if let Ok(local_addr) = sock.local_addr() {
                    let ip_str = local_addr.ip().to_string();
                    if !ip_str.starts_with("127.") {
                        ips.push(ip_str);
                    }
                }
            }
        }
        if ips.is_empty() {
            ips.push("127.0.0.1".to_string());
        }
        ips
    }

    pub fn get_tailscale_info(&self) -> Value {
        let exe_candidates = [r"C:\Program Files\Tailscale\tailscale.exe", "tailscale"];
        for exe in exe_candidates {
            let mut cmd = Command::new(exe);
            cmd.args(["ip", "-4"]);
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            if let Ok(out) = cmd.output() {
                if out.status.success() {
                    let stdout = String::from_utf8_lossy(&out.stdout);
                    if let Some(ip) = stdout
                        .lines()
                        .next()
                        .map(|s| s.trim())
                        .filter(|s| !s.is_empty())
                    {
                        return json!({
                            "installed": true,
                            "ip": ip,
                        });
                    }
                }
                return json!({ "installed": true, "ip": Value::Null });
            }
        }
        json!({ "installed": false, "ip": Value::Null })
    }

    pub fn get_tunnel_url(&self) -> Option<String> {
        let s = get_settings(&self.root);
        if s.remote_mode != "tunnel" {
            return None;
        }
        let tf = self.root.join("tunnel_url.txt");
        let raw = fs::read_to_string(tf).ok()?;
        let url = reqwest::Url::parse(raw.trim()).ok()?;
        (url.scheme() == "https"
            && url.has_host()
            && url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none())
        .then(|| url.as_str().trim_end_matches('/').to_owned())
    }

    pub fn access_url(&self, mode: &str, ips: &[String], tailscale: &Value) -> Option<String> {
        match mode {
            "tunnel" => self.get_tunnel_url(),
            "tailscale" => tailscale["ip"]
                .as_str()
                .map(|ip| format!("http://{}:{}", ip, self.port)),
            "lan" => ips
                .iter()
                .find(|ip| ip.as_str() != "127.0.0.1")
                .map(|ip| format!("http://{}:{}", ip, self.port)),
            _ => None,
        }
    }

    pub fn get_primary_access_url(&self) -> Option<String> {
        let mode = get_settings(&self.root).remote_mode;
        let ts = if mode == "tailscale" {
            self.get_tailscale_info()
        } else {
            Value::Null
        };
        self.access_url(&mode, &self.get_local_ips(), &ts)
    }

    pub fn unavailable_reason(mode: &str) -> &'static str {
        match mode {
            "tunnel" => "Configure an HTTPS public link in tunnel_url.txt on the laptop, or choose This Wi-Fi only.",
            "tailscale" => "Connect Tailscale on the laptop, or choose This Wi-Fi only.",
            _ => "Connect the laptop to a network and refresh to get a phone address.",
        }
    }

    pub fn get_qr_data_url(&self, url: &str) -> Option<String> {
        if let Ok(cache) = self.qr_cache.lock() {
            if let Some((cached_url, cached_data)) = cache.as_ref() {
                if cached_url == url {
                    return Some(cached_data.clone());
                }
            }
        }

        let svg = match QrCode::new(url.as_bytes()) {
            Ok(code) => {
                let width = code.width();
                let border = 2usize;
                let total = width + border * 2;
                let scale = 6usize;
                let px = total * scale;
                let mut paths = String::new();
                for y in 0..width {
                    for x in 0..width {
                        if code[(x, y)] == Color::Dark {
                            let rx = (x + border) * scale;
                            let ry = (y + border) * scale;
                            paths.push_str(&format!(
                                "M{} {}h{}v{}h-{}z",
                                rx, ry, scale, scale, scale
                            ));
                        }
                    }
                }
                format!(
                    "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {px} {px}\" width=\"{px}\" height=\"{px}\" shape-rendering=\"crispEdges\"><rect width=\"100%\" height=\"100%\" fill=\"white\"/><path d=\"{paths}\" fill=\"black\"/></svg>"
                )
            }
            Err(_) => return None,
        };

        let data_url = format!(
            "data:image/svg+xml;base64,{}",
            BASE64.encode(svg.as_bytes())
        );
        if let Ok(mut cache) = self.qr_cache.lock() {
            *cache = Some((url.to_owned(), data_url.clone()));
        }
        Some(data_url)
    }

    pub fn invalidate_qr_cache(&self) {
        if let Ok(mut cache) = self.qr_cache.lock() {
            *cache = None;
        }
    }

    pub async fn find_language_server(&self) -> Option<(String, String)> {
        if let Ok(cache) = self.ls_cache.lock() {
            if let Some((ts, ref val)) = *cache {
                if ts.elapsed() < Duration::from_secs(5) {
                    return val.clone();
                }
            }
        }

        if let (Ok(addr), Ok(csrf)) = (
            std::env::var("ANTIGRAVITY_LS_ADDRESS"),
            std::env::var("ANTIGRAVITY_CSRF_TOKEN"),
        ) {
            if let Ok(url) = reqwest::Url::parse(&addr) {
                if matches!(url.scheme(), "http" | "https")
                    && matches!(url.host_str(), Some("127.0.0.1" | "localhost" | "[::1]"))
                    && url.port().is_some()
                {
                    let res = Some((
                        format!("{}://127.0.0.1:{}", url.scheme(), url.port()?),
                        csrf,
                    ));
                    if let Ok(mut cache) = self.ls_cache.lock() {
                        *cache = Some((Instant::now(), res.clone()));
                    }
                    return res;
                }
            }
        }

        let mut ls_pids: Vec<(u32, String, bool)> = Vec::new();
        if let Ok(mut sys) = self.sys.lock() {
            sys.refresh_processes();
            for (pid, proc_info) in sys.processes() {
                let parent = proc_info
                    .parent()
                    .and_then(|id| sys.process(id))
                    .map(|p| p.name());
                if let Some((token, desktop)) =
                    runtime_credentials(proc_info.name(), proc_info.cmd(), parent)
                {
                    ls_pids.push((pid.as_u32(), token, desktop));
                }
            }
        }

        if !ls_pids.is_empty() {
            // Prefer the desktop account over unrelated CLI background runtimes.
            ls_pids.sort_by_key(|(_, _, standalone)| !*standalone);
            let desktop_address = std::env::var_os("APPDATA").and_then(|dir| {
                let mut file =
                    fs::File::open(PathBuf::from(dir).join("Antigravity/logs/main.log")).ok()?;
                let length = file.metadata().ok()?.len();
                file.seek(SeekFrom::Start(length.saturating_sub(64 * 1024)))
                    .ok()?;
                let mut tail = Vec::new();
                file.take(64 * 1024).read_to_end(&mut tail).ok()?;
                advertised_desktop_address(&String::from_utf8_lossy(&tail))
            });
            for (_, csrf, standalone) in &ls_pids {
                if let Some(address) = desktop_address.as_ref().filter(|_| *standalone) {
                    if self
                        .rpc_at(
                            address,
                            csrf,
                            "GetUserStatus",
                            &json!({}),
                            Duration::from_secs(2),
                        )
                        .await
                        .is_ok_and(|v| v["userStatus"].is_object())
                    {
                        let found = Some((address.clone(), csrf.clone()));
                        if let Ok(mut cache) = self.ls_cache.lock() {
                            *cache = Some((Instant::now(), found.clone()));
                        }
                        return found;
                    }
                }
            }
            let mut cmd = Command::new("netstat");
            cmd.args(["-ano"]);
            #[cfg(windows)]
            cmd.creation_flags(CREATE_NO_WINDOW);
            if let Ok(out) = cmd.output() {
                let text = String::from_utf8_lossy(&out.stdout);
                for (pid, csrf, _) in &ls_pids {
                    let pid_str = pid.to_string();
                    for line in text.lines() {
                        if line.contains("LISTENING") {
                            let parts: Vec<&str> = line.split_whitespace().collect();
                            if parts.len() >= 5 && parts[parts.len() - 1] == pid_str {
                                if let Some(port_str) = parts[1].rsplit(':').next() {
                                    if let Ok(port) = port_str.parse::<u16>() {
                                        for scheme in ["https", "http"] {
                                            let address = format!("{scheme}://127.0.0.1:{port}");
                                            if self
                                                .rpc_at(
                                                    &address,
                                                    csrf,
                                                    "GetUserStatus",
                                                    &json!({}),
                                                    Duration::from_millis(600),
                                                )
                                                .await
                                                .is_ok_and(|v| v["userStatus"].is_object())
                                            {
                                                let found = Some((address, csrf.clone()));
                                                if let Ok(mut cache) = self.ls_cache.lock() {
                                                    *cache = Some((Instant::now(), found.clone()));
                                                }
                                                return found;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }

        if let Ok(mut cache) = self.ls_cache.lock() {
            *cache = Some((Instant::now(), None));
        }
        None
    }

    async fn rpc_at(
        &self,
        address: &str,
        csrf: &str,
        method: &str,
        payload: &Value,
        timeout: Duration,
    ) -> Result<Value, RpcFailure> {
        let response = self
            .client
            .post(format!(
                "{address}/exa.language_server_pb.LanguageServerService/{method}"
            ))
            .header("Connect-Protocol-Version", "1")
            .header("X-Codeium-Csrf-Token", csrf)
            .json(payload)
            .timeout(timeout)
            .send()
            .await
            .map_err(|_| RpcFailure {
                message: "Antigravity runtime is unreachable or timed out.".into(),
                unavailable: true,
            })?;
        if !response.status().is_success() {
            return Err(format!(
                "Antigravity rejected {method} (HTTP {}).",
                response.status().as_u16()
            )
            .into());
        }
        if response
            .content_length()
            .is_some_and(|n| n > 4 * 1024 * 1024)
        {
            return Err("Antigravity RPC response exceeded the size limit.".into());
        }
        let mut response = response;
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Antigravity response was interrupted.")?
        {
            if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
                return Err("Antigravity RPC response exceeded the size limit.".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let value: Value = serde_json::from_slice(&bytes)
            .map_err(|_| "Antigravity returned an incompatible RPC response.")?;
        if !value.is_object()
            || value.get("error").is_some_and(|e| !e.is_null())
            || value.get("code").is_some()
        {
            return Err("Antigravity reported an RPC error. Check the laptop runtime.".into());
        }
        Ok(value)
    }

    pub async fn rpc(&self, method: &str, payload: &Value) -> Result<Value, String> {
        self.rpc_with_failure(method, payload)
            .await
            .map_err(|error| error.message)
    }

    pub async fn rpc_with_failure(
        &self,
        method: &str,
        payload: &Value,
    ) -> Result<Value, RpcFailure> {
        let (address, csrf) = self
            .find_language_server()
            .await
            .ok_or_else(|| RpcFailure {
                message: "Open Antigravity on the laptop to connect.".into(),
                unavailable: true,
            })?;
        let timeout = if method.starts_with("Get") || method.starts_with("Retrieve") {
            3
        } else {
            25
        };
        let result = self
            .rpc_at(
                &address,
                &csrf,
                method,
                payload,
                Duration::from_secs(timeout),
            )
            .await;
        if result.is_err() {
            if let Ok(mut cache) = self.ls_cache.lock() {
                *cache = None;
            }
        }
        result
    }

    pub fn get_telemetry(&self) -> Value {
        let (cpu_pct, used_mb, total_mb, mem_pct, ag_running, ag_count, ag_pid) = {
            if let Ok(mut sys) = self.sys.lock() {
                sys.refresh_cpu_usage();
                sys.refresh_memory();
                sys.refresh_processes();
                let cpu = (sys.global_cpu_info().cpu_usage() * 10.0).round() / 10.0;
                let used = (sys.used_memory() as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0;
                let total = (sys.total_memory() as f64 / (1024.0 * 1024.0) * 10.0).round() / 10.0;
                let pct = if total > 0.0 {
                    ((used / total) * 1000.0).round() / 10.0
                } else {
                    0.0
                };
                let mut ag_procs = Vec::new();
                for (pid, p) in sys.processes() {
                    let n = p.name().to_lowercase();
                    if n.contains("antigravity") {
                        ag_procs.push(pid.as_u32());
                    }
                }
                (
                    cpu,
                    used,
                    total,
                    pct,
                    !ag_procs.is_empty(),
                    ag_procs.len(),
                    ag_procs.first().copied(),
                )
            } else {
                (0.0, 0.0, 0.0, 0.0, false, 0, None)
            }
        };

        let uptime_secs = self.start_instant.elapsed().as_secs();
        let boot_secs = System::uptime();
        let now_ts = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs_f64();
        let hostname = System::host_name().unwrap_or_else(|| "Windows-PC".to_string());

        json!({
            "status": "online",
            "engine": "rust-axum",
            "hostname": hostname,
            "os": "Windows",
            "timestamp": now_ts,
            "access_url": self.get_primary_access_url(),
            "tunnel_url": self.get_tunnel_url(),
            "local_ips": self.get_local_ips(),
            "battery": {
                "has_battery": false,
                "percent": Value::Null,
                "is_plugged": Value::Null,
                "secs_left": Value::Null,
            },
            "cpu_percent": cpu_pct,
            "memory": {
                "percent": mem_pct,
                "used_mb": used_mb,
                "total_mb": total_mb,
            },
            "antigravity": {
                "is_running": ag_running,
                "process_count": ag_count,
                "primary_pid": ag_pid,
            },
            "bridge_uptime": format!("{}m {}s", uptime_secs / 60, uptime_secs % 60),
            "system_uptime": format!("{}h {}m", boot_secs / 3600, (boot_secs % 3600) / 60),
        })
    }

    fn accounts_registry_path(&self) -> PathBuf {
        let dir = self.root.join("conversations");
        let _ = fs::create_dir_all(&dir);
        dir.join("accounts_registry.json")
    }

    pub fn load_saved_accounts(&self) -> Vec<Value> {
        let p = self.accounts_registry_path();
        if let Ok(raw) = fs::read_to_string(p) {
            if let Ok(arr) = serde_json::from_str::<Vec<Value>>(&raw) {
                return arr;
            }
        }
        Vec::new()
    }

    pub fn save_accounts_registry(&self, accounts: &[Value]) {
        let p = self.accounts_registry_path();
        if let Ok(s) = serde_json::to_string_pretty(accounts) {
            let _ = crate::storage::atomic_write(&p, s.as_bytes());
        }
    }

    pub async fn get_user_account_info(&self) -> Value {
        if let Ok(cache) = self.account_cache.lock() {
            if let Some((ts, ref val)) = *cache {
                if ts.elapsed() < Duration::from_secs(4) {
                    return val.clone();
                }
            }
        }

        let mut saved = self.load_saved_accounts();
        let active_idx = saved.iter().position(|a| {
            a.get("is_active")
                .and_then(|v| v.as_bool())
                .unwrap_or(false)
        });
        let active_acc = if let Some(idx) = active_idx {
            saved.get(idx).cloned()
        } else if !saved.is_empty() {
            if let Some(first) = saved.first_mut() {
                if let Some(obj) = first.as_object_mut() {
                    obj.insert("is_active".to_string(), json!(true));
                }
            }
            self.save_accounts_registry(&saved);
            saved.first().cloned()
        } else {
            None
        };

        let mut name = active_acc
            .as_ref()
            .and_then(|a| a.get("name"))
            .and_then(|v| v.as_str())
            .unwrap_or("Antigravity User")
            .to_string();
        let mut email = active_acc
            .as_ref()
            .and_then(|a| a.get("email"))
            .and_then(|v| v.as_str())
            .unwrap_or("No active account")
            .to_string();
        let mut plan = active_acc
            .as_ref()
            .and_then(|a| a.get("plan"))
            .and_then(|v| v.as_str())
            .unwrap_or("Unknown plan")
            .to_string();
        let mut tier_id = active_acc
            .as_ref()
            .and_then(|a| a.get("tier_id"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let avatar_url = active_acc
            .as_ref()
            .and_then(|a| a.get("avatar_url"))
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let ls = self.find_language_server().await;
        let mut live_account = false;
        if let Some((ref address, ref csrf)) = ls {
            if let Ok(body) = self
                .rpc_at(
                    address,
                    csrf,
                    "GetUserStatus",
                    &json!({}),
                    Duration::from_secs(2),
                )
                .await
            {
                if let Some(us) = body.get("userStatus") {
                    if us
                        .get("email")
                        .and_then(Value::as_str)
                        .is_some_and(|e| e.contains('@'))
                    {
                        live_account = true;
                        if let Some(n) = us.get("name").and_then(|v| v.as_str()) {
                            name = n.to_string();
                        }
                        if let Some(e) = us.get("email").and_then(|v| v.as_str()) {
                            email = e.to_string();
                        }
                        if let Some(p) = us
                            .get("userTier")
                            .and_then(|t| t.get("name"))
                            .and_then(|v| v.as_str())
                        {
                            plan = p.to_string();
                        }
                        if let Some(tid) = us
                            .get("userTier")
                            .and_then(|t| t.get("id"))
                            .and_then(|v| v.as_str())
                        {
                            tier_id = tid.to_string();
                        }
                    }
                }
            }
        }

        let res = json!({
            "name": name,
            "email": email,
            "avatar_url": avatar_url,
            "plan": plan,
            "tier_id": tier_id,
            "connected": live_account,
            "is_logged_in": live_account,
            "port": ls.and_then(|(a, _)| reqwest::Url::parse(&a).ok().and_then(|u| u.port())),
            "saved_accounts": saved,
        });

        if let Ok(mut cache) = self.account_cache.lock() {
            *cache = Some((Instant::now(), res.clone()));
        }
        res
    }

    pub async fn get_token_quota_stats(&self) -> Value {
        if let Ok(cache) = self.quota_cache.lock() {
            if let Some((ts, ref val)) = *cache {
                if ts.elapsed() < Duration::from_secs(4) {
                    return val.clone();
                }
            }
        }

        let acc = self.get_user_account_info().await;
        let email = acc
            .get("email")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let last_sync = Local::now().format("%H:%M:%S").to_string();

        let live = self.rpc("RetrieveUserQuotaSummary", &json!({})).await.ok();
        let normalized = live.as_ref().and_then(normalize_quota_groups);
        let is_live = normalized.is_some();
        let model_quotas = normalized
            .unwrap_or_else(|| normalize_quota_groups(&json!({"response":{"groups":[]}})).unwrap());

        let res = json!({
            "five_hours": {
                "total_tokens": Value::Null,
                "input_tokens": Value::Null,
                "output_tokens": Value::Null,
                "cached_tokens": Value::Null,
                "thinking_tokens": Value::Null,
                "turn_count": Value::Null,
                "sessions_count": Value::Null,
                "formatted_total": "--",
                "status": "Unavailable",
            },
            "weekly": {
                "total_tokens": Value::Null,
                "input_tokens": Value::Null,
                "output_tokens": Value::Null,
                "cached_tokens": Value::Null,
                "thinking_tokens": Value::Null,
                "turn_count": Value::Null,
                "sessions_count": Value::Null,
                "formatted_total": "--",
            },
            "active_model": Value::Null,
            "last_sync": last_sync,
            "models_quota": model_quotas,
            "quota_groups": live.as_ref().and_then(normalize_quota_list).unwrap_or_default(),
            "quota_message": if is_live { "Usage synced from Antigravity." } else { "Quota unavailable. Open the standalone Antigravity App on the laptop to sync usage." },
            "account": acc,
            "account_email": email,
            "is_live": is_live,
        });

        if let Ok(mut cache) = self.quota_cache.lock() {
            *cache = Some((Instant::now(), res.clone()));
        }
        res
    }

    pub fn invalidate_account_caches(&self) {
        if let Ok(mut c) = self.account_cache.lock() {
            *c = None;
        }
        if let Ok(mut c) = self.quota_cache.lock() {
            *c = None;
        }
    }
}

fn normalize_quota_list(body: &Value) -> Option<Vec<Value>> {
    let groups = body.get("response")?.get("groups")?.as_array()?;
    Some(groups.iter().enumerate().map(|(index, group)| {
        let buckets = group["buckets"].as_array().into_iter().flatten().enumerate().map(|(bucket_index, bucket)| {
            let disabled = bucket["disabled"].as_bool().unwrap_or(false);
            let pct = bucket["remainingFraction"].as_f64()
                .filter(|value| value.is_finite() && (0.0..=1.0).contains(value) && !disabled)
                .map(|value| (value * 1000.0).round() / 10.0);
            json!({"id":bucket["bucketId"].as_str().map(String::from).unwrap_or_else(||bucket_index.to_string()),
                "window":bucket["window"],"title":bucket["displayName"],"description":bucket["description"],
                "remaining_pct":pct,"disabled":disabled,"available":true,"reset_time":bucket["resetTime"]})
        }).collect::<Vec<_>>();
        json!({"id":group["groupId"].as_str().map(String::from).unwrap_or_else(||index.to_string()),
            "title":group["displayName"].as_str().unwrap_or("Model usage"),"description":group["description"],"buckets":buckets})
    }).collect())
}

fn normalize_quota_groups(body: &Value) -> Option<Value> {
    let groups = body.get("response")?.get("groups")?.as_array()?;
    let mut result = json!({});
    for (key, title) in [
        ("gemini_models", "Gemini models"),
        ("claude_gpt_models", "Claude and GPT models"),
        ("argon_models", "Gemini 4 Argon"),
    ] {
        let unknown = json!({"remaining_pct":null,"refresh_text":"Not reported by Antigravity.","available":false,"disabled":false});
        result[key] = json!({"title":title,"weekly":unknown.clone(),"five_hour":unknown});
    }
    for group in groups {
        let name = group["displayName"].as_str().unwrap_or("").to_lowercase();
        let key = if name.contains("argon") {
            "argon_models"
        } else if name.contains("gemini") {
            "gemini_models"
        } else if name.contains("claude") || name.contains("gpt") {
            "claude_gpt_models"
        } else {
            continue;
        };
        result[key]["description"] = group["description"].clone();
        for bucket in group["buckets"].as_array().into_iter().flatten() {
            let window = bucket["window"]
                .as_str()
                .or_else(|| bucket["bucketId"].as_str())
                .unwrap_or("");
            let period = if window.contains("weekly") {
                "weekly"
            } else if window.contains("5h") {
                "five_hour"
            } else {
                continue;
            };
            let disabled = bucket["disabled"].as_bool().unwrap_or(false);
            let pct = bucket["remainingFraction"]
                .as_f64()
                .filter(|value| value.is_finite() && (0.0..=1.0).contains(value) && !disabled)
                .map(|value| (value * 1000.0).round() / 10.0);
            let description = bucket["description"]
                .as_str()
                .filter(|text| !text.is_empty())
                .unwrap_or(if disabled {
                    "This limit does not currently apply."
                } else if pct.is_some() {
                    "Reported by Antigravity."
                } else {
                    "Not reported by Antigravity."
                });
            result[key][period] = json!({"remaining_pct":pct,"refresh_text":description,
                "available":true,"disabled":disabled,"reset_time":bucket["resetTime"]});
        }
    }
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pairing_address_requires_the_selected_network() {
        let monitor = TelemetryMonitor::new(PathBuf::new(), 8000);
        let lan = vec!["192.168.1.12".to_owned()];
        assert_eq!(monitor.access_url("tailscale", &lan, &Value::Null), None);
        assert_eq!(
            monitor
                .access_url("tailscale", &lan, &json!({"ip":"100.64.1.2"}))
                .as_deref(),
            Some("http://100.64.1.2:8000")
        );
        assert_eq!(
            monitor.access_url("lan", &lan, &Value::Null).as_deref(),
            Some("http://192.168.1.12:8000")
        );
        assert_eq!(
            monitor.access_url("lan", &["127.0.0.1".into()], &Value::Null),
            None
        );
    }

    #[test]
    fn ide_owned_hubs_and_legacy_servers_are_discovered_without_plain_cli_sessions() {
        let args = vec!["--hub".into(), "--csrf_token=fixture".into()];
        assert_eq!(
            runtime_credentials("agy.exe", &args, Some("Antigravity IDE.exe")),
            Some(("fixture".into(), true))
        );
        assert!(runtime_credentials("agy.exe", &args, Some("powershell.exe")).is_none());
        assert!(
            runtime_credentials("agy.exe", &["acp".into()], Some("Antigravity IDE.exe")).is_none()
        );
        assert_eq!(
            runtime_credentials(
                "language_server.exe",
                &["--csrf_token".into(), "legacy".into()],
                None
            ),
            Some(("legacy".into(), false))
        );
    }

    #[test]
    fn future_quota_groups_and_windows_are_preserved_independently() {
        let groups = normalize_quota_list(&json!({"response":{"groups":[
            {"displayName":"Gemini 4 Carbon","buckets":[{"bucketId":"carbon_monthly","window":"monthly","remainingFraction":0.37}]},
            {"displayName":"Future provider","buckets":[{"window":"hourly","remainingFraction":1,"disabled":true}]}
        ]}})).unwrap();
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0]["buckets"][0]["window"], "monthly");
        assert_eq!(groups[0]["buckets"][0]["remaining_pct"], 37.0);
        assert!(groups[1]["buckets"][0]["remaining_pct"].is_null());
        assert_eq!(groups[1]["buckets"][0]["disabled"], true);
    }

    #[test]
    fn argon_does_not_overwrite_gemini_and_disabled_limits_are_not_available() {
        let quotas = normalize_quota_groups(&json!({"response":{"groups":[
            {"displayName":"Gemini Models","buckets":[{"window":"weekly","remainingFraction":0.87}]},
            {"displayName":"Gemini 4 Argon","buckets":[{"window":"weekly","remainingFraction":0.00099}]},
            {"displayName":"Claude and GPT models","buckets":[{"window":"5h","remainingFraction":1,"disabled":true}]}
        ]}})).unwrap();
        assert_eq!(quotas["gemini_models"]["weekly"]["remaining_pct"], 87.0);
        assert_eq!(quotas["argon_models"]["weekly"]["remaining_pct"], 0.1);
        assert!(quotas["claude_gpt_models"]["five_hour"]["remaining_pct"].is_null());
        assert_eq!(quotas["claude_gpt_models"]["five_hour"]["disabled"], true);
        assert_eq!(quotas["argon_models"]["five_hour"]["available"], false);
    }

    #[test]
    fn missing_and_invalid_quota_values_stay_unknown() {
        let quotas = normalize_quota_groups(&json!({"response":{"groups":[
            {"displayName":"Gemini","buckets":[{"window":"weekly"},{"window":"5h","remainingFraction":2}]}
        ]}})).unwrap();
        assert!(quotas["gemini_models"]["weekly"]["remaining_pct"].is_null());
        assert!(quotas["gemini_models"]["five_hour"]["remaining_pct"].is_null());
        assert!(normalize_quota_groups(&json!({"error":"offline"})).is_none());
    }
}
