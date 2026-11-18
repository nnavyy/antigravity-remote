// Local ACP fixture. Never contacts AGY or a model provider.
use serde_json::{json, Value};
use std::{
    env, fs,
    io::{self, BufRead, Write},
};

fn emit(value: Value) {
    println!("{value}");
    io::stdout().flush().unwrap();
}

fn main() {
    let args = env::args().collect::<Vec<_>>();
    let log = env::var("AGY_FIXTURE_LOG").unwrap();
    let catalog = || -> Value {
        serde_json::from_slice(&fs::read(env::var("AGY_FIXTURE_CATALOG").unwrap()).unwrap())
            .unwrap()
    };
    if args.get(1).is_some_and(|arg| arg == "models") {
        writeln!(
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log)
                .unwrap(),
            "{{\"method\":\"models\"}}"
        )
        .unwrap();
        for model in catalog().as_array().unwrap() {
            println!(
                "{}\t{}",
                model["id"].as_str().unwrap(),
                model["name"].as_str().unwrap()
            );
        }
        return;
    }
    let session = "11111111-2222-4333-8444-555555555555";
    let session_setup = || -> Value {
        if let Ok(path) = env::var("AGY_FIXTURE_SESSION_CATALOG") {
            return serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        }
        let rows = catalog();
        let models: Vec<Value> = rows
            .as_array()
            .unwrap()
            .iter()
            .map(|m| json!({"modelId":m["id"],"name":m["name"]}))
            .collect();
        json!({"models":{"currentModelId":rows[0]["id"],"availableModels":models}})
    };
    let mut model = String::new();
    let mut waiting = None;
    let mut permission = None;
    for line in io::stdin().lock().lines() {
        let request: Value = serde_json::from_str(&line.unwrap()).unwrap();
        writeln!(
            fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log)
                .unwrap(),
            "{request}"
        )
        .unwrap();
        let id = request["id"].clone();
        let method = request["method"].as_str().unwrap_or("");
        let params = &request["params"];
        let result = match method {
            "initialize" => json!({"protocolVersion":1,"agentCapabilities":{"loadSession":true}}),
            "session/new" => {
                let mut result = session_setup();
                result["sessionId"] = json!(session);
                result
            }
            "session/load" => {
                assert_eq!(params["sessionId"], session);
                session_setup()
            }
            "session/set_model" => {
                assert!(catalog()
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|m| m["id"] == params["modelId"]));
                model = params["modelId"].as_str().unwrap().to_string();
                json!({})
            }
            "session/prompt" => {
                assert_eq!(params["sessionId"], session);
                let text = params["prompt"][0]["text"].as_str().unwrap();
                emit(
                    json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,"update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":format!("ACP_OK {model}")}}}}),
                );
                if text.contains("disconnect") {
                    return;
                }
                if text.contains("oversize") {
                    for _ in 0..3 {
                        emit(
                            json!({"jsonrpc":"2.0","method":"session/update","params":{"sessionId":session,
                            "update":{"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"x".repeat(2 * 1024 * 1024)}}}}),
                        );
                    }
                }
                if text.contains("permission") {
                    permission = Some(id);
                    emit(
                        json!({"jsonrpc":"2.0","id":9000,"method":"session/request_permission","params":{"sessionId":session,"toolCall":{"toolCallId":"call-1","title":"Read fixture.txt","rawInput":{"path":"fixture.txt"}},"options":[{"optionId":"read-once","name":"Allow once","kind":"allow_once"},{"optionId":"deny","name":"Deny once","kind":"reject_once"}]}}),
                    );
                    continue;
                }
                if text.contains("wait") {
                    waiting = Some(id);
                    continue;
                }
                json!({"stopReason":"end_turn"})
            }
            "session/cancel" => {
                if let Some(pending) = waiting.take() {
                    emit(json!({"jsonrpc":"2.0","id":pending,"result":{"stopReason":"cancelled"}}));
                }
                continue;
            }
            "" if id == 9000 => {
                let outcome = &request["result"]["outcome"];
                assert!(
                    outcome["outcome"] == "cancelled"
                        || (outcome["outcome"] == "selected"
                            && matches!(outcome["optionId"].as_str(), Some("read-once" | "deny")))
                );
                emit(
                    json!({"jsonrpc":"2.0","id":permission.take().unwrap(),"result":{"stopReason":if outcome["outcome"] == "cancelled" { "cancelled" } else { "end_turn" }}}),
                );
                continue;
            }
            _ => panic!("Unexpected ACP method: {method}"),
        };
        emit(json!({"jsonrpc":"2.0","id":id,"result":result}));
    }
}
