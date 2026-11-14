import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Card, NodeState, Peek, Pending, ScanResult, SessionRow, Tokens, View, Work } from '../types'

// Session Manager: every Claude Code session on this PC, grouped by Claude account,
// with token totals; clears uploaded images/files and deletes old sessions and leftover logs.
// The heavy work runs in scripts/sessions.mjs (Node), which re-checks every target and
// never touches skills, plugins, memory or settings.

const PANE = 'session-manager'
const TITLE = 'Sessions'
const STORE_KEY = 'lastScan'
const DAY = 86_400_000

// Shape tags decline what an earlier version stored (scan-1 rows had no `kind`).
const scanAtom = atom({ plugin: 'session-manager', key: 'scan' } as const, null, { shape: 'scan-2' })
const viewAtom = atom(
  { plugin: 'session-manager', key: 'view' } as const,
  { account: 'all', filter: 'chats', sort: 'recent', olderDays: 30, page: 0 },
  { shape: 'view-2' },
)
const busyAtom = atom({ plugin: 'session-manager', key: 'busy' } as const, '')
const pendingAtom = atom({ plugin: 'session-manager', key: 'pending' } as const, null, { shape: 'pending-1' })
const noteAtom = atom({ plugin: 'session-manager', key: 'note' } as const, '')
const workAtom = atom({ plugin: 'session-manager', key: 'work' } as const, null, { shape: 'work-1' })
const cardAtom = atom({ plugin: 'session-manager', key: 'card' } as const, '' as Card)
const cardPageAtom = atom({ plugin: 'session-manager', key: 'cardPage' } as const, 0)
const peekAtom = atom({ plugin: 'session-manager', key: 'peek' } as const, null, { shape: 'peek-1' })
const nodeAtom = atom({ plugin: 'session-manager', key: 'node' } as const, '' as NodeState)
const widgetAtom = atom({ plugin: 'session-manager', key: 'widget' } as const, true)
const WIDGET_KEY = 'showWidget'
const CARD_ROWS = 8
const LABEL: Record<Pending['action'], [string, string]> = {
  delete: ['Deleting', 'session(s)'],
  strip: ['Clearing uploads in', 'session(s)'],
  move: ['Moving', 'chat(s) to this account'],
  restore: ['Restoring', 'chat(s) to the sidebar'],
}

// ---------- formatting ----------

const mb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.round(n / 1e3)} KB`)
const num = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${(n / 1e3).toFixed(1)}K` : String(n))
const tok = (t: Tokens) => `in ${num(t.input)} · out ${num(t.output)} · cache write ${num(t.cacheWrite)} · cache read ${num(t.cacheRead)}`
const age = (ms: number) => {
  const d = (Date.now() - ms) / DAY
  return d < 1 / 24 ? 'just now' : d < 1 ? `${Math.round(d * 24)}h ago` : `${Math.round(d)}d ago`
}
const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, Math.max(1, n - 1))}…` : s)
const errText = (err: unknown) => String((err as Error)?.message ?? err)
const bytesOf = (rows: SessionRow[], pick: (s: SessionRow) => number) => rows.reduce((a, s) => a + pick(s), 0)

const STATE: Record<SessionRow['state'], { label: string; color: string }> = {
  'in-app': { label: 'In app list', color: 'success' },
  archived: { label: 'Archived in app', color: 'suggestion' },
  'deleted-in-app': { label: 'Deleted in app, files left', color: 'warning' },
  'cli-only': { label: 'Not in app list', color: 'subtle' },
}

// ---------- Node.js for the helper ----------

// The helper needs Node.js 18 or newer. 'node' on PATH first, then the usual install folders
// on Windows, macOS (Homebrew) and Linux: a fresh install, or one a desktop app's PATH leaves
// out, is still found. A place that does not exist on this system simply fails to start.
const NODE_CANDIDATES = [
  'node',
  'C:\\Program Files\\nodejs\\node.exe',
  '/opt/homebrew/bin/node',
  '/usr/local/bin/node',
  '/usr/bin/node',
  '/home/linuxbrew/.linuxbrew/bin/node',
]
const BREW_CANDIDATES = ['brew', '/opt/homebrew/bin/brew', '/usr/local/bin/brew', '/home/linuxbrew/.linuxbrew/bin/brew']
const MANUAL_NODE = 'Install the LTS version from https://nodejs.org (or your package manager, for example `sudo apt install nodejs`), then press Scan.'
const NODE_MIN_MAJOR = 18
let nodeCmd = ''

// A Node installed with nvm, fnm, volta or asdf is on the PATH only of an interactive shell,
// which a desktop app started from the Dock or Finder does not have: ask the shells for it.
// On Windows these shells do not exist and fail to start.
async function nodeFromShell($: EngineInterface): Promise<string[]> {
  const found: string[] = []
  for (const shell of ['/bin/zsh', '/bin/bash']) {
    try {
      const r = await $.process.run([shell, '-ilc', 'command -v node'], { timeoutMs: 15_000 })
      const p = r.stdout.trim().split(/\s+/).pop() ?? ''
      if (r.exitCode === 0 && p.startsWith('/')) found.push(p)
    } catch {}
  }
  return found
}

async function findNode($: EngineInterface): Promise<string> {
  if (nodeCmd) return nodeCmd
  for (const candidate of [...NODE_CANDIDATES, ...(await nodeFromShell($))]) {
    try {
      const r = await $.process.run([candidate, '--version'], { timeoutMs: 15_000 })
      const major = Number(/^v(\d+)\./.exec(r.stdout.trim())?.[1] ?? 0)
      if (r.exitCode === 0 && major >= NODE_MIN_MAJOR) {
        nodeCmd = candidate
        return candidate
      }
    } catch {} // not installed at this place
  }
  return ''
}

async function needNode($: EngineInterface): Promise<string> {
  const found = await findNode($)
  if (!found) {
    await update($, nodeAtom, now => (now === 'installing' ? now : 'missing'))
    throw new Error(`Node.js ${NODE_MIN_MAJOR} or newer is needed; press "Install Node.js" in the Sessions pane`)
  }
  await update($, nodeAtom, now => (now === 'missing' ? '' : now))
  return found
}

// The first installer that starts on this system: winget on Windows, else Homebrew
// (macOS, or Linux with Homebrew). The mod has no way to ask which system it is on, so it tries.
async function nodeInstaller($: EngineInterface): Promise<{ name: string; argv: string[] } | undefined> {
  const starts = async (cmd: string) => {
    try {
      return (await $.process.run([cmd, '--version'], { timeoutMs: 20_000 })).exitCode === 0
    } catch {
      return false
    }
  }
  if (await starts('winget')) {
    return {
      name: 'winget',
      argv: ['winget', 'install', '--id', 'OpenJS.NodeJS.LTS', '--exact', '--silent', '--accept-source-agreements', '--accept-package-agreements', '--disable-interactivity'],
    }
  }
  for (const brew of BREW_CANDIDATES) if (await starts(brew)) return { name: 'Homebrew', argv: [brew, 'install', 'node'] }
  return undefined
}

// Installs Node.js when the person presses the button: on Windows the LTS version from the
// official OpenJS.NodeJS.LTS winget package (Windows may ask for permission), on a Mac (or
// Linux) with Homebrew its `node` formula. Elsewhere it says how to install it. Then scans.
async function installNode($: EngineInterface) {
  if ((await read($, nodeAtom)) === 'installing') return
  await update($, nodeAtom, () => 'installing')
  await update($, noteAtom, () => 'Looking for an installer…')
  let note: string
  const installer = await nodeInstaller($)
  if (!installer) {
    note = `No winget or Homebrew found. ${MANUAL_NODE}`
  } else {
    await update($, noteAtom, () => `Installing Node.js with ${installer.name}… this can take a few minutes.`)
    try {
      const r = await $.process.run(installer.argv, { timeoutMs: 900_000 })
      nodeCmd = ''
      note = (await findNode($)) ? 'Node.js is installed. Scanning…' : `Node.js did not install (${installer.name} exited ${r.exitCode}). ${MANUAL_NODE}`
    } catch (err) {
      note = `Could not run ${installer.name} (${cut(errText(err), 80)}). ${MANUAL_NODE}`
    }
  }
  await update($, nodeAtom, () => (nodeCmd ? '' : 'missing'))
  await update($, noteAtom, () => note)
  if (nodeCmd) await runScan($)
}

// ---------- helper calls ----------

async function helper($: EngineInterface, argv: string[]) {
  const script = `${$.plugin.root}/scripts/sessions.mjs`
  const current = await $.session.id().catch(() => '')
  const node = await needNode($)
  const r = await $.process.run([node, script, ...argv, ...(current ? ['--exclude', current] : [])], { timeoutMs: 600_000 })
  let body: { ok?: boolean; error?: string } & Record<string, unknown>
  try {
    body = JSON.parse(r.stdout)
  } catch {
    throw new Error(`helper exited ${r.exitCode}: ${cut(r.stderr || r.stdout, 300)}`)
  }
  if (!body.ok) throw new Error(cut(body.error ?? 'helper failed', 300))
  return body
}

async function runScan($: EngineInterface) {
  if (await read($, busyAtom)) return
  await update($, busyAtom, () => 'Scanning sessions…')
  try {
    const result = (await helper($, ['scan'])) as unknown as ScanResult
    await update($, scanAtom, () => result)
    await $.store.set(STORE_KEY, result).catch(() => undefined)
    await update($, noteAtom, () => `Scanned ${result.sessions.length} sessions in ${(result.tookMs / 1000).toFixed(1)} s`)
  } catch (err) {
    await update($, noteAtom, () => `Scan failed: ${errText(err)}`)
  } finally {
    await update($, busyAtom, () => '')
  }
  // An action confirmed while this scan ran starts now (Cancel clears it first).
  const queued = await read($, pendingAtom)
  if (queued?.isQueued) void runAction($, { ...queued, isQueued: false })
}

// Opens the View card for one session and fills it from the helper's `peek`.
async function runPeek($: EngineInterface, s: SessionRow) {
  const peek: Peek = { id: s.id, title: s.title, isLoading: true }
  await update($, peekAtom, () => peek)
  try {
    const body = await helper($, ['peek', '--ids', s.id])
    await update($, peekAtom, now => (now?.id === s.id ? { ...(body as unknown as Peek), id: s.id, title: s.title, isLoading: false } : now))
  } catch (err) {
    await update($, peekAtom, now => (now?.id === s.id ? { ...peek, isLoading: false, error: errText(err) } : now))
  }
}

// Runs a delete, clear or move, streaming the helper's `@@progress` lines into the progress bar.
async function helperWithProgress($: EngineInterface, action: Pending['action'], ids: string[], label: string) {
  const script = `${$.plugin.root}/scripts/sessions.mjs`
  const current = await $.session.id().catch(() => '')
  const argv = [await needNode($), script, action, '--ids', '-', ...(current ? ['--exclude', current] : [])]
  await update($, workAtom, () => ({ label, done: 0, total: ids.length, bytes: 0 }))
  let stdout = ''
  let errLine = ''
  let stderr = ''
  for await (const { stream, text } of $.process.spawn({ argv, input: ids.join('\n') })) {
    if (stream === 'stdout') {
      stdout += text
      continue
    }
    errLine += text
    const lines = errLine.split('\n')
    errLine = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.startsWith('@@progress ')) {
        stderr += `${line}\n`
        continue
      }
      try {
        const p = JSON.parse(line.slice(11)) as { done: number; total: number; bytes: number }
        await update($, workAtom, w => ({ label: w?.label ?? label, done: p.done, total: p.total, bytes: p.bytes }))
      } catch {}
    }
  }
  let body: { ok?: boolean; error?: string } & Record<string, unknown>
  try {
    body = JSON.parse(stdout)
  } catch {
    throw new Error(`helper failed: ${cut(stderr || stdout, 300)}`)
  }
  if (!body.ok) throw new Error(cut(body.error ?? 'helper failed', 300))
  return body
}

async function runAction($: EngineInterface, p: Pending) {
  if (p.isQueued) return // already waiting for the scan
  if (await read($, workAtom)) {
    // One run at a time: say so instead of ignoring the press.
    await update($, noteAtom, () => 'Another cleanup is still running; confirm again when it ends.')
    $.ui.toast('Another cleanup is still running')
    return
  }
  if (await read($, busyAtom)) {
    // A scan is running: keep the confirmed action; runScan starts it when the scan ends.
    await update($, pendingAtom, () => ({ ...p, isQueued: true }))
    return
  }
  await update($, pendingAtom, () => null)
  const [verb, noun] = LABEL[p.action]
  const label = `${verb} ${p.ids.length} ${noun}`
  await update($, busyAtom, () => `${label}…`)
  let note: string
  try {
    const body = await helperWithProgress($, p.action, p.ids, label)
    const results = (body.results ?? []) as { id: string; ok: boolean; reason?: string; freed?: number; bytes?: number; alreadyGone?: boolean }[]
    const gone = results.filter(r => r.alreadyGone).length
    const done = results.filter(r => r.ok && !r.alreadyGone)
    const refused = results.filter(r => !r.ok)
    const bytes = done.reduce((a, r) => a + (r.freed ?? r.bytes ?? 0), 0)
    const where = body.recycled && p.action !== 'move' ? ` (in the ${String(body.trash ?? 'Recycle Bin')}; empty it to free the space)` : ''
    note =
      p.action === 'delete'
        ? `Deleted ${done.length} session(s), ${mb(bytes)}${where}`
        : p.action === 'strip'
          ? `Cleared uploads in ${done.length} session(s), ${mb(bytes)} smaller${where}`
          : p.action === 'restore'
            ? `Restored ${done.length} chat(s) to the sidebar. Restart the Claude app to see them.`
            : `Moved ${done.length} chat(s) to this account. Restart the Claude app to see them in the sidebar.`
    if (gone) note += ` · ${gone} were already gone`
    if (refused.length) note += ` · skipped ${refused.length}: ${cut(refused[0]?.reason ?? '', 80)}`
  } catch (err) {
    note = `Failed: ${errText(err)}`
  }
  await update($, workAtom, () => null)
  await update($, busyAtom, () => '')
  await update($, cardPageAtom, () => 0)
  await runScan($)
  await update($, noteAtom, () => note)
  $.ui.toast(note)
}

// ---------- selection ----------

const inAccount = (scan: ScanResult, view: View) =>
  scan.sessions.filter(s => (view.account === 'all' ? true : view.account === 'none' ? !s.account : s.account === view.account))

function visible(scan: ScanResult, view: View): SessionRow[] {
  const cutoff = Date.now() - view.olderDays * DAY
  let list = inAccount(scan, view)
  if (view.filter === 'chats') list = list.filter(s => s.kind === 'chat')
  if (view.filter === 'logs') list = list.filter(s => s.kind === 'log')
  if (view.filter === 'deletable') list = list.filter(s => s.canDelete)
  if (view.filter === 'uploads') list = list.filter(s => s.uploads.count > 0)
  if (view.filter === 'old') list = list.filter(s => s.mtimeMs < cutoff)
  const key =
    view.sort === 'size'
      ? (s: SessionRow) => s.bytes.total
      : view.sort === 'tokens'
        ? (s: SessionRow) => s.tokens.output + s.tokens.input + s.tokens.cacheWrite
        : (s: SessionRow) => s.mtimeMs
  return [...list].sort((a, b) => key(b) - key(a))
}

const sum = (rows: SessionRow[]): Tokens =>
  rows.reduce(
    (t, s) => ({
      input: t.input + s.tokens.input,
      output: t.output + s.tokens.output,
      cacheWrite: t.cacheWrite + s.tokens.cacheWrite,
      cacheRead: t.cacheRead + s.tokens.cacheRead,
      messages: t.messages + s.tokens.messages,
    }),
    { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 },
  )

function summaryText(scan: ScanResult | null): string {
  if (!scan) return 'No scan result yet (the scan failed or is still running); see the Sessions pane.'
  const chats = scan.sessions.filter(s => s.kind === 'chat')
  const logs = scan.sessions.filter(s => s.kind === 'log')
  const lines = [
    `${chats.length} conversations and ${logs.length} leftover logs (${mb(bytesOf(logs, s => s.bytes.total))}); ${mb(bytesOf(scan.sessions, s => s.bytes.total))} on disk, ${mb(bytesOf(scan.sessions, s => s.uploads.bytes))} of it uploads.`,
    `Tokens (all sessions): ${tok(scan.total)} over ${scan.total.messages} model replies.`,
  ]
  for (const a of scan.accounts) {
    const rows = scan.sessions.filter(s => s.account === a.accountUuid)
    if (!rows.length) continue // an account with no sessions left adds nothing
    const tags = `${a.isAppActive ? ' · this app' : ''}${a.isSignedIn ? ' · terminal login' : ''}`
    lines.push(`- ${a.label}${tags}: ${rows.length} session(s), out ${num(sum(rows).output)} tokens`)
  }
  const none = chats.filter(s => !s.account)
  lines.push(`- conversations in no app list: ${none.length}, out ${num(sum(none).output)} tokens`)
  return lines.join('\n')
}

// ---------- register ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'sessions', description: 'Show every Claude session on this PC: tokens, uploads, cleanup' })
    // Bring back the last scan so the pane has numbers before a new scan finishes.
    if (!(await read($, scanAtom))) {
      const kept = (await $.store.get(STORE_KEY).catch(() => undefined)) as ScanResult | undefined
      const isCurrentShape = kept?.ok && Array.isArray(kept.sessions) && kept.sessions.every(s => s.kind !== undefined)
      if (isCurrentShape) await update($, scanAtom, () => kept)
    }
    // The small Sessions widget beside the chat, on the desktop app only (other surfaces
    // would open the full pane unasked). The person turns it off from the pane.
    const wants = (await $.store.get(WIDGET_KEY).catch(() => undefined)) !== false
    await update($, widgetAtom, () => wants)
    if (wants && e.surface === 'desktop') {
      await $.ui.open({ id: PANE, title: TITLE, placement: 'widget' }).catch(() => undefined)
      const scan = await read($, scanAtom)
      if (!scan || Date.now() - Date.parse(scan.scannedAt) > 60 * 60_000) void runScan($)
    }
    return started
  })

  on('command.run', { command: 'sessions' }, async $ => {
    const opened = await $.ui.open({ id: PANE, title: TITLE })
    let scan = await read($, scanAtom)
    if (!scan) {
      // First run: wait for the numbers so the command's answer holds them.
      await runScan($)
      scan = await read($, scanAtom)
    } else if (Date.now() - Date.parse(scan.scannedAt) > 10 * 60_000) void runScan($)
    const head = opened.isPlaced
      ? 'Sessions pane opened.'
      : `The Sessions pane is not shown yet (${opened.reason ?? 'no surface to draw it'}); run /sessions again in a moment, or start a new session. Summary:`
    return { text: `${head}\n${summaryText(scan)}` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button, Select, Progress } = $.ui.resolve(e)
    const scan = await read($, scanAtom)
    // Windows names it the Recycle Bin; macOS and Linux, the Trash. Known after the first scan.
    const bin = scan?.trash ?? 'Recycle Bin'
    const view = await read($, viewAtom)
    const busy = await read($, busyAtom)
    const pending = await read($, pendingAtom)
    const note = await read($, noteAtom)
    const cols = Math.max(40, e.props.bodyColumns ?? e.viewport?.columns ?? 80)
    const setView = (patch: Partial<View>) => update($, viewAtom, v => ({ ...v, page: 0, ...patch }))
    const ask = (p: Pending) => update($, pendingAtom, () => p)

    const status = busy ? (
      <Text color="warning">{busy}</Text>
    ) : note ? (
      <Text dimColor>{note}</Text>
    ) : null

    const nodeState = await read($, nodeAtom)
    const nodeBanner =
      nodeState === '' ? null : (
        <Box key="node" flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
          <Text bold color="warning">
            {nodeState === 'installing' ? 'Installing Node.js…' : 'Node.js is needed'}
          </Text>
          <Text>
            {nodeState === 'installing'
              ? 'Installing Node.js. Your system may ask for permission; this can take a few minutes.'
              : 'Session Manager reads your sessions with Node.js (free, from nodejs.org). The button installs it with winget on Windows or Homebrew on a Mac; you can also get it from https://nodejs.org.'}
          </Text>
          {nodeState === 'missing' && (
            <Box>
              <Button key="install-node" variant="primary" onPress={() => void installNode($)}>
                Install Node.js
              </Button>
            </Box>
          )}
        </Box>
      )

    // The widget: a glance at the numbers; the person expands it for the full pane.
    if (e.props.placement === 'widget') {
      const chatsAll = scan?.sessions.filter(x => x.kind === 'chat') ?? []
      const logsAll = scan?.sessions.filter(x => x.kind === 'log' && x.canDelete) ?? []
      const app = scan?.accounts.find(a => a.isAppActive)
      const others = scan?.sessions.filter(x => x.canMove && x.account && app && x.account !== app.accountUuid).length ?? 0
      return (
        <Box flexDirection="column" paddingX={1}>
          <Text bold>Sessions</Text>
          {nodeState !== '' ? (
            <Text color="warning">{nodeState === 'installing' ? 'Installing Node.js…' : 'Needs Node.js: expand to install'}</Text>
          ) : scan ? (
            <>
              <Text>{`${chatsAll.length} chats · ${mb(bytesOf(scan.sessions, x => x.bytes.total))}`}</Text>
              <Text dimColor size="caption">
                {`${mb(bytesOf(scan.sessions, x => x.uploads.bytes))} uploads · ${logsAll.length} leftover logs${others ? ` · ${others} in other accounts` : ''}`}
              </Text>
              <Text dimColor size="caption">{`out ${num(scan.total.output)} tokens`}</Text>
            </>
          ) : (
            <Text dimColor>{busy || 'Not scanned yet'}</Text>
          )}
        </Box>
      )
    }

    if (!scan) {
      return (
        <Box flexDirection="column" gap={1} paddingX={1}>
          <Text bold size="heading">
            Claude sessions on this PC
          </Text>
          {nodeBanner}
          <Text>{busy ? '' : 'No scan yet. A scan reads every session transcript once (about 20 seconds), then is cached.'}</Text>
          {!busy && (
            <Box>
              <Button key="scan" variant="primary" onPress={() => void runScan($)}>
                Scan sessions
              </Button>
            </Box>
          )}
          {status}
        </Box>
      )
    }

    // ----- numbers for the selected account -----
    const scope = inAccount(scan, view)
    const chats = scope.filter(s => s.kind === 'chat')
    const logs = scope.filter(s => s.kind === 'log')
    const cutoff = Date.now() - view.olderDays * DAY
    const deletableLogs = logs.filter(s => s.canDelete)
    const oldChats = chats.filter(s => s.canDelete && s.mtimeMs < cutoff)
    const strippable = scope.filter(s => s.canStrip)
    const scopeTokens = sum(scope)

    const rows = visible(scan, view)
    const bodyRows = e.props.scroll?.bodyRows ?? e.viewport?.rows ?? 40
    const pageSize = Math.max(4, Math.floor((bodyRows - 30) / 5))
    const pages = Math.max(1, Math.ceil(rows.length / pageSize))
    const page = Math.min(view.page, pages - 1)
    const shown = rows.slice(page * pageSize, (page + 1) * pageSize)

    const countFor = (account?: string) => scan.sessions.filter(s => s.account === account).length
    const accountOptions = [
      { value: 'all', label: `All accounts (${scan.sessions.length})` },
      ...scan.accounts.map(a => ({
        value: a.accountUuid,
        label: `${a.label}${a.isAppActive ? ' · this app' : ''}${a.isSignedIn ? ' · terminal login' : ''}${scan.users.length > 1 ? ` · ${a.user}` : ''} (${countFor(a.accountUuid)})`,
      })),
      { value: 'none', label: `In no app list (${countFor(undefined)})` },
    ]

    const card = await read($, cardAtom)
    const cardPage = await read($, cardPageAtom)
    const work = await read($, workAtom)
    const peek = await read($, peekAtom)
    const widget = await read($, widgetAtom)
    const isWorking = work !== null || busy !== ''
    const openCard = (c: Card) => {
      void update($, cardPageAtom, () => 0)
      void update($, cardAtom, now => (now === c ? '' : c))
    }

    // Plain functions, not components: the surface's table holds the only tags.
    // A tile with `opens` gets a button that opens its card of cleanable items below the tiles.
    const tile = (key: string, label: string, value: string, hint: string, opens?: { card: Card; count: number }, color?: string) => (
      <Box
        key={key}
        flexDirection="column"
        borderStyle="round"
        borderColor={opens && card === opens.card ? 'suggestion' : 'subtle'}
        paddingX={1}
        minWidth={18}
      >
        <Text dimColor size="caption">
          {label}
        </Text>
        <Text bold color={color} size="heading">
          {value}
        </Text>
        <Text dimColor size="caption">
          {hint}
        </Text>
        {opens && opens.count > 0 ? (
          <Button key={`open-${opens.card}`} plain dimColor={card !== opens.card} onPress={() => openCard(opens.card)}>
            {card === opens.card ? '▴ Close' : `▾ ${opens.card === 'accounts' ? 'Bring here' : 'Clean up'} ${opens.count}`}
          </Button>
        ) : null}
      </Box>
    )

    // ----- the open card: what this tile can clean, and its own cleanup button -----
    type CardSpec = { title: string; items: SessionRow[]; info: string; all?: Pending; one: (s: SessionRow) => Pending | undefined; size: (s: SessionRow) => number; verb: string }
    const uploadRows = scope.filter(s => s.uploads.count > 0).sort((a, b) => b.uploads.bytes - a.uploads.bytes)
    const appAccount = scan.accounts.find(a => a.isAppActive)
    const movable = scope.filter(s => s.canMove && s.account && appAccount && s.account !== appAccount.accountUuid).sort((a, b) => b.mtimeMs - a.mtimeMs)
    const specs: Record<Exclude<Card, ''>, CardSpec> = {
      accounts: {
        title: `Chats in other accounts · ${movable.length}`,
        items: movable,
        info: `Moves each chat's sidebar entry into the account this app uses now (${appAccount ? appAccount.label : 'unknown'}), so you can continue it there; it lands in the Active list. The conversation itself is not copied, so nothing is left behind. Restart the Claude app to see moved chats.`,
        all: movable.length
          ? { action: 'move', ids: movable.map(s => s.id), label: `Move ${movable.length} chat(s) from other accounts to this account`, bytes: 0 }
          : undefined,
        one: s => ({ action: 'move', ids: [s.id], label: `Move "${cut(s.title, 40)}" to this account`, bytes: 0 }),
        size: s => s.bytes.total,
        verb: 'Move',
      },
      logs: {
        title: `Leftover logs · ${deletableLogs.length} · ${mb(bytesOf(deletableLogs, s => s.bytes.total))}`,
        items: [...deletableLogs].sort((a, b) => b.bytes.total - a.bytes.total),
        info: 'Summary runs with no real replies (they start with "Below is a conversation log"). Safe to delete.',
        all: deletableLogs.length
          ? { action: 'delete', ids: deletableLogs.map(s => s.id), label: `Delete ${deletableLogs.length} leftover conversation logs (summary runs with no real replies)`, bytes: bytesOf(deletableLogs, s => s.bytes.total) }
          : undefined,
        one: s => ({ action: 'delete', ids: [s.id], label: `Delete leftover log "${cut(s.title, 40)}"`, bytes: s.bytes.total }),
        size: s => s.bytes.total,
        verb: 'Delete',
      },
      uploads: {
        title: `Uploads · ${bytesOf(uploadRows, s => s.uploads.count)} files · ${mb(bytesOf(uploadRows, s => s.uploads.bytes))}`,
        items: uploadRows,
        info: 'Pasted and uploaded images and files kept inside transcripts. Clearing keeps the conversation and replaces each upload with a placeholder.',
        all: strippable.length
          ? { action: 'strip', ids: strippable.map(s => s.id), label: `Clear uploaded images and files from ${strippable.length} session(s)`, bytes: bytesOf(strippable, s => s.uploads.bytes) }
          : undefined,
        one: s => (s.canStrip ? { action: 'strip', ids: [s.id], label: `Clear ${s.uploads.count} uploads from "${cut(s.title, 40)}"`, bytes: s.uploads.bytes } : undefined),
        size: s => s.uploads.bytes,
        verb: 'Clear',
      },
      old: {
        title: `Older than ${view.olderDays} days · ${oldChats.length} · ${mb(bytesOf(oldChats, s => s.bytes.total))}`,
        items: [...oldChats].sort((a, b) => b.bytes.total - a.bytes.total),
        info: `Conversations not used for ${view.olderDays} days and no longer in the app list. Change "Old means" to widen or narrow this.`,
        all: oldChats.length
          ? { action: 'delete', ids: oldChats.map(s => s.id), label: `Delete ${oldChats.length} conversation(s) older than ${view.olderDays} days and their files`, bytes: bytesOf(oldChats, s => s.bytes.total) }
          : undefined,
        one: s => ({ action: 'delete', ids: [s.id], label: `Delete "${cut(s.title, 40)}" and its files`, bytes: s.bytes.total }),
        size: s => s.bytes.total,
        verb: 'Delete',
      },
    }
    const spec = card ? specs[card] : undefined
    const cardPages = spec ? Math.max(1, Math.ceil(spec.items.length / CARD_ROWS)) : 1
    const cp = Math.min(cardPage, cardPages - 1)
    const cardView = spec ? (
      <Box key="card" flexDirection="column" borderStyle="round" borderColor="suggestion" paddingX={1} rowGap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold>{spec.title}</Text>
          <Button key="card-close" role="dismiss" plain dimColor onPress={() => void update($, cardAtom, () => '')}>
            Close
          </Button>
        </Box>
        <Text dimColor>{spec.info}</Text>
        <Box flexDirection="column">
          {spec.items.length === 0 && <Text dimColor>Nothing to clean here right now.</Text>}
          {spec.items.slice(cp * CARD_ROWS, (cp + 1) * CARD_ROWS).map(s => {
            const one = spec.one(s)
            return (
              <Box key={`c-${s.id}`} flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
                <Text wrap="truncate-end">
                  {cut(s.title.replace(/\s+/g, ' '), Math.max(20, cols - 40))}
                  <Text dimColor>{`  ${age(s.mtimeMs)} · ${mb(spec.size(s))}`}</Text>
                </Text>
                <Box flexDirection="row" columnGap={1}>
                  <Button key={`c-view-${s.id}`} plain dimColor={peek?.id !== s.id} onPress={() => void runPeek($, s)}>
                    View
                  </Button>
                  {one && !isWorking ? (
                    <Button key={`c-act-${s.id}`} dimColor onPress={() => void ask(one)}>
                      {spec.verb}
                    </Button>
                  ) : (
                    <Text dimColor>{s.isLive ? 'in use' : ''}</Text>
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" flexWrap="wrap" rowGap={1}>
          {spec.all && !isWorking ? (
            <Button key="card-all" variant="primary" onPress={() => void ask(spec.all!)}>
              {`${spec.verb} all ${spec.all.ids.length}${spec.all.bytes ? ` · ${mb(spec.all.bytes)}` : ''}`}
            </Button>
          ) : (
            <Text dimColor>{isWorking ? 'Working…' : 'Nothing to do here right now.'}</Text>
          )}
          {cardPages > 1 ? (
            <Box flexDirection="row" columnGap={1} alignItems="center">
              <Button key="card-prev" plain onPress={() => void update($, cardPageAtom, () => Math.max(0, cp - 1))}>
                ‹
              </Button>
              <Text dimColor>{`${cp + 1} / ${cardPages}`}</Text>
              <Button key="card-next" plain onPress={() => void update($, cardPageAtom, () => Math.min(cardPages - 1, cp + 1))}>
                ›
              </Button>
            </Box>
          ) : null}
        </Box>
        <Text dimColor size="caption">
          {card === 'accounts'
            ? `Only the sidebar entry moves; the old entry goes to the ${bin}. This uses the app’s own files, so an app update may change how it works.`
            : `Only session transcripts and their own folders are removed. Skills, plugins, mods, memory and settings are never touched. Removed files go to the ${bin}.`}
        </Text>
      </Box>
    ) : null

    // ----- View: what is inside one session -----
    const line = (label: string, value: string | undefined) =>
      value ? (
        <Text wrap="truncate-end">
          <Text dimColor>{`${label}  `}</Text>
          {value}
        </Text>
      ) : null
    const peekView = peek ? (
      <Box key="peek" flexDirection="column" borderStyle="round" borderColor="claude" paddingX={1} rowGap={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Text bold wrap="truncate-end">{`Inside: ${cut(peek.title.replace(/\s+/g, ' '), Math.max(20, cols - 20))}`}</Text>
          <Button key="peek-close" role="dismiss" plain dimColor onPress={() => void update($, peekAtom, () => null)}>
            Close
          </Button>
        </Box>
        {peek.isLoading ? <Progress label="Reading the conversation" /> : null}
        {peek.error ? <Text color="error">{peek.error}</Text> : null}
        {!peek.isLoading && !peek.error ? (
          <Box flexDirection="column" rowGap={1}>
            <Box flexDirection="column">
              {line('When', peek.first ? `${peek.first.slice(0, 16).replace('T', ' ')} → ${(peek.last ?? '').slice(0, 16).replace('T', ' ')}` : undefined)}
              {line('Model', peek.model)}
              {line('Branch', peek.branch)}
              {line('Prompts', `${peek.promptCount ?? 0} from you · ${peek.uploads ?? 0} uploads`)}
              {line('Tools', (peek.tools ?? []).map(([t, n]) => `${t} ${n}`).join(' · ') || undefined)}
            </Box>
            {(peek.firstPrompts ?? []).length ? (
              <Box flexDirection="column">
                <Text bold>You asked</Text>
                {(peek.firstPrompts ?? []).map((p, i) => (
                  <Text key={`fp-${i}`} wrap="truncate-end">{`• ${cut(p.replace(/\s+/g, ' '), 300)}`}</Text>
                ))}
                {peek.lastPrompt ? <Text wrap="truncate-end" dimColor>{`… last: ${cut(peek.lastPrompt.replace(/\s+/g, ' '), 300)}`}</Text> : null}
              </Box>
            ) : null}
            {(peek.lastReplies ?? []).length ? (
              <Box flexDirection="column">
                <Text bold>Claude's last replies</Text>
                {(peek.lastReplies ?? []).map((r, i) => (
                  <Text key={`lr-${i}`} wrap="truncate-end" dimColor>{`• ${cut(r.replace(/\s+/g, ' '), 400)}`}</Text>
                ))}
              </Box>
            ) : null}
            {(peek.files ?? []).length ? (
              <Box flexDirection="column">
                <Text bold>Files it worked on</Text>
                {(peek.files ?? []).map((f, i) => (
                  <Text key={`ff-${i}`} dimColor wrap="truncate-middle">{f}</Text>
                ))}
              </Box>
            ) : null}
          </Box>
        ) : null}
      </Box>
    ) : null

    // ----- progress while a delete or clear runs -----
    const progressView = work ? (
      <Box key="work" flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1}>
        <Text bold>{work.label}</Text>
        <Progress label={work.label} value={work.done} max={Math.max(1, work.total)} valueText={`${work.done} of ${work.total}`} />
        <Text dimColor>{`${work.total - work.done} left${work.bytes ? ` · ${mb(work.bytes)} freed so far` : ''}`}</Text>
      </Box>
    ) : null

    return (
      <Box flexDirection="column" gap={1} paddingX={1}>
        {/* ----- header ----- */}
        <Box flexDirection="row" justifyContent="space-between" alignItems="center">
          <Box flexDirection="column">
            <Text bold size="title">
              Claude sessions
            </Text>
            <Text dimColor size="caption">
              {`Scanned ${age(Date.parse(scan.scannedAt))} · ${scan.users.length} user(s) · ${scan.accounts.length} Claude account folder(s)`}
            </Text>
          </Box>
          <Button key="rescan" onPress={() => void runScan($)}>
            Rescan
          </Button>
        </Box>

        {/* ----- totals for the selected account ----- */}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1} rowGap={1}>
          {tile('t-chats', 'Conversations', String(chats.length), mb(bytesOf(chats, s => s.bytes.total)))}
          {tile('t-logs', 'Leftover logs', String(logs.length), mb(bytesOf(logs, s => s.bytes.total)), { card: 'logs', count: deletableLogs.length }, logs.length ? 'warning' : undefined)}
          {tile('t-uploads', 'Uploads', mb(bytesOf(scope, s => s.uploads.bytes)), `${bytesOf(scope, s => s.uploads.count)} files`, { card: 'uploads', count: uploadRows.length })}
          {tile('t-old', `Older than ${view.olderDays}d`, String(oldChats.length), mb(bytesOf(oldChats, s => s.bytes.total)), { card: 'old', count: oldChats.length })}
          {tile('t-accounts', 'Other accounts', String(movable.length), 'chats you can bring here', { card: 'accounts', count: movable.length })}
          {tile('t-out', 'Output tokens', num(scopeTokens.output), `${num(scopeTokens.messages)} replies`)}
          {tile('t-cache', 'Cache read', num(scopeTokens.cacheRead), `write ${num(scopeTokens.cacheWrite)}`)}
        </Box>
        {nodeBanner}
        {progressView}
        {cardView}
        {peekView}
        {/* ----- confirmation ----- */}
        {pending && (
          <Box flexDirection="column" borderStyle="round" borderColor="warning" paddingX={1} rowGap={1}>
            <Text bold color="warning">{`${pending.label}?`}</Text>
            {/* Exactly what the action touches, so the person confirms names, not a count. */}
            <Box flexDirection="column">
              {pending.ids.slice(0, 5).map(id => {
                const s = scan.sessions.find(x => x.id === id)
                return (
                  <Text key={`pend-${id}`} wrap="truncate-end">
                    {`• ${cut((s?.title ?? id).replace(/\s+/g, ' '), Math.max(20, cols - 24))}${s ? ` · ${mb(pending.action === 'strip' ? s.uploads.bytes : s.bytes.total)}` : ''}`}
                  </Text>
                )
              })}
              {pending.ids.length > 5 ? <Text dimColor>{`…and ${pending.ids.length - 5} more`}</Text> : null}
            </Box>
            <Text>
              {pending.action === 'restore'
                ? `Gives each chat a new entry in this app’s sidebar (Active list) so you can continue it, and moves the app’s “deleted” mark to the ${bin}. The conversation is not changed. Restart the Claude app afterwards.`
                : pending.action === 'move'
                ? 'Each chat leaves its old account’s sidebar and joins this one. Restart the Claude app afterwards. Chats open now or used in the last 15 minutes are skipped.'
                : pending.action === 'delete'
                  ? `About ${mb(pending.bytes)}. The transcript and its side files go to the ${bin}, where you can restore them. Sessions open now, used in the last 15 minutes or still in the app list are skipped.`
                  : `About ${mb(pending.bytes)}. The conversation stays; each upload becomes a placeholder. The original goes to the ${bin}. Sessions open now or used in the last 15 minutes are skipped.`}
            </Text>
            {pending.isQueued ? <Text color="warning">Waiting for the scan to finish, then it starts by itself…</Text> : null}
            <Box flexDirection="row" columnGap={1}>
              <Button key="confirm" variant="primary" onPress={() => void runAction($, pending)}>
                {pending.isQueued ? 'Starting after the scan…' : pending.action === 'delete' ? 'Yes, delete' : pending.action === 'strip' ? 'Yes, clear' : pending.action === 'restore' ? 'Yes, restore' : 'Yes, move'}
              </Button>
              <Button key="cancel" onPress={() => void update($, pendingAtom, () => null)}>
                Cancel
              </Button>
            </Box>
          </Box>
        )}

        <Text dimColor>{`All accounts: ${tok(scan.total)}`}</Text>

        {/* ----- filters ----- */}
        <Box flexDirection="row" flexWrap="wrap" columnGap={2} rowGap={1}>
          <Select key="account" label="Account" value={view.account} options={accountOptions} onSelect={v => void setView({ account: v })} />
          <Select
            key="filter"
            label="Show"
            value={view.filter}
            options={[
              { value: 'chats', label: `Conversations (${chats.length})` },
              { value: 'logs', label: `Leftover logs (${logs.length})` },
              { value: 'all', label: `Everything (${scope.length})` },
              { value: 'uploads', label: 'With uploads' },
              { value: 'old', label: `Older than ${view.olderDays} days` },
              { value: 'deletable', label: 'Deletable' },
            ]}
            onSelect={v => void setView({ filter: v as View['filter'] })}
          />
          <Select
            key="sort"
            label="Sort"
            value={view.sort}
            options={[
              { value: 'recent', label: 'Most recent' },
              { value: 'size', label: 'Largest' },
              { value: 'tokens', label: 'Most tokens' },
            ]}
            onSelect={v => void setView({ sort: v as View['sort'] })}
          />
          <Select
            key="days"
            label="Old means"
            value={String(view.olderDays)}
            options={['7', '14', '30', '60', '90'].map(d => ({ value: d, label: `${d} days` }))}
            onSelect={v => void setView({ olderDays: Number(v) })}
          />
        </Box>

        {status}

        {/* ----- list ----- */}
        <Box flexDirection="column" rowGap={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Text bold>{`${view.filter === 'logs' ? 'Leftover logs' : view.filter === 'chats' ? 'Conversations' : 'Sessions'} · ${rows.length}`}</Text>
            {pages > 1 ? <Text dimColor>{`Page ${page + 1} of ${pages}`}</Text> : null}
          </Box>
          {shown.length === 0 && <Text dimColor>No sessions match these filters.</Text>}
          {shown.map(s => {
            const st = s.kind === 'log' ? { label: 'Leftover log', color: 'subtle' } : STATE[s.state]
            const when = age(s.mtimeMs)
            return (
              <Box key={`row-${s.id}`} flexDirection="column" borderStyle="round" borderColor={s.isCurrent ? 'suggestion' : 'subtle'} paddingX={1}>
                <Box flexDirection="row" justifyContent="space-between" columnGap={2}>
                  <Text bold wrap="truncate-end">
                    {cut(s.title.replace(/\s+/g, ' '), cols - when.length - 10)}
                  </Text>
                  <Text dimColor>{when}</Text>
                </Box>
                <Text wrap="truncate-end">
                  <Text color={st.color}>{`● ${st.label}`}</Text>
                  {s.isCurrent ? <Text color="suggestion"> · this session</Text> : s.isLive ? <Text color="warning"> · in use</Text> : null}
                  <Text dimColor>
                    {` · ${mb(s.bytes.total)} · ${num(s.replies)} replies · out ${num(s.tokens.output)} · cache read ${num(s.tokens.cacheRead)}`}
                    {s.uploads.count ? ` · ${s.uploads.count} uploads (${mb(s.uploads.bytes)})` : ''}
                  </Text>
                </Text>
                <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
                  <Text dimColor size="caption" wrap="truncate-middle">
                    {cut(s.cwd ?? s.project, Math.max(20, cols - 34))}
                  </Text>
                  <Box flexDirection="row" columnGap={1}>
                    <Button key={`view-${s.id}`} dimColor={peek?.id !== s.id} onPress={() => void runPeek($, s)}>
                      View
                    </Button>
                    {s.canMove && appAccount && s.account !== appAccount.accountUuid && !isWorking && (
                      <Button
                        key={`move-${s.id}`}
                        dimColor
                        onPress={() => void ask({ action: 'move', ids: [s.id], label: `Move "${cut(s.title, 40)}" to this account`, bytes: 0 })}
                      >
                        Move here
                      </Button>
                    )}
                    {s.canRestore && !isWorking && (
                      <Button
                        key={`restore-${s.id}`}
                        dimColor
                        onPress={() => void ask({ action: 'restore', ids: [s.id], label: `Restore "${cut(s.title, 40)}" to the sidebar`, bytes: 0 })}
                      >
                        Restore to sidebar
                      </Button>
                    )}
                    {s.canStrip && (
                      <Button
                        key={`strip-${s.id}`}
                        dimColor
                        onPress={() =>
                          void ask({ action: 'strip', ids: [s.id], label: `Clear ${s.uploads.count} uploads from "${cut(s.title, 40)}"`, bytes: s.uploads.bytes })
                        }
                      >
                        Clear uploads
                      </Button>
                    )}
                    {s.canDelete && (
                      <Button
                        key={`del-${s.id}`}
                        dimColor
                        onPress={() => void ask({ action: 'delete', ids: [s.id], label: `Delete "${cut(s.title, 40)}" and its files`, bytes: s.bytes.total })}
                      >
                        Delete
                      </Button>
                    )}
                  </Box>
                </Box>
              </Box>
            )
          })}
        </Box>

        {pages > 1 && (
          <Box flexDirection="row" columnGap={1} alignItems="center" justifyContent="center">
            <Button key="prev" onPress={() => void update($, viewAtom, v => ({ ...v, page: Math.max(0, page - 1) }))}>
              ‹ Prev
            </Button>
            <Text dimColor>{`${page + 1} / ${pages}`}</Text>
            <Button key="next" onPress={() => void update($, viewAtom, v => ({ ...v, page: Math.min(pages - 1, page + 1) }))}>
              Next ›
            </Button>
          </Box>
        )}
        <Text dimColor size="caption">
          Conversations still in the app list are deleted from the app first (right-click, Delete); their leftover files can then be cleared here.
        </Text>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
          <Text dimColor size="caption">
            Session Manager © 2026 mothannakh · https://satisfy.live/
          </Text>
          <Button
            key="widget-toggle"
            plain
            dimColor
            onPress={async () => {
              const next = !(await read($, widgetAtom))
              await update($, widgetAtom, () => next)
              await $.store.set(WIDGET_KEY, next).catch(() => undefined)
            }}
          >
            {widget ? 'Widget at start: on' : 'Widget at start: off'}
          </Button>
        </Box>
      </Box>
    )
  })
}
