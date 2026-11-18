"""Ask the signed-in CLI to read one disposable fixture outside its workspace; decline any request."""
import argparse
import json
import os
from pathlib import Path
import sys
import tempfile
import time
import uuid
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
from smoke import Server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", required=True)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    server = Server(args.binary)
    try:
        server.env.update(USERPROFILE=str(Path.home()), HOME=str(Path.home()),
                          BRIDGE_AGY_EXE=str(Path.home() / ".gemini/bin/agy.exe"))
        server.restart()
        with tempfile.TemporaryDirectory(prefix="agy-read-fixture-") as folder:
            fixture = Path(folder) / "read-check.txt"
            marker = uuid.uuid4().hex
            fixture.write_text(marker, encoding="utf8")
            def api(method, endpoint, body=None):
                req = Request(f"http://127.0.0.1:{server.port}{endpoint}", method=method,
                              data=json.dumps(body).encode() if body is not None else None,
                              headers={"Content-Type":"application/json"})
                with urlopen(req, timeout=95) as reply:
                    return reply.status, json.load(reply)
            cid = api("POST", "/api/conversations", {"title":"Consent verification"})[1]["id"]
            catalog = api("GET", f"/api/models?target=cli&refresh=true&conversation_id={cid}")[1]
            models = [m["id"] for m in catalog["models"] if not m["disabled"]]
            model = next((m for m in models if "flash" in m and m.endswith("-low")), models[0])
            prompt = (f"Using only your file reading tool, read this disposable test file: {fixture}. "
                      "Reply with its contents. If access is declined or unavailable, reply exactly "
                      "AGY_READ_DECLINED and stop. Do not use the terminal or modify files.")
            status = api("POST", "/api/tasks/submit", {"execution_target":"cli", "model":model,
                         "conversation_id":cid, "request_id":str(uuid.uuid4()), "prompt":prompt})[0]
            assert status == 200, status
            decisions = []
            deadline = time.monotonic() + 120
            while time.monotonic() < deadline:
                for req in api("GET", "/api/tasks/pending")[1]["tasks"]:
                    assert req["conversation_id"] == cid
                    choice = next((o for o in req["options"] if o["kind"] == "reject_once"), None)
                    decision = {"conversation_id":cid, "request_id":req["request_id"],
                                "option_id":choice["optionId"] if choice else None}
                    status = api("POST", "/api/tasks/reject", decision)[0]
                    assert status == 200, status
                    decisions.append(choice["kind"] if choice else "cancelled")
                if cid not in api("GET", "/api/conversations/active-tasks")[1]["active_tasks"]:
                    break
                time.sleep(.2)
            else:
                raise TimeoutError("AGY did not finish the fixture read")
            replies = [m for m in api("GET", f"/api/conversations/{cid}")[1]["messages"] if m["sender"] == "antigravity"]
            assert replies, "No native reply"
            last = replies[-1]
            result = {"native_decisions":decisions, "finish_status":last["status"],
                      "returned_declined_marker":"AGY_READ_DECLINED" in last["text"],
                      "returned_fixture_marker":marker in last["text"]}
            args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
            print(json.dumps(result))
            assert not decisions or not result["returned_fixture_marker"], "The agent read the declined fixture"
    finally:
        server.close()


if __name__ == "__main__":
    main()
