# November 19 corrective audit

## Local pre-submission follow-up

This source kit adds corrections after the published dev.2 release. Image uploads now name each rejected file and explain the reason while keeping successful attachments. Enabling phone sounds reports whether the laptop accepted a chime request. The background launcher displays the configured port, and the phone-link helper checks that the service on that port is Antigravity Remote.

Saving a preference now keeps temporary shell and tunnel overrides out of the settings file. If an earlier build saved those overrides, review the **Connect** settings after restarting without them. A pairing-storage failure returns an error. Unpair saves the required LAN policy before rotating credentials and immediately signals open WebSocket sessions after a successful rotation.

The earlier local candidate passed 37 Rust tests, 64 client tests and 59 packaged-server tests. A further review reproduced overlapping sends and uploads, stale second-pane responses, incorrect cache-removal feedback, and a duplicate startup modifying an active turn. The client now preserves edits made during delivery and checks cache removal. Startup acquires the port and a single-writer handle before chat recovery. The handle permits ordinary file reads. Redirected startup output omits the pairing PIN. If an old log containing a current PIN was shared, rotate it in **Connect → Sign out all paired phones**.

The packager now uses fixed ZIP entry metadata and checks the internal Markdown destinations and common credential and personal-path patterns before replacing the output. The remaining sections record the published dev.2 baseline.

The November 19 report identified defects in both the shipped Rust bridge and a Python service retained in the development workspace. Two failures were reproduced before the fixes. An IDE turn received a browser attachment URL that it could not open on the laptop. A saved model selection prevented the browser from saving an offline draft. The two previous source ZIPs also differed in seven of their 54 common files. The newer ZIP contained another 12 files.

The intended handoff is a development prerelease for **one signed-in Windows laptop and its paired devices**. Google documents both its own Remote Control feature and model availability by subscription. This prototype uses the catalog reported by each installed runtime and rechecks access when sending. Google would need to evaluate its integration and support commitments separately. [Google Remote Control](https://antigravity.google/docs/remote-control/) · [Google model availability](https://antigravity.google/docs/models)

## Findings and changes

| Reported finding | What the review established and changed |
| --- | --- |
| IDE attachments, BMP and uppercase extensions | Confirmed. Desktop, CLI and queued dispatch share upload-folder, file-type and total-size checks. A browser upload URL resolves to the laptop file. The picker and backend accept PNG, JPEG, GIF and WebP. A disposable IDE received the actual uploaded path. |
| Tunnel trust and shared PIN attempts | Confirmed a shared counter and an overly broad proxy classification. The old limiter counted invalid attempts but still admitted a correct PIN. The report overstated the claim that one phone could lock out every valid user. Tunnel forwarding now requires a loopback connector and tunnel mode. Cloudflare's client address separates PIN counters. Missing client identity falls back to the connector address. The test suite covers the trust decision locally. |
| Queue stuck after a busy workspace or failed startup | Confirmed. A queued task gets a fresh delivery receipt after a known pre-delivery failure. A potentially delivered prompt keeps its receipt. Tests release a busy workspace and recover from a failed CLI session setup, then count the actual provider sends. |
| Offline new chats, saved models, rejected drafts and socket reconnect | Confirmed. The phone saves the draft before creating a chat, keeps the selected model and project, and uses a stable draft ID on replay. A failed WebSocket can fall back to HTTP. A permanently rejected or uncertain draft stays visible in **Chat → Unsent drafts** while other drafts continue. Copy the draft before dismissing it. Previously uploaded images still require their files on the same laptop. |
| Missing native chats, stuck activity and leftover metadata | Confirmed. A mapping suppresses a native listing only when a local conversation exists. An unchanged transcript's activity can expire. Deletion records the tombstone and removes metadata. Tests cover a native-only chat, actual cache expiry, draft creation replay and deletion. |
| Windows path spelling and workspace selection | Confirmed inconsistent use of canonical paths and the global project. Session binding, task conflict checks and Git revision hashing normalize Windows paths. HTTP file-open and terminal actions, IDE launch and WebSocket Changes use the selected chat's project, with the selected project as fallback for unbound chats. File-open verifies the resolved project boundary. |
| Nested Git repository without an initial commit | The previous revision reader treated an absent inner HEAD as an error whenever Git reported the nested directory. Git can omit such a directory from parent status. The revision reader now distinguishes an unborn HEAD from a Git failure. The parent review returned HTTP 200 and a stable revision in the fixture. |
| Permission layout, tab switching, secondary paste and ACP locking | Confirmed in the source. Permission cards can expand the composer; stale conversation reads cannot redraw a different tab. Secondary-pane paste leaves the main composer alone. ACP serializes decisions and cancellation without holding the permission-state lock while writing to the child. Chrome exercised Allow at 390 × 844 and Deny at 320 × 568, including the actual touch target. |
| Laptop sound, Markdown links and unpairing | The UI reports the laptop sound endpoint's unsupported result. Markdown links render once; local file links use a delegated click handler. Resetting pairing wakes established WebSockets immediately. A regression checks that a connected phone session closes within three seconds. |
| Local Python service | Confirmed the old LAN-owner, PIN, WebSocket command and model-contract problems by source inspection. The working tree's Python entry point now runs the Rust executable. Direct ASGI startup stops with migration guidance. The legacy setup, launcher and scheduled-task script target Rust. Historical helpers also restrict session paths, Git deletion and desktop launch. The multipart dependency belonged to the retired Python HTTP implementation. The public tag and both public source kits contain the Rust service. |
| Privacy and source history | Confirmed private addresses in a local task file and a tunnel binary and URL in the old local Git history. The addresses were redacted. The public release uses a separate Git history and an explicit list of source files. Every file of the previous public tag was checked against the 66-file dev.1 release ZIP. Local operational data and historical Python code are excluded from the public package. |
| Archives, launchers, links and logs | The handoff points to one canonical ZIP. Superseded ZIP and executable backups were archived locally. Future mapped-image backups live under Cargo's build directory. The publisher diagnoses a missing binary. The background runner rotates its log at 10 MiB and retains one previous file. The installer comments, reviewer links, public feedback ZIP link, local roadmap links and historical binary-size description were corrected. |

## Verification and limits

The previous release recorded 36 Rust tests, 56 client tests and 50 packaged server tests. The corrected build passed 37 Rust tests, 59 client tests and 57 packaged server tests (153 total). One initial headless Chrome run finished its assertions and timed out during cleanup. The harness now waits for the browser to acknowledge its close request. See the [plan](review/audit-followup/PLAN.md) and [verification results](review/audit-followup/verification.json) for the current counts and scope.

- The installed AGY CLI 1.5.12 returned 23 model IDs. The bridge matched all 23. Desktop reported 24 entries with 23 enabled and one disabled. The signed-in account exposed separate Gemini, Claude/GPT and Argon quota groups. Exact model membership will vary with account, runtime and time. Separate Free, Jio promotional, Ultra and enterprise sign-ins remain unverified. [Runtime catalogs and desktop follow-up](review/audit-followup/desktop-live.json)
- Installed CLI and desktop both completed two turns in one session. The CLI streamed output and acknowledged cancellation. The installed CLI read the disposable file under its existing permission policy without asking for a decision. The synthetic ACP provider exercised Allow and Deny in Chrome. [CLI turns](review/audit-followup/cli-live.json) · [Installed permission observation](review/audit-followup/permission-live.json) · [Browser controls](review/audit-followup/permission-browser.json)
- Chrome checked seven viewport configurations from 320 to 1280 CSS pixels. These checks covered model and performance selection, Send reachability and horizontal overflow. Physical-phone QR scanning, microphone permissions, the mobile keyboard and an external Cloudflare tunnel remain field checks. [Viewport results](review/audit-followup/browser/model-browser.json)
- Local loopback tests completed 1,600 reads at up to 64 concurrent clients, followed by a separate 32-request refresh burst. There were zero request errors and the burst made one upstream fixture call. This measures one laptop under a short synthetic workload. Capacity for millions of users, prolonged connections, provider quotas and internet reliability remain unmeasured. [Load measurements](review/audit-followup/load.json)
- Both desktop completion orderings allowed a follow-up. Git checks exercised the project selected in the browser, stale revisions, bulk actions and the unavailable-Git UI. All destructive Git test cases used disposable repositories. [Completion fixture](review/audit-followup/desktop-after.json) · [Workspace checks](review/audit-followup/git-workspaces.json) · [Previous six findings](review/audit-followup/six-findings.json)

## Run and verify

On Windows, extract the source ZIP, run `build.bat`, then double-click `Start_Antigravity_Remote.bat`. Scan the QR shown on the laptop from a phone on the same Wi-Fi. If updating a running bridge, finish the current work and restart the bridge to load the new executable.

From the source root in PowerShell, install the development dependencies listed in the reviewer README. The following commands reproduce the checks. The last three commands use the signed-in installation and may consume account quota.

```powershell
python -m venv .venv
$py = ".\.venv\Scripts\python.exe"
& $py -m pip install psutil websockets
cargo fmt --all -- --check
cargo test --all-targets --locked
cargo clippy --all-targets --locked -- -D warnings
node --test tests/client.test.cjs
.\build.bat
& $py tests/smoke.py --binary antigravity-bridge.exe
$env:BRIDGE_CHROME_EXE = "C:\Program Files\Google\Chrome\Application\chrome.exe"
& $py tests/browser_models.py --binary antigravity-bridge.exe --output-dir review-output
& $py docs/review/repro/check_permission_browser.py --binary antigravity-bridge.exe --output review-output/permission.json
& $py docs/review/repro/check_desktop_completion.py --output review-output/completion.json
& $py docs/review/repro/verify_git_workspace_ui.py --binary antigravity-bridge.exe --output review-output/git.json
& $py docs/review/repro/recheck_local_bridge.py --chrome $env:BRIDGE_CHROME_EXE --output review-output/six.json
& $py tests/load_local.py --binary antigravity-bridge.exe --output review-output/load.json
& $py docs/review/repro/check_publish_build.py
& $py docs/review/repro/package_development.py
& $py docs/review/repro/check_installed_targets.py --ide-followup --output review-output/desktop-live.json
& $py tests/live_agy.py --binary antigravity-bridge.exe --evidence review-output/cli-live.json
& $py docs/review/repro/check_installed_permission.py --binary antigravity-bridge.exe --output review-output/permission-live.json
```
