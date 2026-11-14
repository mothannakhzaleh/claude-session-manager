# Security policy

Session Manager reads and changes files in your Claude Code folders, so security problems matter here.

## Supported versions

Only the latest release gets fixes. Turn on auto-update (see the README) to stay on it.

## Reporting a problem

Please **do not open a public issue**. Report it privately on GitHub:
[Security → Report a vulnerability](https://github.com/mothannakhzaleh/claude-session-manager/security/advisories/new).

Useful details: what can go wrong (for example, a file outside the session folders gets deleted), the steps to make it happen, and the version you use. Leave out real emails, account ids and private paths.

You will get an answer within a week. Once a fix is released, the advisory is published with credit to you, unless you would rather stay anonymous.

## What counts

- Deleting, changing or reading files outside the session folders (skills, plugins, memory, settings, anything else)
- Reading credentials or sending any data off your PC
- Running anything without the person pressing a button for it
