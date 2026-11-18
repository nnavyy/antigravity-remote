# Antigravity Remote development handoff

**Ready to send to Antigravity developers for review and continued development on a single Windows laptop.** A clean extraction of the runtime sources built and served the dashboard. Physical phone pairing, approvals under a live Ask policy and multi-account deployment remain acceptance work.

## Scope

The handoff covers a Windows bridge for one laptop and its signed-in Antigravity account. The executable serves the phone dashboard and launches or connects to a local agent. The reviewed source includes the Rust service, browser assets, Windows build and launch scripts, and disposable test fixtures.

## Changes under review

- A transcript read and the background watcher can both observe the same desktop turn go idle. Each matches the running task ID before releasing its workspace. A completed reply can now be followed by another prompt in the same native session.
- The CLI bridge holds each native ACP permission request until a connected client chooses an offered option or stops the turn. The phone shows tool details, asks again for persistent choices and restores pending requests after a reload. The backend checks the conversation, request and option before writing an answer to AGY.
- Fresh LAN installations require pairing. An existing owner preference is preserved. The desktop target is labeled **Antigravity App** to distinguish it from the IDE.
- The Windows build publishes a complete executable even when the previous image is running. Existing sessions adopt the new build on their next restart.

## Integration boundary

Google documents the CLI's ACP subprocess interface. The desktop bridge uses local runtime methods, so desktop compatibility needs retesting following an App update. Google also ships its own Remote Control. This prototype is a candidate for developer evaluation of same-Wi-Fi pairing and a local dashboard. [Google ACP guide](https://antigravity.google/docs/cli/acp) · [Google Remote Control](https://antigravity.google/docs/remote-control) · [ACP tool permissions](https://agentclientprotocol.com/protocol/tool-calls)

## Verified on November 18, 2026

| Check | Result |
| --- | --- |
| Rust, browser client and packaged HTTP/protocol suites | 36 Rust, 54 client and 50 HTTP/protocol tests passed. The previous build passed 34, 53 and 49 respectively. Formatting, Clippy with warnings denied and JavaScript syntax checks passed. |
| Desktop follow-up regression | Before the fix, reading the transcript ahead of the watcher left the workspace busy and the next prompt returned 409. After the fix, both polling orders released the task, returned 200 and delivered exactly two native prompts. |
| Installed standalone Antigravity App 2.29.0 | Both prompts returned their requested markers in the same native session. The bridge had zero active tasks for that conversation after it went idle. |
| Installed AGY CLI 1.5.11 | Two replies used the same session with different performance variants. Streaming was observed and Stop completed as cancelled. Each of the three turns released its AGY child process. |
| Model and quota discovery | On the signed-in account the App returned 19 entries, including one disabled model. The CLI matched all 18 IDs from `agy models`. The live quota groups were Gemini Models, Claude and GPT models, and Gemini 4 Argon. |
| CLI permissions | The protocol tests checked native option IDs, wrong-chat and stale decisions, Stop and restart. In a separate live run the CLI read a disposable file without asking the bridge. Its policy decides which operations need consent. |
| Phone approval controls | At 390 × 844 a pending request survived a reload. Emulated touch on Allow once and Deny once produced the exact corresponding native option IDs in the ACP fixture. The resolved card disappeared each time. |
| Model picker and composer | Chrome checked seven viewport sizes from 320 through 1,280 pixels wide. Send was reachable at each size and the browser reported zero script errors. The layout check supplies four fixture performance levels when a live family has fewer. |
| Six previous findings and Git scope | Stale reviews, changed binary contents, divergent Git index, chat-to-project binding, unavailable addresses and unavailable Git all passed. Each of the four accept/reject actions changed only the intended fixture repository. |

The packaged Windows executable matched the release build with SHA-256 `b4e7989e1c816b2aae29840f9cd63635a90854e2d40e38242b1a8fda62c3c403`. The probes record account catalog counts and outcomes. [Desktop before](review/development-handoff/desktop-before.json) · [Desktop after](review/development-handoff/desktop-after.json) · [Installed App and catalogs](review/development-handoff/desktop-live.json) · [Live CLI](review/development-handoff/cli-live.json) · [Touch and ACP fixture](review/development-handoff/permission-browser.json) · [Installed permission probe](review/development-handoff/permission-live.json)

The local load test served 1,600 synthetic health and cached catalog reads with zero unexpected responses. A burst of 32 simultaneous refreshes made one upstream catalog request. The bridge recovered from a simulated upstream outage and retained the draft after restart. At 64 concurrent readers the 95th-percentile latency was 36.5 ms for health and 52.6 ms for the catalog. The preceding repeat on this laptop measured 24.2 and 26.5 ms. This workload measures local reads. Capacity for concurrent agent runs, WAN clients or a million users is unmeasured. [Workload results](review/development-handoff/load.json)

## What to send

Share `antigravity-development-handoff.zip` from the project's `dist` directory. It includes the source, locked dependency manifest, Windows launch scripts, test fixtures, reviewer instructions and selected test evidence. The archive is assembled from an explicit file list. Local conversations, credentials, screenshots, installed binaries and Git history stay outside the archive. The runtime and launch files were built in a clean directory using cached dependencies. The resulting executable served the homepage, health check and empty pending-permissions list. [Clean build evidence](review/development-handoff/clean-build.json)

## Running and reproducing

Sign in to Antigravity on Windows, run `.\build.bat` and then `.\Start_Antigravity_Remote.bat`. In Connect, scan the laptop QR from a phone on the same Wi-Fi. If a bridge was already running when the build completed, close that server when its work finishes, then launch the batch file again. Windows may retain a `bridge-*.bak` image until the prior process exits.

The locked Rust build requires its Windows linker. The tests also use Git, Node 22+, Chrome and Python with `psutil` and `websockets`. On a GNU Rust installation, put the MinGW binary directory on PATH before running the tests. After creating the Python environment, use these PowerShell commands from the project root.

```powershell
$py = '.\.venv\Scripts\python.exe'
$out = 'docs/review/development-handoff'
$env:BRIDGE_CHROME_EXE = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
cargo fmt --all -- --check
cargo clippy --all-targets --locked -- -D warnings
cargo test --all-targets --locked
node --check static/app.js
node --check static/connect.js
node --test tests/client.test.cjs
.\build.bat
& $py tests/smoke.py --binary antigravity-bridge.exe
& $py docs/review/repro/check_desktop_completion.py --output "$out/desktop-after.json"
& $py docs/review/repro/check_permission_browser.py --binary antigravity-bridge.exe --output "$out/permission-browser.json"
& $py docs/review/repro/recheck_local_bridge.py --chrome $env:BRIDGE_CHROME_EXE --output "$out/six-findings.json"
& $py docs/review/repro/verify_git_workspace_ui.py --binary antigravity-bridge.exe --output "$out/git-workspaces.json"
& $py tests/load_local.py --binary antigravity-bridge.exe --output "$out/load.json"
```

The following checks use the installed account. Open the standalone Antigravity App for the desktop check. The first command reads the model catalog. The other three send test prompts and can consume quota.

```powershell
& $py tests/browser_models.py --binary antigravity-bridge.exe --output-dir $out
& $py docs/review/repro/check_installed_targets.py --ide-followup --output "$out/desktop-live.json"
& $py tests/live_agy.py --binary antigravity-bridge.exe --evidence "$out/cli-live.json"
& $py docs/review/repro/check_installed_permission.py --binary antigravity-bridge.exe --output "$out/permission-live.json"
```

## Remaining acceptance checks

- Scan the QR and test microphone permission, reconnect and real touch input on physical iOS and Android devices. The current browser measurements use Chrome emulation.
- Exercise a required native approval on an account with an explicit Ask policy. Desktop-hosted tool approvals and pre-execution plan approval are separate workflows. Plan-review submission currently returns HTTP 501.
- Verify each intended account tier, including promotional and administrator-managed accounts. Model availability and quota depend on the actual account, host and organization policy. [Google model availability](https://antigravity.google/docs/models) · [Enterprise setup](https://antigravity.google/docs/enterprise)
- Before a shared deployment, implement per-device revocation, tenant isolation and runner isolation, then test recovery and concurrent inference. The current trust boundary is one laptop, its signed-in account and its paired clients.
