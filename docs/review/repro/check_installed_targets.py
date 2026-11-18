"""Read live AGY catalogs in an isolated bridge. --ide-prompt also exercises one new IDE chat."""
import argparse
import datetime
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
import uuid
from urllib import error, request

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
from smoke import Server


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--ide-prompt", action="store_true")
    parser.add_argument("--ide-followup", action="store_true", help="Also check whether the finished desktop session accepts a second turn.")
    args = parser.parse_args()
    agy = Path(os.environ.get("BRIDGE_AGY_EXE", str(Path.home() / ".gemini/bin/agy.exe")))
    version = subprocess.check_output([agy, "--version"], text=True, timeout=30).strip()
    native = subprocess.check_output([agy, "models"], text=True, encoding="utf8", timeout=90)
    direct = {line.split("\t")[0] for line in native.splitlines() if re.fullmatch(r"[\w.-]+\t.+", line)}
    server = Server(ROOT / "antigravity-bridge.exe")
    result = {"checked": datetime.datetime.now().astimezone().isoformat(), "cli_version": version,
              "direct_count": len(direct), "targets": {}}
    try:
        server.env.update(USERPROFILE=os.environ["USERPROFILE"], HOME=str(Path.home()), BRIDGE_AGY_EXE=str(agy))
        for key in ("ANTIGRAVITY_LS_ADDRESS", "ANTIGRAVITY_CSRF_TOKEN"):
            server.env.pop(key, None)
        server.restart()

        def api(path, data=None):
            req = request.Request(f"http://127.0.0.1:{server.port}{path}",
                                  data=json.dumps(data).encode() if data is not None else None,
                                  headers={"Content-Type": "application/json"})
            try:
                with request.urlopen(req, timeout=95) as reply:
                    return reply.status, json.load(reply)
            except error.HTTPError as exc:
                return exc.code, json.load(exc)

        # A new local draft avoids selecting any existing native conversation.
        _, draft = api("/api/conversations", {"title": "Installed target verification"})
        cid = draft["id"]
        _, detail = api(f"/api/conversations/{cid}")
        assert Path(detail["workspace_path"]).resolve() == server.root.resolve()
        ide_models = []
        for target in ("ide", "auto", "cli"):
            status, catalog = api(f"/api/models?target={target}&refresh=true&conversation_id={cid}")
            enabled = [m["id"] for m in catalog.get("models", []) if not m["disabled"]]
            row = {"http": status, "connected": catalog.get("connected"), "selected_target": catalog.get("target"),
                   "source": catalog.get("source"), "count": len(catalog.get("models", [])), "enabled": len(enabled)}
            row["disabled_ids"] = [m["id"] for m in catalog.get("models", []) if m["disabled"]]
            if target == "cli":
                ids = {m["id"] for m in catalog.get("models", [])}
                row.update(missing_ids=sorted(direct - ids), extra_ids=sorted(ids - direct))
            if target == "ide" and row["connected"]:
                ide_models = enabled
            result["targets"][target] = row
        _, quota = api("/api/tokens")
        result["quota_live"] = quota.get("is_live")
        result["quota_group_titles"] = [g.get("title") for g in quota.get("quota_groups", []) or []]
        result["ide_turn"] = "no usable desktop catalog" if not ide_models else "discovery only"
        if (args.ide_prompt or args.ide_followup) and ide_models:
            model = next((m for m in ide_models if "flash" in m and m.endswith("-low")), ide_models[0])
            status, reply = api("/api/tasks/submit", {"execution_target":"ide","model":model,"conversation_id":cid,
                "request_id":str(uuid.uuid4()), "prompt":"Reply exactly AGY_DESKTOP_OK. Do not use tools or change files."})
            result["ide_turn"] = {"submit_http":status, "acknowledged":reply.get("status") == "ok", "marker_received":False}
            if result["ide_turn"]["acknowledged"]:
                deadline = time.monotonic() + 120
                while time.monotonic() < deadline:
                    _, conv = api(f"/api/conversations/{cid}")
                    if not conv.get("is_processing") and any(m.get("sender") == "antigravity" and "AGY_DESKTOP_OK" in m.get("text","") for m in conv["messages"]):
                        result["ide_turn"]["marker_received"] = True
                        break
                    time.sleep(.5)
                if args.ide_followup and result["ide_turn"]["marker_received"]:
                    native_session = conv.get("ide_conversation_id")
                    time.sleep(5)
                    _, active = api("/api/conversations/active-tasks")
                    status, _ = api("/api/tasks/submit", {"execution_target":"ide","model":model,"conversation_id":cid,
                        "request_id":str(uuid.uuid4()), "prompt":"Reply exactly AGY_DESKTOP_FOLLOWUP_OK. Do not use tools or change files."})
                    follow = {"active_after_idle":cid in active["active_tasks"], "submit_http":status, "marker_received":False}
                    result["ide_followup"] = follow
                    if status == 200:
                        deadline = time.monotonic() + 120
                        while time.monotonic() < deadline:
                            _, conv = api(f"/api/conversations/{cid}")
                            if any(m.get("sender") == "antigravity" and "AGY_DESKTOP_FOLLOWUP_OK" in m.get("text","") for m in conv["messages"]):
                                follow.update(marker_received=True, same_session=bool(native_session) and native_session == conv.get("ide_conversation_id"))
                                break
                            time.sleep(.5)
    finally:
        server.close()
    args.output.write_text(json.dumps(result, indent=2) + "\n", encoding="utf8")
    print(json.dumps(result, indent=2))
    if args.ide_prompt or args.ide_followup:
        assert isinstance(result["ide_turn"], dict) and result["ide_turn"]["marker_received"], "Standalone app did not return the first reply"
    if args.ide_followup:
        follow = result.get("ide_followup", {})
        assert follow.get("same_session") and follow["marker_received"] and not follow["active_after_idle"], "Standalone follow-up did not complete in the original session"


if __name__ == "__main__":
    main()
