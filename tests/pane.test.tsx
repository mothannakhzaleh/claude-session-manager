import { expect, test } from 'claude-code/testing'

import type { ScanResult, SessionRow } from '../types'

const ACC = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const APP = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const DAY = 86_400_000
const zero = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, messages: 0 }

const row = (id: string, patch: Partial<SessionRow>): SessionRow => ({
  id,
  kind: 'chat',
  replies: 3,
  user: 'alice',
  project: 'E--demo',
  cwd: 'E:\\demo',
  title: `Session ${id.slice(0, 4)}`,
  state: 'cli-only',
  isLive: false,
  isCurrent: false,
  canDelete: true,
  canStrip: false,
  last: new Date().toISOString(),
  mtimeMs: Date.now() - 40 * DAY,
  bytes: { transcript: 2_000_000, side: 0, fileHistory: 0, sessionEnv: 0, total: 2_000_000 },
  uploads: { count: 0, bytes: 0 },
  rows: 10,
  tokens: { ...zero, output: 1500, messages: 3 },
  ...patch,
})

const SCAN: ScanResult = {
  ok: true,
  scannedAt: new Date().toISOString(),
  tookMs: 900,
  parsed: 0,
  users: ['alice'],
  accounts: [
    { user: 'alice', accountUuid: ACC, label: 'alice@example.test', isSignedIn: true, isAppActive: false, orgs: 1, indexed: 1, deletedMarkers: 0 },
    { user: 'alice', accountUuid: APP, label: 'account cccccccc', isSignedIn: false, isAppActive: true, orgs: 1, indexed: 0, deletedMarkers: 0 },
  ],
  total: { input: 10, output: 4500, cacheWrite: 100, cacheRead: 9000, messages: 9 },
  models: {},
  sessions: [
    row('11111111-1111-4111-8111-111111111111', { canStrip: true, uploads: { count: 3, bytes: 900_000 } }),
    row('22222222-2222-4222-8222-222222222222', { state: 'in-app', account: ACC, canDelete: false, canMove: true, mtimeMs: Date.now() - DAY }),
    row('33333333-3333-4333-8333-333333333333', { isCurrent: true, isLive: true, canDelete: false, mtimeMs: Date.now() }),
    row('44444444-4444-4444-8444-444444444444', { kind: 'log', replies: 0, title: 'Below is a conversation log', tokens: { ...zero } }),
  ],
}

const PANE = {
  plugin: 'session-manager',
  component: 'Pane',
  requestId: 'session-manager',
  props: { title: 'Sessions', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 40 }, view: {} },
} as const

test('the pane lists sessions and asks before deleting, on every surface', async ($, on) => {
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: SCAN }))
  // The helper's peek answer, as $.process.run would return it.
  on('process.run', (_, e) => ({ value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: e.argv[1] === '--version' ? 'v22.11.0\n' : JSON.stringify({ ok: true, firstPrompts: ['Add a login page'], lastReplies: ['Done.'], tools: [['Edit', 2]], files: ['E:/demo/login.tsx'], promptCount: 1, uploads: 0 }) } }))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /^Claude sessions$/ }))?.text).toBe('Claude sessions')
    expect((await ui.find({ type: 'Text', text: /^Conversations · / }))?.text).toBe('Conversations · 3')
    expect(await ui.find({ key: 'del-11111111-1111-4111-8111-111111111111' })).toBeDefined()
    // Not deletable here: still in the app list, or the session in use; logs are hidden by default.
    expect(await ui.find({ key: 'del-22222222-2222-4222-8222-222222222222' })).toBeUndefined()
    expect(await ui.find({ key: 'del-33333333-3333-4333-8333-333333333333' })).toBeUndefined()
    expect(await ui.find({ key: 'del-44444444-4444-4444-8444-444444444444' })).toBeUndefined()

    await ui.press({ key: 'del-11111111-1111-4111-8111-111111111111' })
    expect((await ui.find({ type: 'Text', text: /^Delete "Session 1111"/ }))?.text).toContain('and its files?')
    await ui.press({ key: 'cancel' })
    expect(await ui.find({ key: 'confirm' })).toBeUndefined()

    // The Leftover logs tile opens a card listing them, with its own cleanup button that asks first.
    expect(await ui.find({ key: 'card-all' })).toBeUndefined()
    await ui.press({ key: 'open-logs' })
    expect((await ui.find({ type: 'Text', text: /^Leftover logs · 1 · / }))?.text).toContain('Leftover logs · 1')
    expect(await ui.find({ key: 'c-act-44444444-4444-4444-8444-444444444444' })).toBeDefined()
    await ui.press({ key: 'card-all' })
    expect((await ui.find({ type: 'Text', text: /^Delete 1 leftover conversation logs/ }))?.text).toContain('no real replies')
    expect(await ui.find({ key: 'confirm' })).toBeDefined()
    await ui.press({ key: 'cancel' })

    // The Uploads tile opens its card; a session with uploads can be cleared from there.
    await ui.press({ key: 'open-uploads' })
    expect(await ui.find({ key: 'c-act-11111111-1111-4111-8111-111111111111' })).toBeDefined()
    expect((await ui.find({ key: 'card-all' }))?.text).toContain('Clear all 1')
    await ui.press({ key: 'card-close' })
    expect(await ui.find({ key: 'card-all' })).toBeUndefined()

    await ui.select({ key: 'filter', value: 'logs' })
    expect(await ui.find({ key: 'del-44444444-4444-4444-8444-444444444444' })).toBeDefined()
    await ui.select({ key: 'filter', value: 'chats' })

    // Other accounts: the in-app chat of account ACC can move to the app's account.
    await ui.press({ key: 'open-accounts' })
    expect(await ui.find({ key: 'c-act-22222222-2222-4222-8222-222222222222' })).toBeDefined()
    expect((await ui.find({ key: 'card-all' }))?.text).toBe('Move all 1')
    await ui.press({ key: 'card-all' })
    expect(await ui.find({ type: 'Text', text: /^Move 1 chat\(s\) from other accounts/ })).toBeDefined()
    expect((await ui.find({ key: 'confirm' }))?.text).toBe('Yes, move')
    await ui.press({ key: 'cancel' })

    // View shows what is inside a chat.
    await ui.press({ key: 'c-view-22222222-2222-4222-8222-222222222222' })
    expect(await ui.find({ type: 'Text', text: /^You asked$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Add a login page/ })).toBeDefined()
    await ui.press({ key: 'peek-close' })
    await ui.press({ key: 'card-close' })

    await ui.select({ key: 'account', value: ACC })
    expect((await ui.find({ type: 'Text', text: /^Conversations · / }))?.text).toBe('Conversations · 1')
    await ui.select({ key: 'account', value: 'all' })
    expect((await ui.find({ key: 'widget-toggle' }))?.text).toBe('Widget at start: on')
    await ui.press({ key: 'widget-toggle' })
    expect((await ui.find({ key: 'widget-toggle' }))?.text).toBe('Widget at start: off')
    await ui.press({ key: 'widget-toggle' })
    await ui.unmount()
  }

  // The desktop widget shows a glance at the numbers.
  const widget = await $.ui.mount({ ...PANE, surface: 'desktop', props: { ...PANE.props, placement: 'widget' } })
  expect((await widget.find({ type: 'Text', text: /^3 chats · / }))?.text).toContain('3 chats')
  expect(await widget.find({ key: 'del-11111111-1111-4111-8111-111111111111' })).toBeUndefined()
  await widget.unmount()
})

test('without Node.js the pane offers to install it', async ($, on) => {
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('store.get', () => ({ value: undefined }))
  on('process.run', () => {
    throw new Error('cannot start: not found')
  })
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'terminal' })
  await ui.press({ key: 'scan' })
  expect(await ui.find({ type: 'Text', text: /^Node\.js is needed$/ })).toBeDefined()
  expect((await ui.find({ key: 'install-node' }))?.text).toBe('Install Node.js')
  await ui.unmount()
})
