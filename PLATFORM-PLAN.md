# Assistant platform implementation

Local task: implement the user's eight requirements in a new authenticated platform, preserving the existing service on port 3210 during development. New platform uses port 3211, separate state and executors.

## Deliverable

- Account/password registration, login/logout, change password, admin user list and read-only access to all users' assistants/transcripts.
- Owned assistants, one durable harness thread each; maximum three active assistants per user enforced transactionally. A fourth activation requires explicitly selecting one to stop.
- Web chat, stored history, authenticated SSE; WeChat pairing continues exactly the same thread.
- Pair greeting; returning assistant receives a summary of the most recent ten user/assistant messages.
- New input interrupts current Codex turn and resumes with pending input; stream every public assistant paragraph, web deltas immediately and WeChat ordered chunks.
- Independent channel and harness interfaces. Persistent jobs and outbound delivery receipts, restart recovery, no uncontrolled repeat of running work.
- Backend authorization, password hashing, CSRF/cookie protection, isolated harness configuration, graceful shutdown and validation.

## Structure

`src/platform/store.js`: platform schema + transaction rules.
`src/platform/auth.js`: authentication and sessions.
`src/platform/engine.js`: assistant lifecycle, jobs, transcript, streams, channel deliveries.
`src/platform/adapters/wechat.js`: encapsulates existing Bridge/Store/Weixin protocol, normalized events.
`src/platform/adapters/codex.js`: isolated Codex process, resume, interrupt and normalized public output.
`src/platform/server.js`: authenticated HTTP/SSE API + frontend assets.
`public/platform/`: responsive registration/login/assistant chat/admin app.

## Verification

Existing 22 tests; platform integration for authorization/activation races/recovery/interruption/channel routing/greeting-summary; browser flows with two users + admin; real Codex streaming/interrupt/context and filesystem access limits; deployed health checks.

## Decisions

- Code branch `feat/assistant-platform`, worktree `/root/workspace/wxbot-platform`.
- Existing Codex 0.153.2 lacks restricted read access. Install 0.163.0 privately, inspect its schema; do not replace system Codex.
- Official protocol reference: https://learn.chatgpt.com/docs/app-server (fetched). `turn/interrupt` cancels then `turn/start` continues same thread. Only public agent message content is forwarded, not internal reasoning or raw tool output.
- Existing service/connected accounts remain running; platform will have independent authentication and state.

## Verification completed

- Original 22 regression tests and 6 platform tests passed.
- Browser registration/login, fourth-assistant swap, streaming interrupt, QR verification, history reload, admin read-only, password change, desktop/mobile passed without JavaScript errors.
- Real Codex 0.163.0 + gpt-6.1-sol: persistent thread resumed the validation word after process restart; live generation interrupted, then continued in the same thread.
- Inspected the Codex process filesystem (inside bubblewrap, not the outer supervisor): own workspace/home present; host Codex home, old service, platform and other users absent.
- Deployed wxbot-platform.service on 127.0.0.1:3211; health check passed and original 3210 still returns HTTP 200.
- Live browser -> real Codex response and real iLink QR creation passed. After systemd restart, the same assistant/thread correctly recalled its previous validation word. Verification assistant left stopped.
- Actual mobile scan and end-to-end real WeChat delivery still require the user; mock channel/real adapter protocol flows are covered by tests.
- Administrator bootstrap secret is in a mode-0600 file outside the repository; no secrets are committed or included in screenshots.
