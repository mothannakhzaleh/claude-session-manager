export type Tokens = { input: number; output: number; cacheWrite: number; cacheRead: number; messages: number }

export type SessionRow = {
  id: string
  kind: 'chat' | 'log' // log: no real model reply, a leftover summary or side run
  replies: number
  user: string
  project: string
  cwd?: string
  title: string
  account?: string
  state: 'in-app' | 'archived' | 'deleted-in-app' | 'cli-only'
  isLive: boolean
  isCurrent: boolean
  canDelete: boolean
  canStrip: boolean
  canMove?: boolean // has an app sidebar entry that can move to another account
  canRestore?: boolean // deleted in the app, conversation kept: the sidebar entry can be rebuilt
  first?: string
  last: string
  mtimeMs: number
  bytes: { transcript: number; side: number; fileHistory: number; sessionEnv: number; total: number }
  uploads: { count: number; bytes: number }
  rows: number
  tokens: Tokens
}

export type AccountRow = {
  user: string
  accountUuid: string
  label: string
  isSignedIn: boolean // the terminal (CLI) login
  isAppActive?: boolean // the account the desktop app is using now
  orgs: number
  indexed: number
  deletedMarkers: number
}

export type ScanResult = {
  ok: true
  platform?: string // process.platform of the helper: win32, darwin or linux (older scans lack it)
  trash?: string // what the system calls its bin: 'Recycle Bin' or 'Trash'
  scannedAt: string
  tookMs: number
  parsed: number
  users: string[]
  accounts: AccountRow[]
  total: Tokens
  models: Record<string, Tokens>
  sessions: SessionRow[]
}

export type View = {
  account: string // 'all', 'none' (no app account) or an account uuid
  filter: 'chats' | 'logs' | 'all' | 'deletable' | 'uploads' | 'old'
  sort: 'recent' | 'size' | 'tokens'
  olderDays: number
  page: number
}

// A running delete or clear: `done` of `total` sessions handled, `bytes` freed so far.
export type Work = { label: string; done: number; total: number; bytes: number }

// The tile whose card is open below the tiles.
export type Card = '' | 'logs' | 'uploads' | 'old' | 'accounts'

// What is inside one session, for the View card.
export type Peek = {
  id: string
  title: string
  isLoading: boolean
  error?: string
  first?: string
  last?: string
  branch?: string
  model?: string
  uploads?: number
  promptCount?: number
  firstPrompts?: string[]
  lastPrompt?: string
  lastReplies?: string[]
  tools?: [string, number][]
  files?: string[]
}

export type Pending = {
  action: 'delete' | 'strip' | 'move' | 'restore'
  ids: string[]
  label: string
  bytes: number
  isQueued?: boolean // confirmed while a scan ran; starts when the scan ends
}

// The Diagnostics box: the helper's report (no emails, ids or user names), ready to copy.
export type Diag = { isLoading: boolean; report?: string; error?: string; isCopied?: boolean }

// Whether the helper's Node.js was found: '' found (or not checked yet), 'missing', 'installing'.
export type NodeState = '' | 'missing' | 'installing'

declare module 'claude-code' {
  interface PluginState {
    'session-manager': {
      scan: Shaped<ScanResult | null>
      view: Shaped<View>
      busy: string
      pending: Shaped<Pending | null>
      note: string
      work: Shaped<Work | null>
      card: Card
      cardPage: number
      peek: Shaped<Peek | null>
      node: NodeState
      widget: boolean // open the small Sessions widget when a desktop session starts
      diag: Shaped<Diag | null>
    }
  }
}
