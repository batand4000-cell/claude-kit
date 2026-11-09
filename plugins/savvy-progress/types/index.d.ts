export type Phase = 'plan' | 'design' | 'delegate' | 'review' | 'close'

export type PlannedTask = {
  title: string
  tier: string
  after: number[]
}

export type Flow = {
  title: string
  total: number
  done: number
  running: number
  phase: Phase
  isFinished: boolean
  tasks: PlannedTask[]
}

export type AgentStatus = 'running' | 'done' | 'failed'

export type AgentRun = {
  id: string
  agentId?: string
  type: string
  description: string
  model: string
  effort?: string
  status: AgentStatus
  startedAt: number
  endedAt?: number
  contextTokens: number
  contextMax: number
  tokens: number
  costUsd: number
  steps: number
  round: number
  /** Self-reported by the worker through the `step` tool. */
  stepDone?: number
  stepTotal?: number
  stepNote?: string
}

export type Panel = {
  isCompact: boolean
  isDoneCollapsed: boolean
  autoOpenedFor: string
}

/** What Clawd is saying in the band's speech bubble, and since when. */
export type Speech = {
  text: string
  at: number
}

/**
 * What the agents were last seen doing, by the kind of tool they called: sending
 * mail or messages, writing files, searching or reading, running commands.
 */
export type ActivityKind = 'signal' | 'build' | 'scan' | 'launch'

export type Activity = {
  kind: ActivityKind
  at: number
}

/** A one-off show in the band: meteors when an agent fails, a rocket when the flow finishes. */
export type Flash = {
  kind: 'meteor' | 'liftoff'
  at: number
}

declare module 'claude-code' {
  interface PluginState {
    'savvy-progress': {
      flow: Flow | null
      agents: AgentRun[]
      panel: Panel
      now: number
      say: Speech | null
      /** When Clawd last spoke; idle chatter waits IDLE_MS after it. */
      spokeAt: number
      /** Clawd acts it out beside the band while it is fresh (ACTIVITY_MS). */
      activity: Activity | null
      /** Shown for FLASH_MS after it happens. */
      flash: Flash | null
      /** When the main session last answered: the prompt cache's clock starts there. */
      answeredAt: number
      /** The cache is close to expiring and nothing runs: Clawd dozes. */
      isSleepy: boolean
    }
  }
}
