"""Compare a transcript reader and a watcher using the existing disposable desktop fixture."""
import argparse
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
import smoke


def exercise(read_completed_transcript):
    fixture = smoke.ModelFlow()
    fixture.setUp()
    try:
        api = fixture.server.json
        cid = api("POST", "/api/conversations", {"title":"Desktop completion check"})[1]["id"]
        payload = {"conversation_id":cid, "execution_target":"ide", "model":"future-v99", "prompt":"Fixture only"}
        fixture.trajectory_status = "CASCADE_RUN_STATUS_RUNNING"
        status, body, _ = api("POST", "/api/tasks/submit", payload)
        assert status == 200, body
        # Let the watcher observe the running task before the runtime turns idle.
        time.sleep(2.5)
        fixture.trajectory_status = "CASCADE_RUN_STATUS_IDLE"
        if read_completed_transcript:
            transcript = api("GET", f"/api/conversations/{cid}")[1]
            assert transcript["native_status"] == fixture.trajectory_status and not transcript["is_processing"]
        time.sleep(5)
        active = cid in api("GET", "/api/conversations/active-tasks")[1]["active_tasks"]
        status, _, _ = api("POST", "/api/tasks/submit", dict(payload, prompt="Fixture follow-up"))
        return {"active_after_idle":active, "followup_http":status,
                "native_sends":sum(method == "SendUserCascadeMessage" for method, _ in fixture.events)}
    finally:
        fixture.tearDown()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    options = parser.parse_args()
    smoke.ARGS = argparse.Namespace(binary=str(ROOT / "antigravity-bridge.exe"))
    result = {name: exercise(read) for name, read in (("watcher_first", False), ("reader_first", True))}
    options.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
    print(json.dumps(result))
    sys.exit(0 if all(r["followup_http"] == 200 and not r["active_after_idle"] for r in result.values()) else 1)
