// Picks the release version for a push to main and writes it to plugin.json.
// Claude Code only offers an update when this version changes, so every release needs a new one.
// - The pushed commits changed "version" themselves: that version is kept (a manual 0.4.0 wins).
// - Otherwise the patch number goes up by one (0.3.0 -> 0.3.1).
// - The first push of the repository releases the version as it is.
// Writes version, tag and bumped to $GITHUB_OUTPUT; tag is empty when that tag already exists.
// Usage: node .github/scripts/bump-version.mjs <sha before the push>
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const MANIFEST = '.claude-plugin/plugin.json'
const before = process.argv[2] ?? ''
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const versionOf = text => JSON.parse(text).version

const text = fs.readFileSync(MANIFEST, 'utf8')
const now = versionOf(text)
if (!/^\d+\.\d+\.\d+$/.test(now ?? '')) throw new Error(`${MANIFEST} version "${now}" is not x.y.z`)

let previous
if (before && !/^0+$/.test(before)) {
  try {
    previous = versionOf(git('show', `${before}:${MANIFEST}`))
  } catch {
    previous = undefined // the manifest did not exist before this push
  }
}

let version = now
let bumped = false
if (previous !== undefined && previous === now) {
  const [major, minor, patch] = now.split('.').map(Number)
  version = `${major}.${minor}.${patch + 1}`
  fs.writeFileSync(MANIFEST, text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`))
  bumped = true
}

const tag = `session-manager--v${version}`
const exists = git('tag', '--list', tag) !== ''
const lines = [`version=${version}`, `tag=${exists ? '' : tag}`, `bumped=${bumped && !exists}`]
if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join('\n')}\n`)
console.log(lines.join(' '))
