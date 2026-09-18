# AetherLink Telegram Bridge

Use the Telegram MCP tools when the user asks to receive notifications, approve/deny an action remotely, answer a question from Telegram, submit a Telegram task, receive files, or monitor task progress.

Prefer `tg_inbox` then `tg_ack` for incoming work. Use `tg_progress` for durable progress, `tg_ask` for questions, `tg_complete` on success, and `tg_fail` on failure. Never use Telegram remote shell unless the user explicitly asks for terminal execution.
