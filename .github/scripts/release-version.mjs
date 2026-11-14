// Picks the name of the release for a push to main. Claude Code itself needs no version:
// plugin.json has none, so it takes the commit as the version and every merge to main is an
// update for people's auto-update. The release number here only names the tag and the
// GitHub Release, so nothing is ever committed to main.
// - The newest session-manager--v<x.y.z> tag, patch + 1 (0.4.0 -> 0.4.1).
// - A line "Release-As: 1.2.0" in the pushed commit's message picks the number instead.
// - The commit already carries a release tag: nothing to do (tag is empty).
// Writes version and tag to $GITHUB_OUTPUT.
// Usage: node .github/scripts/release-version.mjs
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const PREFIX = 'session-manager--v'
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const parse = v => (/^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : undefined)

const tags = git('tag', '--list', `${PREFIX}*`)
  .split('\n')
  .map(t => t.slice(PREFIX.length))
  .filter(parse)
  .sort((a, b) => {
    const [x, y] = [parse(a), parse(b)]
    return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
  })
const already = git('tag', '--points-at', 'HEAD').split('\n').some(t => t.startsWith(PREFIX))

let version
const asked = /^Release-As:\s*(\d+\.\d+\.\d+)\s*$/im.exec(git('log', '-1', '--format=%B'))?.[1]
if (asked) version = asked
else if (tags.length) {
  const [major, minor, patch] = parse(tags[tags.length - 1])
  version = `${major}.${minor}.${patch + 1}`
} else version = '0.1.0'

const tag = already || tags.includes(version) ? '' : `${PREFIX}${version}`
const lines = [`version=${version}`, `tag=${tag}`]
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
console.log(lines.join(' '))
