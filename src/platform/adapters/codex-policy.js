// The outer bubblewrap mount namespace separates assistants. This inner Codex
// profile confines commands and keeps the shared model login out of tool reads.
export function agentConfig(model, proxyPort) {
  return `model = ${JSON.stringify(model)}
model_reasoning_effort = "medium"
approval_policy = "never"
default_permissions = "assistant"
web_search = "live"
project_doc_max_bytes = 32768
allow_login_shell = false

[features]
shell_tool = true
unified_exec = true
multi_agent = true
skill_search = true
network_proxy = true
skip_host_skill_discovery = true
# Shared deployment login must not expose its private connected applications.
apps = false
remote_plugin = false
plugins = false
hooks = false
skill_mcp_dependency_install = false

[projects."/workspace"]
trust_level = "untrusted"

[agents]
max_threads = 2

[permissions.assistant]
extends = ":workspace"

[permissions.assistant.filesystem]
"/home/assistant" = "read"
"/home/assistant/.cache" = "write"
"/home/assistant/.local" = "write"
"/home/assistant/.npm" = "write"
"/home/assistant/.codex" = "deny"
"/home/assistant/.codex/skills" = "read"

[permissions.assistant.network]
enabled = true
proxy_url = "http://127.0.0.1:${proxyPort}"
enable_socks5 = false
allow_local_binding = false
allow_upstream_proxy = false

[permissions.assistant.network.domains]
"*" = "allow"
`;
}
