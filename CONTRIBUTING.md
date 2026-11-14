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

Check it before opening a pull request:

```bash
claude plugin validate .
```

```bash
claude plugin test .
```

The helper also runs on its own, for example `node scripts/sessions.mjs scan`. It prints one JSON object.

## Rules that keep people's data safe

- Never let the helper touch skills, plugins, memory, settings or anything outside the session folders. Keep the checks in `sessionShape` and `PROTECTED`.
- Everything that deletes or rewrites files asks first in the pane and sends the old files to the Recycle Bin.
- Never read credentials. The account file is read only for the account id, email and organization name, to label accounts on screen.
- Tests and screenshots use made-up data only.

## Releases

Do not change `version` in `.claude-plugin/plugin.json`. Every merge to `main` that changes the mod is released by the [Release workflow](.github/workflows/release.yml): it raises the version, tags it and publishes a GitHub Release. For a bigger release the maintainer may set the version by hand (for example `0.4.0`), and the workflow keeps it.

## License

By contributing you agree that your work is released under the [MIT License](LICENSE).
