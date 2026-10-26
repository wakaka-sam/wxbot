# Direct-send rollback experiment (2026-10-26)

This diagnostic branch reverses the CLI/relay integration introduced by b70e502 on top of a6d5a42. It is not deployed to production and is not an established fix. Existing UI and origin-guard fixes and sanitized send diagnostics remain.

## Code comparison

The b70e502 change introduced the wxbot send command, per-turn relay, and automatic final-text duplicate suppression. It did not modify Weixin HTTP requests, Bridge recipient selection, or the WechatChannel adapter. In this branch, platform engine and Codex adapter match pre-integration commit 4d7c96e. The direct path is WechatChannel.send -> Bridge.send -> Weixin.sendText -> HTTP.

## Validation

- Syntax checks passed.
- 24 legacy/adapter tests and 23 platform tests passed on SG.
- No second production polling process was started. The first real diagnostic used an isolated temporary channel store on SG; the account/context were read from the current binding and temporary data was removed afterward. Other probes invoked Weixin directly. Production source, bindings and history were not rolled back.
- 06:11:45 UTC: first rollback-path probe received HTTP 200 with ret=-2; no device delivery claimed. The upstream error description was not retained for this attempt, so the precise reason is unknown.
- 06:11:51 UTC: production received a fresh user message between probes. The adapter updates saved reply context when the incoming message provides a context token. Token changes were not captured in this experiment.
- 06:12:01 UTC: second rollback-version direct probe returned a message_id; the user confirmed seeing it on WeChat.
- 06:12:31 UTC: the unchanged production-version direct probe also returned a message_id; the user confirmed seeing that message too.
- The unchanged production engine additionally completed a normal assistant response to the fresh input and persisted a sent receipt. Device display of that normal assistant response has not been separately confirmed.

## Interpretation and limits

Both rollback and current HTTP implementations can deliver to the affected binding now. The evidence does not support blaming the command extraction for the previously reported delivery failure. The new inbound message between the failed and successful probes makes reply-context freshness a plausible factor in this run, but no token comparison or upstream diagnostic proves it. This experiment does not establish the cause of the earlier ret=0-without-visible-delivery incident, and a direct-send probe does not exercise every CLI/relay or automatic-reply path.

The diagnostic branch is retained for review; do not merge it as a proven repair. Private correlation records remain on SG outside the repository. No credentials, recipient IDs or conversation contents belong in this report.
