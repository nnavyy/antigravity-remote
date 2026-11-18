"""Verify the six review findings against the packaged bridge using disposable state."""
import argparse
import hashlib
import os
import re
import json
from pathlib import Path
import subprocess
from urllib.parse import quote, urlsplit

from verify_git_workspace_ui import ROOT, Server, UI_REQUEST, git


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "docs/review/six-fixes-2026-11-18.json")
    parser.add_argument("--chrome", type=Path, help="Also verify the rendered phone UI in a disposable headless Chrome profile.")
    args = parser.parse_args()
    binary = ROOT / "antigravity-bridge.exe"
    results = {"binary_sha256": hashlib.sha256(binary.read_bytes()).hexdigest()}
    server = Server(binary)
    try:
        def repo(name):
            path = server.root / name
            path.mkdir()
            git(path, "init")
            git(path, "config", "user.name", "Review fixture")
            git(path, "config", "user.email", "fixture@example.invalid")
            git(path, "config", "core.autocrlf", "false")
            git(path, "config", "core.hooksPath", ".git/hooks")
            (path / "note.txt").write_text("baseline\n", encoding="utf-8")
            git(path, "add", "note.txt")
            git(path, "commit", "-m", "Fixture baseline")
            return path

        def listing(path):
            return server.json("GET", "/api/changes?workspace_path=" + quote(str(path), safe=""))[1]

        def action(path, snapshot, call):
            # Capture the real client confirmation and POST in the existing VM harness.
            script = UI_REQUEST.replace("let captured;", "let captured, confirmation;").replace(
                "confirm:()=>true", "confirm:m=>{confirmation=m;return true;}").replace(
                "JSON.stringify(captured)", "JSON.stringify({...captured, confirmation})")
            data = {"snapshot": snapshot, "other": str(path), "action": call}
            ui = json.loads(subprocess.check_output(["node", "-e", script, json.dumps(data)], cwd=ROOT, encoding="utf-8"))
            status, body, _ = server.json("POST", ui["url"], ui["body"])
            return {"http": status, "result": body.get("status"), "code": body.get("code"),
                    "confirmation": ui["confirmation"].replace(str(path), "<fixture>"),
                    "request_fields": sorted(ui["body"])}

        path = repo("stale-review")
        note = path / "note.txt"
        note.write_text("version reviewed on the phone\n", encoding="utf-8")
        snapshot = listing(path)
        displayed = snapshot["files"][0]["status"]
        git(path, "mv", "note.txt", "moved.txt")
        git(path, "commit", "-m", "Move reviewed note on laptop")
        note.write_text("separate local notes\n", encoding="utf-8")
        before = git(path, "status", "--porcelain").strip()
        results["stale_revert"] = {**action(path, snapshot, 'rejectFileChange("note.txt","modified")'),
            "displayed_status": displayed, "status_before_post": before, "replacement_exists_after": note.exists(),
            "moved_file_preserved": (path / "moved.txt").read_text() == "version reviewed on the phone\n"}

        assert results["stale_revert"]["code"] == "stale_review" and results["stale_revert"]["http"] == 409
        assert note.read_text() == "separate local notes\n" and results["stale_revert"]["moved_file_preserved"]

        def post(path, endpoint, **fields):
            return server.json("POST", "/api/changes/" + endpoint, {"workspace_path": str(path), **fields})[:2]

        path = repo("same-status")
        note = path / "note.txt"
        note.write_bytes(b"binary\0reviewed")
        old = listing(path)
        note.write_bytes(b"binary\0changed")
        unchanged = git(path, "rev-parse", "HEAD")
        protected = []
        for op in ("accept", "reject"):
            for scope in ({"scope": "file", "file_path": "note.txt"}, {"scope": "all"}):
                status, reply = post(path, op, revision=old["revision"], **scope)
                assert (status, reply.get("code")) == (409, "stale_review"), reply
                assert note.read_bytes() == b"binary\0changed" and git(path, "rev-parse", "HEAD") == unchanged
                protected.append(op + " " + scope["scope"])
        status, reply = post(path, "reject", scope="all")
        assert (status, reply.get("code")) == (428, "review_required")
        results["same_status_binary_edit"] = {"blocked_actions": protected, "missing_revision_http": status}

        path = repo("staged-only")
        note = path / "note.txt"
        note.write_text("work kept only in the index\n", encoding="utf-8")
        git(path, "add", "note.txt")
        note.write_text("baseline\n", encoding="utf-8")
        head = git(path, "rev-parse", "HEAD")
        staged = git(path, "show", ":note.txt")
        results["bulk_accept"] = {**action(path, listing(path), "confirmAcceptAllChanges()"),
            "index_before": staged.strip(), "index_after": git(path, "show", ":note.txt").strip(),
            "head_unchanged": git(path, "rev-parse", "HEAD") == head,
            "pending_after": git(path, "status", "--porcelain").splitlines()}

        bulk = results["bulk_accept"]
        assert (bulk["http"], bulk["code"]) == (409, "divergent_index")
        assert bulk["index_before"] == bulk["index_after"] and bulk["head_unchanged"] and note.read_text() == "baseline\n"

        path = repo("rejected-hook")
        note = path / "note.txt"
        note.write_text("already staged\n")
        git(path, "add", "note.txt")
        new = path / "new.txt"
        new.write_text("untracked work\n")
        hook = path / ".git" / "hooks" / "pre-commit"
        hook.write_bytes(b"#!/bin/sh\necho review-hook-rejected >&2\nexit 1\n")
        hook.chmod(0o755)
        def git_state():
            return (git(path, "rev-parse", "HEAD"), git(path, "write-tree"), git(path, "status", "--porcelain"), note.read_bytes(), new.read_bytes())
        before = git_state()
        status, reply = post(path, "accept", scope="all", revision=listing(path)["revision"])
        assert (status, reply.get("code")) == (409, "git_commit_failed"), reply
        assert "review-hook-rejected" in reply["message"] and git_state() == before
        assert not (path / ".git" / "index.lock").exists()
        hook.unlink()
        retry, reply = post(path, "accept", scope="all", revision=listing(path)["revision"])
        assert retry == 200 and reply["status"] == "ok" and git(path, "status", "--porcelain") == "", reply
        assert git(path, "show", "HEAD:new.txt") == "untracked work\n"
        results["rejected_hook"] = {"http": status, "head_index_worktree_preserved": True, "retry_http": retry}

        path = repo("large-edit")
        with (path / "note.txt").open("a", encoding="utf-8") as out:
            out.writelines(f"line {i}\n" for i in range(250))
        results["diff_count"] = {"git_numstat": git(path, "diff", "--numstat", "HEAD").strip(),
                                 "bridge_insertions": listing(path)["total_insertions"]}

        assert results["diff_count"]["bridge_insertions"] == 250
        assert listing(path)["files"][0]["diff_truncated"]
        (path / "extra.txt").write_text("+++looks like a header\n" * 125, encoding="utf-8")
        view = listing(path)
        extra = next(f for f in view["files"] if f["path"] == "extra.txt")
        assert extra["insertions"] == 125 and extra["diff_truncated"] and len(extra["diff"].splitlines()) == 80
        assert view["total_insertions"] == 375
        results["diff_count"].update(untracked_insertions=extra["insertions"], combined_insertions=375, both_previews_truncated=True)

        project_a = repo("project-a")
        project_b = repo("project-b")
        server.json("POST", "/api/workspaces/select", {"path": str(project_a)})
        cid = server.json("POST", "/api/conversations", {"title": "Review fixture chat"})[1]["id"]
        selected = server.json("POST", "/api/workspaces/select", {"path": str(project_b)})[1]["workspace"]
        conversations = server.json("GET", "/api/conversations")[1]["conversations"]
        js = """
const fs = require('node:fs'), vm = require('node:vm');
const data = JSON.parse(process.argv[1]), header = {};
const ctx = vm.createContext({console, data, localStorage:{getItem:()=>null}, navigator:{},
  document:{addEventListener(){},getElementById:id=>id==='activeConvWorkspace'?header:null},window:{addEventListener(){}}});
vm.runInContext(fs.readFileSync('static/app.js','utf8'),ctx);
vm.runInContext('state.activeConversationId=data.cid;state.conversations=data.conversations;addLogEvent=()=>{};fetchWorkspaces=()=>{};handleSocketMessage({type:"WORKSPACE_CHANGED",workspace:data.selected});',ctx);
console.log(JSON.stringify({header:header.textContent, bound:vm.runInContext('changesWorkspacePath()',ctx)}));
"""
        client = json.loads(subprocess.check_output(["node", "-e", js, json.dumps({
            "cid": cid, "selected": selected, "conversations": conversations})], cwd=ROOT, encoding="utf-8"))
        results["bound_chat_project_label"] = {"visible_header": client["header"],
            "client_review_project": Path(client["bound"]).name,
            "server_conversation_project": Path(server.json("GET", "/api/changes")[1]["workspace"]).name}

        assert client["header"].endswith("target: project-a")
        assert results["bound_chat_project_label"]["client_review_project"] == results["bound_chat_project_label"]["server_conversation_project"] == "project-a"
        assert not (server.root / "tunnel_url.txt").exists()
        code, _, _ = server.json("POST", "/api/settings", {"remote_mode":"tunnel"})
        _, connection, _ = server.json("GET", "/api/connection")
        results["unconfigured_tunnel"] = {"settings_http": code, "reported_mode": connection["settings"]["remote_mode"],
            "primary_matches_lan": connection["primary_url"] == connection["lan_url"],
            "pair_host_matches_lan": urlsplit(connection["pair_url"] or "").netloc == urlsplit(connection["lan_url"]).netloc,
            "qr_offered": bool(connection["qr_data_url"])}
        assert all(connection[key] is None for key in ("primary_url", "pair_url", "qr_data_url"))
        assert connection["unavailable_reason"] and connection["settings"]["remote_mode"] == "tunnel"
        qr = server.json("GET", "/api/qr")[1]
        assert all(qr[key] is None for key in ("url", "pair_url", "qr_data_url"))
        if os.name == "nt":
            env = dict(os.environ, BRIDGE_PORT=str(server.port))
            helper = subprocess.run(["cmd", "/d", "/c", "Cek_Link_HP.bat"], cwd=ROOT, env=env, input=b"4\r\n",
                                    capture_output=True, timeout=20)
            assert b"PHONE ADDRESS UNAVAILABLE" in helper.stdout and b"PRIMARY PHONE LINK" not in helper.stdout
            results["windows_link_helper"] = {"unavailable_shown": True}
        (server.root / "tunnel_url.txt").write_text("https://review.example.invalid", encoding="utf-8")
        connection = server.json("GET", "/api/connection")[1]
        results["configured_tunnel_control"] = {
            "pair_host_matches_configuration": urlsplit(connection["pair_url"]).hostname == "review.example.invalid",
            "qr_offered": bool(connection["qr_data_url"])}

        assert all(results["configured_tunnel_control"].values())
        clean = listing(project_a)
        assert clean["availability"] == "ready" and clean["total_changes"] == 0
        changed = git(path, "status", "--porcelain").strip()
        (server.root / "empty-bin").mkdir()
        server.env["PATH"] = str(server.root / "empty-bin")
        server.restart()
        code, view, _ = server.json("GET", "/api/changes?workspace_path=" + quote(str(path), safe=""))
        results["git_unavailable"] = {"actual_git_status": changed, "http": code, "is_git": view.get("is_git"),
            "change_count": view.get("total_changes"), "error": view.get("error") or view.get("message")}
        assert code == 503 and view["availability"] == "unavailable" and view["message"]
        assert "total_changes" not in view and "revision" not in view
        if args.chrome:
            (server.root / "tunnel_url.txt").unlink()
            server.json("POST", "/api/workspaces/select", {"path": str(path)})
            server.json("POST", "/api/conversations", {"title": "Rendered changes fixture"})
            page = subprocess.run([str(args.chrome), "--headless=new", "--disable-gpu", "--no-first-run",
                "--disable-background-networking", "--window-size=390,844", "--virtual-time-budget=5000",
                "--user-data-dir=" + str(server.root / "browser-profile"), "--dump-dom",
                f"http://127.0.0.1:{server.port}/#connect"], capture_output=True, timeout=45, check=True)
            dom = page.stdout.decode("utf-8")
            address = re.search(r'<button[^>]*id="cxUrl"[^>]*>Address unavailable</button>', dom)
            assert address and "disabled" in address.group(), "The rendered Connect address is still actionable."
            assert re.search(r'<img[^>]*id="cxQr"[^>]*>', dom) and 'src=' not in re.search(r'<img[^>]*id="cxQr"[^>]*>', dom).group()
            assert dom.count("Changes unavailable</span>") >= 2 and dom.count(">Retry</button>") >= 2, "Missing Changes retry state"
            results["rendered_phone_ui"] = {"browser": args.chrome.name, "address_disabled": True,
                "stale_qr_removed": True, "both_changes_views_show_retry": True}
    finally:
        server.close()
    output = args.output
    output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(results, indent=2))


if __name__ == "__main__":
    main()
