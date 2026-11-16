---
name: toggle-widget
description: Show or hide the small Session Manager widget beside the chat in the Claude desktop app. Use when the person asks to show, hide, turn on or turn off the sessions widget.
---

# Sessions widget

Call the tool `mcp__session-manager__toggle_widget`. If it is not loaded yet, load it with ToolSearch (`select:mcp__session-manager__toggle_widget`) and call it.

- The person asked to show or turn it on: call it with `{ "show": true }`.
- The person asked to hide or turn it off: call it with `{ "show": false }`.
- They only picked this skill, without saying which: call it with no input; it switches the widget.

Then tell the person in one line what the tool answered. The choice is remembered for new sessions; `/widget` switches it too.
