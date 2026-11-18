# GitHub handoff and phone UI review

This release is for developers evaluating a single signed-in Windows laptop and its paired phone. The baseline passed 140 tests. This revision passed 142 across the current Rust, client and packaged HTTP/protocol suites. [Verification and fix plan](review/github-handoff/PLAN.md)

## What changed

| Finding | User-visible change | Verification |
| --- | --- | --- |
| A failed first connection request showed “You're connected.” Later failures could retain laptop controls. | Connect now shows an unavailable state and Retry connection. It clears stale pairing details. After pairing, Open Chat takes the user directly to the composer tab. | Client regression and Chrome recovery flow. |
| Chat, Changes and Projects initially displayed the developer's folder. The message field relied on its placeholder for its name. | Project labels wait for the actual workspace. The composer has the persistent accessible name “Message.” | Client and workspace tests. |
| Refreshing a pending tool request replaced the focused button. | Controls for unresolved request IDs retain focus. Resolving a request removes its card. | Chrome focus check, reload and emulated taps on Allow once and Deny once. |
| Windows republished an unchanged executable and could leave another backup while it was running. | An identical build keeps the installed image in place. An updated build is published for the next launch. | Disposable Windows executable tested for first publish, identical live rebuild and changed live rebuild. |

## Results on November 18, 2026

- **36 Rust tests, 56 client tests and 50 packaged HTTP/protocol tests passed.** Cargo formatting, Clippy with warnings denied, JavaScript syntax and the locked release build passed. The six prior regressions and all four Git workspace actions passed. Six archived observers also ran. Historical Git clients that omit the reviewed revision received the expected HTTP 428. [Git workspace evidence](review/github-handoff/git-workspaces.json)
- **Phone usability.** At 390 × 844 the keyboard traversed Chat, Changes, Usage, Projects and Connect, then returned to Chat, with the selected panel visible and focus on its tab. Chrome checked the model picker and composer across seven sizes from 320 to 1,280 pixels wide. Send remained reachable and the four performance choices stayed on one row. [Browser interaction evidence](review/github-handoff/permission-browser.json)
- **Installed Antigravity.** App 2.29.0 accepted a follow-up in the same session. CLI 1.5.11 resumed a conversation, streamed and acknowledged Stop. The App reported 19 models with one disabled and a separate Gemini 4 Argon quota group. The CLI matched all 18 IDs returned by the signed-in command. [App and catalog evidence](review/github-handoff/desktop-live.json) · [CLI evidence](review/github-handoff/cli-live.json) · [Desktop race regression](review/github-handoff/desktop-after.json)
- **Tool consent.** The browser and ACP fixture verified individual decisions. The separate live file-read probe initially received HTTP 502. A repeat in a fresh disposable conversation completed and returned the fixture contents without requesting permission. The cause of the first 502 was not established. A live account whose policy requires asking remains an acceptance case. [Live probe](review/github-handoff/permission-live.json)
- **Local load.** All 1,600 loopback health and cached catalog reads succeeded. A burst of 32 refreshes produced one upstream catalog request. The bridge recovered from a simulated upstream outage and preserved a draft across restart. These measurements cover a single laptop and a fixture provider. [Load results](review/github-handoff/load.json)

## Source distribution

The public handoff starts with a fresh Git history containing the 66 reviewed source, test, documentation and evidence files. The publication check compared every staged Git blob with its ZIP entry. A second locked release build used sources extracted into a fresh directory and the existing Cargo dependency cache in offline mode. Its executable served the revised dashboard, reported a healthy Rust service and returned an empty pending-permissions list at startup.

## Reproduce

Follow the Windows setup in the [README](../README.md). The [development handoff](ANTIGRAVITY_DEVELOPMENT_HANDOFF.md) gives exact Cargo, Node, packaged HTTP, live account and browser commands. To record a fresh run, set its PowerShell `$out` variable to a new directory and create it first. The signed-in checks send test prompts and may consume quota.

The following PowerShell commands run the Windows publisher regression and produce a fresh source archive from the reviewed file list.

```powershell
.\.venv\Scripts\python.exe docs/review/repro/check_publish_build.py
.\.venv\Scripts\python.exe docs/review/repro/package_development.py --output dist/antigravity-remote-source.zip
```

## Remaining evaluation

Use physical iOS and Android phones to validate camera scanning, microphone permission and reconnection on the intended network. Verify promotional, Free, Pro, Ultra and managed Enterprise accounts with their own policies. Shared hosting would also require per-device revocation, tenant isolation and representative load testing. Million-user capacity has not been established.
