"""Build the reviewer source archive from an explicit file list and check every entry."""
from argparse import ArgumentParser
from pathlib import Path
import posixpath
import re
from tempfile import NamedTemporaryFile
from urllib.parse import unquote, urlsplit
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo

ROOT = Path(__file__).resolve().parents[3]


def verify_public_contents(archive):
    """Check the kit's local Markdown destinations and common private-data signatures."""
    names = set(archive.namelist())
    local_links = 0
    private = re.compile(
        r"-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----|(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{20,}"
        r"|AIza[\w-]{35}|AKIA[0-9A-Z]{16}|sk-(?:proj-)?[A-Za-z0-9_-]{24,}"
        r"|(?i:[a-z]:[/\\]+Users[/\\]+[\w.-]+|/(?:Users|home)/[\w.-]+/)"
    )
    email = re.compile(r"[\w.+-]+@([\w.-]+\.[A-Za-z]{2,})")
    for name in sorted(names):
        if name.endswith((".png", ".gif")):
            continue
        data = archive.read(name).decode("utf-8")
        normalized = re.sub(r"[/\\]+", "/", data).casefold()
        local_paths = (p.as_posix().casefold().rstrip("/") + "/" for p in (ROOT, Path.home()) if p.parent != p)
        if (private.search(data) or any(p in normalized for p in local_paths)
                or any(not (domain.lower().endswith(".invalid") or domain.lower() in
                            {"example.com", "example.org", "example.net"}) for domain in email.findall(data))):
            raise ValueError(f"Potential private data in {name}")
        if name.endswith(".md"):
            for destination in re.findall(r"!?\[[^\]\n]*\]\(([^)\n]+)\)", data):
                link = urlsplit(destination.strip("<>"))
                if link.scheme or link.netloc or not link.path:
                    continue
                target = posixpath.normpath(posixpath.join(posixpath.dirname(name), unquote(link.path)))
                if target not in names:
                    raise ValueError(f"Missing Markdown destination in {name}: {target}")
                local_links += 1
    return local_links


def main():
    parser = ArgumentParser()
    parser.add_argument("--output", type=Path, default=ROOT / "dist/antigravity-remote-source.zip")
    args = parser.parse_args()
    names = """
        docs/AUDIT_FOLLOWUP.md docs/review/audit-followup/PLAN.md run_background_log.ps1
        docs/assets/demo.gif docs/assets/preview-connect.png docs/assets/preview-models.png
        docs/assets/preview-permissions.png docs/assets/preview-changes.png
        docs/review/audit-followup/verification.json docs/review/audit-followup/desktop-after.json
        docs/review/audit-followup/desktop-live.json docs/review/audit-followup/cli-live.json
        docs/review/audit-followup/permission-live.json docs/review/audit-followup/permission-browser.json
        docs/review/audit-followup/git-workspaces.json docs/review/audit-followup/load.json
        docs/review/audit-followup/six-findings.json docs/review/audit-followup/browser/model-browser.json
        .gitignore Cargo.toml Cargo.lock LICENSE NOTICE CITATION.cff CODE_OF_CONDUCT.md install.ps1 build.bat publish_build.ps1 Start_Antigravity_Remote.bat
        open_connect.ps1 Cek_Link_HP.bat start_background_bridge.vbs run_background.bat
        rs/acp.rs rs/acp/permissions.rs rs/conversations.rs rs/main.rs rs/models.rs rs/receipts.rs
        rs/security.rs rs/storage.rs rs/telemetry.rs rs/workspaces.rs
        static/app.css static/app.js static/connect.js static/index.html static/icon-192.png
        static/icon-512.png static/manifest.json static/sw.js static/ux.css
        tests/browser_models.cjs tests/browser_models.py tests/client.test.cjs tests/fake_acp.rs
        tests/fake_agentapi.rs tests/live_agy.py tests/load_local.py tests/smoke.py
        docs/review/repro/check_desktop_completion.py docs/review/repro/check_installed_targets.py
        docs/review/repro/check_permission_browser.py docs/review/repro/check_installed_permission.py
        docs/review/repro/recheck_local_bridge.py docs/review/repro/check_publish_build.py
        docs/review/repro/package_development.py docs/GITHUB_HANDOFF_REVIEW.md
        docs/review/github-handoff/PLAN.md docs/review/github-handoff/desktop-after.json
        docs/review/github-handoff/desktop-live.json docs/review/github-handoff/cli-live.json
        docs/review/github-handoff/permission-live.json docs/review/github-handoff/permission-browser.json
        docs/review/github-handoff/git-workspaces.json docs/review/github-handoff/load.json
        docs/review/repro/verify_git_workspace_ui.py docs/ANTIGRAVITY_DEVELOPMENT_HANDOFF.md
        docs/review/development-handoff/PLAN.md docs/review/development-handoff/desktop-before.json
        docs/review/development-handoff/desktop-after.json docs/review/development-handoff/desktop-live.json
        docs/review/development-handoff/cli-live.json docs/review/development-handoff/permission-live.json
        docs/review/development-handoff/permission-browser.json docs/review/development-handoff/clean-build.json
        docs/review/development-handoff/load.json
    """.split()
    entries = {name: ROOT / name for name in names}
    reviewer_readme = ROOT / "docs/review/development-handoff/REVIEWER_README.md"
    entries["README.md"] = reviewer_readme if reviewer_readme.is_file() else ROOT / "README.md"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    payloads = {name: source.read_bytes() for name, source in entries.items()}
    if reviewer_readme.is_file():
        # The reviewer guide lives two levels below docs in the working tree.
        payloads["README.md"] = payloads["README.md"].replace(b"](../../", b"](docs/")
    with NamedTemporaryFile(dir=args.output.parent, delete=False, suffix=".tmp") as handle:
        stage = Path(handle.name)
    try:
        with ZipFile(stage, "w", ZIP_DEFLATED) as archive:
            for name, data in sorted(payloads.items()):
                # Fixed DOS epoch and platform so identical inputs have a stable checksum.
                entry = ZipInfo(name)
                entry.create_system = 0
                archive.writestr(entry, data, compress_type=ZIP_DEFLATED)
        with ZipFile(stage) as archive:
            if sorted(archive.namelist()) != sorted(entries) or archive.testzip():
                raise ValueError("Source archive did not match the file list")
            for name, data in payloads.items():
                if archive.read(name) != data:
                    raise ValueError(f"Source verification failed for {name}")
            local_links = verify_public_contents(archive)
        stage.replace(args.output)
        print(f"Verified {len(entries)} files and {local_links} local Markdown links in {args.output}. "
              "No recognized private-data signatures in text files.")
    finally:
        stage.unlink(missing_ok=True)


if __name__ == "__main__":
    main()
