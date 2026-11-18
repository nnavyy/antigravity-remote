use crate::telemetry::TelemetryMonitor;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::time::{Duration, Instant};

pub async fn catalog(monitor: &TelemetryMonitor, target: &str, refresh: bool) -> Value {
    let started = Instant::now();
    let mut cache = monitor.model_cache.lock().await;
    if let Some((at, value)) = cache.get(target) {
        if *at >= started || (!refresh && at.elapsed() < Duration::from_secs(10)) {
            return value.clone();
        }
    }
    let previous_sync = cache
        .get(target)
        .map(|(_, value)| value["last_successful_sync"].clone())
        .unwrap_or(Value::Null);
    let mut result = discover(monitor, target).await;
    result["last_successful_sync"] = if result["connected"] == true {
        result["synced_at"].clone()
    } else {
        previous_sync
    };
    cache.insert(target.to_string(), (Instant::now(), result.clone()));
    result
}

async fn discover(monitor: &TelemetryMonitor, target: &str) -> Value {
    if target != "cli" {
        match monitor
            .rpc_with_failure("GetAvailableModels", &json!({"forceRefresh":true}))
            .await
        {
            Ok(body) => {
                return match normalize(&body) {
                    Ok(mut models) => {
                        models["target"] = json!("ide");
                        models
                    }
                    Err(message) => {
                        json!({"connected":false,"target":"ide","models":[],"message":message})
                    }
                }
            }
            // Only an absent/unreachable desktop permits automatic CLI fallback.
            // A responding desktop's denied or incompatible catalog must not
            // silently switch the request to another account or runtime.
            Err(error) if target == "ide" && error.unavailable => {
                return json!({"connected":false,"target":"ide","models":[],"message":"Open the standalone Antigravity App on the laptop to connect this target."});
            }
            Err(error) if !error.unavailable => {
                return json!({"connected":false,"target":"ide","models":[],"message":error.message});
            }
            Err(_) => {}
        }
    }
    match cli_catalog().await {
        Ok(models) => models,
        Err(message) => {
            json!({"connected":false,"target":if target == "auto" { "ide" } else {target},"models":[],"message":message})
        }
    }
}

async fn cli_catalog() -> Result<Value, String> {
    let exe = crate::acp::executable().ok_or(
        "AGY is disconnected. Open Antigravity or install and sign in to AGY CLI on the laptop.",
    )?;
    let mut command = tokio::process::Command::new(exe);
    command.arg("models").kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x08000000);
    let output = tokio::time::timeout(Duration::from_secs(50), command.output())
        .await
        .map_err(|_| "AGY model discovery timed out. Check the laptop connection.")?
        .map_err(|_| "Could not run AGY model discovery.")?;
    if !output.status.success() {
        return Err("AGY could not load models. Sign in using AGY on the laptop.".into());
    }
    let models = parse_cli_models(&String::from_utf8_lossy(&output.stdout));
    if models.is_empty() {
        return Err("AGY returned an empty or incompatible model catalog.".into());
    }
    Ok(
        json!({"connected":true,"source":"agy_cli","target":"cli","models":models,
        "synced_at":chrono::Utc::now().to_rfc3339(),"message":"Models synced from AGY CLI."}),
    )
}

fn parse_cli_models(output: &str) -> Vec<Value> {
    let mut seen = HashSet::new();
    output
        .lines()
        .filter_map(|line| {
            // `agy models` emits tab-delimited records, not arbitrary status text.
            let (id, name) = line.split_once('\t')?;
            let name = name.trim();
            if id.is_empty()
                || name.is_empty()
                || !id
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || "-_.".contains(c))
                || !seen.insert(id)
            {
                return None;
            }
            Some(json!({"id":id,"name":name,"disabled":false,"native_model":null,"category":""}))
        })
        .collect()
}

fn normalize(body: &Value) -> Result<Value, String> {
    let response = &body["response"];
    let details = response["models"]
        .as_object()
        .ok_or("Antigravity model catalog format changed.")?;
    // The map also contains internal completion/image models. Only expose models
    // explicitly listed in the runtime's account-specific agent picker.
    let sorts = response["agentModelSorts"]
        .as_array()
        .ok_or("Antigravity did not provide an agent model list.")?;
    let mut seen = HashSet::new();
    let mut models = Vec::new();
    for sort in sorts {
        let groups = sort["groups"]
            .as_array()
            .ok_or("Antigravity agent model groups changed format.")?;
        for group in groups {
            let ids = group["modelIds"]
                .as_array()
                .ok_or("Antigravity agent model IDs changed format.")?;
            for raw_id in ids {
                let id = raw_id
                    .as_str()
                    .filter(|id| !id.is_empty())
                    .ok_or("Antigravity returned an invalid model ID.")?;
                if !seen.insert(id) {
                    continue;
                }
                let Some(model) = details.get(id).filter(|m| m.is_object()) else {
                    continue;
                };
                let Some(name) = model["displayName"].as_str().filter(|s| !s.is_empty()) else {
                    continue;
                };
                let native_model = model.get("model").filter(|v| {
                    v.as_str()
                        .is_some_and(|s| s.starts_with("MODEL_") && s != "MODEL_UNSPECIFIED")
                        || v.as_i64().is_some_and(|n| n > 0)
                });
                let disabled = match model.get("disabled") {
                    None => false,
                    Some(value) => value
                        .as_bool()
                        .ok_or("Antigravity model access flags changed format.")?,
                } || native_model.is_none();
                models.push(json!({"id":id,"name":name,"disabled":disabled,
                    "native_model":native_model,
                    "category":group["displayName"].as_str().unwrap_or(""),
                    "description":model["description"].as_str().unwrap_or(""),
                    "supports_images":model["supportsImages"].as_bool().unwrap_or(false)}));
            }
        }
    }
    let default = response
        .get("defaultAgentModelId")
        .map(|value| {
            value
                .as_str()
                .ok_or("Antigravity default model changed format.")
        })
        .transpose()?
        .filter(|id| !id.is_empty());
    Ok(
        json!({"connected":true,"source":"antigravity_runtime","models":models,
        "default_model_id":default,"synced_at":chrono::Utc::now().to_rfc3339(),
        "message":"Models are synced from your connected Antigravity account."}),
    )
}

pub fn validate_selection(catalog: &Value, id: &str) -> Result<Value, &'static str> {
    if catalog["connected"] != true {
        return Err("Cannot verify model access. Reconnect Antigravity before sending.");
    }
    if id.is_empty() {
        let enabled = catalog["models"]
            .as_array()
            .is_some_and(|models| models.iter().any(|model| model["disabled"] == false));
        if !enabled {
            return Err("No agent models are available to the connected Antigravity account. Check its plan and organization policy.");
        }
        if let Some(default) = catalog["default_model_id"]
            .as_str()
            .filter(|id| !id.is_empty())
        {
            validate_selection(catalog, default)?;
        }
        // Preserve the provider's session default; never substitute a first or
        // supposedly higher-tier model when no explicit model was requested.
        return Ok(Value::Null);
    }
    if let Some(model) = catalog["models"].as_array().and_then(|models| {
        models
            .iter()
            .find(|m| m["id"] == id && m["disabled"] == false)
    }) {
        Ok(model["native_model"].clone())
    } else {
        Err("This model is no longer available to the connected Antigravity account. Refresh the model picker.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_account_agent_models_are_exposed_and_future_ids_need_no_update() {
        let body = json!({"response":{"models":{
            "future-v99":{"displayName":"Future model","model":"MODEL_FUTURE"},
            "locked":{"displayName":"Paid model","model":"MODEL_PAID","disabled":true},
            "internal":{"displayName":"Completion engine"}},
            "agentModelSorts":[{"groups":[{"modelIds":["future-v99","locked","missing","future-v99"]}]}],
            "defaultAgentModelId":"future-v99"}});
        let catalog = normalize(&body).unwrap();
        assert_eq!(catalog["models"].as_array().unwrap().len(), 2);
        assert_eq!(catalog["default_model_id"], "future-v99");
        assert!(validate_selection(&catalog, "future-v99").is_ok());
        assert!(validate_selection(&catalog, "locked").is_err());
        assert!(validate_selection(&catalog, "internal").is_err());
        assert!(validate_selection(&json!({"connected":false}), "future-v99").is_err());
    }
    #[test]
    fn incompatible_catalog_is_not_guessed() {
        assert!(normalize(&json!({"response":{"models":{}}})).is_err());
    }

    #[test]
    fn malformed_picker_or_entitlement_flags_are_never_enabled() {
        for sorts in [
            json!([{}]),
            json!([{"groups":{}}]),
            json!([{"groups":[{}]}]),
            json!([{"groups":[{"modelIds":[42]}]}]),
        ] {
            assert!(normalize(&json!({"response":{"models":{},"agentModelSorts":sorts}})).is_err());
        }
        let body = json!({"response":{"models":{"restricted":{"displayName":"Restricted","model":"MODEL_RESTRICTED","disabled":"true"}},
            "agentModelSorts":[{"groups":[{"modelIds":["restricted"]}]}]}});
        assert!(normalize(&body).is_err());
    }

    #[test]
    fn native_default_requires_live_access_without_choosing_a_replacement() {
        assert!(validate_selection(&json!({"connected":false}), "").is_err());
        assert!(validate_selection(&json!({"connected":true,"models":[]}), "").is_err());
        let mut catalog = json!({"connected":true,"models":[{"id":"restricted","disabled":true},{"id":"enabled","disabled":false}]});
        assert_eq!(validate_selection(&catalog, "").unwrap(), Value::Null);
        catalog["default_model_id"] = json!("restricted");
        assert!(validate_selection(&catalog, "").is_err());
        catalog["default_model_id"] = json!("enabled");
        assert_eq!(validate_selection(&catalog, "").unwrap(), Value::Null);
    }

    #[test]
    fn cli_status_text_is_not_a_model_catalog() {
        assert!(parse_cli_models("Fetching available models...\n").is_empty());
        assert!(parse_cli_models("MODEL NAME\n").is_empty());
    }

    #[test]
    fn cli_catalog_keeps_exact_future_ids_and_fixed_model_names() {
        let models = parse_cli_models("future-xhigh\tFuture (XHigh)\norchestrator-argon\tOrchestrator (Argon)\nfuture-xhigh\tDuplicate\n");
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], "future-xhigh");
        assert_eq!(models[1]["name"], "Orchestrator (Argon)");
        assert!(!models[0]["disabled"].as_bool().unwrap());
    }
}
