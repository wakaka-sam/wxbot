# Assistant browser runtime

The platform uses Playwright 1.64.1 and its matching Chromium Headless Shell
156.0.8078.4 (revision 1248) installed on sg under `/opt/wxbot-agent-tools`.
These are the versions verified on 2026-11-06, not an automatic upgrade policy.

## Incident and fix

The admin assistant chose `/usr/bin/chromium`, whose Debian launcher requires
`/etc/chromium.d`, absent from the assistant's outer mount namespace. Using
`/usr/lib/chromium/chromium` bypassed that launcher but encountered crashpad
configuration errors, then `process_singleton_posix.cc:297 socket() failed:
Operation not permitted` after assigning writable XDG directories.

The outer app-server process had Seccomp=0. Commands launched by that same
Codex app-server had Seccomp=2 and AF_UNIX socket creation returned EPERM.
In the same command permission profile, the system Chromium failed while the
bundled Headless Shell opened HTTPS and evaluated JavaScript successfully.
The failure is the full Chromium ProcessSingleton socket requirement meeting
the inner command sandbox, not missing Playwright or shared libraries.
`ldd` found no missing dependencies for either browser executable.

The fix keeps the outer bubblewrap isolation, inner command sandbox, managed
proxy and systemd resource limits. It does not allow Unix sockets, local
binding, private-network access or privileged execution. Chromium already ran
with `--no-sandbox`; that existing browser option does not disable the outer
assistant sandbox. A remote CDP/browser service is unnecessary for the tested
capabilities and no listening browser endpoint is exposed.

`WXBOT_MANAGED_BROWSER=1` enables compatibility in the existing Node preload.
Legacy `require('playwright').chromium.launch()` calls with either system path,
or the bundled full Chromium path, are routed to Playwright's default matching
headless shell. The platform supplies its proxy even when a legacy script omits
it. Explicit channels and headed requests also use the supported headless
runtime, with a short diagnostic. Unrecognized custom executable paths fail
with an actionable message. This is a Node Playwright integration, not a
replacement for the system Chromium executable or a Python Playwright install.

## Use inside an assistant

See [the installed browser skill](../src/browser-skill.md) for the complete example.

```js
const { openBrowser } = require('/home/assistant/.local/share/wxbot-tools/browser.cjs');
(async () => {
  const { browser, context, page, saveState } = await openBrowser({ session: 'airasia' });
  try {
    await page.goto('https://www.airasia.com/check-in/', { waitUntil: 'domcontentloaded' });
    console.log(await page.title());
    await page.screenshot({ path: '/workspace/airasia.png', fullPage: true });
    // Save only when persistence is wanted; never log the state object.
    await saveState();
  } finally { await browser.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
```

Each assistant has a distinct host-backed home and workspace. Temporary browser
profiles use `~/.cache/wxbot-browser/tmp`; each launch receives its own private
config/cache/download directories. Normal close, launch failure and browser
disconnection clean the launch directories. Playwright handles process signals;
the assistant's systemd scope terminates remaining processes on harness close.
An uncatchable process kill may leave cache files; these are private disposable
cache, not shared sessions. Download files must be saved into `/workspace`
before browser close. Do not change TMPDIR to a shared host directory.

Named sessions are opt-in and explicit `saveState()` writes Cookie,
localStorage and IndexedDB state atomically with mode 0600 under
`~/.local/share/wxbot-browser/sessions`. Do not print or commit these files.
SessionStorage is not persisted. Concurrent writers to the same named session
use last-save-wins, so give concurrent workflows distinct names.

Timeouts are 30 seconds for launch, 15 seconds for default actions, 45 seconds
for default navigation and 15 minutes maximum browser lifetime. Existing
resource limits remain 768 MiB RAM, 256 MiB swap, one CPU quota and 192 tasks.
Large pages or concurrent browsers may exhaust this budget. Service Workers
remain blocked and the existing broken Battle.net RUM subresource exception
is unchanged. These restrictions can affect some sites; do not infer that a
working browser guarantees access to an account, reservation or protected site.

## Acceptance and reproduction

Use the deployment's Node, CLI and environment, via the same `CodexHarness`
and `command/exec` permission profile used by assistant commands:

```sh
cd /root/workspace/wxbot
set -a
. /etc/wxbot-platform.env
set +a
PLATFORM_AGENT_TEST=1 BROWSER_ARTIFACTS=/root/.config/wxbot-platform/browser-acceptance-20261106 \
  node scripts/test-platform-browser-runtime.mjs
```

The opt-in test creates two synthetic assistants, never starts a second platform
process and never uses production conversations, website credentials or orders.
It checks HTTPS/JavaScript, a synthetic dynamic form, filling, same-context
Cookie sharing, saved-state restoration, downloads, legacy path compatibility,
persistent contexts, cleanup, 0600 state permissions and cross-assistant state
isolation. It also verifies AF_UNIX remains denied, host credentials remain
unreadable, and loopback/metadata access is blocked directly and through the
proxy. It closes scopes and removes synthetic data after testing. Screenshots
and a sanitized report are kept in BROWSER_ARTIFACTS, outside Git.

On 2026-11-06 all of those checks passed. AirAsia returned HTTP 200 at
`https://www.airasia.com/check-in/v2/en/gb` and displayed its booking/PNR and
name fields plus Search button. The screenshot was visually checked. Some
auxiliary page content was still loading; no claim is made about every asset.
No login, actual booking lookup, check-in or payment was performed. Site state
can change; the test reports form availability separately from browser health.

## Deployment and rollback

After checks, commit/push the source, verify there are no running platform jobs,
and restart `wxbot-platform.service`. Existing thread IDs, WeChat bindings and
private data remain intact. The next harness preparation installs the updated
helper and browser skill and sets the new runtime environment. Installing tools
for the idle admin home ahead of restart makes the updated instructions visible
immediately without changing its scripts or conversation.

To roll back, revert the browser-runtime fix commit with `git revert`, run the
relevant checks, push the revert, and restart `wxbot-platform.service`. The next
harness preparation restores the previous helper/configuration. Named session
files are not deleted; keep them private or remove only the unwanted named
session inside its owning assistant. Do not reset the repository or delete
platform data.

References: [Playwright browser versions and Headless Shell](https://playwright.dev/docs/browsers),
[BrowserContext state](https://playwright.dev/docs/api/class-browsercontext),
[official OpenAI configuration reference](https://learn.chatgpt.com/docs/config-file/config-reference).
The installed CLI and same-permission runtime probes, rather than assumed
semantics of a newer documentation version, determine this deployment's behavior.
