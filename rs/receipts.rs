use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{self, Write},
    path::{Path, PathBuf},
};

pub enum Claim {
    New(PathBuf),
    Replay(u16, Value),
    Conflict(&'static str),
}

pub fn claim(root: &Path, id: &str, payload: &Value) -> io::Result<Claim> {
    let mut input = payload.clone();
    if let Some(obj) = input.as_object_mut() {
        for key in ["request_id", "offline_id", "queued_at"] {
            obj.remove(key);
        }
    }
    let fingerprint = format!("{:x}", Sha256::digest(serde_json::to_vec(&input)?));
    let dir = root.join("data/receipts");
    fs::create_dir_all(&dir)?;
    let path = dir.join(format!("{id}.json"));
    match fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
    {
        Ok(mut file) => {
            file.write_all(&serde_json::to_vec(
                &json!({"fingerprint":fingerprint,"state":"pending"}),
            )?)?;
            file.sync_all()?;
            Ok(Claim::New(path))
        }
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {
            let saved: Value = serde_json::from_slice(&fs::read(&path)?).unwrap_or(Value::Null);
            if saved.is_null() {
                return Ok(Claim::Conflict(
                    "Delivery receipt is incomplete. Check the IDE before retrying.",
                ));
            }
            if saved["fingerprint"] != fingerprint {
                return Ok(Claim::Conflict(
                    "Request ID already belongs to a different task.",
                ));
            }
            if saved["state"] == "complete" {
                return Ok(Claim::Replay(
                    saved["http_status"].as_u64().unwrap_or(500) as u16,
                    saved["response"].clone(),
                ));
            }
            Ok(Claim::Conflict(
                "Delivery is pending or its outcome is unknown. Check the IDE before retrying.",
            ))
        }
        Err(e) => Err(e),
    }
}

pub fn complete(path: &Path, status: u16, response: &Value) -> io::Result<()> {
    let mut saved: Value = serde_json::from_slice(&fs::read(path)?)?;
    saved["state"] = json!("complete");
    saved["http_status"] = json!(status);
    saved["response"] = response.clone();
    crate::storage::atomic_write(path, &serde_json::to_vec(&saved)?)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn incomplete_receipt_never_dispatches_again() {
        let root = std::env::temp_dir().join(format!("ag-receipt-{}", uuid::Uuid::new_v4()));
        let id = uuid::Uuid::new_v4().to_string();
        assert!(matches!(
            claim(&root, &id, &json!({"prompt":"one"})).unwrap(),
            Claim::New(_)
        ));
        assert!(matches!(
            claim(&root, &id, &json!({"prompt":"one"})).unwrap(),
            Claim::Conflict(_)
        ));
        fs::remove_dir_all(root).unwrap();
    }
}
