use axum::{
    body::Body,
    extract::{ConnectInfo, Request},
    http::{header, HeaderMap, StatusCode},
    middleware::Next,
    response::{Html, IntoResponse, Redirect, Response},
    Json,
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    net::{IpAddr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant},
};

pub const COOKIE_NAME: &str = "ag_session";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeSettings {
    #[serde(default = "default_remote_mode")]
    pub remote_mode: String,
    #[serde(default = "default_require_lan_pin")]
    pub require_lan_pin: bool,
    #[serde(default)]
    pub allow_shell: bool,
}

fn default_require_lan_pin() -> bool {
    true
}

fn default_remote_mode() -> String {
    "lan".to_string()
}

impl Default for BridgeSettings {
    fn default() -> Self {
        Self {
            remote_mode: "lan".to_string(),
            require_lan_pin: default_require_lan_pin(),
            allow_shell: false,
        }
    }
}

pub fn data_dir(root: &Path) -> PathBuf {
    let d = root.join("data");
    let _ = fs::create_dir_all(&d);
    d
}

pub fn load_token(root: &Path, rotate: bool) -> String {
    static TOKEN_LOCK: Mutex<()> = Mutex::new(());
    let _guard = TOKEN_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let token_file = data_dir(root).join(".bridge_token");
    if !rotate {
        if let Ok(raw) = fs::read_to_string(&token_file) {
            let t = raw.trim().to_string();
            if t.len() >= 16 {
                return t;
            }
        }
    }
    if !rotate {
        if let Ok(env_tok) = std::env::var("BRIDGE_TOKEN") {
            let t = env_tok.trim().to_string();
            if t.len() >= 16 {
                crate::storage::atomic_write(&token_file, t.as_bytes())
                    .expect("Cannot persist bridge token");
                return t;
            }
        }
    }
    let new_tok = format!(
        "{}{}",
        uuid::Uuid::new_v4().simple(),
        &uuid::Uuid::new_v4().simple().to_string()[..12]
    );
    crate::storage::atomic_write(&token_file, new_tok.as_bytes())
        .expect("Cannot persist bridge token");
    new_tok
}

pub fn derive_pin(token: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(token.as_bytes());
    let digest = hasher.finalize();
    let n = u32::from_be_bytes([digest[0], digest[1], digest[2], digest[3]]) % 1_000_000;
    format!("{:06}", n)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

pub fn token_matches(candidate: &str, token: &str) -> bool {
    let c = candidate.trim();
    if c.is_empty() {
        return false;
    }
    let pin = derive_pin(token);
    constant_time_eq(c.as_bytes(), token.as_bytes())
        || constant_time_eq(c.as_bytes(), pin.as_bytes())
}

pub fn get_settings(root: &Path) -> BridgeSettings {
    let mut s = BridgeSettings::default();
    let settings_file = data_dir(root).join(".bridge_settings.json");
    if let Ok(raw) = fs::read_to_string(&settings_file) {
        if let Ok(parsed) = serde_json::from_str::<BridgeSettings>(&raw) {
            s = parsed;
        }
    }
    if !matches!(s.remote_mode.as_str(), "lan" | "tailscale" | "tunnel") {
        s.remote_mode = "lan".to_string();
    }
    if std::env::var("BRIDGE_ALLOW_TUNNEL").ok().as_deref() == Some("1") {
        s.remote_mode = "tunnel".to_string();
    }
    if std::env::var("BRIDGE_ALLOW_SHELL").ok().as_deref() == Some("1") {
        s.allow_shell = true;
    }
    s
}

pub fn save_settings(root: &Path, patch: serde_json::Value) -> std::io::Result<BridgeSettings> {
    static SETTINGS_LOCK: Mutex<()> = Mutex::new(());
    let _guard = SETTINGS_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut cur = get_settings(root);
    if let Some(mode) = patch.get("remote_mode").and_then(|v| v.as_str()) {
        if matches!(mode, "lan" | "tailscale" | "tunnel") {
            cur.remote_mode = mode.to_string();
        }
    }
    if let Some(pin) = patch.get("require_lan_pin").and_then(|v| v.as_bool()) {
        cur.require_lan_pin = pin;
    }
    if let Some(sh) = patch.get("allow_shell").and_then(|v| v.as_bool()) {
        cur.allow_shell = sh;
    }
    let settings_file = data_dir(root).join(".bridge_settings.json");
    if let Ok(serialized) = serde_json::to_string_pretty(&cur) {
        crate::storage::atomic_write(&settings_file, serialized.as_bytes())?;
    }
    Ok(cur)
}

fn normalize_ip(ip: IpAddr) -> IpAddr {
    match ip {
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                IpAddr::V4(v4)
            } else {
                IpAddr::V6(v6)
            }
        }
        IpAddr::V4(v4) => IpAddr::V4(v4),
    }
}

pub fn is_loopback(ip: IpAddr) -> bool {
    normalize_ip(ip).is_loopback()
}

pub fn is_lan(ip: IpAddr) -> bool {
    match normalize_ip(ip) {
        IpAddr::V4(v4) => v4.is_loopback() || v4.is_private() || v4.is_link_local(),
        IpAddr::V6(v6) => {
            v6.is_loopback()
                || (v6.segments()[0] & 0xffc0) == 0xfe80
                || (v6.segments()[0] & 0xfe00) == 0xfc00
        }
    }
}

pub fn is_tailscale(ip: IpAddr) -> bool {
    match normalize_ip(ip) {
        IpAddr::V4(v4) => {
            let oct = v4.octets();
            oct[0] == 100 && (oct[1] & 0b1100_0000) == 64
        }
        IpAddr::V6(v6) => {
            let seg = v6.segments();
            seg[0] == 0xfd7a && seg[1] == 0x115c && seg[2] == 0xa1e0
        }
    }
}

pub fn is_proxied(headers: &HeaderMap) -> bool {
    const PROXY_HEADERS: &[&str] = &[
        "cf-connecting-ip",
        "x-forwarded-for",
        "x-real-ip",
        "forwarded",
        "cf-ray",
    ];
    PROXY_HEADERS.iter().any(|h| headers.contains_key(*h))
}

pub fn is_owner_request(addr: SocketAddr, headers: &HeaderMap) -> bool {
    if is_proxied(headers) {
        return false;
    }
    is_loopback(addr.ip())
}

fn extract_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    let raw = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in raw.split(';') {
        if let Some((k, v)) = part.trim().split_once('=') {
            if k.trim() == name {
                return Some(v.trim().to_string());
            }
        }
    }
    None
}

fn extract_query_param(query: Option<&str>, key: &str) -> Option<String> {
    let q = query?;
    for pair in q.split('&') {
        if let Some((k, v)) = pair.split_once('=') {
            if k == key && !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

fn session_cookie_header(token: &str, secure: bool) -> String {
    let mut c = format!(
        "{}={}; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax",
        COOKIE_NAME, token
    );
    if secure {
        c.push_str("; Secure");
    }
    c
}

const PIN_PAGE_HTML: &str = r#"<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pair Phone - Antigravity Bridge</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0c;color:#f4f4f5;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Inter',sans-serif;padding:20px}
  .box{max-width:360px;width:100%;background:#131317;border:1px solid #27272a;border-radius:16px;padding:24px;box-sizing:border-box}
  h1{font-size:18px;margin:0 0 6px}
  p{color:#a1a1aa;font-size:13px;margin:0 0 16px}
  input{width:100%;box-sizing:border-box;padding:12px 14px;border-radius:10px;border:1px solid #3f3f46;background:#09090b;color:#fff;font:600 18px 'JetBrains Mono',monospace;letter-spacing:3px;text-align:center;margin-bottom:12px}
  button{width:100%;padding:12px;border-radius:10px;border:0;background:#38bdf8;color:#09090b;font:600 14px inherit;cursor:pointer}
</style></head><body>
<form class="box" method="GET" action="/pair">
  <h1>Pair this phone</h1>
  <p>Scan the QR code on your laptop's Connect tab, or enter the 6-digit PIN shown below the QR code.</p>
  <input name="t" placeholder="000000" autocomplete="one-time-code" autofocus required>
  <button type="submit">Connect</button>
</form></body></html>"#;

fn same_origin(headers: &HeaderMap) -> bool {
    if headers.get("sec-fetch-site").and_then(|v| v.to_str().ok()) == Some("cross-site") {
        return false;
    }
    let Some(origin) = headers.get(header::ORIGIN) else {
        return true;
    };
    let Ok(origin) = origin.to_str() else {
        return false;
    };
    let Ok(url) = reqwest::Url::parse(origin) else {
        return false;
    };
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    matches!(url.scheme(), "http" | "https")
        && reqwest::Url::parse(&format!("{}://{}", url.scheme(), host))
            .is_ok_and(|expected| expected.origin() == url.origin())
}

fn pairing_rate_limited(ip: IpAddr) -> bool {
    static ATTEMPTS: OnceLock<Mutex<HashMap<IpAddr, (Instant, u32)>>> = OnceLock::new();
    let mut attempts = ATTEMPTS
        .get_or_init(|| Mutex::new(HashMap::new()))
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    attempts.retain(|_, (at, _)| at.elapsed() < Duration::from_secs(60));
    if attempts.len() >= 2048 && !attempts.contains_key(&ip) {
        return true;
    }
    let entry = attempts.entry(ip).or_insert((Instant::now(), 0));
    entry.1 += 1;
    entry.1 > 10
}

pub async fn security_middleware(
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    req: Request<Body>,
    next: Next,
) -> Response {
    let root = std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."));
    let settings = get_settings(&root);
    let token = load_token(&root, false);
    let headers = req.headers().clone();
    let path = req.uri().path().to_string();
    let query = req.uri().query().map(|s| s.to_string());
    let client_ip = addr.ip();
    let proxied = is_proxied(&headers);

    if path == "/healthz" {
        return next.run(req).await;
    }

    // 1. Network boundary check
    let allowed_net = if proxied {
        settings.remote_mode == "tunnel"
    } else {
        is_lan(client_ip)
            || (is_tailscale(client_ip)
                && matches!(settings.remote_mode.as_str(), "tailscale" | "tunnel"))
    };

    if !allowed_net {
        let msg = if proxied {
            "Public tunnel disabled. Enable it in the Connect tab on your laptop."
        } else {
            "Same Wi-Fi network only (or enable Tailscale in Connect)."
        };
        return (StatusCode::FORBIDDEN, Json(json!({"error": msg}))).into_response();
    }

    // WebSocket upgrades and GET actions need the same boundary as HTTP writes.
    if !same_origin(&headers) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"Cross-origin request blocked."})),
        )
            .into_response();
    }
    // Stop DNS rebinding from inheriting LAN auto-pairing privileges.
    if !proxied {
        let valid_host = headers
            .get(header::HOST)
            .and_then(|v| v.to_str().ok())
            .and_then(|host| reqwest::Url::parse(&format!("http://{}", host)).ok())
            .and_then(|url| url.host_str().map(str::to_string))
            .is_some_and(|host| {
                host == "localhost"
                    || host
                        .trim_matches(['[', ']'])
                        .parse::<IpAddr>()
                        .is_ok_and(|ip| is_lan(ip) || is_tailscale(ip))
            });
        if !valid_host {
            return (
                StatusCode::FORBIDDEN,
                Json(json!({"error":"Use the laptop's local IP address or localhost."})),
            )
                .into_response();
        }
    }

    // 2. Pairing endpoint (/pair?t=<token_or_pin>)
    let q_tok = extract_query_param(query.as_deref(), "t")
        .or_else(|| extract_query_param(query.as_deref(), "pin"));
    let candidate = q_tok
        .as_deref()
        .or_else(|| headers.get("x-bridge-token").and_then(|v| v.to_str().ok()))
        .or_else(|| {
            headers
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer "))
        });
    if (path == "/pair" || candidate.is_some())
        && !candidate.is_some_and(|c| token_matches(c, &token))
        && !is_owner_request(addr, &headers)
        && pairing_rate_limited(client_ip)
    {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(json!({"error":"Too many pairing attempts. Try again in one minute."})),
        )
            .into_response();
    }

    if path == "/pair" {
        let cand = q_tok.unwrap_or_default();
        if !token_matches(&cand, &token) {
            return (StatusCode::FORBIDDEN, Html(PIN_PAGE_HTML)).into_response();
        }
        let mut resp = Redirect::to("/").into_response();
        if let Ok(val) = header::HeaderValue::from_str(&session_cookie_header(&token, proxied)) {
            resp.headers_mut().insert(header::SET_COOKIE, val);
        }
        return resp;
    }

    // 3. Token / Cookie / Same-Wi-Fi authentication
    let is_local = is_loopback(client_ip) && !proxied;
    let is_trusted_lan = !settings.require_lan_pin && is_lan(client_ip) && !proxied;

    let cookie_tok = extract_cookie(&headers, COOKIE_NAME).unwrap_or_default();
    let hdr_tok = headers
        .get("x-bridge-token")
        .and_then(|v| v.to_str().ok())
        .or_else(|| {
            headers
                .get(header::AUTHORIZATION)
                .and_then(|v| v.to_str().ok())
                .and_then(|s| s.strip_prefix("Bearer "))
        })
        .unwrap_or_default();

    let query_valid = q_tok
        .as_deref()
        .map(|c| token_matches(c, &token))
        .unwrap_or(false);
    let cookie_valid = constant_time_eq(cookie_tok.as_bytes(), token.as_bytes());
    let header_valid = constant_time_eq(hdr_tok.as_bytes(), token.as_bytes());

    let authed = is_local || is_trusted_lan || cookie_valid || header_valid || query_valid;
    if !authed {
        if path == "/" || (!path.starts_with("/api/") && path != "/ws") {
            return (StatusCode::UNAUTHORIZED, Html(PIN_PAGE_HTML)).into_response();
        }
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({
                "error": "Not paired. Scan the QR code or enter the 6-digit PIN shown on your laptop."
            })),
        )
            .into_response();
    }

    // 5. Remote shell guard
    if path == "/api/command/exec" && !settings.allow_shell {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({
                "error": "Remote shell is disabled for safety. Enable it in the Connect tab on your laptop if needed."
            })),
        )
            .into_response();
    }

    let mut resp = next.run(req).await;
    resp.headers_mut()
        .insert(header::CACHE_CONTROL, "no-store".parse().unwrap());
    resp.headers_mut()
        .insert(header::X_CONTENT_TYPE_OPTIONS, "nosniff".parse().unwrap());
    resp.headers_mut()
        .insert(header::X_FRAME_OPTIONS, "DENY".parse().unwrap());
    resp.headers_mut()
        .insert(header::REFERRER_POLICY, "no-referrer".parse().unwrap());
    if (query_valid || is_trusted_lan) && !cookie_valid {
        if let Ok(val) = header::HeaderValue::from_str(&session_cookie_header(&token, proxied)) {
            resp.headers_mut().append(header::SET_COOKIE, val);
        }
    }
    resp
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn new_and_missing_pairing_settings_require_a_pin_and_preserve_explicit_opt_out() {
        assert!(BridgeSettings::default().require_lan_pin);
        assert!(
            serde_json::from_str::<BridgeSettings>("{}")
                .unwrap()
                .require_lan_pin
        );
        assert!(
            !serde_json::from_value::<BridgeSettings>(json!({"require_lan_pin":false}))
                .unwrap()
                .require_lan_pin
        );
    }

    #[test]
    fn validates_origins_including_opaque_and_default_ports() {
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "localhost:80".parse().unwrap());
        for origin in ["http://localhost", "http://localhost:80"] {
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert!(same_origin(&headers));
        }
        for origin in [
            "null",
            "not-a-url",
            "http://evil.example",
            "http://localhost:8000",
        ] {
            headers.insert(header::ORIGIN, origin.parse().unwrap());
            assert!(!same_origin(&headers));
        }
    }

    #[test]
    fn pin_attempts_are_bounded() {
        let ip = "203.0.113.99".parse().unwrap();
        for _ in 0..10 {
            assert!(!pairing_rate_limited(ip));
        }
        assert!(pairing_rate_limited(ip));
    }

    #[test]
    fn only_direct_loopback_is_owner() {
        assert!(is_owner_request(
            "127.0.0.1:5000".parse().unwrap(),
            &HeaderMap::new()
        ));
        assert!(!is_owner_request(
            "192.168.1.20:5000".parse().unwrap(),
            &HeaderMap::new()
        ));
        let mut headers = HeaderMap::new();
        headers.insert("x-forwarded-for", "127.0.0.1".parse().unwrap());
        assert!(!is_owner_request(
            "127.0.0.1:5000".parse().unwrap(),
            &headers
        ));
    }

    #[test]
    fn network_ranges_do_not_trust_public_addresses() {
        for ip in [
            "127.0.0.1",
            "192.168.1.2",
            "10.0.0.1",
            "172.16.0.1",
            "::ffff:192.168.1.2",
        ] {
            assert!(is_lan(ip.parse().unwrap()), "{ip}");
        }
        for ip in ["8.8.8.8", "172.32.0.1", "100.64.0.1"] {
            assert!(!is_lan(ip.parse().unwrap()), "{ip}");
        }
        assert!(is_tailscale("100.64.0.1".parse().unwrap()));
        assert!(!is_tailscale("100.128.0.1".parse().unwrap()));
    }
}
