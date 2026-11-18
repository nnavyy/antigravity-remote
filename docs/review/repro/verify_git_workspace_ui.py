"""Verify actual JS-generated Git requests against two disposable repositories."""
import argparse
from datetime import date
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
from urllib.parse import quote

ROOT = Path(__file__).resolve().parents[3]
sys.path.insert(0, str(ROOT / "tests"))
from smoke import Server

UI_REQUEST = r"""
const fs = require('node:fs');
const vm = require('node:vm');
const data = JSON.parse(process.argv[1]);
let captured;
const context = vm.createContext({
  console, AbortController, AbortSignal, setTimeout, clearTimeout,
  localStorage: {getItem:()=>null}, navigator: {},
  document: {addEventListener(){},getElementById:()=>null,querySelectorAll:()=>[]},
  window: {addEventListener(){},confirm:()=>true},
  fetch: async (url, options) => {
    captured = {url, body:JSON.parse(options.body)};
    return new Response(JSON.stringify({status:'error',message:'Capture only'}),
      {headers:{'content-type':'application/json'}});
  },
  data,
});
vm.runInContext(fs.readFileSync('static/app.js','utf8'),context);
vm.runInContext(`showToast=()=>{};addLogEvent=()=>{};
  state.changes=data.snapshot;state.currentWorkspace={path:data.other};
  state.activeConversationId='b';state.conversations=[{id:'b',workspace_path:data.other}];`,context);
vm.runInContext(data.action,context).then(()=>console.log(JSON.stringify(captured)))
  .catch(error=>{console.error(error);process.exitCode=1;});
"""


def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--binary", default="target/release/antigravity-bridge.exe")
    parser.add_argument("--output", type=Path, default=ROOT / f"docs/review/git-ui-workspace-{date.today()}.json")
    args = parser.parse_args()
    evidence = {"date": date.today().isoformat(), "scope": "Actual UI request generation plus disposable HTTP/Git; no provider traffic", "checks": []}
    with tempfile.TemporaryDirectory(prefix="agy-git-ui-binary-") as directory:
        binary = Path(directory) / "antigravity-bridge.exe"
        shutil.copy2(ROOT / args.binary, binary)
        evidence["binary_sha256"] = hashlib.sha256(binary.read_bytes()).hexdigest()
        server = Server(binary)
        try:
            repos = [server.root / "repo-a", server.root / "repo-b"]
            for repo in repos:
                repo.mkdir()
                git(repo, "init")
                git(repo, "config", "user.name", "Audit")
                git(repo, "config", "user.email", "audit@example.invalid")
                git(repo, "config", "core.autocrlf", "false")
                (repo / "shared.txt").write_text("initial\n", encoding="utf8")
                git(repo, "add", "shared.txt")
                git(repo, "commit", "-m", "Fixture baseline")
            repo_a, repo_b = repos
            server.json("POST", "/api/workspaces/select", {"path": str(repo_b)})
            server.json("POST", "/api/conversations", {"title": "Server selection is project B"})
            for index, action in enumerate((
                'rejectFileChange("shared.txt")', 'acceptFileChange("shared.txt")',
                'confirmRejectAllChanges()', 'confirmAcceptAllChanges()',
            )):
                original_a = git(repo_a, "show", "HEAD:shared.txt")
                changed_a = f"project A edit {index}\n"
                changed_b = f"project B edit {index}\n"
                (repo_a / "shared.txt").write_text(changed_a, encoding="utf8")
                (repo_b / "shared.txt").write_text(changed_b, encoding="utf8")
                selected = server.json("GET", "/api/changes")[1]
                assert Path(selected["workspace"]).resolve() == repo_b.resolve()
                snapshot = server.json("GET", f"/api/changes?workspace_path={quote(str(repo_a), safe='')}")[1]
                captured = json.loads(subprocess.run(
                    ["node", "-e", UI_REQUEST, json.dumps({"snapshot": snapshot, "other": str(repo_b), "action": action})],
                    cwd=ROOT, check=True, capture_output=True, text=True,
                ).stdout)
                assert Path(captured["body"]["workspace_path"]).resolve() == repo_a.resolve()
                status, result, _ = server.json("POST", captured["url"], captured["body"])
                assert status == 200 and result["status"] == "ok", result
                expected_a = original_a if "reject" in captured["url"] else changed_a
                assert (repo_a / "shared.txt").read_text(encoding="utf8") == expected_a
                assert (repo_b / "shared.txt").read_text(encoding="utf8") == changed_b
                assert git(repo_b, "rev-list", "--count", "HEAD").strip() == "1"
                evidence["checks"].append({"action": action, "server_selected": "repo-b",
                    "request_workspace": "repo-a", "scope": captured["body"]["scope"],
                    "repo_a_expected_change": True, "repo_b_untouched": True})
        finally:
            server.close()
    output = args.output
    output.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf8")
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    main()
