# wxbot deployment

- User direction (2026-10-23): all future wxbot platform deployments go to SSH host `sg`.
- Production URL: https://wxbot.wakaka007.cn.
- Production source on sg: `/root/workspace/wxbot`; service: `wxbot-platform.service`.
- Production configuration: `/etc/wxbot-platform.env`; data: `/root/.local/share/wxbot-platform`.
- Operational details and migration backup are on sg under `/root/.config/wxbot-platform/`.
- The original machine is for source development only for this platform. Its migrated platform data, credentials, backup, private CLI, and service unit were removed at the user's request. Do not recreate or deploy a local production platform or copy production conversations back here.
- The separate legacy `wxbot.service` on local port 3210 was not part of the platform migration and remains in place with its own data. Do not treat it as the active platform deployment or remove its independent data incidentally.
- Never run two platform processes against the same WeChat bindings. Keep credentials and private conversation data out of Git.

## Completing changes

- After completing a change and passing the checks appropriate to it, commit the relevant changes and push them to this repository's GitHub remote before reporting completion. This applies to code, documentation, and configuration changes.
- The user has authorized this routine commit-and-push workflow; do not ask for confirmation each time. Use the GitHub SSH access on `sg` when the development machine cannot push.
- Preserve unrelated work, exclude credentials and runtime data, and do not force-push. If a check or push fails, resolve it when possible; otherwise report the exact blocker and clearly state that the change has not been pushed.
- Verify that the remote branch contains the completed commit. Deployments continue to target `sg` according to the rules above.
