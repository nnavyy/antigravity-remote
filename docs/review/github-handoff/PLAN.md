# GitHub handoff verification plan

Review the Windows launcher's release and the dashboard from the perspective of someone pairing a phone for the first time. Exercise Chat, Changes, Usage, Projects and Connect in a disposable browser session. Check whether navigation and key actions have accessible names and selected states, the composer stays reachable, errors give a recovery action, and keyboard focus survives background refreshes. Record reproducible defects here before changing the application.

Rerun the locked Rust tests, formatting and lint, JavaScript syntax and client suite, packaged HTTP/ACP suite, desktop race, model browser, permission browser, six previous regressions, Git workspace scope and local load test. Rerun the installed App and CLI checks against disposable chats. Expect both desktop follow-up orders to succeed, exact account model IDs, a resumed CLI session, acknowledged Stop, and single-use consent. The baseline was 36 Rust, 54 client and 50 HTTP/protocol tests. Expect zero unexpected local reads and one upstream call in the simultaneous refresh burst.

After corrections, verify the source ZIP against the reviewed file list and build or start the extracted source. Record evidence and limitations in the review. Publish the reviewed source snapshot to the designated GitHub destination after these checks. Verify the remote commit and the download.

## Reproduced before changing the UI

1. A failed first connection request displays “You're connected.” There is no retry action, and later failures can retain owner state. Discard stale connection data, show a retry action and disable owner controls until the server responds. Give a successfully paired phone a direct route to Chat.
2. The initial Chat, Changes and Projects labels identify the developer's folder. Replace these with neutral placeholders until the actual workspace is available. Give the message field a persistent accessible name.
3. A background refresh removed the focused Allow button in a real Chrome session. Preserve controls for outstanding request IDs and update their disabled state in place. Repeat the focus, reload and touch tests, then exercise all five navigation tabs.

The two focused client tests failed on the old UI. The browser regression also exited 1 with “An unchanged permission refresh removed the focused button.”

4. Rebuilding an identical executable replaced the live image and left another Windows backup during this run. A disposable identical-file check failed because the destination timestamp changed. Skip publishing when source and destination have the same SHA-256. Check first publication, repeated publication and a genuinely changed image separately.
