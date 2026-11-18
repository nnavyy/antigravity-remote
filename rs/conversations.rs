use chrono::Local;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs,
    io::{BufRead, BufReader},
    path::{Path, PathBuf},
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

pub struct ConversationManager {
    pub root: PathBuf,
    pub active_id: Mutex<Option<String>>,
    pub deleted_ids: Mutex<HashSet<String>>,
    cache: Mutex<HashMap<String, (u64, u64, Value)>>,
    write_lock: Mutex<()>,
}

impl ConversationManager {
    pub fn new(root: PathBuf) -> Self {
        let conv_dir = root.join("conversations");
        let _ = fs::create_dir_all(&conv_dir);
        let deleted_file = conv_dir.join("deleted_sessions.json");
        let mut deleted = HashSet::new();
        if let Ok(raw) = fs::read_to_string(deleted_file) {
            if let Ok(arr) = serde_json::from_str::<Vec<String>>(&raw) {
                for id in arr {
                    deleted.insert(id);
                }
            }
        }
        Self {
            root,
            active_id: Mutex::new(None),
            deleted_ids: Mutex::new(deleted),
            cache: Mutex::new(HashMap::new()),
            write_lock: Mutex::new(()),
        }
    }

    fn home_dir() -> PathBuf {
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|_| PathBuf::from("."))
    }

    pub fn brain_dirs() -> Vec<PathBuf> {
        let home = Self::home_dir();
        let candidates = [
            home.join(".gemini").join("antigravity").join("brain"),
            home.join(".gemini").join("antigravity-ide").join("brain"),
        ];
        let mut dirs: Vec<PathBuf> = candidates.iter().filter(|d| d.exists()).cloned().collect();
        if dirs.is_empty() {
            dirs.push(candidates[0].clone());
        }
        dirs
    }

    pub fn resolve_transcript_path(&self, conv_id: &str) -> PathBuf {
        if !Self::valid_id(conv_id) {
            return self.root.join("conversations/.invalid-transcript");
        }
        let metadata = self.metadata(conv_id);
        let native_id = metadata["ide_conversation_id"]
            .as_str()
            .filter(|id| Self::valid_id(id))
            .unwrap_or(conv_id);
        for bdir in Self::brain_dirs() {
            let p = bdir
                .join(native_id)
                .join(".system_generated")
                .join("logs")
                .join("transcript.jsonl");
            if p.exists() {
                return p;
            }
        }
        Self::brain_dirs()[0]
            .join(native_id)
            .join(".system_generated")
            .join("logs")
            .join("transcript.jsonl")
    }

    fn overlay_path(&self, conv_id: &str) -> PathBuf {
        self.root
            .join("conversations")
            .join(format!("{}_overlay.json", conv_id))
    }

    pub fn metadata(&self, id: &str) -> Value {
        if !Self::valid_id(id) {
            return json!({});
        }
        fs::read(
            self.root
                .join("conversations")
                .join(format!("{id}_meta.json")),
        )
        .ok()
        .and_then(|data| serde_json::from_slice(&data).ok())
        .unwrap_or_else(|| json!({}))
    }

    pub fn update_metadata(&self, id: &str, patch: Value) -> std::io::Result<()> {
        if !Self::valid_id(id) {
            return Err(std::io::Error::other("Invalid conversation ID"));
        }
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut data = self.metadata(id);
        if let Some(patch) = patch.as_object() {
            for (key, value) in patch {
                data[key] = value.clone();
            }
        }
        crate::storage::atomic_write(
            &self
                .root
                .join("conversations")
                .join(format!("{id}_meta.json")),
            &serde_json::to_vec(&data)?,
        )
    }

    pub fn valid_id(id: &str) -> bool {
        !id.is_empty()
            && id.len() <= 128
            && id
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
    }

    fn local_conv_path(&self, conv_id: &str) -> PathBuf {
        self.root
            .join("conversations")
            .join(format!("{}.json", conv_id))
    }

    pub fn get_overlay_messages(&self, conv_id: &str) -> Vec<Value> {
        if !Self::valid_id(conv_id) {
            return Vec::new();
        }
        let p = self.overlay_path(conv_id);
        if let Ok(raw) = fs::read_to_string(p) {
            if let Ok(arr) = serde_json::from_str::<Vec<Value>>(&raw) {
                return arr;
            }
        }
        Vec::new()
    }

    pub fn add_message(
        &self,
        conv_id: &str,
        sender: &str,
        text: &str,
        status: &str,
        images: Vec<String>,
        logs: Vec<String>,
    ) -> Value {
        if !Self::valid_id(conv_id) {
            return json!({"status":"error", "message":"Invalid conversation ID"});
        }
        let _write_guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let msg = json!({
            "id": format!("msg-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
            "sender": sender,
            "text": text,
            "timestamp": Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),
            "status": status,
            "bugs_detected": [],
            "fixes_applied": [],
            "diff": "",
            "files_modified": [],
            "logs": logs,
            "images": images,
        });

        let local_file = self.local_conv_path(conv_id);
        if local_file.exists() {
            if let Ok(raw) = fs::read_to_string(&local_file) {
                if let Ok(mut data) = serde_json::from_str::<Value>(&raw) {
                    if let Some(arr) = data.get_mut("messages").and_then(|v| v.as_array_mut()) {
                        arr.push(msg.clone());
                    }
                    if let Some(obj) = data.as_object_mut() {
                        obj.insert(
                            "updated_at".to_string(),
                            json!(Local::now().format("%Y-%m-%d %H:%M:%S").to_string()),
                        );
                    }
                    if let Ok(s) = serde_json::to_string_pretty(&data) {
                        if let Err(e) = crate::storage::atomic_write(&local_file, s.as_bytes()) {
                            return json!({"status":"error", "message":e.to_string()});
                        }
                    }
                    return msg;
                }
            }
        }

        let ov_file = self.overlay_path(conv_id);
        let mut ov = self.get_overlay_messages(conv_id);
        ov.push(msg.clone());
        if let Ok(s) = serde_json::to_string_pretty(&ov) {
            if let Err(e) = crate::storage::atomic_write(&ov_file, s.as_bytes()) {
                return json!({"status":"error", "message":e.to_string()});
            }
        }
        msg
    }

    fn clean_user_content(raw: &str) -> String {
        let mut s = if let Some((_, after)) = raw.split_once("<USER_REQUEST>") {
            after
                .split("</USER_REQUEST>")
                .next()
                .unwrap_or(after)
                .trim()
                .to_string()
        } else {
            raw.trim().to_string()
        };
        for prefix in [
            "[EXECUTION TARGET:",
            "[ACTIVE MODEL:",
            "[PERFORMANCE:",
            "[ACTIVE SKILLS:",
        ] {
            while let Some(pos) = s.find(prefix) {
                if let Some(end) = s[pos..].find(']') {
                    let mut remove_end = pos + end + 1;
                    while remove_end < s.len() && s.as_bytes()[remove_end].is_ascii_whitespace() {
                        remove_end += 1;
                    }
                    s.replace_range(pos..remove_end, "");
                } else {
                    break;
                }
            }
        }
        if let Some((before, _)) = s.split_once("[LAMPIRAN GAMBAR DARI USER:") {
            s = before.trim().to_string();
        }
        s.trim().to_string()
    }

    pub fn get_conversation(&self, conv_id: &str) -> Option<Value> {
        let mut conv = self.read_conversation(conv_id)?;
        if let Some(metadata) = self.metadata(conv_id).as_object() {
            for (key, value) in metadata {
                conv[key] = value.clone();
            }
        }
        Some(conv)
    }

    pub fn store_native_trajectory(&self, conv_id: &str, body: &Value) -> std::io::Result<bool> {
        let steps = body["trajectory"]["steps"]
            .as_array()
            .ok_or_else(|| std::io::Error::other("Missing native trajectory steps"))?;
        let status = body["status"]
            .as_str()
            .filter(|s| s.starts_with("CASCADE_RUN_STATUS_") && !s.ends_with("UNSPECIFIED"))
            .ok_or_else(|| std::io::Error::other("Missing native execution status"))?;
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut conv = self
            .get_conversation(conv_id)
            .ok_or_else(|| std::io::Error::other("Unknown conversation"))?;
        let before = conv.clone();
        let mut messages = Vec::new();
        for (index, step) in steps.iter().enumerate() {
            let kind = step["type"].as_str().unwrap_or("");
            let (sender, text, message_status) = match kind {
                "CORTEX_STEP_TYPE_USER_INPUT" => (
                    "user",
                    Self::clean_user_content(
                        step["userInput"]["userResponse"].as_str().unwrap_or(""),
                    ),
                    "completed",
                ),
                "CORTEX_STEP_TYPE_PLANNER_RESPONSE" => (
                    "antigravity",
                    step["plannerResponse"]["response"]
                        .as_str()
                        .unwrap_or("")
                        .to_string(),
                    "completed",
                ),
                "CORTEX_STEP_TYPE_ERROR_MESSAGE" => (
                    "antigravity",
                    step["errorMessage"]["error"]["shortError"]
                        .as_str()
                        .or_else(|| step["errorMessage"]["error"]["userErrorMessage"].as_str())
                        .unwrap_or("Antigravity reported an execution error.")
                        .to_string(),
                    "error",
                ),
                _ => continue,
            };
            if !text.trim().is_empty() {
                messages.push(json!({"id":format!("native-{index}"),"sender":sender,"text":text,"status":message_status,
                    "timestamp":step["metadata"]["createdAt"].as_str().unwrap_or(conv["created_at"].as_str().unwrap_or("")),
                    "images":[],"logs":[]}));
            }
        }
        conv["messages"] = json!(messages);
        conv["native_status"] = json!(status);
        conv["is_processing"] = json!(status != "CASCADE_RUN_STATUS_IDLE");
        conv["execution_error"] = json!(steps
            .last()
            .and_then(|s| s["errorMessage"]["error"]["shortError"].as_str()));
        self.merge_overlay(conv_id, &mut conv);
        if conv == before {
            return Ok(false);
        }
        crate::storage::atomic_write(&self.local_conv_path(conv_id), &serde_json::to_vec(&conv)?)?;
        Ok(true)
    }

    pub fn store_cli_reply(
        &self,
        conv_id: &str,
        message_id: &str,
        text: &str,
        status: &str,
    ) -> std::io::Result<()> {
        let _guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut conv = self
            .get_conversation(conv_id)
            .ok_or_else(|| std::io::Error::other("Unknown conversation"))?;
        let messages = conv["messages"]
            .as_array_mut()
            .ok_or_else(|| std::io::Error::other("Missing messages"))?;
        let message = json!({"id":message_id,"sender":"antigravity","text":text,"status":status,
            "timestamp":Local::now().format("%Y-%m-%d %H:%M:%S").to_string(),"images":[],"logs":[]});
        if let Some(existing) = messages.iter_mut().find(|m| m["id"] == message_id) {
            *existing = message;
        } else if !text.is_empty() {
            messages.push(message);
        }
        conv["is_processing"] = json!(status == "streaming");
        conv["execution_error"] = if status == "error" {
            json!(text)
        } else {
            Value::Null
        };
        crate::storage::atomic_write(&self.local_conv_path(conv_id), &serde_json::to_vec(&conv)?)
    }

    fn read_conversation(&self, conv_id: &str) -> Option<Value> {
        if !Self::valid_id(conv_id) {
            return None;
        }
        if let Ok(del) = self.deleted_ids.lock() {
            if del.contains(conv_id) {
                return None;
            }
        }

        let transcript = self.resolve_transcript_path(conv_id);
        if transcript.exists()
            && (!matches!(
                self.metadata(conv_id)["native_transport"].as_str(),
                Some("rpc" | "acp")
            ) || !self.local_conv_path(conv_id).exists())
        {
            return Some(self.parse_brain_conversation(conv_id, &transcript));
        }

        let local_file = self.local_conv_path(conv_id);
        if local_file.exists() {
            if let Ok(raw) = fs::read_to_string(&local_file) {
                if let Ok(mut data) = serde_json::from_str::<Value>(&raw) {
                    self.merge_overlay(conv_id, &mut data);
                    return Some(data);
                }
            }
        }
        None
    }

    fn parse_brain_conversation(&self, conv_id: &str, transcript_file: &Path) -> Value {
        let (mtime_key, file_size) = fs::metadata(transcript_file)
            .ok()
            .map(|m| {
                let mt = m
                    .modified()
                    .ok()
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_nanos() as u64)
                    .unwrap_or(0);
                (mt, m.len())
            })
            .unwrap_or((0, 0));

        let mtime_secs = mtime_key / 1_000_000_000;
        if let Ok(cache) = self.cache.lock() {
            if let Some((c_mt, c_sz, ref base)) = cache.get(conv_id) {
                if *c_mt == mtime_key && *c_sz == file_size {
                    let mut out = base.clone();
                    self.merge_overlay(conv_id, &mut out);
                    return out;
                }
            }
        }

        let mut messages: Vec<Value> = Vec::new();
        let mut title = "Antigravity IDE session".to_string();
        let mut created_at = String::new();
        let mut updated_at = String::new();
        let mut last_step_type = String::new();
        let mut last_tool_name: Option<String> = None;

        if let Ok(file) = fs::File::open(transcript_file) {
            let reader = BufReader::new(file);
            for line in reader.lines().map_while(Result::ok) {
                let Ok(step) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                let stype = step
                    .get("type")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                let idx = step.get("step_index").and_then(|v| v.as_i64()).unwrap_or(0);
                let raw_time = step
                    .get("created_at")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let t = if raw_time.len() >= 19 {
                    raw_time
                        .chars()
                        .take(19)
                        .collect::<String>()
                        .replace('T', " ")
                } else {
                    Local::now().format("%Y-%m-%d %H:%M:%S").to_string()
                };
                if created_at.is_empty() {
                    created_at = t.clone();
                }
                updated_at = t.clone();
                last_step_type = stype.clone();

                if stype == "USER_INPUT" {
                    let raw = step.get("content").and_then(|v| v.as_str()).unwrap_or("");
                    let clean = Self::clean_user_content(raw);
                    if title == "Antigravity IDE session" && !clean.is_empty() {
                        let first_line = clean.lines().next().unwrap_or(&clean).trim();
                        title = if first_line.chars().count() > 45 {
                            format!("{}...", first_line.chars().take(45).collect::<String>())
                        } else {
                            first_line.to_string()
                        };
                    }
                    if !clean.is_empty() {
                        messages.push(json!({
                            "id": format!("msg-user-{}", idx),
                            "sender": "user",
                            "text": clean,
                            "timestamp": t,
                            "status": "completed",
                            "bugs_detected": [],
                            "fixes_applied": [],
                            "diff": "",
                            "files_modified": [],
                            "logs": [],
                            "images": [],
                        }));
                    }
                } else if stype == "PLANNER_RESPONSE" {
                    let txt = step
                        .get("content")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .trim();
                    let mut logs = Vec::new();
                    last_tool_name = None;
                    if let Some(tcs) = step.get("tool_calls").and_then(|v| v.as_array()) {
                        for tc in tcs {
                            if let Some(tname) = tc.get("name").and_then(|v| v.as_str()) {
                                logs.push(format!("[TOOL] {}", tname));
                                if last_tool_name.is_none() {
                                    last_tool_name = Some(tname.to_string());
                                }
                            }
                        }
                    }
                    if !txt.is_empty() {
                        messages.push(json!({
                            "id": format!("msg-agent-{}", idx),
                            "sender": "antigravity",
                            "text": txt,
                            "timestamp": t,
                            "status": "completed",
                            "bugs_detected": [],
                            "fixes_applied": [],
                            "diff": "",
                            "files_modified": [],
                            "logs": logs,
                            "images": [],
                        }));
                    }
                }
            }
        }

        let now_secs = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let is_fresh = now_secs.saturating_sub(mtime_secs) <= 15;
        let is_processing =
            is_fresh && (last_step_type == "USER_INPUT" || last_tool_name.is_some());
        let current_action = if is_processing {
            match last_tool_name.as_deref() {
                Some("run_command") => "Running terminal command...".to_string(),
                Some("edit_file") | Some("write_file") => "Applying code changes...".to_string(),
                Some("read_file") => "Reading and analyzing files...".to_string(),
                Some(other) => format!("Running step: {}...", other),
                None => "Analyzing instructions...".to_string(),
            }
        } else {
            String::new()
        };

        let base = json!({
            "id": conv_id,
            "title": title,
            "workspace": "Autonomous AI",
            "source": "antigravity_ide",
            "created_at": created_at,
            "updated_at": updated_at,
            "skills": [],
            "messages": messages,
            "is_processing": is_processing,
            "current_action": current_action,
            "active_tool": last_tool_name,
            "pending_input": Value::Null,
            "pending_agreement": Value::Null,
        });

        if let Ok(mut cache) = self.cache.lock() {
            if cache.len() >= 10 && !cache.contains_key(conv_id) {
                cache.clear();
            }
            cache.insert(conv_id.to_string(), (mtime_key, file_size, base.clone()));
        }

        let mut out = base;
        self.merge_overlay(conv_id, &mut out);
        out
    }

    fn merge_overlay(&self, conv_id: &str, conv: &mut Value) {
        let overlay = self.get_overlay_messages(conv_id);
        if overlay.is_empty() {
            return;
        }
        if let Some(arr) = conv.get_mut("messages").and_then(|v| v.as_array_mut()) {
            for ov in overlay {
                let ov_txt = ov.get("text").and_then(|v| v.as_str()).unwrap_or("").trim();
                let already = arr.iter().any(|m| {
                    m.get("sender").and_then(|v| v.as_str()) == Some("user")
                        && m.get("text")
                            .and_then(|v| v.as_str())
                            .map(|t| t.trim() == ov_txt)
                            .unwrap_or(false)
                });
                if !already {
                    arr.push(ov);
                }
            }
        }
    }

    pub fn list_conversations(&self) -> Vec<Value> {
        let deleted = self
            .deleted_ids
            .lock()
            .map(|d| d.clone())
            .unwrap_or_default();
        let mut items: Vec<(u64, Value)> = Vec::new();
        let mut seen = HashSet::new();

        let mapped_ids: HashSet<String> = fs::read_dir(self.root.join("conversations"))
            .into_iter()
            .flatten()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().ends_with("_meta.json"))
            .filter_map(|entry| fs::read(entry.path()).ok())
            .filter_map(|data| serde_json::from_slice::<Value>(&data).ok())
            .filter_map(|data| data["ide_conversation_id"].as_str().map(str::to_string))
            .collect();

        for bdir in Self::brain_dirs() {
            let Ok(entries) = fs::read_dir(&bdir) else {
                continue;
            };
            for entry in entries.map_while(Result::ok) {
                let path = entry.path();
                if !path.is_dir() {
                    continue;
                }
                let Some(cid) = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .map(|s| s.to_string())
                else {
                    continue;
                };
                if cid == "tempmediaStorage"
                    || mapped_ids.contains(&cid)
                    || deleted.contains(&cid)
                    || !seen.insert(cid.clone())
                {
                    continue;
                }
                let tf = path
                    .join(".system_generated")
                    .join("logs")
                    .join("transcript.jsonl");
                if !tf.exists() {
                    continue;
                }
                let mtime = fs::metadata(&tf)
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let conv = self.get_conversation(&cid).unwrap_or(Value::Null);
                let msg_count = conv
                    .get("messages")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                let last_preview = conv
                    .get("messages")
                    .and_then(|v| v.as_array())
                    .and_then(|a| a.last())
                    .and_then(|m| m.get("text"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .chars()
                    .take(80)
                    .collect::<String>();
                items.push((
                    mtime,
                    json!({
                        "id": cid,
                        "title": conv.get("title").and_then(|v| v.as_str()).unwrap_or("Antigravity IDE session"),
                        "workspace": conv["workspace"],
                        "workspace_path": conv["workspace_path"],
                        "source": "antigravity_ide",
                        "created_at": conv.get("created_at").and_then(|v| v.as_str()).unwrap_or(""),
                        "updated_at": conv.get("updated_at").and_then(|v| v.as_str()).unwrap_or(""),
                        "message_count": msg_count,
                        "last_preview": last_preview,
                        "is_processing": conv.get("is_processing").and_then(|v| v.as_bool()).unwrap_or(false),
                    }),
                ));
            }
        }

        // Also include local JSON conversations
        let conv_dir = self.root.join("conversations");
        if let Ok(entries) = fs::read_dir(&conv_dir) {
            for entry in entries.map_while(Result::ok) {
                let p = entry.path();
                let Some(fname) = p.file_name().and_then(|n| n.to_str()) else {
                    continue;
                };
                if !fname.ends_with(".json")
                    || fname.ends_with("_overlay.json")
                    || fname.ends_with("_meta.json")
                    || fname == "deleted_sessions.json"
                    || fname == "accounts_registry.json"
                {
                    continue;
                }
                let cid = fname.trim_end_matches(".json").to_string();
                if deleted.contains(&cid) || !seen.insert(cid.clone()) {
                    continue;
                }
                if let Some(data) = self.get_conversation(&cid) {
                    let mtime = fs::metadata(&p)
                        .ok()
                        .and_then(|m| m.modified().ok())
                        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                        .map(|d| d.as_secs())
                        .unwrap_or(0);
                    let msg_count = data
                        .get("messages")
                        .and_then(|v| v.as_array())
                        .map(|a| a.len())
                        .unwrap_or(0);
                    items.push((
                            mtime,
                            json!({
                                "id": cid,
                                "title": data.get("title").and_then(|v| v.as_str()).unwrap_or("New session"),
                                "workspace": data.get("workspace").and_then(|v| v.as_str()).unwrap_or("Autonomous AI"),
                                "source": "mobile_bridge",
                                "created_at": data.get("created_at").and_then(|v| v.as_str()).unwrap_or(""),
                                "updated_at": data.get("updated_at").and_then(|v| v.as_str()).unwrap_or(""),
                                "message_count": msg_count,
                                "last_preview": "",
                                "is_processing": data["is_processing"].as_bool().unwrap_or(false),
                                "workspace_path":data["workspace_path"],
                                "ide_conversation_id":data["ide_conversation_id"],
                            }),
                        ));
                }
            }
        }

        items.sort_by_key(|a| std::cmp::Reverse(a.0));
        let result: Vec<Value> = items.into_iter().map(|(_, v)| v).collect();

        if let Ok(mut act) = self.active_id.lock() {
            if act.is_none() {
                if let Some(first_id) = result
                    .first()
                    .and_then(|v| v.get("id"))
                    .and_then(|v| v.as_str())
                {
                    *act = Some(first_id.to_string());
                }
            }
        }
        result
    }

    pub fn get_active_id(&self) -> Option<String> {
        if let Ok(act) = self.active_id.lock() {
            if act.is_some() {
                return act.clone();
            }
        }
        let list = self.list_conversations();
        list.first()
            .and_then(|v| v.get("id"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    }

    pub fn create_conversation(
        &self,
        title: Option<String>,
        workspace: &str,
        skills: Vec<String>,
        initial_prompt: Option<String>,
    ) -> Value {
        let cid = uuid::Uuid::new_v4().to_string();
        let now = Local::now().format("%Y-%m-%d %H:%M:%S").to_string();
        let final_title = title
            .filter(|t| !t.trim().is_empty())
            .or_else(|| {
                initial_prompt.as_ref().and_then(|p| {
                    let t = p.trim();
                    if t.is_empty() {
                        None
                    } else {
                        Some(t.chars().take(42).collect::<String>())
                    }
                })
            })
            .unwrap_or_else(|| "New conversation".to_string());

        let mut messages = Vec::new();
        if let Some(ref p) = initial_prompt {
            if !p.trim().is_empty() {
                messages.push(json!({
                    "id": format!("msg-{}", &uuid::Uuid::new_v4().simple().to_string()[..8]),
                    "sender": "user",
                    "text": p.trim(),
                    "timestamp": now,
                    "status": "submitted",
                    "bugs_detected": [],
                    "fixes_applied": [],
                    "diff": "",
                    "files_modified": [],
                    "logs": [],
                    "images": [],
                }));
            }
        }

        let conv = json!({
            "id": cid,
            "title": final_title,
            "workspace": workspace,
            "source": "mobile_bridge",
            "created_at": now,
            "updated_at": now,
            "skills": skills,
            "messages": messages,
            "is_processing": false,
        });

        let p = self.local_conv_path(&cid);
        if let Ok(s) = serde_json::to_string_pretty(&conv) {
            if let Err(e) = crate::storage::atomic_write(&p, s.as_bytes()) {
                return json!({"status":"error", "message":e.to_string()});
            }
        }
        if let Ok(mut act) = self.active_id.lock() {
            *act = Some(cid);
        }
        conv
    }

    pub fn delete_conversation(&self, conv_id: &str) -> bool {
        if !Self::valid_id(conv_id) {
            return false;
        }
        let _write_guard = self.write_lock.lock().unwrap_or_else(|e| e.into_inner());
        if let Ok(mut del) = self.deleted_ids.lock() {
            del.insert(conv_id.to_string());
            let vec: Vec<String> = del.iter().cloned().collect();
            let deleted_file = self
                .root
                .join("conversations")
                .join("deleted_sessions.json");
            if let Ok(s) = serde_json::to_string_pretty(&vec) {
                if crate::storage::atomic_write(&deleted_file, s.as_bytes()).is_err() {
                    del.remove(conv_id);
                    return false;
                }
            }
        }
        let _ = fs::remove_file(self.local_conv_path(conv_id));
        let _ = fs::remove_file(self.overlay_path(conv_id));
        if let Ok(mut act) = self.active_id.lock() {
            if act.as_deref() == Some(conv_id) {
                *act = None;
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_runtime_responses_and_execution_errors_survive_restart() {
        let root = std::env::temp_dir().join(format!("ag-native-{}", uuid::Uuid::new_v4()));
        let mgr = ConversationManager::new(root.clone());
        let cid = mgr.create_conversation(None, "Test", vec![], None)["id"]
            .as_str()
            .unwrap()
            .to_string();
        mgr.update_metadata(&cid, json!({"native_transport":"rpc"}))
            .unwrap();
        let mut body = json!({"status":"CASCADE_RUN_STATUS_IDLE","trajectory":{"steps":[
            {"type":"CORTEX_STEP_TYPE_USER_INPUT","userInput":{"userResponse":"<USER_REQUEST>\nHello\n</USER_REQUEST>"}},
            {"type":"CORTEX_STEP_TYPE_ERROR_MESSAGE","errorMessage":{"error":{"shortError":"Model unavailable"}}}
        ]}});
        assert!(mgr.store_native_trajectory(&cid, &body).unwrap());
        assert!(!mgr.store_native_trajectory(&cid, &body).unwrap());
        let conv = mgr.get_conversation(&cid).unwrap();
        assert_eq!(conv["messages"][0]["text"], "Hello");
        assert_eq!(conv["messages"][1]["status"], "error");
        assert_eq!(conv["execution_error"], "Model unavailable");
        body["trajectory"]["steps"][1] = json!({"type":"CORTEX_STEP_TYPE_PLANNER_RESPONSE","plannerResponse":{"response":"Real reply"}});
        mgr.store_native_trajectory(&cid, &body).unwrap();
        let restored = ConversationManager::new(root.clone())
            .get_conversation(&cid)
            .unwrap();
        assert_eq!(restored["messages"][1]["text"], "Real reply");
        assert!(restored["execution_error"].is_null());
        assert_eq!(restored["is_processing"], false);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn reading_transcript_does_not_change_selected_session() {
        let root = std::env::temp_dir().join(format!("ag-conv-{}", uuid::Uuid::new_v4()));
        let mgr = ConversationManager::new(root.clone());
        *mgr.active_id.lock().unwrap() = Some("chosen-session".into());
        let transcript = root.join("transcript.jsonl");
        fs::write(
            &transcript,
            "{\"type\":\"USER_INPUT\",\"content\":\"Hello\"}\n",
        )
        .unwrap();
        mgr.parse_brain_conversation("other-session", &transcript);
        assert_eq!(mgr.get_active_id().as_deref(), Some("chosen-session"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn traversal_cannot_read_or_delete_files_outside_conversations() {
        let root = std::env::temp_dir().join(format!("ag-path-{}", uuid::Uuid::new_v4()));
        let mgr = ConversationManager::new(root.clone());
        let outside = root.join("private.json");
        fs::write(&outside, "{\"secret\":true}").unwrap();
        assert!(mgr.get_conversation("../private").is_none());
        assert!(!mgr.delete_conversation("../private"));
        assert!(outside.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_messages_are_not_lost() {
        let root = std::env::temp_dir().join(format!("ag-write-{}", uuid::Uuid::new_v4()));
        let mgr = std::sync::Arc::new(ConversationManager::new(root.clone()));
        let conv = mgr.create_conversation(None, "Test", vec![], None);
        let cid = conv["id"].as_str().unwrap().to_string();
        std::thread::scope(|scope| {
            for i in 0..20 {
                let mgr = &mgr;
                let cid = &cid;
                scope.spawn(move || {
                    mgr.add_message(
                        cid,
                        "user",
                        &format!("message {i}"),
                        "submitted",
                        vec![],
                        vec![],
                    );
                });
            }
        });
        assert_eq!(
            mgr.get_conversation(&cid).unwrap()["messages"]
                .as_array()
                .unwrap()
                .len(),
            20
        );
        fs::remove_dir_all(root).unwrap();
    }
}
