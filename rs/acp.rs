mod permissions;
use base64::Engine as _;
use permissions::Permissions;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    process::Stdio,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock, Weak,
    },
    time::Duration,
};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, Command},
    sync::{mpsc, oneshot, Mutex as AsyncMutex},
};

pub fn executable() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("BRIDGE_AGY_EXE") {
        return Some(PathBuf::from(path)).filter(|p| p.is_file());
    }
    let home = std::env::var_os("USERPROFILE").or_else(|| std::env::var_os("HOME"))?;
    let installed = PathBuf::from(home).join(".gemini/bin/agy.exe");
    if installed.is_file() {
        return Some(installed);
    }
    std::env::split_paths(&std::env::var_os("PATH")?).find_map(|dir| {
        ["agy.exe", "agy"]
            .into_iter()
            .map(|name| dir.join(name))
            .find(|p| p.is_file())
    })
}

pub fn resolve_images(
    root: &std::path::Path,
    images: &Value,
) -> Result<Vec<(PathBuf, &'static str)>, String> {
    if images.is_null() {
        return Ok(Vec::new());
    }
    let images = images
        .as_array()
        .ok_or("Expected a list of image attachments.")?;
    if images.is_empty() {
        return Ok(Vec::new());
    }
    let uploads = root
        .join("uploads")
        .canonicalize()
        .map_err(|_| "Image attachments are unavailable.")?;
    let mut paths = Vec::new();
    let mut total = 0u64;
    for image in images {
        let name = image
            .as_str()
            .filter(|s| !s.chars().any(char::is_control))
            .ok_or("Invalid image attachment.")?;
        let path = match name.strip_prefix("/uploads/") {
            Some(name) => uploads.join(name),
            None => PathBuf::from(name),
        };
        let path = path
            .canonicalize()
            .map_err(|_| "An image attachment is no longer available.")?;
        if path.parent() != Some(uploads.as_path())
            || !path.is_file()
            || path.to_string_lossy().chars().any(char::is_control)
        {
            return Err("Attach images through the bridge upload control.".into());
        }
        let ext = path
            .extension()
            .and_then(|v| v.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let mime = match ext.as_str() {
            "png" => "image/png",
            "jpg" | "jpeg" => "image/jpeg",
            "webp" => "image/webp",
            "gif" => "image/gif",
            _ => return Err("Attach a PNG, JPEG, WebP or GIF image.".into()),
        };
        total = total.saturating_add(
            path.metadata()
                .map_err(|_| "Could not read the image attachment.")?
                .len(),
        );
        if total > 12 * 1024 * 1024 {
            return Err("Image attachments exceed 12 MiB for one message.".into());
        }
        paths.push((crate::workspaces::strip_windows_prefix(path), mime));
    }
    Ok(paths)
}

pub fn image_blocks(images: &[(PathBuf, &str)]) -> Result<Vec<Value>, String> {
    images.iter().map(|(path, mime)| {
        let data = std::fs::read(path).map_err(|_| "Could not read the image attachment.")?;
        Ok(json!({"type":"image","mimeType":mime,"data":base64::engine::general_purpose::STANDARD.encode(data)}))
    }).collect()
}

pub enum DecisionError {
    Stale,
    InvalidOption,
    Disconnected,
}

pub struct Client {
    permissions: AsyncMutex<Permissions>,
    decision_writes: AsyncMutex<()>,
    input: AsyncMutex<ChildStdin>,
    child: AsyncMutex<Child>,
    pending: Mutex<HashMap<u64, oneshot::Sender<Result<Value, String>>>>,
    sequence: AtomicU64,
    pub alive: AtomicBool,
    pub cancel_confirmed: AtomicBool,
    pub events: AsyncMutex<mpsc::Receiver<Value>>,
    session_id: OnceLock<String>,
    session_models: OnceLock<Value>,
}

impl Client {
    pub async fn connect(cwd: &str, session: Option<&str>) -> Result<Arc<Self>, String> {
        let exe =
            executable().ok_or("AGY CLI was not found. Install AGY and sign in on the laptop.")?;
        let mut command = Command::new(exe);
        command
            .arg("acp")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        #[cfg(windows)]
        command.creation_flags(0x08000000);
        let mut child = command.spawn().map_err(|_| "Could not start AGY ACP.")?;
        let input = child.stdin.take().ok_or("AGY stdin unavailable.")?;
        let output = child.stdout.take().ok_or("AGY stdout unavailable.")?;
        let (tx, rx) = mpsc::channel(256);
        let client = Arc::new(Self {
            input: AsyncMutex::new(input),
            decision_writes: AsyncMutex::new(()),
            permissions: AsyncMutex::new(Permissions::default()),
            child: AsyncMutex::new(child),
            pending: Mutex::new(HashMap::new()),
            sequence: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            cancel_confirmed: AtomicBool::new(false),
            events: AsyncMutex::new(rx),
            session_id: OnceLock::new(),
            session_models: OnceLock::new(),
        });
        let weak = Arc::downgrade(&client);
        tokio::spawn(Self::read_messages(weak, BufReader::new(output), tx));
        client
            .request(
                "initialize",
                json!({"protocolVersion":1,"clientCapabilities":{},
            "clientInfo":{"name":"antigravity-bridge","version":"2.0.0"}}),
                Duration::from_secs(20),
            )
            .await?;
        let params = json!({"cwd":cwd,"mcpServers":[],"sessionId":session});
        let setup = client.request(
            if session.is_some() {
                "session/load"
            } else {
                "session/new"
            },
            params,
            Duration::from_secs(30),
        );
        tokio::pin!(setup);
        let response = {
            let mut events = client.events.lock().await;
            loop {
                tokio::select! {
                    response = &mut setup => break response?,
                    _ = events.recv() => {}
                }
            }
        };
        let id = session
            .or_else(|| response["sessionId"].as_str())
            .filter(|id| crate::conversations::ConversationManager::valid_id(id))
            .ok_or("AGY did not return a valid session ID.")?
            .to_string();
        client
            .session_id
            .set(id)
            .map_err(|_| "AGY session was already initialized.")?;
        let _ = client.session_models.set(response["models"].clone());
        Ok(Arc::clone(&client))
    }

    async fn read_messages(
        weak: Weak<Self>,
        mut output: BufReader<tokio::process::ChildStdout>,
        events: mpsc::Sender<Value>,
    ) {
        loop {
            let mut line = Vec::new();
            match (&mut output)
                .take(4 * 1024 * 1024 + 1)
                .read_until(b'\n', &mut line)
                .await
            {
                Ok(0) | Err(_) => break,
                Ok(_) if line.len() > 4 * 1024 * 1024 => break,
                Ok(_) => {}
            }
            let Ok(message) = serde_json::from_slice::<Value>(&line) else {
                break;
            };
            let Some(client) = weak.upgrade() else { return };
            if message.get("method").is_some() {
                if let Some(id) = message.get("id") {
                    let reply = if message["method"] == "session/request_permission" {
                        let offered = {
                            let mut permissions = client.permissions.lock().await;
                            // Two outstanding requests sharing a wire ID cannot be answered safely.
                            if permissions.pending.iter().any(|(pending, _)| pending == id) {
                                permissions.closed = true;
                                permissions.pending.clear();
                                break;
                            }
                            message["params"]["sessionId"].as_str() == Some(client.session_id())
                                && permissions.offer(id, &message["params"])
                        };
                        if offered {
                            if events
                                .send(json!({"permissions_changed":true}))
                                .await
                                .is_err()
                            {
                                break;
                            }
                            continue;
                        }
                        let _ = events.send(json!({"permission_required":true})).await;
                        json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}})
                    } else {
                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"Client capability unavailable"}})
                    };
                    if client.write(&reply).await.is_err() {
                        break;
                    }
                } else if message["method"] == "session/update" {
                    let params = &message["params"];
                    if params["sessionId"].as_str() == Some(client.session_id())
                        && matches!(
                            params["update"]["sessionUpdate"].as_str(),
                            Some("tool_call" | "tool_call_update")
                        )
                    {
                        client.permissions.lock().await.remember(&params["update"]);
                    }
                    if events.send(params.clone()).await.is_err() {
                        break;
                    }
                }
            } else if let Some(id) = message["id"].as_u64() {
                {
                    let mut permissions = client.permissions.lock().await;
                    if permissions.prompt_id == Some(id) {
                        permissions.closed = true;
                        permissions.prompt_id = None;
                        permissions.pending.clear();
                    }
                }
                let sender = client
                    .pending
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&id);
                if let Some(sender) = sender {
                    let response = if message.get("error").is_some() {
                        Err(message["error"]["message"]
                            .as_str()
                            .unwrap_or("AGY rejected the request.")
                            .to_string())
                    } else {
                        Ok(message["result"].clone())
                    };
                    let _ = sender.send(response);
                }
            }
        }
        if let Some(client) = weak.upgrade() {
            client.alive.store(false, Ordering::SeqCst);
            for (_, sender) in client
                .pending
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .drain()
            {
                let _ = sender.send(Err(
                    "AGY disconnected. Check the native session before retrying.".to_string(),
                ));
            }
        }
    }

    async fn write(&self, value: &Value) -> Result<(), String> {
        let mut data = serde_json::to_vec(value).map_err(|_| "Invalid ACP request.")?;
        data.push(b'\n');
        tokio::time::timeout(Duration::from_secs(10), async {
            let mut input = self.input.lock().await;
            input
                .write_all(&data)
                .await
                .map_err(|_| "AGY connection closed.".to_string())?;
            input
                .flush()
                .await
                .map_err(|_| "AGY connection closed.".to_string())
        })
        .await
        .map_err(|_| {
            "AGY stopped accepting requests. Check the native session before retrying.".to_string()
        })?
    }

    pub async fn request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        if !self.alive.load(Ordering::SeqCst) {
            return Err("AGY connection closed.".into());
        }
        let id = self.sequence.fetch_add(1, Ordering::SeqCst);
        let (tx, rx) = oneshot::channel();
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(id, tx);
        let result = async {
            let message = json!({"jsonrpc":"2.0","id":id,"method":method,"params":params});
            if method == "session/prompt" {
                let mut permissions = self.permissions.lock().await;
                if permissions.closed {
                    return Err("AGY turn was stopped before submission.".into());
                }
                permissions.prompt_id = Some(id);
                self.write(&message).await?;
            } else {
                self.write(&message).await?;
            }
            tokio::time::timeout(timeout, rx)
                .await
                .map_err(|_| {
                    "AGY request timed out. Check the native session before retrying.".to_string()
                })?
                .map_err(|_| "AGY connection closed.".to_string())?
        }
        .await;
        self.pending
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&id);
        result
    }

    pub async fn permission_requests(&self) -> Vec<Value> {
        let permissions = self.permissions.lock().await;
        if !self.alive.load(Ordering::SeqCst) || permissions.closed {
            return Vec::new();
        }
        permissions
            .pending
            .iter()
            .map(|(_, view)| view.clone())
            .collect()
    }

    pub async fn decide(
        &self,
        request: &str,
        option: Option<&str>,
        approve: bool,
    ) -> Result<(), DecisionError> {
        let _order = self.decision_writes.lock().await;
        let mut permissions = self.permissions.lock().await;
        if permissions.closed || !self.alive.load(Ordering::SeqCst) {
            return Err(DecisionError::Stale);
        }
        let pos = permissions
            .pending
            .iter()
            .position(|(_, view)| view["request_id"] == request)
            .ok_or(DecisionError::Stale)?;
        let outcome = match option {
            Some(id) => {
                let options = permissions.pending[pos].1["options"].as_array().unwrap();
                let valid = options.iter().any(|o| {
                    o["optionId"] == id
                        && o["kind"].as_str().is_some_and(|kind| {
                            kind.starts_with(if approve { "allow_" } else { "reject_" })
                        })
                });
                if !valid {
                    return Err(DecisionError::InvalidOption);
                }
                json!({"outcome":"selected","optionId":id})
            }
            None if !approve => json!({"outcome":"cancelled"}),
            None => return Err(DecisionError::InvalidOption),
        };
        let (id, _) = permissions.pending.remove(pos);
        drop(permissions);
        self.write(&json!({"jsonrpc":"2.0","id":id,"result":{"outcome":outcome}}))
            .await
            .map_err(|_| DecisionError::Disconnected)
    }

    pub async fn cancel(&self) -> Result<(), String> {
        let _order = self.decision_writes.lock().await;
        let pending = {
            let mut permissions = self.permissions.lock().await;
            permissions.closed = true;
            std::mem::take(&mut permissions.pending)
        };
        self.write(&json!({"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":self.session_id()}})).await?;
        for (id, _) in pending {
            self.write(
                &json!({"jsonrpc":"2.0","id":id,"result":{"outcome":{"outcome":"cancelled"}}}),
            )
            .await?;
        }
        Ok(())
    }

    pub fn session_id(&self) -> &str {
        self.session_id.get().map(String::as_str).unwrap_or("")
    }

    pub fn validate_model(
        &self,
        requested: &str,
        allowed: &Value,
    ) -> Result<Option<String>, String> {
        validate_session_model(
            self.session_models.get().unwrap_or(&Value::Null),
            requested,
            allowed,
        )
    }

    pub async fn shutdown(&self) {
        self.alive.store(false, Ordering::SeqCst);
        let _ = self.child.lock().await.kill().await;
    }
}

fn validate_session_model(
    models: &Value,
    requested: &str,
    allowed: &Value,
) -> Result<Option<String>, String> {
    let allowed = allowed
        .as_array()
        .filter(|ids| !ids.is_empty())
        .ok_or("Model access could not be verified. Refresh models before sending.")?;
    let selected = if requested.is_empty() {
        if models.is_null() {
            return Ok(None);
        }
        models["currentModelId"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("AGY did not provide a session default. Choose an available model.")?
    } else {
        requested
    };
    if !allowed.iter().any(|id| id.as_str() == Some(selected)) {
        return Err("This session's model is no longer available to the current AGY account. Choose an available model.".into());
    }
    if !models.is_null() {
        let entries = models["availableModels"]
            .as_array()
            .ok_or("AGY session model information is incompatible. Refresh AGY before sending.")?;
        let mut seen = std::collections::HashSet::new();
        for entry in entries {
            let id = entry["modelId"]
                .as_str()
                .filter(|id| !id.is_empty())
                .ok_or("AGY session returned an invalid model entry.")?;
            if !seen.insert(id) || entry.get("disabled").is_some_and(|v| !v.is_boolean()) {
                return Err("AGY session returned ambiguous model access.".into());
            }
        }
        if !entries
            .iter()
            .any(|m| m["modelId"] == selected && m["disabled"] != true)
        {
            return Err("This model is unavailable in the current AGY session. Choose another model or start a new conversation.".into());
        }
    }
    Ok(Some(selected.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn session_default_must_still_be_entitled_after_downgrade() {
        let models = json!({"currentModelId":"retired","availableModels":[{"modelId":"retired"},{"modelId":"basic"}]});
        assert!(validate_session_model(&models, "", &json!(["basic"])).is_err());
        assert_eq!(
            validate_session_model(&models, "basic", &json!(["basic"])).unwrap(),
            Some("basic".into())
        );
    }

    #[test]
    fn session_specific_access_can_be_narrower_than_cli_catalog() {
        let models = json!({"currentModelId":"basic","availableModels":[{"modelId":"basic"}]});
        assert!(validate_session_model(&models, "paid", &json!(["basic", "paid"])).is_err());
        assert_eq!(
            validate_session_model(&models, "", &json!(["basic", "paid"])).unwrap(),
            Some("basic".into())
        );
    }

    #[test]
    fn malformed_session_models_do_not_authorize_a_send() {
        for models in [
            json!({}),
            json!({"availableModels":"bad"}),
            json!({"availableModels":[{}]}),
            json!({"availableModels":[{"modelId":"basic","disabled":"true"}]}),
        ] {
            assert!(validate_session_model(&models, "basic", &json!(["basic"])).is_err());
        }
        // ACP permits agents without model-selection metadata. The fresh CLI list
        // and native set_model/prompt still enforce access in that case.
        assert_eq!(
            validate_session_model(&Value::Null, "", &json!(["basic"])).unwrap(),
            None
        );
        assert!(validate_session_model(&Value::Null, "retired", &json!(["basic"])).is_err());
    }
}
