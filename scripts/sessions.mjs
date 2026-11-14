// Session Manager helper: scans Claude Code transcripts on this PC, sums their
// token usage, strips uploaded images/documents, deletes old sessions, shows what is
// inside one (peek) and moves app sidebar entries between accounts (move).
// Prints one JSON object on stdout. Never reads credential files.
//
//   node sessions.mjs scan   [--exclude <id>]
//   node sessions.mjs strip  --ids a,b [--exclude <id>] [--permanent]
//   node sessions.mjs delete --ids a,b [--exclude <id>] [--permanent]
//   node sessions.mjs diag   (a report for bug reports: no emails, ids or user names)
//   --users-root <dir>   folder holding user profiles (default: the folder above your home, such as
//                        C:\Users, /Users or /home; tests use a fixture)
//   --cache <file>       scan cache (default <home>/.claude/cache/session-manager-scan.json)
// Runs on Windows, macOS and Linux. Removed files go to the Recycle Bin or Trash.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import readline from 'node:readline'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const LIVE_MS = 15 * 60 * 1000 // a transcript written in the last 15 minutes counts as live
const CACHE_VERSION = 3
// 1x1 transparent PNG: keeps every image block valid after its upload is removed.
const TINY_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
const BIG = 1024 // base64 strings shorter than this are left alone
// Never removed or rewritten, whatever is asked: a target whose path holds any of these
// folder names is refused, and only the four session shapes in sessionShape() are allowed.
const PROTECTED = new Set(['skills', 'plugins', 'dev-mods', 'memory', 'agents', 'commands', 'hooks', 'output-styles', 'rules', 'cache', 'backups', 'sessions', 'session-data', 'state', 'downloads'])

const args = process.argv.slice(2)
const cmd = args[0]
const opt = name => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? args[i + 1] : undefined
}
const flag = name => args.includes(`--${name}`)
const exclude = new Set((opt('exclude') ?? '').split(',').filter(Boolean))
const usersRoot = opt('users-root') ?? path.dirname(os.homedir())
const selfProfile = opt('users-root') ? undefined : os.homedir()

const PLATFORM = process.platform
// Windows and macOS compare paths without case; Linux paths are case-sensitive.
const fold = p => (PLATFORM === 'win32' || PLATFORM === 'darwin' ? p.toLowerCase() : p)
const TRASH_NAME = PLATFORM === 'win32' ? 'Recycle Bin' : 'Trash'

const out = value => process.stdout.write(JSON.stringify(value))
// One line per step on stderr, read by the mod for its progress bar: @@progress {"done":3,"total":9,"bytes":1234}
const progress = (done, total, bytes) => process.stderr.write(`@@progress ${JSON.stringify({ done, total, bytes })}\n`)
const fail = message => {
  out({ ok: false, error: message })
  process.exit(1)
}

// ---------- discovery ----------

async function dirs(p) {
  try {
    return (await fsp.readdir(p, { withFileTypes: true })).filter(d => d.isDirectory()).map(d => d.name)
  } catch {
    return []
  }
}
async function files(p) {
  try {
    return (await fsp.readdir(p, { withFileTypes: true })).filter(d => d.isFile()).map(d => d.name)
  } catch {
    return []
  }
}
async function exists(p) {
  try {
    await fsp.access(p)
    return true
  } catch {
    return false
  }
}
async function sizeOf(p) {
  let st
  try {
    st = await fsp.lstat(p)
  } catch {
    return 0
  }
  if (st.isFile()) return st.size
  if (!st.isDirectory()) return 0
  let total = 0
  for (const d of await fsp.readdir(p, { withFileTypes: true }).catch(() => [])) {
    total += await sizeOf(path.join(p, d.name))
  }
  return total
}

// Every user profile whose .claude folder this process can read.
async function profiles() {
  const found = []
  for (const name of await dirs(usersRoot)) {
    const home = path.join(usersRoot, name)
    const claude = path.join(home, '.claude')
    if (await exists(path.join(claude, 'projects'))) found.push({ user: name, home, claude })
  }
  return found
}

// Sessions a running Claude Code process holds: .claude\sessions\<pid>.json names them.
// Only `pid` and `sessionId` are read; a file whose process has ended is ignored.
async function runningSessions(claude) {
  const ids = new Set()
  const dir = path.join(claude, 'sessions')
  for (const name of await files(dir)) {
    if (!/^\d+\.json$/.test(name)) continue
    try {
      const { pid, sessionId } = JSON.parse(await fsp.readFile(path.join(dir, name), 'utf8'))
      if (!UUID.test(sessionId ?? '') || !Number.isInteger(pid)) continue
      try {
        process.kill(pid, 0)
        ids.add(sessionId)
      } catch (err) {
        if (err?.code === 'EPERM') ids.add(sessionId) // alive, owned by someone else
      }
    } catch {}
  }
  return ids
}

// Only these three fields of ~/.claude.json are read: the signed-in account's id and label.
async function signedInAccount(home) {
  try {
    const o = JSON.parse(await fsp.readFile(path.join(home, '.claude.json'), 'utf8'))
    const a = o?.oauthAccount
    if (!a?.accountUuid) return undefined
    return { accountUuid: a.accountUuid, email: a.emailAddress, org: a.organizationName }
  } catch {
    return undefined
  }
}

// The desktop app's data folders under a home, each of which may hold claude-code-sessions:
//   Windows  AppData\Local\Claude-Data\<install>   (older builds: AppData\Roaming\Claude)
//   macOS    Library/Application Support/Claude
//   Linux    .config/Claude   (no official app; community builds use this)
async function appRoots(home) {
  const roots = []
  const installs = async base => (await dirs(base)).map(d => path.join(base, d))
  if (PLATFORM === 'win32') {
    roots.push(...(await installs(path.join(home, 'AppData', 'Local', 'Claude-Data'))), path.join(home, 'AppData', 'Roaming', 'Claude'))
  } else if (PLATFORM === 'darwin') {
    const support = path.join(home, 'Library', 'Application Support')
    roots.push(path.join(support, 'Claude'), ...(await installs(path.join(support, 'Claude-Data'))))
  } else {
    roots.push(path.join(home, '.config', 'Claude'))
  }
  const found = []
  for (const r of roots) if (await exists(path.join(r, 'claude-code-sessions'))) found.push(r)
  return found
}

// The desktop app's per-account session index: <app root>/claude-code-sessions/<account>/<org>.
// Read only. local_<id>.json names the transcript (cliSessionId); deleted_<id> marks one the app deleted.
async function desktopIndex(home) {
  const index = new Map()
  const accounts = new Map()
  for (const appRoot of await appRoots(home)) {
    const root = path.join(appRoot, 'claude-code-sessions')
    for (const account of await dirs(root)) {
      if (!UUID.test(account)) continue
      for (const org of await dirs(path.join(root, account))) {
        if (!UUID.test(org)) continue
        const folder = path.join(root, account, org)
        const acc = accounts.get(account) ?? { accountUuid: account, orgs: new Set(), indexed: 0, deletedMarkers: 0, lastWriteMs: 0, folder }
        acc.orgs.add(org)
        accounts.set(account, acc)
        // The app writes into the folder of the account it is signed in to, so the newest write marks it.
        for (const name of await fsp.readdir(folder).catch(() => [])) {
          // The archive list and temp files are written by a move too; only the app's own writes count.
          if (name === 'archived-sessions.idx' || name.endsWith('.sm-tmp')) continue
          const st = await fsp.stat(path.join(folder, name)).catch(() => undefined)
          if (st && st.mtimeMs > acc.lastWriteMs) {
            acc.lastWriteMs = st.mtimeMs
            acc.folder = folder
          }
        }
        for (const name of await files(folder)) {
          if (name.startsWith('deleted_')) {
            const id = name.slice(8)
            acc.deletedMarkers++
            if (UUID.test(id) && !index.has(id)) index.set(id, { account, org, state: 'deleted-in-app' })
          } else if (name.startsWith('local_') && name.endsWith('.json')) {
            try {
              const o = JSON.parse(await fsp.readFile(path.join(folder, name), 'utf8'))
              const id = o.cliSessionId
              if (!UUID.test(id ?? '')) continue
              acc.indexed++
              index.set(id, {
                account,
                org,
                state: o.isArchived ? 'archived' : 'in-app',
                appTitle: typeof o.title === 'string' ? o.title : undefined,
                localFile: path.join(folder, name),
                appId: name.slice(6, -5), // local_<appId>.json
              })
            } catch {}
          }
        }
      }
    }
  }
  return { index, accounts }
}

// ---------- one transcript ----------

function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(b => b?.type === 'text').map(b => b.text).join(' ')
}

// Counts the uploads a row holds: image/document blocks and Read-tool image results.
function countUploads(node, acc, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 40) return
  if (Array.isArray(node)) {
    for (const n of node) countUploads(n, acc, depth + 1)
    return
  }
  const src = node.source
  if ((node.type === 'image' || node.type === 'document') && src?.type === 'base64' && typeof src.data === 'string' && src.data.length >= BIG) {
    acc.count++
    acc.bytes += src.data.length
    return
  }
  if (typeof node.base64 === 'string' && node.base64.length >= BIG) {
    acc.count++
    acc.bytes += node.base64.length
  }
  for (const k in node) {
    const v = node[k]
    if (v && typeof v === 'object') countUploads(v, acc, depth + 1)
  }
}

async function readTranscript(file, ownId) {
  const r = {
    rows: 0,
    badRows: 0,
    cwd: undefined,
    title: undefined,
    firstPrompt: undefined,
    first: undefined,
    last: undefined,
    uploads: { count: 0, bytes: 0 },
    msgs: [], // [messageId, sessionId, input, output, cacheWrite, cacheRead, model]
  }
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  for await (const line of rl) {
    if (!line) continue
    r.rows++
    let o
    try {
      o = JSON.parse(line)
    } catch {
      r.badRows++
      continue
    }
    if (o.timestamp) {
      if (!r.first) r.first = o.timestamp
      r.last = o.timestamp
    }
    if (!r.cwd && typeof o.cwd === 'string') r.cwd = o.cwd
    if (o.sessionId === ownId || ownId === undefined) {
      if (o.type === 'custom-title' && o.customTitle) r.title = o.customTitle
      else if (o.type === 'ai-title' && o.aiTitle && !r.title) r.title = o.aiTitle
      else if (o.type === 'summary' && o.summary && !r.title) r.title = o.summary
    }
    if (o.type === 'user' && !r.firstPrompt && !o.isMeta && o.message?.role === 'user') {
      const t = textOf(o.message.content).trim()
      if (t && !t.startsWith('<')) r.firstPrompt = t.slice(0, 120)
    }
    if (o.type === 'assistant' && o.message?.usage) {
      const u = o.message.usage
      r.msgs.push([
        o.message.id ?? o.requestId ?? o.uuid,
        o.sessionId ?? ownId,
        u.input_tokens | 0,
        u.output_tokens | 0,
        u.cache_creation_input_tokens | 0,
        u.cache_read_input_tokens | 0,
        o.message.model ?? '',
      ])
    }
    countUploads(o.message?.content, r.uploads)
    countUploads(o.toolUseResult, r.uploads)
  }
  return r
}

// ---------- scan ----------

async function loadCache(file) {
  try {
    const c = JSON.parse(await fsp.readFile(file, 'utf8'))
    return c.version === CACHE_VERSION ? c.files : {}
  } catch {
    return {}
  }
}

async function scan() {
  const started = Date.now()
  const profs = await profiles()
  if (profs.length === 0) fail(`no readable .claude folder under ${usersRoot}`)
  const cacheFile = opt('cache') ?? path.join(selfProfile ?? profs[0].home, '.claude', 'cache', 'session-manager-scan.json')
  const cache = await loadCache(cacheFile)
  const nextCache = {}
  const sessions = []
  const accounts = []
  let parsed = 0

  for (const prof of profs) {
    const { index, accounts: accs } = await desktopIndex(prof.home)
    const me = await signedInAccount(prof.home)
    const running = await runningSessions(prof.claude)
    const newest = Math.max(0, ...[...accs.values()].map(a => a.lastWriteMs))
    for (const a of accs.values()) {
      const isMe = me?.accountUuid === a.accountUuid
      accounts.push({
        user: prof.user,
        accountUuid: a.accountUuid,
        label: isMe ? (me.email ?? 'terminal login') : `account ${a.accountUuid.slice(0, 8)}`,
        isSignedIn: isMe, // the terminal (CLI) login
        isAppActive: newest > 0 && a.lastWriteMs === newest, // the account the desktop app uses now
        orgs: a.orgs.size,
        indexed: a.indexed,
        deletedMarkers: a.deletedMarkers,
      })
    }
    if (me && !accs.has(me.accountUuid)) {
      accounts.push({ user: prof.user, accountUuid: me.accountUuid, label: me.email ?? 'terminal login', isSignedIn: true, isAppActive: false, orgs: 0, indexed: 0, deletedMarkers: 0 })
    }
    const projectsDir = path.join(prof.claude, 'projects')
    for (const project of await dirs(projectsDir)) {
      const pdir = path.join(projectsDir, project)
      for (const name of await files(pdir)) {
        if (!name.endsWith('.jsonl')) continue
        const id = name.slice(0, -6)
        if (!UUID.test(id)) continue
        const file = path.join(pdir, name)
        let st
        try {
          st = await fsp.stat(file)
        } catch {
          continue
        }
        const side = path.join(pdir, id)
        const subFiles = (await files(path.join(side, 'subagents'))).filter(n => n.endsWith('.jsonl'))
        const key = `${file}|${st.size}|${st.mtimeMs}|${subFiles.length}`
        let info = cache[key]
        if (!info) {
          info = await readTranscript(file, id)
          for (const sub of subFiles) {
            const s = await readTranscript(path.join(side, 'subagents', sub), undefined)
            for (const m of s.msgs) info.msgs.push([m[0], m[1] ?? id, ...m.slice(2)])
            info.uploads.count += s.uploads.count
            info.uploads.bytes += s.uploads.bytes
          }
          parsed++
        }
        nextCache[key] = info
        const linked = index.get(id)
        const sideBytes = await sizeOf(side)
        const fileHistory = await sizeOf(path.join(prof.claude, 'file-history', id))
        const sessionEnv = await sizeOf(path.join(prof.claude, 'session-env', id))
        const isLive = exclude.has(id) || running.has(id) || Date.now() - st.mtimeMs < LIVE_MS
        const state = linked?.state ?? 'cli-only'
        // A transcript with no real model reply is a leftover log (a summary or side run), not a conversation.
        const replies = info.msgs.reduce((n, m) => n + (m[6] === '<synthetic>' ? 0 : 1), 0)
        sessions.push({
          kind: replies === 0 && !linked ? 'log' : 'chat',
          replies,
          id,
          user: prof.user,
          project,
          cwd: info.cwd,
          title: linked?.appTitle ?? info.title ?? info.firstPrompt ?? '(untitled)',
          account: linked?.account,
          state,
          isLive,
          isCurrent: exclude.has(id),
          // Sessions the app still lists are deleted there first, so its sidebar never points at nothing.
          canDelete: !isLive && state !== 'in-app',
          canStrip: !isLive && info.uploads.count > 0,
          // Has a sidebar entry in the app that can move to another account.
          canMove: !isLive && (state === 'in-app' || state === 'archived'),
          // Deleted in the app with the conversation still here: its sidebar entry can be rebuilt.
          canRestore: !isLive && state === 'deleted-in-app' && Boolean(info.cwd),
          first: info.first,
          last: info.last ?? new Date(st.mtimeMs).toISOString(),
          mtimeMs: st.mtimeMs,
          bytes: { transcript: st.size, side: sideBytes, fileHistory, sessionEnv, total: st.size + sideBytes + fileHistory + sessionEnv },
          uploads: { count: info.uploads.count, bytes: info.uploads.bytes },
          rows: info.rows,
          _msgs: info.msgs,
        })
      }
    }
  }

  // Tokens: each API message once (forks and resumes copy their parent's rows), credited to
  // the session that made it when that transcript is still on disk, else to the file holding it.
  const byId = new Map(sessions.map(s => [s.id, s]))
  const seen = new Set()
  const zero = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 })
  const total = zero()
  const models = {}
  for (const s of sessions) s.tokens = zero()
  const add = (t, i, o, cw, cr) => {
    t.input += i
    t.output += o
    t.cacheWrite += cw
    t.cacheRead += cr
    t.messages++
  }
  for (const pass of [0, 1]) {
    for (const s of sessions) {
      for (const [mid, sid, i, o, cw, cr, model] of s._msgs) {
        if ((sid === s.id ? 0 : 1) !== pass) continue // own rows first
        if (!mid || seen.has(mid) || model === '<synthetic>') continue
        seen.add(mid)
        add((byId.get(sid) ?? s).tokens, i, o, cw, cr)
        add(total, i, o, cw, cr)
        add((models[model] ??= zero()), i, o, cw, cr)
      }
    }
  }
  for (const s of sessions) delete s._msgs

  try {
    await fsp.mkdir(path.dirname(cacheFile), { recursive: true })
    await fsp.writeFile(cacheFile, JSON.stringify({ version: CACHE_VERSION, files: nextCache }))
  } catch {}

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs)
  out({ ok: true, platform: PLATFORM, trash: TRASH_NAME, scannedAt: new Date().toISOString(), tookMs: Date.now() - started, parsed, users: profs.map(p => p.user), accounts, total, models, sessions })
}

// ---------- targets and removal ----------

// The only shapes a removal may take, relative to <profile>\.claude:
//   projects\<project>\<id>.jsonl   projects\<project>\<id>\   file-history\<id>\   session-env\<id>\
function sessionShape(rel, id) {
  const parts = rel.split(/[\\/]/).filter(Boolean)
  if (parts.some(p => PROTECTED.has(p.toLowerCase()))) return false
  const [top, a, b] = parts
  if (top === 'projects') return parts.length === 3 && !a.startsWith('.') && (b === `${id}.jsonl` || b === id)
  if (top === 'file-history' || top === 'session-env') return parts.length === 2 && a === id
  return false
}

// Read once per run: a delete of hundreds of sessions looks these up for each one.
const memo = new Map()
const once = (key, make) => {
  if (!memo.has(key)) memo.set(key, make())
  return memo.get(key)
}

// Finds a session's files, each checked to be a UUID-named entry inside a known .claude folder.
async function targetsOf(id) {
  if (!UUID.test(id)) return undefined
  for (const prof of await once('profiles', profiles)) {
    const projectsDir = path.join(prof.claude, 'projects')
    for (const project of await once(`projects:${projectsDir}`, () => dirs(projectsDir))) {
      const file = path.join(projectsDir, project, `${id}.jsonl`)
      if (!(await exists(file))) continue
      const st = await fsp.stat(file)
      const list = [file]
      for (const p of [path.join(projectsDir, project, id), path.join(prof.claude, 'file-history', id), path.join(prof.claude, 'session-env', id)]) {
        if (await exists(p)) list.push(p)
      }
      const rootReal = fold(await fsp.realpath(prof.claude))
      for (const p of list) {
        const real = await fsp.realpath(p)
        if (!fold(real).startsWith(rootReal + path.sep)) return undefined
        if (!sessionShape(real.slice(rootReal.length + 1), id)) return undefined
        if ((await fsp.lstat(p)).isSymbolicLink()) return undefined
      }
      const { index } = await once(`index:${prof.home}`, () => desktopIndex(prof.home))
      const isRunning = (await once(`running:${prof.claude}`, () => runningSessions(prof.claude))).has(id)
      return { id, file, side: path.join(projectsDir, project, id), list, st, isRunning, state: index.get(id)?.state ?? 'cli-only' }
    }
  }
  return { id, isMissing: true }
}

function refusal(t) {
  if (!t) return 'outside the session folders (skills, plugins, memory and settings are protected)'
  if (t.isMissing) return 'already gone'
  if (exclude.has(t.id)) return 'this is the session you are using now'
  if (t.isRunning) return 'open in a running Claude process'
  if (Date.now() - t.st.mtimeMs < LIVE_MS) return 'written in the last 15 minutes (may be open)'
  return undefined
}

// Moves paths to the Recycle Bin (Windows) or the Trash (macOS, Linux); answers the paths it could not move.
function recycle(paths) {
  if (paths.length === 0) return []
  if (PLATFORM === 'win32') return recycleWindows(paths)
  if (PLATFORM === 'darwin') return trashMac(paths)
  return trashFreedesktop(paths)
}

// One PowerShell call for all paths.
function recycleWindows(paths) {
  const script = [
    'Add-Type -AssemblyName Microsoft.VisualBasic',
    '$failed = @()',
    'foreach ($p in $input) {',
    '  if (-not $p) { continue }',
    '  try {',
    "    if (Test-Path -LiteralPath $p -PathType Container) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteDirectory($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
    "    elseif (Test-Path -LiteralPath $p) { [Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p, 'OnlyErrorDialogs', 'SendToRecycleBin') }",
    '  } catch { $failed += $p }',
    '}',
    '$failed -join "`n"',
  ].join('\n')
  // PowerShell 7 when installed, else the Windows PowerShell every Windows PC has.
  for (const shell of ['pwsh', 'powershell']) {
    const r = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], { input: paths.join('\n'), encoding: 'utf8', windowsHide: true })
    if (r.error?.code === 'ENOENT') continue
    if (r.error || r.status !== 0) return paths
    return r.stdout.split(/\r?\n/).filter(Boolean)
  }
  return paths
}

// A name not yet taken in a trash folder: "name", then "name 2", "name 3", ...
function freeName(dir, base, taken = name => fs.existsSync(path.join(dir, name))) {
  const ext = path.extname(base)
  const stem = ext && ext !== base ? base.slice(0, -ext.length) : base
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${stem} ${n}${ext}`
    if (!taken(name)) return name
  }
}

// macOS: the system `trash` command, where the system has one, keeps Finder's "Put Back".
// Whatever it did not move (no such command, or it refused) gets a plain move into ~/.Trash.
function trashMac(paths) {
  spawnSync('/usr/bin/trash', paths, { encoding: 'utf8' })
  const dir = path.join(os.homedir(), '.Trash')
  const failed = []
  for (const p of paths.filter(x => fs.existsSync(x))) {
    try {
      fs.mkdirSync(dir, { recursive: true })
      fs.renameSync(p, path.join(dir, freeName(dir, path.basename(p))))
    } catch (err) {
      if (err?.code !== 'ENOENT') failed.push(p)
    }
  }
  return failed
}

// Linux: the freedesktop.org Trash in $XDG_DATA_HOME/Trash (~/.local/share/Trash), which file
// managers list and restore from: the item goes to files/, a .trashinfo note to info/.
function trashFreedesktop(paths) {
  const dataHome = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  const filesDir = path.join(dataHome, 'Trash', 'files')
  const infoDir = path.join(dataHome, 'Trash', 'info')
  const failed = []
  const pad = n => String(n).padStart(2, '0')
  for (const p of paths) {
    if (!fs.existsSync(p)) continue
    let info
    try {
      fs.mkdirSync(filesDir, { recursive: true, mode: 0o700 })
      fs.mkdirSync(infoDir, { recursive: true, mode: 0o700 })
      const name = freeName(filesDir, path.basename(p), n => fs.existsSync(path.join(filesDir, n)) || fs.existsSync(path.join(infoDir, `${n}.trashinfo`)))
      const d = new Date()
      const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
      const encoded = path.resolve(p).split('/').map(encodeURIComponent).join('/')
      info = path.join(infoDir, `${name}.trashinfo`)
      fs.writeFileSync(info, `[Trash Info]\nPath=${encoded}\nDeletionDate=${when}\n`, { flag: 'wx' })
      fs.renameSync(p, path.join(filesDir, name))
    } catch {
      if (info) fs.rmSync(info, { force: true })
      failed.push(p) // another disk (EXDEV) or no permission: the file stays where it was
    }
  }
  return failed
}

async function removeAll(paths) {
  if (flag('permanent')) {
    const failed = []
    for (const p of paths) await fsp.rm(p, { recursive: true, force: true }).catch(() => failed.push(p))
    return failed
  }
  return recycle(paths)
}

// Rewrites one transcript without its uploads into <file>.sm-tmp; answers how many it removed.
async function stripFile(file) {
  const tmp = `${file}.sm-tmp`
  const w = fs.createWriteStream(tmp)
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity })
  let removed = 0
  const strip = (node, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 40) return node
    if (Array.isArray(node)) return node.map(n => strip(n, depth + 1))
    const src = node.source
    if (node.type === 'image' && src?.type === 'base64' && typeof src.data === 'string' && src.data.length >= BIG) {
      removed++
      return { ...node, source: { ...src, media_type: 'image/png', data: TINY_PNG } }
    }
    if (node.type === 'document' && src?.type === 'base64' && typeof src.data === 'string' && src.data.length >= BIG) {
      removed++
      return { type: 'text', text: '[uploaded document removed by Session Manager]' }
    }
    const copy = {}
    for (const k in node) {
      const v = node[k]
      if (k === 'base64' && typeof v === 'string' && v.length >= BIG) {
        removed++
        copy[k] = TINY_PNG
      } else copy[k] = v && typeof v === 'object' ? strip(v, depth + 1) : v
    }
    // A Read-tool image result names its media type beside the bytes.
    if (copy.base64 === TINY_PNG && typeof copy.type === 'string' && copy.type.startsWith('image/')) copy.type = 'image/png'
    return copy
  }
  for await (const line of rl) {
    let text = line
    if (line.length >= BIG) {
      try {
        const had = removed
        const next = strip(JSON.parse(line))
        if (removed > had) text = JSON.stringify(next) // untouched rows are written back byte for byte
      } catch {}
    }
    if (!w.write(text + '\n')) await new Promise(res => w.once('drain', res))
  }
  await new Promise((res, rej) => w.end(err => (err ? rej(err) : res())))
  return { tmp, removed }
}

async function strip(ids) {
  const results = []
  let freedAll = 0
  progress(0, ids.length, 0)
  for (const id of ids) {
    if (results.length) progress(results.length, ids.length, freedAll)
    const t = await targetsOf(id)
    const why = refusal(t)
    if (why) {
      results.push({ id, ok: false, reason: why })
      continue
    }
    const subDir = path.join(t.side, 'subagents')
    const jsonls = [t.file, ...(await files(subDir)).filter(n => n.endsWith('.jsonl')).map(n => path.join(subDir, n))]
    let freed = 0
    let blocks = 0
    let error
    const setAside = []
    for (const f of jsonls) {
      const orig = await fsp.stat(f)
      const { tmp, removed } = await stripFile(f)
      if (removed === 0) {
        await fsp.rm(tmp, { force: true })
        continue
      }
      const after = (await fsp.stat(tmp)).size
      // Swap by renames, so the transcript is never missing: original aside, stripped copy in.
      const aside = `${f}.sm-orig`
      try {
        await fsp.rename(f, aside)
      } catch {
        await fsp.rm(tmp, { force: true })
        error = `could not replace ${path.basename(f)} (in use?)`
        break
      }
      try {
        await fsp.rename(tmp, f)
      } catch {
        await fsp.rename(aside, f).catch(() => undefined)
        await fsp.rm(tmp, { force: true })
        error = `could not replace ${path.basename(f)}`
        break
      }
      // Keep the session's last-used time: clearing uploads is not using it.
      await fsp.utimes(f, orig.atime, orig.mtime).catch(() => undefined)
      setAside.push(aside)
      freed += orig.size - after
      blocks += removed
    }
    // The originals go to the Recycle Bin or Trash together (or are deleted with --permanent).
    const left = await removeAll(setAside)
    if (left.length && !error) error = `stripped, but ${left.length} original(s) stay beside it as .sm-orig`
    results.push(error ? { id, ok: false, reason: error, freed, blocks } : { id, ok: true, freed, blocks })
    freedAll += freed
  }
  progress(results.length, ids.length, freedAll)
  out({ ok: true, recycled: !flag('permanent'), trash: TRASH_NAME, results })
}

const CHUNK = 20 // sessions per trash call (one PowerShell start per chunk on Windows), a progress step after each

async function del(ids) {
  const results = []
  const ready = []
  for (const id of ids) {
    const t = await targetsOf(id)
    if (t?.isMissing) {
      results.push({ id, ok: true, bytes: 0, alreadyGone: true }) // removed by an earlier run
      continue
    }
    let why = refusal(t)
    if (!why && t.state === 'in-app') why = 'still listed in the Claude app: delete or archive it there first'
    if (why) results.push({ id, ok: false, reason: why })
    else ready.push(t)
  }
  let done = results.length
  let freed = 0
  progress(done, ids.length, freed)
  for (let i = 0; i < ready.length; i += CHUNK) {
    const chunk = ready.slice(i, i + CHUNK)
    const sizes = new Map()
    for (const t of chunk) {
      let bytes = 0
      for (const p of t.list) bytes += await sizeOf(p)
      sizes.set(t.id, bytes)
    }
    const failed = new Set(await removeAll(chunk.flatMap(t => t.list)))
    for (const t of chunk) {
      const bytes = sizes.get(t.id) ?? 0
      const lost = t.list.filter(p => failed.has(p)).length
      if (lost) results.push({ id: t.id, ok: false, reason: `could not remove ${lost} item(s)`, bytes })
      else {
        results.push({ id: t.id, ok: true, bytes, items: t.list.length })
        freed += bytes
      }
    }
    done += chunk.length
    progress(done, ids.length, freed)
  }
  out({ ok: true, recycled: !flag('permanent'), trash: TRASH_NAME, results })
}

// ---------- move a chat's sidebar entry to another account ----------

const ARCHIVE_IDX = 'archived-sessions.idx'
const LOCAL_NAME = /^local_[0-9a-f-]{36}\.json$/i

// An app index path must be <app root>/claude-code-sessions/<account>/<org>[/local_<id>.json],
// the app root one of appRoots(home).
function appShape(roots, p, withFile) {
  const base = roots.find(r => fold(p).startsWith(fold(r) + path.sep))
  if (!base) return false
  const parts = p.slice(base.length + 1).split(/[\\/]/)
  const [top, account, org, file] = parts
  return (
    parts.length === (withFile ? 4 : 3) &&
    top === 'claude-code-sessions' &&
    UUID.test(account ?? '') &&
    UUID.test(org ?? '') &&
    (!withFile || LOCAL_NAME.test(file ?? ''))
  )
}

// The app's list of archived entries in a folder: {"v":1,"archived":["local_<id>", ...]}. Missing reads as empty.
async function readArchive(folder) {
  const file = path.join(folder, ARCHIVE_IDX)
  if (!(await exists(file))) return { file, data: { v: 1, archived: [] } }
  const data = JSON.parse(await fsp.readFile(file, 'utf8')) // a file we cannot read stops the move
  if (!Array.isArray(data?.archived)) throw new Error(`${ARCHIVE_IDX} has an unknown shape`)
  return { file, data }
}
async function writeArchive({ file, data }) {
  const tmp = `${file}.sm-tmp`
  await fsp.writeFile(tmp, JSON.stringify(data))
  await fsp.rename(tmp, file)
}

async function move(ids) {
  const prof = (await once('profiles', profiles)).find(p => !selfProfile || p.home === selfProfile) ?? (await profiles())[0]
  if (!prof) fail('no profile')
  const { index, accounts } = await desktopIndex(prof.home)
  const roots = await appRoots(prof.home)
  const newest = [...accounts.values()].sort((a, b) => b.lastWriteMs - a.lastWriteMs)[0]
  const target = accounts.get(opt('to') ?? '') ?? newest
  if (!target || !appShape(roots, target.folder, false)) fail('no Claude app account folder to move into')
  const results = []
  progress(0, ids.length, 0)
  for (const id of ids) {
    if (results.length) progress(results.length, ids.length, 0)
    const e = index.get(id)
    const t = await targetsOf(id)
    let why = !e?.localFile ? 'has no entry in the app sidebar' : e.account === target.accountUuid ? 'already in this account' : refusal(t)
    const dest = e?.localFile ? path.join(target.folder, path.basename(e.localFile)) : ''
    if (!why && (!appShape(roots, e.localFile, true) || !appShape(roots, dest, true))) why = 'unexpected app folder layout'
    if (!why && (await exists(dest))) why = 'an entry with this id is already in the target account'
    if (why) {
      results.push({ id, ok: false, reason: why })
      continue
    }
    const srcFolder = path.dirname(e.localFile)
    const entry = `local_${e.appId}`
    let src, dst
    try {
      src = await readArchive(srcFolder)
      dst = await readArchive(target.folder)
    } catch (err) {
      results.push({ id, ok: false, reason: `cannot read the archive list: ${err.message}` })
      continue
    }
    const srcBefore = JSON.parse(JSON.stringify(src.data))
    try {
      const orig = await fsp.stat(e.localFile)
      // A moved chat lands in the Active list, not Archived, so it shows in the sidebar.
      const text = await fsp.readFile(e.localFile, 'utf8')
      const o = JSON.parse(text)
      if (!o || typeof o !== 'object' || Array.isArray(o)) throw new Error('the app entry has an unknown shape')
      const body = o.isArchived === true ? JSON.stringify({ ...o, isArchived: false }) : text
      await fsp.writeFile(dest, body, { flag: 'wx' })
      await fsp.utimes(dest, orig.atime, orig.mtime) // a moved entry keeps its own time
      if (src.data.archived.includes(entry)) {
        src.data.archived = src.data.archived.filter(x => x !== entry)
        await writeArchive(src)
      }
      if (dst.data.archived.includes(entry)) {
        dst.data.archived = dst.data.archived.filter(x => x !== entry)
        await writeArchive(dst)
      }
      const failed = await removeAll([e.localFile])
      if (failed.length) throw new Error('could not remove the old entry')
      results.push({ id, ok: true, to: target.accountUuid })
    } catch (err) {
      // Put everything back: the new copy goes, the old archive list returns.
      await fsp.rm(dest, { force: true }).catch(() => undefined)
      await writeArchive({ file: src.file, data: srcBefore }).catch(() => undefined)
      results.push({ id, ok: false, reason: String(err?.message ?? err) })
    }
  }
  progress(results.length, ids.length, 0)
  out({ ok: true, to: target.accountUuid, recycled: !flag('permanent'), trash: TRASH_NAME, results })
}

// ---------- restore: give a chat the app deleted a sidebar entry again ----------

// Settings taken from the target account's newest entry, so a restored chat opens like the
// others there. Nothing tied to another conversation (titles, forks, summaries, git trust).
const RESTORE_COPY = [
  'model',
  'effort',
  'permissionMode',
  'remoteMcpServersConfig',
  'chromePermissionMode',
  'classifierSummaryEnabled',
  'reportFindingsCard',
  'autoModeServerFallbackPrompt',
  'remoteControlAutoEligible',
]

async function newestEntry(folder) {
  let best
  let bestMs = 0
  for (const name of await files(folder)) {
    if (!LOCAL_NAME.test(name)) continue
    const st = await fsp.stat(path.join(folder, name)).catch(() => undefined)
    if (st && st.mtimeMs > bestMs) {
      bestMs = st.mtimeMs
      best = path.join(folder, name)
    }
  }
  if (!best) return {}
  try {
    const o = JSON.parse(await fsp.readFile(best, 'utf8'))
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {}
  } catch {
    return {}
  }
}

async function restore(ids) {
  const prof = (await once('profiles', profiles)).find(p => !selfProfile || p.home === selfProfile) ?? (await profiles())[0]
  if (!prof) fail('no profile')
  const { index, accounts } = await desktopIndex(prof.home)
  const roots = await appRoots(prof.home)
  const newest = [...accounts.values()].sort((a, b) => b.lastWriteMs - a.lastWriteMs)[0]
  const target = accounts.get(opt('to') ?? '') ?? newest
  if (!target || !appShape(roots, target.folder, false)) fail('no Claude app account folder to restore into')
  const template = await newestEntry(target.folder)
  const sessionsRoot = path.dirname(path.dirname(target.folder)) // ...\claude-code-sessions
  const results = []
  progress(0, ids.length, 0)
  for (const id of ids) {
    if (results.length) progress(results.length, ids.length, 0)
    const e = index.get(id)
    const t = await targetsOf(id)
    let why = e?.state !== 'deleted-in-app' ? (e?.localFile ? 'already in the app sidebar' : 'the app never listed it') : refusal(t)
    const dest = path.join(target.folder, `local_${id}.json`)
    if (!why && !appShape(roots, dest, true)) why = 'unexpected app folder layout'
    if (!why && (await exists(dest))) why = 'an entry with this id is already there'
    let info
    if (!why) {
      info = await readTranscript(t.file, id)
      if (!info.cwd) why = 'the transcript records no working folder'
    }
    if (why) {
      results.push({ id, ok: false, reason: why })
      continue
    }
    const firstMs = Date.parse(info.first ?? '') || t.st.mtimeMs
    const lastMs = Date.parse(info.last ?? '') || t.st.mtimeMs
    const model = [...info.msgs].reverse().find(m => /^claude-/.test(m[6]))?.[6]
    const kept = Object.fromEntries(RESTORE_COPY.filter(k => k in template).map(k => [k, template[k]]))
    const entry = {
      ...kept,
      sessionId: `local_${id}`,
      cliSessionId: id,
      cwd: info.cwd,
      originCwd: info.cwd,
      gitAnchors: [],
      gitAnchorsLookupOnly: true,
      lastFocusedAt: lastMs,
      createdAt: firstMs,
      lastActivityAt: lastMs,
      indexedAt: Date.now(),
      ...(model ? { model } : {}),
      isArchived: false,
      title: (info.title ?? info.firstPrompt ?? 'Restored chat').slice(0, 200),
      titleSource: 'auto',
      interruptedAwaitingPerson: null,
      lastSpawnRootDetected: false,
      autoChosenInApp: true,
      startedFromEnvironmentId: null,
      steeredByRemoteClient: null,
      alwaysAllowedReasons: [],
      sessionPermissionUpdates: [],
      turnBoxDeclared: true,
      turnBoxMounted: true,
      spawnSeed: {},
    }
    // The app's "deleted" markers for this chat, in every account folder of this install.
    const markers = []
    for (const account of await dirs(sessionsRoot)) {
      if (!UUID.test(account)) continue
      for (const org of await dirs(path.join(sessionsRoot, account))) {
        const m = path.join(sessionsRoot, account, org, `deleted_${id}`)
        if (UUID.test(org) && (await exists(m))) markers.push(m)
      }
    }
    try {
      await fsp.writeFile(dest, JSON.stringify(entry), { flag: 'wx' })
      const failed = await removeAll(markers)
      if (failed.length) throw new Error('could not remove the app’s deleted marker')
      results.push({ id, ok: true, to: target.accountUuid, title: entry.title })
    } catch (err) {
      await fsp.rm(dest, { force: true }).catch(() => undefined)
      results.push({ id, ok: false, reason: String(err?.message ?? err) })
    }
  }
  progress(results.length, ids.length, 0)
  out({ ok: true, to: target.accountUuid, recycled: !flag('permanent'), trash: TRASH_NAME, results })
}

// ---------- peek: what is inside one session ----------

async function peek(id) {
  const t = await targetsOf(id)
  if (!t || t.isMissing) fail('session not found')
  const prompts = []
  const replies = []
  const tools = {}
  const files = new Map()
  let uploads = 0
  let first, last, branch, model
  const rl = readline.createInterface({ input: fs.createReadStream(t.file), crlfDelay: Infinity })
  for await (const line of rl) {
    let o
    try {
      o = JSON.parse(line)
    } catch {
      continue
    }
    if (o.timestamp) {
      first ??= o.timestamp
      last = o.timestamp
    }
    if (o.gitBranch) branch = o.gitBranch
    const content = o.message?.content
    if (o.type === 'user' && !o.isMeta && o.message?.role === 'user') {
      const text = textOf(content).trim()
      if (text && !text.startsWith('<')) prompts.push(text.slice(0, 400))
    }
    if (o.type === 'assistant' && Array.isArray(content)) {
      if (o.message.model && o.message.model !== '<synthetic>') model = o.message.model
      for (const b of content) {
        if (b?.type === 'text' && b.text?.trim()) replies.push(b.text.trim().slice(0, 600))
        if (b?.type === 'tool_use') {
          tools[b.name] = (tools[b.name] ?? 0) + 1
          const fp = b.input?.file_path ?? b.input?.notebook_path
          if (typeof fp === 'string') files.set(fp, (files.get(fp) ?? 0) + 1)
        }
      }
    }
    const acc = { count: 0, bytes: 0 }
    countUploads(content, acc)
    uploads += acc.count
  }
  out({
    ok: true,
    id,
    first,
    last,
    branch,
    model,
    uploads,
    promptCount: prompts.length,
    firstPrompts: prompts.slice(0, 3),
    lastPrompt: prompts.length > 3 ? prompts[prompts.length - 1] : undefined,
    lastReplies: replies.slice(-2),
    tools: Object.entries(tools).sort((a, b) => b[1] - a[1]).slice(0, 8),
    files: [...files.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([f]) => f),
  })
}

// ---------- diag: a report to paste into an issue ----------

// What this system looks like to the helper, for a bug report: versions, where the bin is,
// how many transcripts there are and which desktop app folders exist, with counts.
// Never emails, account or organization ids, user names or chat titles: the home folder is
// written as ~ and only the signed-in user's own folders are described.
async function diag() {
  const home = selfProfile ?? (await profiles())[0]?.home ?? os.homedir()
  // The app's install folder name (Claude-Data/claude_<code>) is written as <install>.
  const tilde = p =>
    (fold(p).startsWith(fold(home)) ? `~${p.slice(home.length)}` : p).replaceAll('\\', '/').replace(/(Claude-Data\/)[^/]+/, '$1<install>')
  const ago = ms => (ms ? `${Math.max(0, Math.round((Date.now() - ms) / 86_400_000))} days ago` : 'never')
  const lines = []
  const add = (...l) => lines.push(...l)

  let version = 'unknown'
  try {
    const here = path.dirname(fileURLToPath(import.meta.url))
    version = JSON.parse(await fsp.readFile(path.join(here, '..', '.claude-plugin', 'plugin.json'), 'utf8')).version ?? version
  } catch {}

  add('### Session Manager diagnostics', '')
  add(`- Session Manager: ${version}`)
  add(`- System: ${PLATFORM} ${os.release()} (${os.arch()})`)
  add(`- Node.js: ${process.version}`)
  if (PLATFORM === 'darwin') add(`- Bin: Trash (the \`trash\` command: ${fs.existsSync('/usr/bin/trash') ? 'yes' : 'no, plain move into ~/.Trash'})`)
  else if (PLATFORM === 'linux') add(`- Bin: Trash in ${tilde(path.join(process.env.XDG_DATA_HOME || path.join(home, '.local', 'share'), 'Trash'))}`)
  else add('- Bin: Recycle Bin')
  const profs = await profiles()
  add(`- User folders with Claude Code sessions: ${profs.length}`)

  // This user's transcripts.
  const claude = path.join(home, '.claude')
  let transcripts = 0
  let projects = 0
  for (const project of await dirs(path.join(claude, 'projects'))) {
    const n = (await files(path.join(claude, 'projects', project))).filter(f => f.endsWith('.jsonl') && UUID.test(f.slice(0, -6))).length
    if (n) projects++
    transcripts += n
  }
  add(`- This user: ${transcripts} transcript(s) in ${projects} project folder(s); terminal login: ${(await signedInAccount(home)) ? 'yes' : 'no'}`)

  // The desktop app folders the helper checks on this system, and what each holds.
  add('', '**Desktop app folders checked**', '')
  const roots = await appRoots(home)
  const expected =
    PLATFORM === 'win32'
      ? [path.join(home, 'AppData', 'Local', 'Claude-Data'), path.join(home, 'AppData', 'Roaming', 'Claude')]
      : PLATFORM === 'darwin'
        ? [path.join(home, 'Library', 'Application Support', 'Claude'), path.join(home, 'Library', 'Application Support', 'Claude-Data')]
        : [path.join(home, '.config', 'Claude')]
  for (const p of expected) add(`- ${tilde(p)}: ${(await exists(p)) ? 'exists' : 'missing'}`)
  if (roots.length === 0) add('- No folder with sidebar entries found: move and restore are not available.')
  for (const root of roots) {
    const sessionsDir = path.join(root, 'claude-code-sessions')
    let accounts = 0
    let orgs = 0
    let entries = 0
    let archived = 0
    let deleted = 0
    let newest = 0
    for (const account of await dirs(sessionsDir)) {
      if (!UUID.test(account)) continue
      accounts++
      for (const org of await dirs(path.join(sessionsDir, account))) {
        if (!UUID.test(org)) continue
        orgs++
        const folder = path.join(sessionsDir, account, org)
        for (const name of await files(folder)) {
          if (LOCAL_NAME.test(name)) entries++
          else if (name.startsWith('deleted_')) deleted++
          else if (name === ARCHIVE_IDX) {
            try {
              archived += JSON.parse(await fsp.readFile(path.join(folder, name), 'utf8'))?.archived?.length ?? 0
            } catch {}
          }
          const st = await fsp.stat(path.join(folder, name)).catch(() => undefined)
          if (st && st.mtimeMs > newest) newest = st.mtimeMs
        }
      }
    }
    add(`- ${tilde(sessionsDir)}: ${accounts} account(s), ${orgs} organization folder(s), ${entries} sidebar entries (${archived} archived), ${deleted} deleted mark(s), last written ${ago(newest)}`)
  }

  // Other folders named claude-code-sessions near where apps keep data: a layout this
  // version does not know yet shows up here.
  const bases =
    PLATFORM === 'win32'
      ? [path.join(home, 'AppData', 'Local'), path.join(home, 'AppData', 'Roaming')]
      : PLATFORM === 'darwin'
        ? [path.join(home, 'Library', 'Application Support')]
        : [process.env.XDG_CONFIG_HOME || path.join(home, '.config')]
  const known = new Set(roots.map(r => fold(path.join(r, 'claude-code-sessions'))))
  const others = []
  for (const base of bases) {
    for (const a of await dirs(base)) {
      if (!/claude/i.test(a)) continue
      const level1 = path.join(base, a)
      const candidates = [path.join(level1, 'claude-code-sessions'), ...(await dirs(level1)).map(b => path.join(level1, b, 'claude-code-sessions'))]
      for (const c of candidates) if (!known.has(fold(c)) && (await exists(c))) others.push(c)
    }
  }
  add('', '**Other folders named claude-code-sessions**', '')
  add(...(others.length ? others.map(o => `- ${tilde(o)}`) : ['- none']))

  out({ ok: true, report: lines.join('\n') })
}

// `--ids -` reads the comma- or line-separated ids from standard input (a long list overflows a command line).
async function readIds() {
  const v = opt('ids') ?? ''
  if (v !== '-') return v.split(',').filter(Boolean)
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  return text.split(/[\s,]+/).filter(Boolean)
}

const ids = await readIds()
try {
  if (cmd === 'scan') await scan()
  else if (cmd === 'strip') await strip(ids)
  else if (cmd === 'delete') await del(ids)
  else if (cmd === 'move') await move(ids)
  else if (cmd === 'peek') await peek(ids[0] ?? '')
  else if (cmd === 'restore') await restore(ids)
  else if (cmd === 'diag') await diag()
  else fail('usage: sessions.mjs scan|strip|delete|move|restore|peek|diag [--ids a,b] [--to account] [--exclude id] [--permanent]')
} catch (err) {
  fail(String(err?.stack ?? err))
}
