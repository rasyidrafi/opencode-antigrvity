# Host prompt contract

The plugin is an OpenCode `LanguageModelV3` provider (`aisdk:antigravity`), so
OpenCode calls `doStream` in-process and owns the agent loop. For primary
Antigravity requests, the `context` session hook writes the active agent's
`system` field and OpenCode's instruction sources into provider options; the
adapter forwards both and drops OpenCode's assembled system message. Instruction
sources include AGENTS.md files, generated skills, MCP guidance and project
references; OpenCode's date and environment are omitted because the ACP harness
supplies its own. A missing, empty or whitespace-only field means no
instructions; agent lookup failures propagate instead of falling back.

The adapter sends a nonempty agent prompt and instructions as one text block:

```xml
<instruction>
Configured agent system prompt, unchanged.

OpenCode instruction sources, unchanged.
</instruction>
```

User content follows without a `[user]` marker or adapter boilerplate. The
plugin preserves OpenCode's new-child subagent introduction. It never adds
that introduction itself, so continuation messages are not prefixed again.
Conversation history, attachments and original tool results remain available
when continuing or rebuilding a trajectory. Changed/cleared instructions
retire the previous ACP context, including a parked tool turn once its results
are available, so old instructions are not silently retained.

ACP initialization omits optional `clientInfo` and advertises empty
`clientCapabilities`. Tool configuration uses the protocol's `mcpServers`
field with a server named `external_tool`; model selection is unchanged.

These rules govern the host input to ACP, not Antigravity's own internal
system prompt/metadata. Auxiliary title/generate requests keep their dedicated
utility behavior. Compaction also runs as an isolated summary turn: its result
lets the host rewrite history, and the next primary request reseeds a fresh ACP
session from that rewritten history. This does not promise to resolve Google
location restrictions.
