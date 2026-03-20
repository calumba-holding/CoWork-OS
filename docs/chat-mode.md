# Chat Mode

Chat mode is the direct conversational path in CoWork OS.

It is intentionally different from task execution modes:

- **No tools**
- **No step timeline**
- **No verification / success / partial-success labels**
- **Same-session follow-ups** stay in the current conversation
- **Explicit only**: chat mode is used only when `executionMode` is set to `"chat"`

## Behavior

- The user prompt is sent directly to the LLM as a chat request.
- Follow-up questions keep the earlier conversation in the same session.
- Long conversations use a summary-plus-recent-window history strategy so older context is preserved without sending the full transcript every turn.
- The chat summary is cached and persisted in the conversation snapshot, so it does not need to be regenerated on every turn.
- Explicit chat requests use a fixed high output budget, capped at **48K tokens**, so the same cap applies to the first answer and follow-ups.

## Streaming

- Azure chat calls stream incrementally in chat mode.
- Other modes keep their existing execution behavior and do not use this chat-only streaming path.

## When To Use It

Use chat mode when you want a normal assistant conversation:

- ask a question
- ask a follow-up
- keep the same context
- get a direct answer without task planning or tool use

If you want CoWork OS to execute work, create artifacts, or use tools, use one of the task modes instead.
