---
name: manage-sessions
description: Open Session Manager, the pane that lists every Claude Code session on this computer with token totals, disk use and uploads, and cleans up, moves or restores chats. Use when the person asks to see, count, clean up, move or restore their Claude sessions or chats.
---

# Session Manager

Open the Sessions pane by calling the tool `mcp__session-manager__open_sessions` (no input). If it is not loaded yet, load it with ToolSearch (`select:mcp__session-manager__open_sessions`) and call it.

Then tell the person, in a few lines:

- that the pane is open beside the chat (or, if the tool says it is not shown yet, that `/sessions` opens it);
- the summary the tool returned (sessions, tokens, disk use).

All cleanup happens in the pane, where every delete, clear, move and restore asks the person first and removed files go to the Recycle Bin or Trash. Do not delete, move or edit session files yourself.
