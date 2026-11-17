---
name: auto-update
description: Turn automatic updates of the Session Manager plugin on or off (the desktop app has no switch for it). Use when the person asks to auto-update, keep up to date, or stop updating Session Manager.
---

# Session Manager auto-update

Call the tool `mcp__session-manager__set_auto_update`. If it is not loaded yet, load it with ToolSearch (`select:mcp__session-manager__set_auto_update`) and call it.

- The person asked to turn it off or stop updates: call it with `{ "on": false }`.
- Otherwise (they asked to turn it on, or only picked this skill): call it with `{ "on": true }`.

Then tell the person in one line what the tool answered. `/auto-update` (or `/auto-update off`) does the same.
