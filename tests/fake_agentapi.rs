// Protocol fixture only. Never contacts an IDE or model provider.
use std::{env, fs, io::Write};
fn main() {
    let args: Vec<String> = env::args().collect();
    let command = args.get(2).map(String::as_str).unwrap_or("");
    let cwd = env::current_dir().unwrap();
    writeln!(
        fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(cwd.join("agentapi_calls.log"))
            .unwrap(),
        "{command}"
    )
    .unwrap();
    let id = "11111111-2222-4333-8444-555555555555";
    let transcript = std::path::PathBuf::from(env::var("USERPROFILE").unwrap())
        .join(".gemini/antigravity/brain")
        .join(id)
        .join(".system_generated/logs/transcript.jsonl");
    fs::create_dir_all(transcript.parent().unwrap()).unwrap();
    let mut content = "{\"type\":\"USER_INPUT\",\"content\":\"Protocol fixture prompt\",\"step_index\":0}\n{\"type\":\"PLANNER_RESPONSE\",\"content\":\"BRIDGE_SMOKE_OK\",\"step_index\":1}\n".to_string();
    if command == "new-conversation" {
        content.push_str("{\"type\":\"USER_INPUT\",\"content\":\"Fixture turn still running\",\"step_index\":2}\n");
    }
    fs::write(transcript, content).unwrap();
    if command == "new-conversation" {
        println!("{{\"response\":{{\"conversation_id\":\"{id}\"}}}}");
    } else if command == "send-message" {
        assert!(
            args.iter().any(|a| a == id),
            "Follow-ups must use the mapped native ID"
        );
        println!("{{\"response\":{{\"accepted\":true}}}}");
    } else {
        std::process::exit(1);
    }
}
