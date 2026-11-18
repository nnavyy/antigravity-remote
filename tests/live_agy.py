"""Verify the real AGY account in a disposable bridge workspace.

This sends three small live prompts and can consume model quota.
Usage: python tests/live_agy.py --binary target/release/antigravity-bridge.exe
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import tempfile
import time
import urllib.request
import uuid

import psutil

ROOT = Path(__file__).resolve().parents[1]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default="target/release/antigravity-bridge.exe")
    parser.add_argument("--evidence", default=f"docs/review/agy-live-{datetime.date.today()}.json")
    args = parser.parse_args()
    with tempfile.TemporaryDirectory(prefix="agy-live-") as directory:
        root = Path(directory)
        shutil.copytree(ROOT / "static", root / "static")
        with socket.socket() as sock:
            sock.bind(("127.0.0.1", 0))
            port = sock.getsockname()[1]
        env = dict(os.environ, BRIDGE_HOST="127.0.0.1", BRIDGE_PORT=str(port))
        for key in ("ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN", "BRIDGE_AGY_EXE"):
            env.pop(key, None)
        log = (root / "server.log").open("w", encoding="utf8")
        process = subprocess.Popen([str(Path(args.binary).resolve())], cwd=root, env=env, stdout=log, stderr=subprocess.STDOUT)

        def api(path, payload=None):
            request = urllib.request.Request(f"http://127.0.0.1:{port}{path}", data=None if payload is None else json.dumps(payload).encode(),
                                             headers={"Content-Type":"application/json"})
            with urllib.request.urlopen(request, timeout=95) as response:
                return json.load(response)

        def transcript(cid):
            return api(f"/api/conversations/{cid}")

        def wait_finished(cid, minimum_replies):
            end = time.monotonic() + 120
            while time.monotonic() < end:
                conv = transcript(cid)
                replies = [m for m in conv["messages"] if m["sender"] == "antigravity"]
                if len(replies) >= minimum_replies and not api("/api/conversations/active-tasks")["active_tasks"]:
                    return transcript(cid)
                time.sleep(.25)
            raise TimeoutError("AGY turn did not finish within 120 seconds")

        try:
            for _ in range(100):
                try:
                    api("/healthz")
                    break
                except OSError:
                    time.sleep(.1)
            catalog = api("/api/models?target=cli&refresh=true")
            assert catalog["connected"], catalog
            ids = [m["id"] for m in catalog["models"]]
            preferred = next((i for i in ids if "flash" in i and i.endswith("-low")), ids[0])
            follow_model = next((i for i in ids if "flash" in i and i.endswith("-medium")), preferred)
            cid = api("/api/conversations", {"title":"AGY bridge verification"})["id"]

            def send(prompt, model):
                result = api("/api/tasks/submit", {"conversation_id":cid,"execution_target":"cli","model":model,
                    "prompt":prompt,"request_id":str(uuid.uuid4())})
                assert result["status"] == "ok", result

            def idle_agy_children():
                remaining = []
                for child in psutil.Process(process.pid).children(recursive=True):
                    try:
                        if child.name().lower() in ("agy", "agy.exe"):
                            remaining.append(child.pid)
                    except psutil.NoSuchProcess:
                        pass
                assert not remaining, "An AGY child remained after a completed turn"
                return len(remaining)

            send("Reply exactly AGY_CONNECTION_OK. Do not use tools or change files.", preferred)
            first = wait_finished(cid, 1)
            assert "AGY_CONNECTION_OK" in first["messages"][-1]["text"], first["messages"][-1]
            session = first["acp_session_id"]
            idle_children = [idle_agy_children()]
            send("Reply exactly AGY_FOLLOWUP_OK. Do not use tools or change files.", follow_model)
            second = wait_finished(cid, 2)
            assert "AGY_FOLLOWUP_OK" in second["messages"][-1]["text"], second["messages"][-1]
            assert second["acp_session_id"] == session
            idle_children.append(idle_agy_children())
            send("Write a numbered list of 1000 different short sentences about arithmetic. Use no tools. Do not change files.", preferred)
            end = time.monotonic() + 40
            streamed = False
            while time.monotonic() < end:
                current = transcript(cid)
                if any(m["status"] == "streaming" for m in current["messages"]):
                    streamed = True
                    break
                time.sleep(.1)
            assert streamed, "No streaming chunk was observed"
            stopped = api("/api/tasks/active/stop", {"conversation_id":cid})
            assert stopped["status"] == "ok", stopped
            final = wait_finished(cid, 3)
            assert final["messages"][-1]["status"] == "cancelled", final["messages"][-1]["status"]
            idle_children.append(idle_agy_children())
            quota = api("/api/tokens")
            evidence = {"verified_date":datetime.date.today().isoformat(),"binary_sha256":hashlib.sha256(Path(args.binary).read_bytes()).hexdigest(),
                        "target":catalog["target"],"model_ids":ids,
                        "model_count":len(ids),"requested_models":[preferred,follow_model],
                        "responses":[first["messages"][-1]["text"],second["messages"][-1]["text"]],
                        "same_session":True,"streaming_observed":streamed,"stop_status":final["messages"][-1]["status"],
                        "agy_children_after_each_turn":idle_children,
                        "quota_live":quota["is_live"],"verification_workspace":"disposable temporary directory",
                        "prompts_requested_tools_or_file_changes":False}
            Path(args.evidence).parent.mkdir(parents=True, exist_ok=True)
            Path(args.evidence).write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf8")
            print(json.dumps(evidence, indent=2), flush=True)
        finally:
            children = psutil.Process(process.pid).children(recursive=True) if process.poll() is None else []
            process.terminate()
            process.wait(timeout=10)
            for child in children:
                try:
                    child.terminate()
                except psutil.NoSuchProcess:
                    pass
            psutil.wait_procs(children, timeout=5)
            log.close()


if __name__ == "__main__":
    main()
