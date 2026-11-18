use serde_json::{json, Value};
use std::collections::{HashSet, VecDeque};

const MAX_REQUESTS: usize = 32;
const MAX_CONTEXT_BYTES: usize = 128 * 1024;

#[derive(Default)]
pub(super) struct Permissions {
    pub prompt_id: Option<u64>,
    pub closed: bool,
    tools: VecDeque<(String, Value)>,
    pub pending: Vec<(Value, Value)>, // ACP message id and phone-facing request
}

impl Permissions {
    fn context(&self, update: &Value) -> Option<Value> {
        let id = update["toolCallId"].as_str().filter(|id| !id.is_empty())?;
        let mut context = self
            .tools
            .iter()
            .find(|(key, _)| key == id)
            .map(|(_, value)| value.clone())
            .unwrap_or_else(|| json!({}));
        for key in ["title", "kind", "locations", "rawInput", "content"] {
            if let Some(value) = update.get(key).filter(|v| !v.is_null()) {
                context[key] = value.clone();
            }
        }
        Some(context)
    }

    pub fn remember(&mut self, update: &Value) {
        if self.prompt_id.is_none() {
            return;
        }
        let Some(context) = self.context(update) else {
            return;
        };
        let id = update["toolCallId"].as_str().unwrap();
        self.tools.retain(|(key, _)| key != id);
        if self.tools.len() == MAX_REQUESTS {
            self.tools.pop_front();
        }
        if context.to_string().len() <= MAX_CONTEXT_BYTES {
            self.tools.push_back((id.to_owned(), context));
        }
    }

    pub fn offer(&mut self, rpc_id: &Value, params: &Value) -> bool {
        if self.prompt_id.is_none()
            || self.closed
            || self.pending.len() >= MAX_REQUESTS
            || self.pending.iter().any(|(id, _)| id == rpc_id)
        {
            return false;
        }
        let Some(tool) = self.context(&params["toolCall"]) else {
            return false;
        };
        let Some(options) = params["options"].as_array() else {
            return false;
        };
        if options.is_empty() || options.len() > MAX_REQUESTS {
            return false;
        }
        let mut ids = HashSet::new();
        for option in options {
            let Some(id) = option["optionId"].as_str().filter(|s| !s.is_empty()) else {
                return false;
            };
            if !ids.insert(id)
                || !option["name"]
                    .as_str()
                    .is_some_and(|s| !s.trim().is_empty())
                || !matches!(
                    option["kind"].as_str(),
                    Some("allow_once" | "allow_always" | "reject_once" | "reject_always")
                )
            {
                return false;
            }
        }
        let title = tool["title"].as_str().filter(|s| !s.trim().is_empty());
        if title.is_none()
            && tool["rawInput"].is_null()
            && tool["content"].is_null()
            && tool["locations"].is_null()
        {
            return false;
        }
        let view = json!({"request_id":uuid::Uuid::new_v4().to_string(),"title":title.unwrap_or("Review tool request"),
            "tool":tool,"options":options});
        if view.to_string().len() > MAX_CONTEXT_BYTES {
            return false;
        }
        self.pending.push((rpc_id.clone(), view));
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_only_requests_use_the_current_turns_tool_details() {
        let mut state = Permissions {
            prompt_id: Some(4),
            ..Default::default()
        };
        let options = json!([{"optionId":"yes","name":"Read once","kind":"allow_once"}]);
        let params = json!({"toolCall":{"toolCallId":"read"},"options":options});
        assert!(!state.offer(&json!(7), &params));
        state.remember(
            &json!({"toolCallId":"read","title":"Read file","rawInput":{"path":"fixture.txt"}}),
        );
        assert!(state.offer(&json!(7), &params));
        assert_eq!(
            state.pending[0].1["tool"]["rawInput"]["path"],
            "fixture.txt"
        );
        assert!(!state.offer(&json!(7), &params));
        let duplicate = json!({"toolCall":{"toolCallId":"read"},"options":[options[0],options[0]]});
        assert!(!state.offer(&json!(8), &duplicate));
        state.closed = true;
        assert!(!state.offer(&json!(9), &params));
    }
}
