## What this changes

<!-- One or two sentences, and the issue it fixes (Fixes #123). -->

## How it was checked

- [ ] `claude plugin validate .`
- [ ] `claude plugin test .`
- [ ] Tried in Claude Code (desktop app or terminal): what you did and saw

## Safety

- [ ] Nothing new can delete or change skills, plugins, memory, settings or files outside session folders
- [ ] Anything that deletes or rewrites files still asks first and uses the Recycle Bin
- [ ] No personal data (emails, account ids, private paths) in code, tests or screenshots

Leave `version` in `.claude-plugin/plugin.json` as it is: the release workflow sets it.
