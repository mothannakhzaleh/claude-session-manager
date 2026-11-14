# Contributing

Thanks for helping make Session Manager better. Bug reports, ideas and pull requests are all welcome.

## Before you start

- **Questions and ideas:** start in [Discussions](https://github.com/mothannakhzaleh/claude-session-manager/discussions).
- **Bugs:** open an issue with the bug form. Leave out emails, account ids and private folder names.
- **Security problems:** report them privately, see [SECURITY.md](SECURITY.md).

## Working on the code

The mod has three parts:

| Path | What it is |
| --- | --- |
| `hooks/register.tsx` | The pane, the widget and the `/sessions` command |
| `scripts/sessions.mjs` | The Node.js helper that scans, clears, deletes, moves and restores |
| `types/index.d.ts` | The types of the values the pane keeps |

Try your copy in Claude Code without installing it:

```bash
claude --plugin-dir path/to/claude-session-manager
```

Check it before opening a pull request. The helper tests run on whatever system you use, and CI runs them on Linux, macOS and Windows:

```bash
node --test tests/helper-cross-platform.mjs
```

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The helper also runs on its own, for example `node scripts/sessions.mjs scan`. It prints one JSON object.

## Rules that keep people's data safe

- Never let the helper touch skills, plugins, memory, settings or anything outside the session folders. Keep the checks in `sessionShape` and `PROTECTED`.
- Everything that deletes or rewrites files asks first in the pane and sends the old files to the Recycle Bin (Windows) or the Trash (macOS, Linux).
- Never read credentials. The account file is read only for the account id, email and organization name, to label accounts on screen.
- Tests and screenshots use made-up data only.

## Releases

Changes reach `main` only through pull requests whose checks all pass (Linux, macOS and Windows), and the maintainer may let a pull request merge itself once they do.

Do not add a `version` to `.claude-plugin/plugin.json` or `marketplace.json`: without one, Claude Code takes the commit as the version, so every merge to `main` reaches people's auto-update. Every merge that changes the mod is also tagged and published as a GitHub Release by the [Release workflow](.github/workflows/release.yml), numbered patch + 1. For a bigger number, the maintainer puts a line `Release-As: 0.5.0` in the merged commit's message.

## License

By contributing you agree that your work is released under the [MIT License](LICENSE).
