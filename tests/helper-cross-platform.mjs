// Runs scripts/sessions.mjs against a made-up user profile on the system it runs on
// (Windows, macOS or Linux): scan, peek, clear uploads, delete to the bin, the safety
// refusals, and the desktop app's move and restore. CI runs it on all three systems.
//   node --test tests/helper-cross-platform.mjs
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HELPER = fileURLToPath(new URL('../scripts/sessions.mjs', import.meta.url))
const DAY = 86_400_000
const BIG = 'A'.repeat(4000) // an "upload": a base64 string the helper counts and clears

// Made-up ids; nothing here is a real account.
const ACCOUNT_OLD = '11111111-1111-4111-8111-111111111111'
const ACCOUNT_NEW = '22222222-2222-4222-8222-222222222222'
const ORG = '33333333-3333-4333-8333-333333333333'
const S_CLI = 'aaaaaaaa-0000-4000-8000-000000000001' // terminal only, has an upload
const S_APP = 'aaaaaaaa-0000-4000-8000-000000000002' // listed in the app (old account)
const S_DELETED = 'aaaaaaaa-0000-4000-8000-000000000003' // deleted in the app, transcript left
const S_LIVE = 'aaaaaaaa-0000-4000-8000-000000000004' // written just now
const S_GONE = 'aaaaaaaa-0000-4000-8000-000000000005' // will be deleted

let tmp, usersRoot, home, claude, project, xdg

// Where the desktop app keeps its index on this system (the helper's appRoots()).
function appRoot(h) {
  if (process.platform === 'win32') return path.join(h, 'AppData', 'Local', 'Claude-Data', 'claude_test')
  if (process.platform === 'darwin') return path.join(h, 'Library', 'Application Support', 'Claude')
  return path.join(h, '.config', 'Claude')
}

function transcript(id, { upload = false, title } = {}) {
  const rows = [
    { type: 'user', sessionId: id, cwd: path.join(tmp, 'work'), timestamp: '2026-01-01T10:00:00Z', message: { role: 'user', content: [{ type: 'text', text: `hello from ${id.slice(-1)}` }, ...(upload ? [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: BIG } }] : [])] } },
    { type: 'assistant', sessionId: id, timestamp: '2026-01-01T10:00:05Z', message: { id: `msg_${id}`, role: 'assistant', model: 'claude-test-1', content: [{ type: 'text', text: 'hi' }], usage: { input_tokens: 100, output_tokens: 20, cache_creation_input_tokens: 5, cache_read_input_tokens: 1 } } },
  ]
  if (title) rows.push({ type: 'custom-title', sessionId: id, customTitle: title })
  return rows.map(r => JSON.stringify(r)).join('\n') + '\n'
}

function writeSession(id, opts = {}, ageMs = 2 * DAY) {
  const file = path.join(project, `${id}.jsonl`)
  fs.writeFileSync(file, transcript(id, opts))
  fs.mkdirSync(path.join(claude, 'file-history', id), { recursive: true })
  fs.writeFileSync(path.join(claude, 'file-history', id, 'f.txt'), 'x')
  const t = new Date(Date.now() - ageMs)
  fs.utimesSync(file, t, t)
  return file
}

function run(cmd, ...extra) {
  const r = spawnSync(process.execPath, [HELPER, cmd, '--users-root', usersRoot, '--cache', path.join(tmp, 'cache.json'), ...extra], {
    encoding: 'utf8',
    env: { ...process.env, XDG_DATA_HOME: xdg },
  })
  let body
  try {
    body = JSON.parse(r.stdout)
  } catch {
    assert.fail(`helper printed no JSON (exit ${r.status}): ${r.stderr || r.stdout}`)
  }
  return body
}

before(() => {
  // Inside the home folder, so a move to the bin stays on one disk on every system.
  tmp = fs.mkdtempSync(path.join(os.homedir(), '.sm-test-'))
  usersRoot = path.join(tmp, 'users')
  home = path.join(usersRoot, 'tester')
  claude = path.join(home, '.claude')
  project = path.join(claude, 'projects', '-work')
  xdg = path.join(tmp, 'xdg')
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(path.join(tmp, 'work'))
  // Protected folders that must survive everything.
  fs.mkdirSync(path.join(claude, 'skills', 'keep-me'), { recursive: true })
  fs.writeFileSync(path.join(claude, 'skills', 'keep-me', 'SKILL.md'), 'keep')

  writeSession(S_CLI, { upload: true })
  writeSession(S_APP, { title: 'App chat' })
  writeSession(S_DELETED)
  writeSession(S_LIVE, {}, 0)
  writeSession(S_GONE)

  // The app index: the old account lists S_APP and marks S_DELETED deleted; the new account
  // was written last, so it is the one the app uses now.
  const sessions = path.join(appRoot(home), 'claude-code-sessions')
  const oldFolder = path.join(sessions, ACCOUNT_OLD, ORG)
  const newFolder = path.join(sessions, ACCOUNT_NEW, ORG)
  fs.mkdirSync(oldFolder, { recursive: true })
  fs.mkdirSync(newFolder, { recursive: true })
  fs.writeFileSync(path.join(oldFolder, `local_${S_APP}.json`), JSON.stringify({ sessionId: `local_${S_APP}`, cliSessionId: S_APP, cwd: path.join(tmp, 'work'), title: 'App chat', isArchived: true }))
  fs.writeFileSync(path.join(oldFolder, `deleted_${S_DELETED}`), String(Date.now()))
  const old = new Date(Date.now() - 3 * DAY)
  for (const f of fs.readdirSync(oldFolder)) fs.utimesSync(path.join(oldFolder, f), old, old)
  fs.writeFileSync(path.join(newFolder, 'local_bbbbbbbb-0000-4000-8000-000000000009.json'), JSON.stringify({ cliSessionId: 'bbbbbbbb-0000-4000-8000-000000000009', model: 'claude-test-1', title: 'Newest' }))
})

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

test('scan lists every session with its state, tokens and uploads', () => {
  const r = run('scan')
  assert.equal(r.ok, true, r.error)
  assert.equal(r.platform, process.platform)
  assert.equal(r.trash, process.platform === 'win32' ? 'Recycle Bin' : 'Trash')
  const by = Object.fromEntries(r.sessions.map(s => [s.id, s]))
  assert.equal(r.sessions.length, 5)
  assert.equal(by[S_CLI].state, 'cli-only')
  assert.equal(by[S_CLI].uploads.count, 1)
  assert.equal(by[S_APP].state, 'archived')
  assert.equal(by[S_DELETED].state, 'deleted-in-app')
  assert.equal(by[S_DELETED].canRestore, true)
  assert.equal(by[S_LIVE].isLive, true)
  assert.equal(r.total.input, 500)
  assert.equal(r.total.output, 100)
  const active = r.accounts.find(a => a.isAppActive)
  assert.equal(active?.accountUuid, ACCOUNT_NEW)
})

test('peek shows what is inside a chat', () => {
  const r = run('peek', '--ids', S_APP)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.model, 'claude-test-1')
  assert.equal(r.promptCount, 1)
})

test('clearing uploads keeps the chat and shrinks it', () => {
  const file = path.join(project, `${S_CLI}.jsonl`)
  const before = fs.statSync(file).size
  const r = run('strip', '--ids', S_CLI)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.results[0].ok, true, r.results[0].reason)
  assert.equal(r.results[0].blocks, 1)
  assert.ok(fs.statSync(file).size < before)
  assert.ok(!fs.existsSync(`${file}.sm-orig`), 'the original went to the bin')
  assert.match(fs.readFileSync(file, 'utf8'), /hello from 1/)
})

test('delete sends a session to the bin and refuses a live one', () => {
  const r = run('delete', '--ids', [S_GONE, S_LIVE].join(','))
  assert.equal(r.ok, true, r.error)
  const res = Object.fromEntries(r.results.map(x => [x.id, x]))
  assert.equal(res[S_GONE].ok, true, res[S_GONE].reason)
  assert.equal(res[S_LIVE].ok, false)
  assert.match(res[S_LIVE].reason, /15 minutes/)
  assert.ok(!fs.existsSync(path.join(project, `${S_GONE}.jsonl`)))
  assert.ok(!fs.existsSync(path.join(claude, 'file-history', S_GONE)))
  assert.ok(fs.existsSync(path.join(project, `${S_LIVE}.jsonl`)))
  assert.ok(fs.existsSync(path.join(claude, 'skills', 'keep-me', 'SKILL.md')), 'skills are never touched')
  if (process.platform === 'linux') {
    // freedesktop.org Trash: the item in files/, its note in info/.
    const info = fs.readFileSync(path.join(xdg, 'Trash', 'info', `${S_GONE}.jsonl.trashinfo`), 'utf8')
    assert.match(info, /^\[Trash Info\]\nPath=\/.+\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/)
    assert.ok(fs.existsSync(path.join(xdg, 'Trash', 'files', `${S_GONE}.jsonl`)))
  }
})

test('diagnostics describe the folders without ids or names', () => {
  const r = run('diag')
  assert.equal(r.ok, true, r.error)
  assert.match(r.report, /^### Session Manager diagnostics/)
  assert.match(r.report, new RegExp(`System: ${process.platform} `))
  assert.match(r.report, /claude-code-sessions: 2 account\(s\), 2 organization folder\(s\)/)
  for (const secret of [ACCOUNT_OLD, ACCOUNT_NEW, ORG, S_APP, 'tester', 'App chat', usersRoot]) {
    assert.ok(!r.report.includes(secret), `the report must not hold ${secret}`)
  }
})

test('a bad id is refused', () => {
  const r = run('delete', '--ids', '../skills/keep-me')
  assert.equal(r.results[0].ok, false)
  assert.ok(fs.existsSync(path.join(claude, 'skills', 'keep-me', 'SKILL.md')))
})

test('restore gives a chat deleted in the app a sidebar entry again', () => {
  const r = run('restore', '--ids', S_DELETED)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.results[0].ok, true, r.results[0].reason)
  const sessions = path.join(appRoot(home), 'claude-code-sessions')
  const entry = JSON.parse(fs.readFileSync(path.join(sessions, ACCOUNT_NEW, ORG, `local_${S_DELETED}.json`), 'utf8'))
  assert.equal(entry.cliSessionId, S_DELETED)
  assert.equal(entry.isArchived, false)
  assert.ok(!fs.existsSync(path.join(sessions, ACCOUNT_OLD, ORG, `deleted_${S_DELETED}`)))
})

test('move brings a chat from another account into the active one', () => {
  const r = run('move', '--ids', S_APP)
  assert.equal(r.ok, true, r.error)
  assert.equal(r.results[0].ok, true, r.results[0].reason)
  const sessions = path.join(appRoot(home), 'claude-code-sessions')
  const moved = JSON.parse(fs.readFileSync(path.join(sessions, ACCOUNT_NEW, ORG, `local_${S_APP}.json`), 'utf8'))
  assert.equal(moved.isArchived, false)
  assert.ok(!fs.existsSync(path.join(sessions, ACCOUNT_OLD, ORG, `local_${S_APP}.json`)))
})
