# Session Manager for Claude Code

[![Latest release](https://img.shields.io/github/v/release/mothannakhzaleh/claude-session-manager?label=release)](https://github.com/mothannakhzaleh/claude-session-manager/releases/latest)
[![Release](https://github.com/mothannakhzaleh/claude-session-manager/actions/workflows/release.yml/badge.svg)](https://github.com/mothannakhzaleh/claude-session-manager/actions/workflows/release.yml)
[![Check](https://github.com/mothannakhzaleh/claude-session-manager/actions/workflows/check.yml/badge.svg)](https://github.com/mothannakhzaleh/claude-session-manager/actions/workflows/check.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![Windows | macOS | Linux](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-0078D6)

See every Claude Code session on your computer (Windows, macOS or Linux), for every Claude account, in one pane: what each one cost in tokens, how much disk it uses and what is inside it. Then clean up safely: clear uploaded images and files, delete old sessions and leftover logs, and move chats from another account into the one you use now.

**Works on Windows, macOS and Linux.** Every change is tested on all three before it is released ([what works where](#requirements)).

![Overview: tiles for conversations, leftover logs, uploads, old sessions, other accounts and tokens, then the session list](docs/images/overview.png)

## What it does

- **Every session, every account.** Lists Claude Code sessions from all accounts and users on the computer, grouped by account, with filters (conversations, leftover logs, with uploads, older than N days) and sorting (recent, largest, most tokens).
- **Token totals.** Input, output, cache write and cache read for each session, each account and everything together. Each reply is counted once, and subagent runs are included.
- **Clear uploads.** Pasted screenshots and uploaded files stay inside transcripts and can take hundreds of MB. Clearing keeps the conversation and puts a small placeholder where each upload was.
- **Delete old sessions and leftover logs.** Background summary runs ("Below is a conversation log…") pile up with no real replies. One click removes them, along with old conversations you no longer use.
- **Cards with their own cleanup.** Click a tile (Leftover logs, Uploads, Older than 30 days, Other accounts) to open a card listing just those items, with a button for each one and one for all of them.
- **Progress bar.** Shows what is done, what is left and how much space has been freed so far.
- **View what is inside a chat.** When it ran, model, branch, what you asked, Claude's last replies, the tools it used and the files it worked on, without opening the chat.
- **Bring chats from another account.** Moves a chat's sidebar entry into the account the Claude app uses now, so you can continue it there. It lands in your Active list. The conversation itself stays where it is, so nothing is duplicated or left behind.
- **Restore deleted chats to the sidebar.** A chat you deleted in the app often still has its conversation on disk ("Deleted in app, files left"). **Restore to sidebar** gives it a new entry in your Active list so you can continue it. The conversation is not changed.
- **Small widget.** In the Claude desktop app a small Sessions widget opens beside the chat with the main numbers. Turn it off from the pane footer.
- **Diagnostics.** The **Diagnostics** button in the pane footer shows a short report (versions, where removed files go, which Claude folders exist and how many sessions each holds) with a **Copy report** button for bug reports. It holds no emails, account ids, user names or chat titles.

![Cleanup: the Uploads card with its own Clear all button, and the progress bar while it runs](docs/images/cleanup.png)

![View what is inside a chat, move chats from other accounts, and the desktop widget](docs/images/view.png)

*The pictures show example data.*

## Safe by design

- Skills, plugins, mods, memory, agents, commands, hooks and settings are never touched: the helper only accepts session files by their exact shape and refuses anything inside those folders.
- The session you are using, sessions open in a running Claude process, and sessions written in the last 15 minutes are skipped.
- Conversations still in the app's list are not deleted here. Delete them in the app first; their leftover files can then be cleared here.
- Deleted and replaced files go to the **Recycle Bin** (Windows) or the **Trash** (macOS, Linux), so you can restore them.
- Every delete, clear and move asks you first.
- Credentials are never read. Of the account file it reads only the account id, email and organization name, to label accounts on your screen. Nothing is sent anywhere.

## What it reads, runs and sends

**What it sends:** nothing. The mod and its helper make no network requests and send no data anywhere. The one time anything is downloaded is when you press **Install Node.js**: winget or Homebrew then downloads Node.js from its own official source.

**What it reads, all on your computer:**

- Session transcripts and their side folders under `~/.claude` (`projects`, `file-history`, `session-env`). Conversation text is read to count tokens and uploads, to find titles, and for **View**, and is shown only on your screen.
- The Claude desktop app's sidebar index (`claude-code-sessions` in the app's data folder), to show which chats are in the app and to move or restore them.
- From `~/.claude.json`, only `oauthAccount.accountUuid`, `emailAddress` and `organizationName`, to label accounts on your screen. No token or password is read: the credentials file (`~/.claude/.credentials.json`, or the system keychain) is never opened.

**Programs it starts, and why:**

| Program and arguments (written out in full in [hooks/register.tsx](hooks/register.tsx) and [scripts/sessions.mjs](scripts/sessions.mjs)) | When | Why |
| --- | --- | --- |
| `node scripts/sessions.mjs scan`, `peek`, `strip`, `delete`, `move`, `restore` or `diag` | Scanning, **View**, **Diagnostics** and each action you confirm | The helper that does the work, on local files only |
| `node --version`, then the same with `C:\Program Files\nodejs\node.exe`, `/opt/homebrew/bin/node`, `/usr/local/bin/node`, `/usr/bin/node` and `/home/linuxbrew/.linuxbrew/bin/node` | First use in a session | Finds Node.js 18 or newer |
| `/bin/zsh -ilc "command -v node"` and `/bin/bash -ilc "command -v node"` | macOS and Linux, only when Node.js was not found above | Finds a Node.js installed with nvm, fnm or volta, which only your shell knows |
| `winget --version`, `brew --version` | When you press **Install Node.js** | Picks the installer this system has |
| `winget install --id OpenJS.NodeJS.LTS --exact --silent --accept-source-agreements --accept-package-agreements --disable-interactivity` | **Install Node.js** on Windows | Installs Node.js LTS from its official package |
| `brew install node` | **Install Node.js** on a Mac (or Linux with Homebrew) | Installs Node.js |
| `pwsh` or `powershell -NoProfile -NonInteractive -Command <fixed script>` | Windows, when a confirmed delete, clear, move or restore removes files | Sends them to the Recycle Bin (the script is fixed text in `recycleWindows`) |
| `/usr/bin/trash <files>` | macOS, the same moments | Sends them to the Trash with Finder's **Put Back** |

## Requirements

- Claude Code (the desktop app or the terminal) on one of:

  | System | Tested in CI | Notes |
  | --- | --- | --- |
  | Windows 10 or 11 | yes | Removed files go to the Recycle Bin. |
  | macOS | yes | Removed files go to the Trash (with Finder's **Put Back** where macOS has the `trash` command). Moving and restoring app sidebar entries expects the app's data in `~/Library/Application Support/Claude` and is not yet confirmed on a real Mac: please [report](https://github.com/mothannakhzaleh/claude-session-manager/issues/new/choose) how it goes, with the **Diagnostics** report. |
  | Linux | yes | Removed files go to the desktop Trash (`~/.local/share/Trash`). Claude has no official Linux desktop app, so moving and restoring sidebar entries applies only to a build that keeps its data in `~/.config/Claude`. |

  "Tested in CI" means the helper's scan, view, clear, delete, move and restore run on that system against made-up sessions.

- **Node.js 18 or newer.** If it is missing, the pane shows an **Install Node.js** button: on Windows it installs the LTS version with winget from the official `OpenJS.NodeJS.LTS` package (Windows may ask for permission); on a Mac (or Linux) with [Homebrew](https://brew.sh) it runs `brew install node`. Otherwise install it from [nodejs.org](https://nodejs.org) or your package manager (for example `sudo apt install nodejs`).

## Install

In Claude Code, type:

```
/plugin install session-manager --marketplace mothannakhzaleh/claude-session-manager
```

Or from a terminal:

```bash
claude plugin install session-manager --marketplace mothannakhzaleh/claude-session-manager
```

Then start a new session and type `/sessions` to open the pane.

## Use

- `/sessions` opens the pane. The first scan reads every transcript once (about 20 seconds on a large history). After that, only changed files are read again.
- In the Claude desktop app you can also pick it from **+ → Plugins → Session Manager**, or just ask Claude to "show my sessions": the plugin's `sessions` skill opens the same pane. It never deletes anything itself; all cleanup stays in the pane and asks you first.
- In the desktop app a small Sessions widget opens beside the chat when you start a new session (where your app version has widgets). Turn it off with **Widget at start** in the pane footer.
- Click a tile's **Clean up** or **Bring here** to open its card.
- **View** on any session shows what is inside it.
- Moved chats show in the sidebar after you restart the Claude app.

## Updating

Every change merged into this repository is a new version for Claude Code, after its checks pass on Linux, macOS and Windows. Changes to the mod are also published as a numbered [Release](https://github.com/mothannakhzaleh/claude-session-manager/releases) listing what changed.

**Get updates without doing anything (recommended, once):** in Claude Code, type `/plugin`, open **Marketplaces**, select **claude-session-manager** and choose **Enable auto-update**. Marketplaces other than Anthropic's start with auto-update off, so this one step is needed. After that, Claude Code checks for new versions in the background after your first message in a session, and loads them the next time it starts (or right away with `/reload-plugins`).

**Update by hand:**

- In Claude Code: `/plugin marketplace update claude-session-manager`, then `/plugin` → **Installed** → **session-manager** → **Update now**.
- From a terminal:

  ```bash
  claude plugin marketplace update claude-session-manager
  ```

  ```bash
  claude plugin update session-manager@claude-session-manager
  ```

## Help and contributing

- Questions and ideas: [Discussions](https://github.com/mothannakhzaleh/claude-session-manager/discussions)
- Bugs: [open an issue](https://github.com/mothannakhzaleh/claude-session-manager/issues/new/choose)
- Want to help? Read [CONTRIBUTING.md](CONTRIBUTING.md). Security problems: [SECURITY.md](SECURITY.md).

## License

MIT © 2026 mothannakh · [satisfy.live](https://satisfy.live/)
