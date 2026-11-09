import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Activity, ActivityKind, AgentRun, Flash, Flow, Panel, Phase, PlannedTask, Speech } from '../types'

const flow = atom({ plugin: 'savvy-progress', key: 'flow' } as const, null)
const agents = atom({ plugin: 'savvy-progress', key: 'agents' } as const, [])
const panel = atom({ plugin: 'savvy-progress', key: 'panel' } as const, {
  isCompact: false,
  isDoneCollapsed: false,
  autoOpenedFor: '',
})
const now = atom({ plugin: 'savvy-progress', key: 'now' } as const, 0)
const say = atom({ plugin: 'savvy-progress', key: 'say' } as const, null as Speech | null)
const spokeAt = atom({ plugin: 'savvy-progress', key: 'spokeAt' } as const, 0)

// Clawd's speech bubble: how long a line stays up, and how long a quiet band
// waits before Clawd says something on its own.
const SAY_MS = 8_000
const IDLE_MS = 5 * 60_000

// What the agents are doing, from the tools they call, for Clawd to act out.
const activity = atom({ plugin: 'savvy-progress', key: 'activity' } as const, null as Activity | null)
const ACTIVITY_MS = 20_000

// One-off shows: meteors when an agent fails, a rocket when the flow finishes.
const flash = atom({ plugin: 'savvy-progress', key: 'flash' } as const, null as Flash | null)
const FLASH_MS = 7_000

// The prompt cache lives an hour after the main session's last answer; in its last
// SLEEPY_MS, with nothing running, Clawd dozes off.
const answeredAt = atom({ plugin: 'savvy-progress', key: 'answeredAt' } as const, 0)
const isSleepy = atom({ plugin: 'savvy-progress', key: 'isSleepy' } as const, false)
const CACHE_TTL_MS = 60 * 60_000
const SLEEPY_MS = 10 * 60_000

// Sending mail or messages beams a signal; writing files builds; searching and
// reading scan; running commands or starting agents launch. Other tools change nothing.
const activityOf = (tool: string): ActivityKind | null => {
  const t = tool.toLowerCase()
  if (/send|reply|forward|draft|post_?message|push_?notification/.test(t)) return 'signal'
  if (/^(write|edit|notebookedit)$|create_file|update_file|upload/.test(t)) return 'build'
  if (/^(read|grep|glob|websearch|webfetch)$|search|fetch|read_|get_|list_|query/.test(t)) return 'scan'
  if (/^(bash|powershell|agent)$|run_|execute/.test(t)) return 'launch'
  return null
}

const TOOL = 'mcp__savvy-progress__progress'
const STEP_TOOL = 'mcp__savvy-progress__step'
// Added to the end of each savvy worker's brief. Their system prompt words step
// reporting as a condition ("if the step tool appears among your tools") and they
// skip it even with the tool listed; the same request in the brief is followed.
const STEP_BRIEF = `

Progress reporting: before any other work, call \`${STEP_TOOL}\` with \`total\` (your plan in 3-8 steps) and \`done: 0\`; call it again with \`done\` and a few-word \`note\` as each step finishes. It only draws a progress bar.`
const PANE = 'savvy-agents'
const PHASES: readonly Phase[] = ['plan', 'design', 'delegate', 'review', 'close']
const TIERS: readonly string[] = ['fable', 'heavy', 'careful', 'medium', 'light']
// The tools' schemas are advice to the model, not a check: what a call may ask
// the band and the panel to draw is bounded here.
const MAX_TASKS = 200
const MAX_AFTER = 20
const MAX_TITLE = 120
// The HUD's data color, and the color of a finished flow.
const CYAN = '#3fd8ff'
const DONE = '#5fbf8f'

type ProgressInput = {
  title?: string
  total?: number
  done?: number
  phase?: Phase
  finished?: boolean
  tasks?: { title?: string; tier?: string; after?: number[] }[]
}

// ---------------------------------------------------------------------------
// Language: the `language` option, else Claude Code's `language` setting, else the
// process locale; English when nothing says Hebrew or Russian.

type Lang = 'en' | 'ru' | 'he'

const STRINGS = {
  en: {
    pane: 'Agents',
    cost: 'Cost',
    tokens: 'Tokens',
    time: 'Time',
    collapse: 'Collapse',
    expand: 'Expand',
    running: 'Running',
    finished: 'Finished',
    planned: 'Planned',
    empty: 'No subagents yet.',
    round: 'round',
    failed: 'error',
    after: 'after',
    tokensWord: 'tokens',
    agentsCount: 'agents',
    isRunning: 'running',
    isFinished: 'finished',
    isPlanned: 'planned',
    opened: 'Agents panel opened.',
    closed: 'Agents panel closed.',
    done: 'Done',
    plan: 'Plan',
    design: 'Design',
    tasks: 'Tasks',
    review: 'Review',
    busy: 'running',
    ctx: 'ctx',
    tier: { light: 'light', medium: 'medium', careful: 'careful', heavy: 'heavy', fable: 'fable', other: 'other' },
    effort: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    planReady: 'Plan ready',
    active: 'active',
    idleWord: 'idle',
    working: 'WORKING',
    standby: 'STANDBY',
    complete: 'COMPLETE',
    actSignal: 'SENDING',
    actBuild: 'BUILDING',
    actScan: 'SCANNING',
    actLaunch: 'RUNNING',
    taskDone: 'Done',
    taskFailed: 'Hit a snag',
    allDone: 'All done! Nice work',
    // One every 5 minutes while nothing runs, in order, so none repeats for over two hours.
    idle: [
      'Still here if you need me',
      'Tiny crab, big plans',
      'Snip snap, ready when you are',
      'Stretching my claws…',
      'I polished the progress bar',
      'Sideways is my favorite direction',
      'You’re doing great',
      'Counting stars… 41, 42…',
      'Floating. Very professional.',
      'This helmet fogs up when I think hard',
      'Spotted a black hole. Waved. It didn’t wave back',
      'Zero gravity, zero bugs. Hopefully',
      'Orbiting your project. Looks nice from here',
      'Fun fact: crabs are great astronauts',
      'Tidying the asteroid belt',
      'Naming a star after you',
      'My antenna picks up good vibes',
      'Hydrated? Space crabs drink water too',
      'Moonwalking. Sideways, of course',
      'Ground control, all quiet here',
      'Charting a course for your next idea',
      'Collected 3 space rocks. Want one?',
      'The galaxy says hi',
      'Mission log: still adorable',
      'Ready for liftoff whenever you are',
      'Is it snack time on Earth?',
      'Stargazing until you need me',
      'Every big project starts tiny. Like me',
    ],
  },
  ru: {
    pane: 'Агенты',
    cost: 'Стоимость',
    tokens: 'Токены',
    time: 'Время',
    collapse: 'Свернуть',
    expand: 'Развернуть',
    running: 'Работают',
    finished: 'Завершены',
    planned: 'Запланированы',
    empty: 'Субагентов пока нет.',
    round: 'раунд',
    failed: 'ошибка',
    after: 'после',
    tokensWord: 'токенов',
    agentsCount: 'агентов',
    isRunning: 'работает',
    isFinished: 'завершён',
    isPlanned: 'запланирована',
    opened: 'Панель агентов открыта.',
    closed: 'Панель агентов закрыта.',
    done: 'Готово',
    plan: 'План',
    design: 'Дизайн',
    tasks: 'Задачи',
    review: 'Ревью',
    busy: 'в работе',
    ctx: 'ctx',
    tier: { light: 'light', medium: 'medium', careful: 'careful', heavy: 'heavy', fable: 'fable', other: 'other' },
    effort: { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max' },
    planReady: 'План готов',
    active: 'активны',
    idleWord: 'простой',
    working: 'РАБОТАЕТ',
    standby: 'ОЖИДАНИЕ',
    complete: 'ГОТОВО',
    actSignal: 'ОТПРАВКА',
    actBuild: 'СТРОЮ',
    actScan: 'ПОИСК',
    actLaunch: 'ЗАПУСК',
    taskDone: 'Готово',
    taskFailed: 'Что-то пошло не так',
    allDone: 'Всё готово! Отличная работа',
    idle: [
      'Я тут, если что',
      'Маленький краб, большие планы',
      'Щёлк-щёлк, жду команды',
      'Разминаю клешни…',
      'Я протёр прогресс-бар',
      'Боком ходить удобнее',
      'У тебя отлично получается',
      'Считаю пузырьки… 41, 42…',
    ],
  },
  he: {
    pane: 'סוכנים',
    cost: 'עלות',
    tokens: 'טוקנים',
    time: 'זמן',
    collapse: 'כיווץ',
    expand: 'הרחבה',
    running: 'פועלים',
    finished: 'הסתיימו',
    planned: 'מתוכננים',
    empty: 'עדיין אין סוכנים.',
    round: 'סבב',
    failed: 'שגיאה',
    after: 'אחרי',
    tokensWord: 'טוקנים',
    agentsCount: 'סוכנים',
    isRunning: 'פועל',
    isFinished: 'הסתיים',
    isPlanned: 'מתוכנן',
    opened: 'חלונית הסוכנים נפתחה.',
    closed: 'חלונית הסוכנים נסגרה.',
    done: 'הושלם',
    plan: 'תכנון',
    design: 'עיצוב',
    tasks: 'משימות',
    review: 'בדיקה',
    busy: 'בעבודה',
    ctx: 'הקשר',
    tier: { light: 'קל', medium: 'בינוני', careful: 'זהיר', heavy: 'כבד', fable: 'פייבל', other: 'אחר' },
    effort: { low: 'נמוך', medium: 'בינוני', high: 'גבוה', xhigh: 'גבוה מאוד', max: 'מקסימלי' },
    planReady: 'התוכנית מוכנה',
    active: 'פעילים',
    idleWord: 'במנוחה',
    working: 'פועל',
    standby: 'בהמתנה',
    complete: 'הושלם',
    actSignal: 'שולח',
    actBuild: 'בונה',
    actScan: 'סורק',
    actLaunch: 'מריץ',
    taskDone: 'הושלם',
    taskFailed: 'משהו השתבש',
    allDone: 'הכול מוכן! עבודה יפה',
    idle: [
      'אני כאן אם צריך',
      'סרטן קטן, תוכניות גדולות',
      'קליק-קלאק, מוכן כשאתם מוכנים',
      'מותח את הצבתות…',
      'ניקיתי את פס ההתקדמות',
      'הצידה זה הכיוון האהוב עליי',
      'אתם עושים עבודה מצוינת',
      'סופר בועות… 41, 42…',
    ],
  },
} as const

// Module scope is fine here: session.start sets it again on every (re)load.
let lang: Lang = 'en'
const tr = () => STRINGS[lang]

// Hebrew draws every row mirrored: crab and title on the right, numbers on the left.
const isRtl = () => lang === 'he'

// Tier and effort words as shown; anything unknown shows as it came.
const tierWord = (tier: string): string => (tr().tier as Record<string, string>)[tier] ?? tier
const effortWord = (effort: string): string => (tr().effort as Record<string, string>)[effort] ?? effort

const isRussian = (v: unknown): boolean => typeof v === 'string' && /^(ru|russian|рус)/i.test(v.trim())
const isHebrew = (v: unknown): boolean => typeof v === 'string' && /^(he|iw|hebrew|עברית)/i.test(v.trim())
const langOf = (v: unknown): Lang => (isHebrew(v) ? 'he' : isRussian(v) ? 'ru' : 'en')

async function detectLang($: EngineInterface, option: unknown): Promise<Lang> {
  if (option === 'en' || option === 'ru' || option === 'he') return option
  try {
    const settings = (await $.settings.read()) as Record<string, unknown>
    if (typeof settings.language === 'string' && settings.language.trim()) return langOf(settings.language)
  } catch {
    // No settings: fall through to the locale.
  }
  const locale = (await $.env.get('LC_ALL')) || (await $.env.get('LC_MESSAGES')) || (await $.env.get('LANG'))
  return langOf(locale)
}

const blank = (): Flow => ({
  title: 'savvy-flow',
  total: 0,
  done: 0,
  running: 0,
  phase: 'plan',
  isFinished: false,
  tasks: [],
})

const isNewFlow = (prev: Flow | null, input: ProgressInput): boolean =>
  !prev || prev.isFinished || (input.title !== undefined && clip(input.title.trim(), MAX_TITLE) !== prev.title)

// Only a known tier is kept: the name is later a key into the tier tables.
const tierName = (v: string): string => {
  const t = v.replace(/^savvy-/, '').trim().toLowerCase()
  return TIERS.includes(t) ? t : ''
}

const cleanTasks = (tasks: ProgressInput['tasks']): PlannedTask[] | undefined =>
  tasks
    ?.filter(t => t.title?.trim())
    .slice(0, MAX_TASKS)
    .map(t => ({
      title: (t.title ?? '').trim(),
      tier: tierName(t.tier ?? ''),
      after: (t.after ?? []).filter(n => Number.isInteger(n) && n > 0).slice(0, MAX_AFTER),
    }))

const merge = (prev: Flow | null, input: ProgressInput): Flow => {
  // A new title means a new flow: never carry counters over from an earlier one.
  const base = isNewFlow(prev, input) || !prev ? blank() : { ...blank(), ...prev }
  const tasks = cleanTasks(input.tasks) ?? base.tasks
  const total = Math.min(MAX_TASKS, Math.max(0, Math.round(input.total ?? (input.tasks ? tasks.length : base.total))))
  const done = Math.min(total || Infinity, Math.max(0, Math.round(input.done ?? base.done)))
  const phase = input.phase && PHASES.includes(input.phase) ? input.phase : base.phase
  return {
    ...base,
    title: clip(input.title?.trim() || base.title, MAX_TITLE),
    total,
    done,
    phase: input.finished ? 'close' : phase,
    isFinished: input.finished === true,
    tasks,
  }
}

const label = (f: Flow): string => {
  const s = tr()
  if (f.isFinished) return s.done
  if (f.phase === 'plan') return s.plan
  if (f.phase === 'design') return s.design
  const count = f.total ? `${f.done}/${f.total}` : `${f.running} ${s.busy}`
  return `${f.phase === 'review' ? s.review : s.tasks} ${count}`
}

const ratio = (f: Flow): number => (f.isFinished ? 1 : f.total ? f.done / f.total : 0)

// The whole row is one SVG: the desktop wraps sibling elements onto new lines,
// so the gauge, readouts, status, crab and its callout live in one drawing; only
// the count and the dismiss are Buttons beside it. Nothing moves unless an agent
// is running.
const H = 46
// The crab's drawing grid is 30 units wide, props included.
const CRAB_BOX = 30
const BAND_CRAB = 0.7
const FONT = "-apple-system,BlinkMacSystemFont,'SF Pro Text','Segoe UI',sans-serif"
const HUD = "'Cascadia Mono','SF Mono',Consolas,ui-monospace,monospace"

const xml = (s: string): string =>
  s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

const clip = (s: string, max: number): string => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s)

// CJK, fullwidth forms and emoji advance about 1em; at 0.56em a Chinese title was sized at half its width and the bar drew over it.
// 中日韩文字、全角标点和 emoji 约占 1em；按 0.56em 算时中文标题宽度被低估近一半，进度条会压到标题上。
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA960-\uA97F\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF01-\uFF60\uFFE0-\uFFE6\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u

// Rough advance of system UI text, in em; good enough to size the title's slot.
const charEm = (ch: string): number =>
  WIDE.test(ch) ? 1 : /[\s.,:;'|!il1()[\]]/.test(ch) ? 0.3 : /[A-ZА-ЯЁmwшщжюМШЩЖЮ@%]/.test(ch) ? 0.72 : 0.56

const textWidth = (s: string, size: number): number => [...s].reduce((w, ch) => w + charEm(ch) * size, 0)

// Cuts `s` to fit `maxW` pixels, with an ellipsis when it had to cut.
const fitText = (s: string, size: number, maxW: number): string => {
  if (textWidth(s, size) <= maxW) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(out + ch + '…', size) > maxW) break
    out += ch
  }
  return out + '…'
}

// The band: a galaxy panel that blends into Claude (its background and text colors,
// a faint haze and stars), a ringed planet as the progress gauge, labeled readouts,
// a status word and Clawd the astronaut with a speech bubble.
type Readout = { label: string; value: string }
type BandState = 'working' | 'standby' | 'complete'

// What the band reads out, each with its name: tasks, agents, tokens, cost.
const bandReadouts = (f: Flow | null, list: AgentRun[], at: number): Readout[] => {
  const s = tr()
  const t = totals(list, at)
  const active = list.filter(a => a.status === 'running').length
  const out: Readout[] = []
  if (f) out.push({ label: s.tasks, value: f.isFinished ? s.done : f.total ? `${f.done} / ${f.total}` : label(f) })
  out.push({ label: s.pane, value: active ? `${active} ${s.active}` : s.idleWord })
  if (list.length) {
    out.push({ label: s.tokens, value: fmtTokens(t.tokens) })
    out.push({ label: s.cost, value: fmtCost(t.cost) })
  }
  return out
}

const CELL_PAD = 12
const mono = (s: string, size: number): number => [...s].length * size * 0.62
const cellWidth = (r: Readout): number => Math.max(mono(r.label.toUpperCase(), 8) + r.label.length * 1.5, mono(r.value, 12)) + CELL_PAD * 2

// Galaxy look, matching session-band's: Claude's own background and text colors in
// light and dark mode, a faint galaxy haze with stars, and Claude's clay as accent.
const SKY_CLAY = '#D97757'
const SKY_LILAC = '#8B5CF6'
const SKY_GOLD = '#E8A15E'

// Deterministic noise: the same seed draws the same sky on every redraw.
const skyRand = (i: number, k: number): number => {
  const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// A seed for this session's sky, from its id.
const skySeed = (id: string): number => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 7)

const skyStars = (W: number, Hh: number, seed: number): string =>
  Array.from({ length: Math.round(W / 10) }, (_, i) => {
    const x = (skyRand(i, seed) * W).toFixed(1)
    const y = (skyRand(i, seed + 1) * Hh).toFixed(1)
    const r = skyRand(i, seed + 2) < 0.12 ? 0.85 : 0.45
    const o = (0.3 + skyRand(i, seed + 3) * 0.6).toFixed(2)
    const tw = i % 5 === 0 ? ` class="tw" style="animation-delay:-${(skyRand(i, 9) * 3).toFixed(2)}s"` : ''
    return `<circle${tw} cx="${x}" cy="${y}" r="${r}" opacity="${o}"/>`
  }).join('')

const SKY_CSS = `.bg{fill:#F5F3EE}.edge{fill:none;stroke:#1F1E1D;stroke-opacity:.08}.haze{opacity:.5}.stars{fill:#6F6488;opacity:.45}
.lb{fill:#8A8780}.vl{fill:#1F1E1D}.sep{fill:#1F1E1D;fill-opacity:.08}.trk{stroke:#1F1E1D;stroke-opacity:.16}
.st{fill:#8A8780}.go .st{fill:${SKY_CLAY}}.done .st{fill:#2F8F5B}.bb{fill:#FFFFFF;stroke:${SKY_CLAY};stroke-opacity:.55}.bt{fill:#1F1E1D}
@media (prefers-color-scheme: dark){.bg{fill:#2B2A27}.edge{stroke:#fff}.haze{opacity:1}.stars{fill:#fff;opacity:.85}
.lb{fill:#A6A39B}.vl{fill:#ECEAE4}.sep{fill:#fff;fill-opacity:.08}.trk{stroke:#fff;stroke-opacity:.2}
.st{fill:#A6A39B}.go .st{fill:${SKY_GOLD}}.done .st{fill:#7EE0B0}.bb{fill:#1E1B2A}.bt{fill:#ECEAE4}}
.pop{transform-box:fill-box;animation:pop .22s ease-out 1}@keyframes pop{from{transform:scale(.4);opacity:0}}
@media (prefers-reduced-motion: reduce){.pop{animation:none}}`

// The motion, written only while an agent runs.
const skyMotion = (W: number): string => `.tw{animation:tw 2.4s ease-in-out infinite}@keyframes tw{50%{opacity:.1}}
.shoot{animation:shoot 5s ease-in infinite}@keyframes shoot{0%{transform:translate(-60px,-6px);opacity:0}8%{opacity:1}30%{transform:translate(${Math.round(W * 0.55)}px,26px);opacity:0}100%{transform:translate(${Math.round(W * 0.55)}px,26px);opacity:0}}
.swirl{animation:swirl 1.6s linear infinite}@keyframes swirl{to{stroke-dashoffset:-19}}
.wave{animation:wave 1.5s ease-out infinite}@keyframes wave{0%{opacity:0}20%{opacity:1}100%{opacity:0;transform:translate(6px,-4px)}}
.hammer{animation:hit .55s ease-in-out infinite}@keyframes hit{0%,100%{transform:rotate(-38deg)}55%{transform:rotate(8deg)}}
.spark{animation:spark .55s steps(1) infinite}@keyframes spark{0%,45%{opacity:0}55%,85%{opacity:1}}
.glint{animation:glint 1.2s steps(1) infinite}@keyframes glint{50%{opacity:.15}}
.look{animation:look 3s ease-in-out infinite}@keyframes look{50%{transform:rotate(-12deg)}}
.rocket{animation:fly 1.8s ease-in infinite}@keyframes fly{0%{transform:translateY(4px);opacity:0}15%{opacity:1}100%{transform:translateY(-14px);opacity:0}}
.flame{animation:flame .2s steps(1) infinite}@keyframes flame{50%{transform:scaleY(.6)}}
@media (prefers-reduced-motion: reduce){.tw,.shoot,.swirl,.wave,.hammer,.spark,.glint,.look,.rocket,.flame{animation:none}}`

// Clawd's prop for what the agents are doing, in a 26×H box at x: a satellite beaming
// signal arcs (mail and messages), a hammer shaping a space rock (writing files), a
// telescope (searching and reading) or a rocket lifting off (running commands).
const skyProp = (kind: ActivityKind, x: number, Hh: number): string => {
  const cy = Hh / 2
  if (kind === 'signal')
    return `<g transform="rotate(-20 ${x + 9} ${cy})">
<rect x="${x + 1}" y="${cy - 2}" width="5" height="4" fill="#8B5CF6"/><rect x="${x + 12}" y="${cy - 2}" width="5" height="4" fill="#8B5CF6"/>
<path d="M${x + 1} ${cy}h16" stroke="#C4B5FD" stroke-width=".5"/>
<rect x="${x + 6.5}" y="${cy - 3}" width="5" height="6" rx="1" fill="#C9C2D6"/>
<path d="M${x + 9} ${cy - 3}v-3" stroke="#C9C2D6"/><circle cx="${x + 9}" cy="${cy - 6.5}" r="1.2" fill="${SKY_CLAY}"/></g>
${[0, 1, 2].map(i => `<path class="wave" style="animation-delay:${(i * 0.5).toFixed(1)}s" d="M${x + 14 + i * 3} ${cy - 11 - i}a${5 + i * 3} ${5 + i * 3} 0 0 1 ${4 + i * 2} ${5 + i * 2}" fill="none" stroke="${SKY_LILAC}" stroke-width="1.2" stroke-linecap="round"/>`).join('')}`
  if (kind === 'build')
    return `<path d="M${x + 3} ${cy + 9}l3-6 6-2 6 3 2 5-4 3h-9z" fill="#6D5A99"/><path d="M${x + 7} ${cy + 4}l3 1M${x + 13} ${cy + 3}l1 3" stroke="#A99BC6" stroke-width=".8"/>
<g class="hammer" style="transform-origin:${x + 22}px ${cy + 2}px"><path d="M${x + 22} ${cy + 2}l-8-8" stroke="#A88B6A" stroke-width="1.6" stroke-linecap="round"/><rect x="${x + 10.5}" y="${cy - 9.5}" width="6" height="3.4" rx=".6" transform="rotate(-45 ${x + 13.5} ${cy - 7.8})" fill="#C9C2D6"/></g>
<g class="spark" fill="${SKY_GOLD}"><circle cx="${x + 9}" cy="${cy - 1}" r=".9"/><circle cx="${x + 5}" cy="${cy}" r=".7"/><circle cx="${x + 11}" cy="${cy - 3}" r=".6"/></g>`
  if (kind === 'scan')
    return `<g class="look" style="transform-origin:${x + 10}px ${cy + 6}px"><rect x="${x + 3}" y="${cy - 4}" width="16" height="5" rx="1.5" transform="rotate(-28 ${x + 10} ${cy})" fill="#8B5CF6"/>
<circle class="glint" cx="${x + 18}" cy="${cy - 6}" r="1.6" fill="#E9D5FF"/></g>
<path d="M${x + 10} ${cy + 1}l-4 9M${x + 10} ${cy + 1}l4 9" stroke="#A99BC6" stroke-width="1.1" stroke-linecap="round"/>
<path d="M${x + 22} ${cy - 13}l.8 1.6 1.6.8-1.6.8-.8 1.6-.8-1.6-1.6-.8 1.6-.8z" fill="#E9D5FF"/>`
  return `<g class="rocket"><path d="M${x + 13} ${cy - 10}c3 3 3 9 0 13h-4c-3-4-3-10 0-13 1-1.2 3-1.2 4 0z" transform="translate(-2 0)" fill="#E8E2F2"/>
<circle cx="${x + 11}" cy="${cy - 4}" r="1.6" fill="#8B5CF6"/><path d="M${x + 7} ${cy + 1}l-2 4h3zM${x + 15} ${cy + 1}l2 4h-3z" fill="${SKY_CLAY}"/>
<path class="flame" style="transform-origin:${x + 11}px ${cy + 3}px" d="M${x + 9} ${cy + 3}h4l-2 5z" fill="${SKY_GOLD}"/></g>`
}

const skyBackdrop = (W: number, Hh: number, seed: number, isWorking: boolean): string => `
<defs>
<radialGradient id="haze1" cx="${0.45 + skyRand(seed, 1) * 0.4}" cy="0.25" r="0.6"><stop offset="0" stop-color="#A78BFA" stop-opacity=".3"/><stop offset=".5" stop-color="${SKY_LILAC}" stop-opacity=".14"/><stop offset="1" stop-color="${SKY_LILAC}" stop-opacity="0"/></radialGradient>
<radialGradient id="haze2" cx="0.15" cy="1" r="0.5"><stop offset="0" stop-color="${SKY_CLAY}" stop-opacity=".14"/><stop offset="1" stop-color="${SKY_CLAY}" stop-opacity="0"/></radialGradient>
<linearGradient id="trail"><stop offset="0" stop-color="${SKY_CLAY}" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".9"/></linearGradient>
<clipPath id="box"><rect x="0.5" y="0.5" width="${W - 1}" height="${Hh - 1}" rx="10"/></clipPath>
</defs>
<rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${Hh - 1}" rx="10"/>
<g clip-path="url(#box)">
<g class="haze"><rect width="${W}" height="${Hh}" fill="url(#haze1)"/><rect width="${W}" height="${Hh}" fill="url(#haze2)"/></g>
<g class="stars">${skyStars(W, Hh, seed)}</g>
${isWorking ? `<g class="shoot"><rect width="46" height="1.2" rx=".6" fill="url(#trail)" transform="rotate(14)"/></g>` : ''}
</g>`

// A black hole: a purple halo, an accretion disk from lilac through violet to clay,
// a black core with a thin photon ring. The disk's far half passes behind the core
// and its near half in front. With `pct` the disk is a gauge: only that share of it
// is lit. While working, streaks swirl around the disk.
const skyBlackHole = (cx: number, cy: number, isWorking: boolean, pct: number | null = null, isDone = false): string => {
  const rx = 13
  const ry = 3.8
  const per = Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry)))
  const tilt = `transform="rotate(-14 ${cx} ${cy})"`
  const lit = pct === null ? per : per * Math.min(1, Math.max(0, pct))
  const disk = isDone ? 'url(#diskDone)' : 'url(#disk)'
  const rings = `<ellipse class="trk" cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke-width="2.4"/>
<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${disk}" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="${lit.toFixed(1)} ${per.toFixed(1)}" transform="rotate(180 ${cx} ${cy})"/>
<ellipse${isWorking ? ' class="swirl"' : ''} cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="#fff" stroke-opacity=".55" stroke-width=".7" stroke-dasharray="2.5 7"/>`
  return `<defs>
<linearGradient id="disk" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#C4B5FD"/><stop offset=".5" stop-color="#8B5CF6"/><stop offset="1" stop-color="#D97757"/></linearGradient>
<linearGradient id="diskDone" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#A7F3D0"/><stop offset="1" stop-color="#8B5CF6"/></linearGradient>
<radialGradient id="halo"><stop offset=".35" stop-color="#8B5CF6" stop-opacity=".45"/><stop offset="1" stop-color="#8B5CF6" stop-opacity="0"/></radialGradient>
<clipPath id="near"><rect x="${cx - 20}" y="${cy}" width="40" height="20"/></clipPath>
</defs>
<circle cx="${cx}" cy="${cy}" r="14" fill="url(#halo)"/>
<g ${tilt}>${rings}</g>
<circle cx="${cx}" cy="${cy}" r="5.4" fill="#05030A"/>
<circle cx="${cx}" cy="${cy}" r="5.9" fill="none" stroke="#E9D5FF" stroke-opacity=".9" stroke-width=".7"/>
<g ${tilt} clip-path="url(#near)">${rings}</g>`
}

// Far-off things for the empty parts of a panel, one kind per call, at (x, y).
const SKY_DECOR = ['galaxy', 'ringed', 'moon', 'belt', 'comet', 'nebula', 'planet'] as const
type SkyDecor = (typeof SKY_DECOR)[number]

const skyDecor = (kind: SkyDecor, x: number, y: number, k: number): string => {
  if (kind === 'galaxy')
    return `<defs><radialGradient id="dg${k}"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset=".3" stop-color="#A78BFA" stop-opacity=".5"/><stop offset="1" stop-color="#8B5CF6" stop-opacity="0"/></radialGradient></defs>
<g transform="rotate(-24 ${x} ${y})"><ellipse cx="${x}" cy="${y}" rx="20" ry="5.5" fill="url(#dg${k})"/><ellipse cx="${x}" cy="${y}" rx="8" ry="2" fill="none" stroke="#fff" stroke-opacity=".3" stroke-width=".6"/></g>`
  if (kind === 'ringed')
    return `<g transform="rotate(-18 ${x} ${y})"><ellipse cx="${x}" cy="${y}" rx="9" ry="2.4" fill="none" stroke="#E8A15E" stroke-opacity=".7" stroke-width="1"/></g>
<circle cx="${x}" cy="${y}" r="4.2" fill="#B98AE0"/><circle cx="${x + 1.6}" cy="${y - 0.8}" r="3.8" fill="#000" opacity=".25"/>
<g transform="rotate(-18 ${x} ${y})"><path d="M${x - 9} ${y}A9 2.4 0 0 0 ${x + 9} ${y}" fill="none" stroke="#E8A15E" stroke-opacity=".8" stroke-width="1"/></g>`
  if (kind === 'moon')
    return `<circle cx="${x}" cy="${y}" r="5.5" fill="#C9C2D6" opacity=".85"/><circle cx="${x - 1.8}" cy="${y - 1.4}" r="1.2" fill="#8E879C"/><circle cx="${x + 2}" cy="${y + 1.8}" r=".9" fill="#8E879C"/><circle cx="${x + 2.6}" cy="${y}" r="5" fill="#000" opacity=".22"/>`
  if (kind === 'belt')
    return Array.from({ length: 9 }, (_, i) => {
      const ax = x - 26 + i * 6.5 + skyRand(i, 41 + k) * 3
      const ay = y - 5 + i * 1.3 + skyRand(i, 42 + k) * 4
      const s = 0.8 + skyRand(i, 43 + k) * 1.4
      return `<path d="M${ax.toFixed(1)} ${ay.toFixed(1)}l${s} ${-s * 0.6}l${s * 0.9} ${s * 0.5}l${-s * 0.3} ${s}l${-s} ${s * 0.2}z" fill="#A99BC6" opacity="${(0.4 + skyRand(i, 44) * 0.4).toFixed(2)}"/>`
    }).join('')
  if (kind === 'comet')
    return `<defs><linearGradient id="ct${k}" x1="1" y1="0" x2="0" y2="0"><stop offset="0" stop-color="#E9D5FF" stop-opacity=".9"/><stop offset="1" stop-color="#8B5CF6" stop-opacity="0"/></linearGradient></defs>
<path d="M${x} ${y}l-26 7l26-4.4z" fill="url(#ct${k})"/><circle cx="${x}" cy="${y}" r="1.8" fill="#fff"/>`
  if (kind === 'nebula')
    return `<defs><radialGradient id="nb${k}"><stop offset="0" stop-color="#C084FC" stop-opacity=".45"/><stop offset=".6" stop-color="#8B5CF6" stop-opacity=".15"/><stop offset="1" stop-color="#8B5CF6" stop-opacity="0"/></radialGradient></defs>
<ellipse cx="${x}" cy="${y}" rx="26" ry="11" fill="url(#nb${k})"/><ellipse cx="${x + 9}" cy="${y + 3}" rx="14" ry="7" fill="url(#nb${k})"/>`
  return `<defs><radialGradient id="pp${k}" cx=".35" cy=".3"><stop offset="0" stop-color="#9FD8FF"/><stop offset="1" stop-color="#4C3A9E"/></radialGradient></defs>
<circle cx="${x}" cy="${y}" r="5" fill="url(#pp${k})"/><circle cx="${x + 2}" cy="${y - 1}" r="4.6" fill="#000" opacity=".25"/>`
}

// Two different far-off things for this session's sky, picked by its seed.
const skyDecorPair = (seed: number): [SkyDecor, SkyDecor] => {
  const a = Math.floor(skyRand(seed, 5) * SKY_DECOR.length)
  const b = (a + 1 + Math.floor(skyRand(seed, 6) * (SKY_DECOR.length - 1))) % SKY_DECOR.length
  return [SKY_DECOR[a] ?? 'galaxy', SKY_DECOR[b] ?? 'moon']
}

// `speech` is what Clawd says in a bubble beside it, if anything.
// One-off shows, played a few times and then gone even if the band is not redrawn:
// three red meteors streaking down across the band when an agent fails, or a rocket
// lifting off from the black hole when the whole flow is done.
const skyFlash = (kind: Flash['kind'], W: number, Hh: number): string => {
  if (kind === 'meteor') {
    const one = (i: number) => {
      const x = W * (0.3 + i * 0.22)
      return `<g class="met" style="animation-delay:${(i * 0.35).toFixed(2)}s"><path d="M${x} -6l-34 ${Hh * 0.55}" stroke="url(#metTrail)" stroke-width="2" stroke-linecap="round"/><circle cx="${x - 34}" cy="${(Hh * 0.55 - 6).toFixed(1)}" r="2.2" fill="#FFD2C2"/></g>`
    }
    return `<defs><linearGradient id="metTrail" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#FF6B5A" stop-opacity="0"/><stop offset="1" stop-color="#FF6B5A"/></linearGradient></defs>
<style>.met{opacity:0;animation:met 1.1s ease-in 3 both}@keyframes met{0%{opacity:0;transform:translate(0,0)}15%{opacity:1}100%{opacity:0;transform:translate(-26px,${Hh * 0.6}px)}}
@media (prefers-reduced-motion: reduce){.met{animation:none;opacity:.8}}</style>
<g clip-path="url(#box)">${[0, 1, 2].map(one).join('')}</g>`
  }
  return `<style>.lift{opacity:0;animation:lift 2.2s cubic-bezier(.4,0,.9,.6) 2 both}@keyframes lift{0%{opacity:0;transform:translate(0,0)}10%{opacity:1}100%{opacity:0;transform:translate(${Math.round(W * 0.45)}px,-${Hh + 30}px)}}
.lf{animation:flame .2s steps(1) 22}@keyframes flame{50%{transform:scaleY(.6)}}
@media (prefers-reduced-motion: reduce){.lift{animation:none;opacity:1}}</style>
<g clip-path="url(#box)"><g class="lift"><g transform="translate(40 ${Hh - 6}) rotate(35) scale(1.3)">
<path d="M0 -12c3 3 3 9 0 13h-4c-3-4-3-10 0-13 1-1.2 3-1.2 4 0z" transform="translate(2 0)" fill="#F4EFE6"/>
<circle cx="0" cy="-6" r="1.6" fill="#8B5CF6"/><path d="M-4 -1l-2 4h3zM4 -1l2 4h-3z" fill="${SKY_CLAY}"/>
<path class="lf" style="transform-origin:0 1px" d="M-2 1h4l-2 6z" fill="${SKY_GOLD}"/></g></g></g>`
}

// Sleepy Clawd: a few z's drifting up from its helmet (still, like the rest of standby).
const skyZzz = (x: number, y: number): string =>
  `<g class="lb" font-family="${FONT}" font-style="italic" font-weight="600"><text x="${x}" y="${y}" font-size="7">z</text><text x="${x + 5}" y="${y - 5}" font-size="9">z</text><text x="${x + 11}" y="${y - 11}" font-size="11">Z</text></g>`

// `act` is what the agents are doing right now, if anything: Clawd holds its prop and
// the status names it. `show` is a one-off show to play; `sleepy` has Clawd doze.
const bandSvg = (all: Readout[], pct: number | null, state: BandState, W: number, speech = '', seed = 0, act: ActivityKind | null = null, show: Flash['kind'] | null = null, sleepy = false): string => {
  const s = tr()
  const live = state === 'working'
  const isDone = state === 'complete'
  const crabW = CRAB_BOX * BAND_CRAB
  const doing = live ? act : null
  const PROP_W = doing ? 28 : 0
  const ACT_WORD: Record<ActivityKind, string> = { signal: s.actSignal, build: s.actBuild, scan: s.actScan, launch: s.actLaunch }
  const status = doing ? ACT_WORD[doing] : state === 'working' ? s.working : isDone ? s.complete : s.standby
  const statusW = mono(status, 9) + status.length * 1.5 + 18
  // Readouts that would run under the status or Clawd are left out, from the end.
  const GAUGE = 70
  const cells = [...all]
  while (cells.length > 1 && GAUGE + cells.reduce((w, r) => w + cellWidth(r), 0) > W - statusW - crabW - PROP_W - 24) cells.pop()

  const parts: string[] = []
  let x = GAUGE
  for (const r of cells) {
    parts.push(`<rect class="sep" x="${x}" y="10" width="1" height="${H - 20}"/>`)
    parts.push(`<text class="lb" x="${x + CELL_PAD}" y="18" font-family="${HUD}" font-size="8" letter-spacing="1.5">${xml(r.label.toUpperCase())}</text>`)
    parts.push(`<text class="vl" x="${x + CELL_PAD}" y="33" font-family="${HUD}" font-size="12" font-variant-numeric="tabular-nums">${xml(r.value)}</text>`)
    x += cellWidth(r)
  }

  // Two far-off things in the gap between the readouts and the status, when it is wide.
  const sx = W - crabW - 16 - PROP_W - statusW
  const gap = sx - x
  const decor = skyDecorPair(seed)
  const far =
    gap > 150
      ? `<g clip-path="url(#box)">${skyDecor(decor[0], x + gap * 0.3, H * 0.42, 1)}${gap > 230 ? skyDecor(decor[1], x + gap * 0.72, H * 0.58, 2) : ''}</g>`
      : ''

  // The status: a comet while working, a dot otherwise.
  const mark = live
    ? `<path d="M${sx - 2} ${H / 2 + 3}l-10 4" stroke="${SKY_CLAY}" stroke-opacity=".5" stroke-width="1.4" stroke-linecap="round"/><circle class="st" cx="${sx + 1}" cy="${H / 2 + 1.8}" r="2.6"/>`
    : `<circle class="st" cx="${sx + 1}" cy="${H / 2}" r="2.6" opacity="${isDone ? 1 : 0.6}"/>`

  // Clawd's bubble opens toward the readouts, opaque over anything under it.
  let bubble = ''
  if (speech) {
    const size = 10
    const text = fitText(speech, size, Math.min(320, W - crabW - GAUGE - 40))
    const bw = Math.ceil(textWidth(text, size) + 16)
    const bx = W - crabW - 14 - bw
    const by = H / 2 - 10
    bubble = `<g class="pop" style="transform-origin:100% 50%">
<path class="bb" d="M${bx + bw - 1} ${H / 2 - 3}l7 3-7 3z"/>
<rect class="bb" x="${bx}" y="${by}" width="${bw}" height="20" rx="10"/>
<text class="bt" x="${bx + bw / 2}" y="${H / 2 + 3.5}" text-anchor="middle" font-family="${FONT}" font-size="${size}">${xml(text)}</text>
</g>`
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>${SKY_CSS}${live ? skyMotion(W) : ''}</style>
${skyBackdrop(W, H, seed, live)}
${far}
<g class="${live ? 'go' : isDone ? 'done' : 'idle'}">
${skyBlackHole(24, H / 2, live, pct ?? 0, isDone)}
<text class="vl" x="46" y="${H / 2 + 4}" font-family="${HUD}" font-size="11">${pct === null ? '—' : Math.round(pct * 100) + '%'}</text>
${parts.join('')}
${mark}
<text class="st" x="${sx + 12}" y="${H / 2 + 3.2}" font-family="${HUD}" font-size="9" letter-spacing="1.5">${xml(status)}</text>
</g>
${doing ? skyProp(doing, W - crabW - 10 - PROP_W, H) : ''}
${CRAB_CSS}${crab(W - crabW - 8, H / 2 - 14, 'fable', sleepy && !live, live, BAND_CRAB)}
${sleepy && !live && !speech ? skyZzz(W - crabW - 15, H / 2 - 5) : ''}
${show ? skyFlash(show, W, H) : ''}
${bubble}
<rect class="edge" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10"/>
</svg>`
}

// ---------------------------------------------------------------------------
// Agents panel: every subagent of the session, plus the tasks the flow planned.

const TIER_COLOR: Record<string, string> = {
  fable: '#7F77DD',
  heavy: '#D85A30',
  careful: '#BA7517',
  medium: '#378ADD',
  light: '#1D9E75',
  other: '#888780',
}

// What each savvy tier runs on, for planned tasks that have no run yet.
const colorOf = (tier: string): string => TIER_COLOR[tier] ?? '#888780'

const TIER_MODEL: Record<string, [model: string, effort: string]> = {
  fable: ['Fable', 'high'],
  heavy: ['Opus', 'xhigh'],
  careful: ['Opus', 'high'],
  medium: ['Opus', 'medium'],
  light: ['Opus', 'low'],
}

// "Opus · xhigh", with the effort word in the panel's language; '' for an unknown tier.
const tierModel = (tier: string): string => {
  const m = TIER_MODEL[tier]
  return m ? `${m[0]} · ${effortWord(m[1])}` : ''
}

// "Opus 5.5 · low" for a run, or just the model when no effort was seen.
const runModel = (a: AgentRun): string => (a.effort ? `${modelName(a.model)} · ${effortWord(a.effort)}` : modelName(a.model))

// USD per million tokens: input, output, cache read, cache write. The first row that
// matches a model id wins, so a release sits above its family.
// The engine reports tokens, not money, so the panel's cost is an estimate. It reports
// one cache-write count with no split by lifetime; writes are priced at the 1-hour
// rate (2x input), which is what Claude Code writes on a subscription.
type Price = [input: number, output: number, cacheRead: number, cacheWrite: number]

const PRICES: [RegExp, Price][] = [
  [/(fable|mythos)-5-1/, [10, 50, 0.25, 20]],
  [/fable|mythos/, [10, 50, 1, 20]],
  [/opus-5-5/, [4, 20, 0.2, 8]],
  [/opus/, [5, 25, 0.5, 10]],
  [/sonnet-5-5/, [2, 10, 0.1, 4]],
  [/sonnet-5/, [2, 10, 0.2, 4]],
  [/sonnet/, [3, 15, 0.3, 6]],
  [/haiku-5-5/, [0.1, 0.5, 0.01, 0.2]],
  [/haiku/, [1, 5, 0.1, 2]],
]

// Haiku 5.5 is priced by prompt length: a request whose prompt (input, cache reads and
// cache writes together) is over 100,000 tokens pays these prices instead.
const HAIKU_LONG_PROMPT = 100_000
const HAIKU_LONG: Price = [0.5, 2.5, 0.05, 1]

type Usage = {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens: number
  cache_creation_input_tokens: number
}

const priceOf = (model: string, prompt: number): Price => {
  const id = model.toLowerCase()
  if (prompt > HAIKU_LONG_PROMPT && /haiku-5-5/.test(id)) return HAIKU_LONG
  return PRICES.find(([re]) => re.test(id))?.[1] ?? [4, 20, 0.2, 8]
}

// `isRequest` says the usage is one model request, which is what a prompt-length price
// is set by; a turn's sum is priced at the model's ordinary prices.
const costOf = (model: string, u: Usage, isRequest: boolean): number => {
  const prompt = isRequest ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) : 0
  const [i, o, r, w] = priceOf(model, prompt)
  return (
    ((u.input_tokens || 0) * i +
      (u.output_tokens || 0) * o +
      (u.cache_read_input_tokens || 0) * r +
      (u.cache_creation_input_tokens || 0) * w) /
    1e6
  )
}

// Haiku 4.5 and the Claude 3 models have a 200K window; the rest, Haiku 5.5 included, 1M.
const windowOf = (model: string): number => (/haiku-4|claude-3/i.test(model) ? 200_000 : 1_000_000)

// `savvy-careful`, or `savvy-flow:savvy-careful` when the agents ship in a plugin.
const tierOf = (type: string): string => {
  const bare = type.replace(/^[^:]*:/, '')
  const t = bare.replace(/^savvy-/, '').toLowerCase()
  return Object.hasOwn(TIER_COLOR, t) && bare.startsWith('savvy-') ? t : 'other'
}

const modelName = (id: string): string => {
  const m = /(fable|mythos|opus|sonnet|haiku)-(\d+)(?:-(\d{1,2})(?!\d))?/i.exec(id)
  const [, family = '', major = '', minor] = m ?? []
  if (!family) return id.replace(/^claude-/, '').replace(/\[.*\]$/, '') || '—'
  return `${family.charAt(0).toUpperCase()}${family.slice(1).toLowerCase()} ${major}${minor ? '.' + minor : ''}`
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()

const fmtTokens = (n: number): string =>
  n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1e3 ? `${Math.round(n / 1e3)}k` : `${Math.round(n)}`

const fmtCost = (usd: number): string => `$${usd < 10 ? usd.toFixed(2) : usd.toFixed(1)}`

const fmtTime = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

const elapsed = (a: AgentRun, at: number): number => (a.endedAt ?? Math.max(at, a.startedAt)) - a.startedAt

type Planned = PlannedTask & { n: number }

const plannedOf = (f: Flow | null, list: AgentRun[]): Planned[] => {
  if (!f || f.isFinished) return []
  const started = new Set(list.map(a => norm(a.description)))
  return (f.tasks ?? []).map((t, i) => ({ ...t, n: i + 1 })).filter(t => !started.has(norm(t.title)))
}

const totals = (list: AgentRun[], at: number) => {
  const cost = list.reduce((s, a) => s + a.costUsd, 0)
  const tokens = list.reduce((s, a) => s + a.tokens, 0)
  const start = Math.min(...list.map(a => a.startedAt))
  const end = Math.max(...list.map(a => a.endedAt ?? Math.max(at, a.startedAt)))
  return { cost, tokens, time: list.length ? end - start : 0 }
}

// --- desktop drawings: each row is one SVG, as the band above the prompt is.

// The pane's backdrop: a dotted grid as tall as the content laid over it; the
// row SVGs are transparent, so it shows through between their marks.
const GRID_STEP = 16
// A Text or Button row on the desktop is about 20px; the grid errs taller.
const LINE_H = 24
// The engine refuses an Svg taller than 4096px, so a long grid is stacked from
// tiles of at most this height; a multiple of GRID_STEP keeps the dots aligned.
const GRID_TILE = 4096
const gridTiles = (H: number) => Array.from({ length: Math.ceil(H / GRID_TILE) }, (_, i) => Math.min(GRID_TILE, H - i * GRID_TILE))
const gridSvg = (W: number, H: number) => `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>.d{fill:#d9d8d4}@media (prefers-color-scheme: dark){.d{fill:#3a3a38}}</style>
<defs><pattern id="g" width="${GRID_STEP}" height="${GRID_STEP}" patternUnits="userSpaceOnUse"><circle class="d" cx="${GRID_STEP / 2}" cy="${GRID_STEP / 2}" r="1"/></pattern></defs>
<rect width="${W}" height="${H}" fill="url(#g)"/>
</svg>`

const PANE_CSS = `<style>
.t{fill:#1f1f1f}.s{fill:#6b6b68}.m{fill:#9a9a96}.k{fill:#ecebe8}.ln{stroke:#e4e4e1}.tile{fill:#f4f3f0}
@media (prefers-color-scheme: dark){.t{fill:#ececec}.s{fill:#a8a8a4}.m{fill:#7d7d79}.k{fill:#2c2c2b}.ln{stroke:#333331}.tile{fill:#262625}}
.live{animation:p 1.6s ease-in-out infinite}@keyframes p{50%{opacity:.3}}
.spin{transform-box:fill-box;transform-origin:50% 50%;animation:rot 6s linear infinite}.rev{animation-duration:3s;animation-direction:reverse}
@keyframes rot{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.live,.spin{animation:none}}
</style>`

// Pixel Clawd from DockCrab (Clawdy): a 24×18 crab on a 30×28 grid, one costume per tier.
// The body keeps the brand clay; the tier's color lives in the costume's accent.
const CLAY = '#D97757'
const INK = '#1F1E1D'

// `cls` puts a pixel in a named group: `bd` (the default) is the body and its
// costume, `la`/`lb` the leg pairs, anything else a prop with its own motion.
type Fill = (x: number, y: number, w: number, h: number, c: string, cls?: string) => void

const stamp = (f: Fill, x: number, y: number, rows: string[], map: Record<string, string>, cls?: string): void =>
  rows.forEach((row, dy) => [...row].forEach((ch, dx) => map[ch] && f(x + dx, y + dy, 1, 1, map[ch] ?? '', cls)))

// `armCls` lets a raised claw travel with the prop it holds.
const crabBody = (f: Fill, armFront = 0, armCls?: string): void => {
  f(7, 10, 16, 12, CLAY)
  f(3, 14, 4, 4, CLAY)
  f(23, 14 + armFront, 4, 4, CLAY, armCls)
  f(9, 12, 2, 2, INK)
  f(19, 12, 2, 2, INK)
  f(7, 22, 2, 4, CLAY, 'la')
  f(17, 22, 2, 4, CLAY, 'la')
  f(11, 22, 2, 4, CLAY, 'lb')
  f(21, 22, 2, 4, CLAY, 'lb')
}

// Pure CSS, run by the compositor: no redraws. Periods divide one second, so the
// once-a-second redraw of a running row restarts them in phase. Every crab walks;
// each costume adds its prop's own motion on top.
const CRAB_CSS = `<style>
.run .la{animation:st .5s steps(1) infinite}.run .lb{animation:st .5s steps(1) infinite -.25s}
.run .bd{animation:bob .5s steps(1) infinite -.125s}
.run g{transform-box:fill-box}
@keyframes st{50%{transform:translateY(-1px)}}@keyframes bob{50%{transform:translateY(1px)}}
.c-fable.run{animation:float 1s ease-in-out infinite}
.c-fable.run .la,.c-fable.run .lb,.c-fable.run .bd{animation:none}
.c-fable.run .ant{animation:blink 1s steps(1) infinite}
.c-fable.run .star{animation:blink .5s steps(1) infinite -.25s}
@keyframes float{50%{transform:translateY(-2px)}}@keyframes blink{50%{opacity:.15}}
.c-heavy.run .it{animation:scan 1s steps(1) infinite}
.c-heavy.run .gl{animation:blink 1s steps(1) infinite -.5s}
@keyframes scan{25%{transform:translate(-1px,1px)}50%{transform:translate(-2px,2px)}75%{transform:translate(-1px,1px)}}
.c-careful.run .it{transform-origin:100% 100%;animation:twist .5s ease-in-out infinite}
@keyframes twist{50%{transform:rotate(-35deg)}}
.c-medium.run .pan{transform-origin:0 50%;animation:tilt 1s ease-in-out infinite}
.c-medium.run .egg{animation:flip 1s ease-in-out infinite}
@keyframes tilt{20%,40%{transform:rotate(-12deg)}}@keyframes flip{30%{transform:translateY(-5px) scaleY(-1)}60%{transform:translateY(0)}}
.c-light.run .la{animation-duration:.25s}.c-light.run .lb{animation-duration:.25s;animation-delay:-.125s}
.c-light.run .flag{transform-origin:0 50%;animation:wave .25s steps(1) infinite}
@keyframes wave{50%{transform:skewY(-12deg) scaleX(.85)}}
.c-explore.run .it{transform-origin:50% 100%;animation:fence .5s ease-in-out infinite}
@keyframes fence{50%{transform:rotate(25deg)}}
@media (prefers-reduced-motion: reduce){.run,.run g{animation:none!important}}
</style>`

const COSTUMES: Record<string, (f: Fill, t: string) => void> = {
  // Fable: astronaut in a glass dome; floats instead of walking, the antenna and the star blink.
  fable: (f, t) => {
    crabBody(f)
    f(6, 7, 18, 1, '#E6E8EE'); f(5, 8, 1, 14, '#E6E8EE'); f(24, 8, 1, 14, '#E6E8EE'); f(6, 22, 18, 1, '#C9CCD2')
    f(6, 8, 18, 14, 'rgba(169,214,245,.32)'); f(8, 9, 2, 1, '#fff'); f(8, 10, 1, 2, '#fff')
    f(14, 4, 2, 3, '#C9CCD2'); f(14, 2, 2, 2, t, 'ant'); f(13, 18, 4, 2, t)
    f(27, 3, 1, 3, '#F5C542', 'star'); f(26, 4, 3, 1, '#F5C542', 'star')
  },
  // Heavy: detective with a deerstalker; the magnifier sweeps and glints.
  heavy: (f, t) => {
    crabBody(f, -4, 'it')
    stamp(f, 6, 3, ['......bbbbbb......', '....bbcbbcbbbb....', '...bbbbbbbbbbbb...', '..bcbbcbbcbbcbbb..', '.bbbbbbbbbbbbbbbb.', 'dddddddddddddddddd'], { b: '#7A4A26', c: '#A0703F', d: '#5A3519' })
    f(6, 9, 18, 1, t)
    stamp(f, 23, 1, ['.kkk.', 'k...k', 'k...k', 'k...k', '.kkk.'], { k: '#3A3A3C' }, 'it')
    f(24, 2, 3, 3, 'rgba(169,214,245,.7)', 'it'); f(25, 6, 1, 4, '#7A4A26', 'it'); f(24, 2, 1, 1, '#fff', 'gl')
  },
  // Careful: engineer in a hard hat; the wrench turns a bolt.
  careful: (f, t) => {
    crabBody(f)
    stamp(f, 6, 4, ['.....yyyyyyyy.....', '...yyyyyhhyyyyy...', '..yyyyyyhhyyyyyy..', '..yyyyyyhhyyyyyy..', '.yyyyyyyhhyyyyyyy.', 'dddddddddddddddddd'], { y: '#F5C542', h: '#FBE08A', d: '#C99A1E' })
    f(13, 5, 4, 2, t)
    stamp(f, 0, 10, ['.s.s', 'sss.', '.s..', '.s..'], { s: '#8E929A' }, 'it')
  },
  // Medium: chef, the toque traced from DockCrab's Sprites.chefHat; tosses the omelette.
  medium: (f, t) => {
    crabBody(f, -4, 'pan')
    stamp(f, 6, 0, ['........lll.......', '.......lllll......', '.wwwwgwwwwwwgwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwwwwwwwwwwwwww', 'wwwwwgwwwwwggwwwww', '.wwwwgwwwwwggwwwww', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.', '.dddbbbbbbbbbbbbb.'], { w: '#F4F3EE', l: '#F7F6F2', g: '#D2D1C8', b: t, d: '#B45F43' })
    f(22, 8, 7, 2, '#4A4A48', 'pan'); f(26, 10, 1, 1, '#4A4A48', 'pan'); f(24, 7, 3, 1, '#F5B731', 'egg')
  },
  // Light: racer in a helmet; runs at double pace, the checkered flag flutters.
  light: (f, t) => {
    crabBody(f, -4)
    stamp(f, 6, 5, ['....rrrrrrrrrr....', '..rrrrrrwwrrrrrr..', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.rrrrrrrwwrrrrrrr.', '.kkkkkkkkkkkkkkkkr'], { r: t, w: '#F8F6F1', k: INK })
    f(25, 1, 1, 9, '#8E929A')
    stamp(f, 26, 1, ['wkwk', 'kwkw', 'wkwk'], { w: '#F8F6F1', k: INK }, 'flag')
  },
  // Explore: pirate scouting the code; the cutlass fences.
  explore: f => {
    crabBody(f)
    stamp(f, 5, 3, ['.kk..............kk.', '.kkk....kkkk....kkk.', '..kkkkkkkwwkkkkkkk..', '..kkkkkkkkkkkkkkkk..', '.gggggggggggggggggg.'], { k: '#55514C', w: '#F8F6F1', g: '#F5C542' })
    f(7, 11, 11, 1, INK); f(18, 11, 4, 3, INK)
    f(27, 6, 1, 9, '#C9CCD2', 'it'); f(26, 15, 3, 1, '#7A4A26', 'it')
  },
  other: f => crabBody(f),
}

const costumeOf = (type: string): string => (type === 'Explore' ? 'explore' : tierOf(type))

const CRAB_SCALE = 1.1

// Body and props nest inside `bd` so a prop rides the bob and adds its own motion;
// legs stay outside it and step on their own. `mirror` flips the crab inside its
// own box (x .. x + CRAB_BOX * scale) so it faces left.
const crab = (x: number, y: number, costume: string, dim = false, isWalking = false, scale = CRAB_SCALE, mirror = false): string => {
  const groups = new Map<string, string[]>([['bd', []]])
  const f: Fill = (cx, cy, w, h, c, cls = 'bd') => {
    if (!groups.has(cls)) groups.set(cls, [])
    groups.get(cls)?.push(`<rect x="${cx}" y="${cy}" width="${w}" height="${h}" fill="${c}"/>`)
  }
  const draw = COSTUMES[costume] ?? ((g: Fill) => crabBody(g))
  draw(f, colorOf(costume))
  const group = (cls: string) => `<g class="${cls}">${(groups.get(cls) ?? []).join('')}</g>`
  const props = [...groups.keys()].filter(k => k !== 'bd' && k !== 'la' && k !== 'lb')
  const body = `<g class="bd">${(groups.get('bd') ?? []).join('')}${props.map(group).join('')}</g>`
  const place = mirror ? `translate(${x + CRAB_BOX * scale},${y}) scale(${-scale},${scale})` : `translate(${x},${y}) scale(${scale})`
  return `<g transform="${place}" opacity="${dim ? 0.45 : 1}" shape-rendering="crispEdges"><g class="c-${costume}${isWalking ? ' run' : ''}">${body}${group('la')}${group('lb')}</g></g>`
}

const statusMark = (x: number, y: number, status: string, color: string): string => {
  if (status === 'running') return `<circle class="live" cx="${x}" cy="${y}" r="3.5" fill="${color}"/>`
  if (status === 'done') return `<path d="M${x - 5} ${y}l3.5 3.5 6.5-7" fill="none" stroke="#3B9C5F" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`
  if (status === 'failed') return `<path d="M${x - 4} ${y - 4}l8 8M${x + 4} ${y - 4}l-8 8" stroke="#D0453F" stroke-width="1.8" stroke-linecap="round"/>`
  return `<circle cx="${x}" cy="${y}" r="5" fill="none" stroke="#9a9a96" stroke-width="1.4"/><path d="M${x} ${y - 2.5}v2.8l1.8 1.2" fill="none" stroke="#9a9a96" stroke-width="1.4" stroke-linecap="round"/>`
}

// Panel rows are laid out left to right; in Hebrew each box mirrors across the
// row (`mx`) and text hugs the mirrored side. `words` text may hold Hebrew and
// takes `direction="rtl"` (whose `start` is the right edge); numbers stay
// left to right so "≈$0.25" keeps its order.
const mx = (W: number, x: number, w = 0): number => (isRtl() ? W - x - w : x)

// Text that starts at x: left-aligned, or right-aligned at the mirrored x.
const startText = (W: number, x: number, y: number, words = true): string =>
  !isRtl()
    ? `x="${x}" y="${y}"`
    : `x="${W - x}" y="${y}"${words ? ' direction="rtl" text-anchor="start"' : ' text-anchor="end"'}`

// Text that ends at x: right-aligned, or left-aligned at the mirrored x.
const endText = (W: number, x: number, y: number, words = false): string =>
  !isRtl() ? `x="${x}" y="${y}" text-anchor="end"` : `x="${W - x}" y="${y}"${words ? ' direction="rtl" text-anchor="end"' : ''}`

const crabWidth = (scale: number): number => Math.round(CRAB_BOX * scale * 100) / 100

// The band's Clawd is the only crab: a panel row gets a HUD ring badge in its
// tier's color at x, in the box a crab used to fill; on the mirrored side in
// Hebrew. Its rings turn only while the agent runs.
const rowBadge =(W: number, x: number, y: number, costume: string, dim = false, isRunning = false): string => {
  const box = crabWidth(CRAB_SCALE)
  const cx = mx(W, x, box) + box / 2
  const cy = y + 19
  const color = colorOf(costume)
  const spin = isRunning ? ' class="spin"' : ''
  const back = isRunning ? ' class="spin rev"' : ''
  return `<g opacity="${dim ? 0.45 : 1}" fill="none" stroke="${color}">
<circle cx="${cx}" cy="${cy}" r="10" stroke-opacity=".25"/>
<circle${spin} cx="${cx}" cy="${cy}" r="10" stroke-width="1.5" stroke-dasharray="12 3.7"/>
<circle${back} cx="${cx}" cy="${cy}" r="6" stroke-dasharray="14 4.85" stroke-opacity=".8"/>
<circle cx="${cx}" cy="${cy}" r="2.2" fill="${color}" stroke="none"/>
</g>`
}

const svg = (W: number, H: number, body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${PANE_CSS}${CRAB_CSS}${body}</svg>`

// The pane's own title already says "Agents": the header names the flow, if any.
const headerSvg = (W: number, title: string, t: ReturnType<typeof totals>): string => {
  const s = tr()
  const gap = 6
  const tw = (W - gap * 2) / 3
  const top = title ? 28 : 0
  const tile = (i: number, k: string, v: string) =>
    `<rect class="tile" x="${mx(W, i * (tw + gap), tw)}" y="${top}" width="${tw}" height="40" rx="8"/>
<text class="s" ${startText(W, i * (tw + gap) + 9, top + 16)} font-family="${FONT}" font-size="11">${k}</text>
<text class="t" ${startText(W, i * (tw + gap) + 9, top + 33, false)} font-family="${FONT}" font-size="15" font-weight="600" font-variant-numeric="tabular-nums">${v}</text>`
  return svg(
    W,
    headerHeight(title),
    `${title ? `<text class="t" ${startText(W, 0, 15)} font-family="${FONT}" font-size="14" font-weight="600">${xml(fitText(title, 14, W))}</text>` : ''}
${tile(0, s.cost, '≈' + fmtCost(t.cost))}${tile(1, s.tokens, fmtTokens(t.tokens))}${tile(2, s.time, fmtTime(t.time))}`,
  )
}

const headerHeight = (title: string): number => (title ? 72 : 44)

// The task's own progress when the worker reports steps; a finished run is full.
const progressOf = (a: AgentRun): number | null => {
  if (a.status === 'done') return 1
  if (a.stepTotal) return Math.min(1, (a.stepDone ?? 0) / a.stepTotal)
  return null
}

const ctxOf = (a: AgentRun): number => (a.contextMax ? Math.min(100, Math.round((a.contextTokens / a.contextMax) * 100)) : 0)

const agentSvg = (W: number, a: AgentRun, at: number): string => {
  const s = tr()
  const tier = tierOf(a.type)
  const color = colorOf(tier)
  const ctx = ctxOf(a)
  const textW = W - 42 - 22
  const meta = [runModel(a)]
  if (a.round > 1) meta.push(`${s.round} ${a.round}`)
  if (a.status === 'failed') meta.push(s.failed)
  const barW = textW
  const progress = progressOf(a)
  const stats = `${s.ctx} ${ctx}% · ${fmtTokens(a.contextTokens)}  ≈${fmtCost(a.costUsd)}  ${fmtTime(elapsed(a, at))}`
  const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' · ' + a.stepNote : ''}` : ''
  const stepsW = Math.max(0, barW - textWidth(stats, 11) - 12)
  // Without reported steps the bar falls back to the context, drawn grey.
  // HUD blocks: one per reported step when there are few, else 7px chunks; the rest a hairline.
  const segs = a.stepTotal && a.stepTotal <= 20 && progress !== null ? a.stepTotal : Math.max(4, Math.min(60, Math.floor(barW / 7)))
  const segW = (barW - 2 * (segs - 1)) / segs
  const lit = Math.round(segs * (progress ?? ctx / 100))
  const blocks = Array.from({ length: segs }, (_, i) => {
    const x = mx(W, 42 + i * (segW + 2), segW).toFixed(2)
    const w = segW.toFixed(2)
    if (i >= lit) return `<rect class="k" x="${x}" y="56.5" width="${w}" height="1"/>`
    const fill = progress === null ? ' class="m"' : ` fill="${color}"`
    return `<rect${fill} x="${x}" y="55" width="${w}" height="4"/>`
  }).join('')
  return svg(
    W,
    66,
    `${rowBadge(W, 0, 14, costumeOf(a.type), false, a.status === 'running')}
<text class="t" ${startText(W, 42, 18)} font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(a.description || a.type, 13, textW))}</text>
<text ${startText(W, 42, 34)} font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tier === 'other' ? a.type : tierWord(tier))}</tspan><tspan class="s">  ${xml(meta.join('  ·  '))}</tspan></text>
${steps && stepsW > 30 ? `<text class="t" ${startText(W, 42, 49)} font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${xml(fitText(steps, 11, stepsW))}</text>` : ''}
<text class="s" ${endText(W, 42 + barW, 49, true)} font-family="${FONT}" font-size="11" font-variant-numeric="tabular-nums">${stats}</text>
${blocks}
${statusMark(mx(W, W - 8), 16, a.status, color)}
<line class="ln" x1="0" y1="65.5" x2="${W}" y2="65.5"/>`,
  )
}

const plannedSvg = (W: number, p: Planned): string => {
  const tier = p.tier in TIER_COLOR ? p.tier : 'other'
  const color = colorOf(tier)
  const textW = W - 42 - 22
  const meta = [tierModel(tier)]
  if (p.after.length) meta.push(`${tr().after} ${p.after.join(', ')}`)
  return svg(
    W,
    46,
    `${rowBadge(W, 0, 6, tier, true)}
<text class="s" ${startText(W, 42, 18)} font-family="${FONT}" font-size="13" font-weight="600">${xml(fitText(`${p.n}. ${p.title}`, 13, textW))}</text>
<text ${startText(W, 42, 34)} font-family="${FONT}" font-size="11"><tspan fill="${color}">${xml(tierWord(tier))}</tspan><tspan class="m">  ${xml(meta.filter(Boolean).join('  ·  '))}</tspan></text>
${statusMark(mx(W, W - 8), 16, 'planned', color)}
<line class="ln" x1="0" y1="45.5" x2="${W}" y2="45.5"/>`,
  )
}

const compactSvg = (W: number, list: AgentRun[], planned: Planned[], t: ReturnType<typeof totals>): string => {
  const icons = [
    ...list.filter(a => a.status === 'running').map(a => ({ k: costumeOf(a.type), c: colorOf(tierOf(a.type)), s: 'running', dim: false })),
    ...list.filter(a => a.status !== 'running').map(a => ({ k: costumeOf(a.type), c: colorOf(tierOf(a.type)), s: a.status, dim: false })),
    ...planned.map(p => ({ k: p.tier in TIER_COLOR ? p.tier : 'other', c: colorOf(p.tier), s: 'planned', dim: true })),
  ]
  const fit = Math.max(1, Math.floor((W - 150) / 36))
  const shown = icons.slice(0, fit)
  const more = icons.length - shown.length
  const body = shown
    .map((ic, i) => rowBadge(W, i * 36, 0, ic.k, ic.dim, ic.s === 'running') + (ic.s === 'running' ? `<circle class="live" cx="${mx(W, i * 36 + 32)}" cy="4" r="3" fill="${ic.c}"/>` : ''))
    .join('')
  const x = shown.length * 36 + (more ? 4 : 0)
  return svg(
    W,
    32,
    `${body}${more ? `<text class="s" ${startText(W, x, 21, false)} font-family="${FONT}" font-size="12">+${more}</text>` : ''}
<text class="s" ${endText(W, W, 21)} font-family="${FONT}" font-size="12" font-variant-numeric="tabular-nums">≈${fmtCost(t.cost)} · ${fmtTokens(t.tokens)} · ${fmtTime(t.time)}</text>`,
  )
}

// --- terminal drawing: the same rows in text.

const ctxBar = (pct: number, width: number): string => {
  const filled = Math.round((width * pct) / 100)
  return '━'.repeat(filled) + '─'.repeat(Math.max(0, width - filled))
}

const STATUS_GLYPH: Record<string, string> = { running: '●', done: '✓', failed: '✗', planned: '◷' }

// Opens the agents pane, or closes it when it is up; true when it ends up open.
async function togglePane($: EngineInterface): Promise<boolean> {
  const isOpen = (await $.ui.panes()).some(p => p.id === PANE)
  if (isOpen) {
    await $.ui.close({ id: PANE })
    return false
  }
  const at = await $.clock.now()
  await update($, now, () => at)
  await $.ui.open({ id: PANE, title: tr().pane })
  return true
}

async function autoOpen($: EngineInterface, key: string): Promise<void> {
  const p = await read($, panel)
  if (p.autoOpenedFor === key) return
  await update($, panel, prev => ({ ...prev, autoOpenedFor: key }))
  void $.ui.open({ id: PANE, title: tr().pane })
}

// Clawd says `text` in the band's bubble for SAY_MS.
async function speak($: EngineInterface, text: string): Promise<void> {
  const at = await $.clock.now()
  await update($, say, () => ({ text: clip(text, 60), at }))
  await update($, spokeAt, () => at)
}

// Once a second: take the bubble and a one-off show down when their time is up,
// doze off or wake up with the cache, and when the band is up with nothing running
// and Clawd has been quiet for IDLE_MS, say something. Writes only on a change.
async function tickSpeech($: EngineInterface): Promise<void> {
  const at = await $.clock.now()
  const said = await read($, say)
  if (said && at - said.at >= SAY_MS) await update($, say, () => null)
  const shown = await read($, flash)
  if (shown && at - shown.at >= FLASH_MS) await update($, flash, () => null)

  const isRunning = (await read($, agents)).some(a => a.status === 'running')
  const answered = await read($, answeredAt)
  const sleepy = !isRunning && answered > 0 && at - answered >= CACHE_TTL_MS - SLEEPY_MS
  if (sleepy !== (await read($, isSleepy))) await update($, isSleepy, () => sleepy)

  const f = await read($, flow)
  if (!f || isRunning) return
  if (at - (await read($, spokeAt)) < IDLE_MS) return
  const lines = tr().idle
  await speak($, lines[Math.floor(at / IDLE_MS) % lines.length] ?? '')
}

export const register: Register = (on, options) => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    lang = await detectLang($, options.language)
    await $.tool.register({
      name: 'progress',
      description:
        'Report /savvy-flow progress to the progress bar above the prompt and the agents panel. ' +
        'Call it after presenting the plan (title, total, tasks, phase "delegate"), each time a task is accepted (done), ' +
        'when switching phase or re-planning (tasks), and once at the end with finished: true. Fields left out keep their previous value. ' +
        'For the main session only: a call from a subagent is ignored (workers report with `step`).',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short name of the overall task, a few words.' },
          total: { type: 'integer', minimum: 0, description: 'Number of planned worker tasks.' },
          done: { type: 'integer', minimum: 0, description: 'Number of tasks accepted after review.' },
          phase: { type: 'string', enum: [...PHASES] },
          finished: { type: 'boolean', description: 'True once the flow is closed.' },
          tasks: {
            type: 'array',
            description:
              'The planned worker tasks in order, numbered from 1. Each title must equal the Agent tool `description` the task will be delegated with, so the panel can match runs to tasks.',
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: 'A few words; reused verbatim as the Agent description.' },
                tier: { type: 'string', enum: [...TIERS] },
                after: { type: 'array', items: { type: 'integer' }, description: 'Numbers of the tasks this one waits for.' },
              },
              required: ['title', 'tier'],
            },
          },
        },
      },
    })
    await $.tool.register({
      name: 'step',
      description:
        'For savvy-flow workers: report progress on your own task to the agents panel. ' +
        'Right after reading the brief, call it with `total` (your plan in 3-8 steps) and `done: 0`; ' +
        'call it again as each step finishes. Cheap and silent: it only draws a bar.',
      inputSchema: {
        type: 'object',
        properties: {
          done: { type: 'integer', minimum: 0, description: 'Steps finished so far.' },
          total: { type: 'integer', minimum: 1, description: 'Steps planned; may change if the plan changes.' },
          note: { type: 'string', description: 'The step in progress, a few words.' },
        },
        required: ['done'],
      },
      // In every agent's tool list, not behind ToolSearch: workers do not go looking for it.
      isDeferred: false,
    })
    await $.command.register({
      name: 'agents-info',
      description: 'Show or hide the panel of subagents: running, finished and planned, with model, context, cost and time',
    })

    // Ticks the running agents' clocks; quiet when nothing runs. Also times Clawd's bubble.
    $.clock.every(1000, () => {
      void (async () => {
        await tickSpeech($)
        const list = await read($, agents)
        if (!list.some(a => a.status === 'running')) return
        const at = await $.clock.now()
        await update($, now, () => at)
      })()
    })
    // A fresh session starts the idle wait now, not at once.
    const startedAt = await $.clock.now()
    await update($, spokeAt, prev => prev || startedAt)
    return started
  })

  on('command.run', { command: 'agents-info' }, async ($, e) => {
    // `/agents-info open` opens the panel, or brings it forward from behind another tab, without toggling it.
    if ((e.args ?? '').trim() === 'open') {
      const at = await $.clock.now()
      await update($, now, () => at)
      await $.ui.open({ id: PANE, title: tr().pane })
      return { text: tr().opened }
    }
    const isOpen = await togglePane($)
    return { text: isOpen ? tr().opened : tr().closed }
  })

  on('tool.call', { tool: TOOL }, async ($, e) => {
    // The flow is the main session's: a call from a worker's loop carries its agentId
    // and changes nothing, or any subagent could rename, finish or reset the flow.
    if (e.agentId) return { result: 'ignored: only the main session reports the flow' }
    const input = e as unknown as ProgressInput
    const prev = await read($, flow)
    if (isNewFlow(prev, input) && input.title !== undefined) {
      // A new flow starts with a clean list; agents still running stay.
      await update($, agents, list => list.filter(a => a.status === 'running'))
    }
    const next = await update($, flow, p => merge(p, input))
    if (next && input.tasks?.length) await autoOpen($, next.title)
    if (next?.isFinished && !prev?.isFinished) {
      // The whole job is done: a rocket lifts off across the band.
      await speak($, tr().allDone)
      const at = await $.clock.now()
      await update($, flash, () => ({ kind: 'liftoff', at }))
    }
    else if (next && input.tasks?.length) await speak($, `${tr().planReady} · ${next.total} ${tr().tasks.toLowerCase()}`)
    return { result: `ok: ${label(next ?? blank())}` }
  })

  // A worker's own progress: the call runs in the worker's loop, so agentId names it.
  on('tool.call', { tool: STEP_TOOL }, async ($, e) => {
    const input = e as unknown as { done?: number; total?: number; note?: string }
    const agentId = e.agentId
    if (!agentId) return { result: 'ignored: only subagents report steps' }
    let matched = false
    await update($, agents, list =>
      list.map(a => {
        if (a.agentId !== agentId) return a
        matched = true
        const total = Math.max(0, Math.round(input.total ?? a.stepTotal ?? 0))
        const done = Math.max(0, Math.round(input.done ?? a.stepDone ?? 0))
        return { ...a, stepTotal: total, stepDone: total ? Math.min(total, done) : done, stepNote: input.note?.trim() || undefined }
      }),
    )
    return { result: matched ? 'ok' : `ignored: no panel row for agent ${agentId}` }
  })

  // Notes what kind of work a tool call is, for Clawd to act out; the call itself
  // passes through untouched, and a failure to note it never blocks it.
  on('tool.call', async ($, e, next) => {
    const kind = activityOf(String(e.tool))
    if (kind) {
      await $.clock
        .now()
        .then(at => update($, activity, () => ({ kind, at })))
        .catch(() => undefined)
    }
    return next(e)
  })

  // Safety net: worker launches move the faint layer even if the orchestrator forgets to report.
  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const type = String(e.subagent_type ?? '')
    if (!type.startsWith('savvy-')) return next(e)

    await update($, flow, prev => {
      const base = prev && !prev.isFinished ? { ...blank(), ...prev } : blank()
      return { ...base, running: base.running + 1, phase: base.phase === 'plan' ? 'delegate' : base.phase }
    })
    try {
      return await next(e)
    } finally {
      await update($, flow, prev => (prev ? { ...prev, running: Math.max(0, prev.running - 1) } : prev))
    }
  })

  on('agent.spawn', async ($, e, next) => {
    const isUnbriefed = e.subagentType.startsWith('savvy-') && !e.prompt.includes(STEP_TOOL)
    const started = await next(isUnbriefed ? { ...e, prompt: e.prompt + STEP_BRIEF } : e)
    if (started.deny !== undefined) return started

    const at = await $.clock.now()
    await update($, agents, list => {
      const round = 1 + list.filter(a => norm(a.description) === norm(e.description) && e.description).length
      const run: AgentRun = {
        id: started.agentId ?? e.tool_use_id,
        agentId: started.agentId,
        type: e.subagentType,
        description: e.description,
        model: started.model,
        status: 'running',
        startedAt: at,
        contextTokens: 0,
        contextMax: windowOf(started.model),
        tokens: 0,
        costUsd: 0,
        steps: 0,
        round,
      }
      return [...list.filter(a => a.id !== run.id), run].slice(-200)
    })
    await update($, now, () => at)
    if (e.subagentType.startsWith('savvy-')) {
      const f = await read($, flow)
      await autoOpen($, f && !f.isFinished ? f.title : 'savvy-flow')
    } else if (options.autoOpen === 'any') {
      await autoOpen($, 'any-agent')
    }
    return started
  })

  // Each model request of a subagent: live context, tokens and cost.
  on('turn.step', async function* ($, e, next) {
    const result = yield* next(e)
    const agentId = e.agentId
    const usage = result.usage
    if (!agentId || !usage) return result

    const model = usage.model || e.model
    await update($, agents, list =>
      list.map((a): AgentRun =>
        a.agentId !== agentId
          ? a
          : {
              ...a,
              model,
              effort: typeof e.effort === 'string' ? e.effort : a.effort,
              status: 'running',
              endedAt: undefined,
              contextTokens:
                (usage.input_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0) +
                (usage.output_tokens || 0),
              contextMax: windowOf(model),
              tokens:
                a.tokens +
                (usage.input_tokens || 0) +
                (usage.output_tokens || 0) +
                (usage.cache_read_input_tokens || 0) +
                (usage.cache_creation_input_tokens || 0),
              costUsd: a.costUsd + costOf(model, usage, true),
              steps: a.steps + 1,
            },
      ),
    )
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const agentId = e.agentId
    if (agentId) {
      const at = await $.clock.now()
      await update($, agents, list =>
        list.map((a): AgentRun => {
          if (a.agentId !== agentId) return a
          // A run whose steps went unseen still gets the turn's own sum.
          const fallback = a.steps === 0 && e.usage
          return {
            ...a,
            status: e.reason === 'answer' ? 'done' : 'failed',
            endedAt: at,
            ...(fallback && e.usage
              ? {
                  model: e.usage.model || a.model,
                  tokens:
                    e.usage.input_tokens +
                    e.usage.output_tokens +
                    e.usage.cache_read_input_tokens +
                    e.usage.cache_creation_input_tokens,
                  costUsd: costOf(e.usage.model || a.model, e.usage, false),
                }
              : {}),
          }
        }),
      )
      await update($, now, () => at)
      // Clawd calls out a finished or failed agent by its task.
      const run = (await read($, agents)).find(a => a.agentId === agentId)
      if (run) {
        const s = tr()
        const what = clip(run.description || run.type, 32)
        await speak($, run.status === 'done' ? `${s.taskDone}: ${what}` : `${s.taskFailed}: ${what}`)
        // A failed agent rains meteors across the band.
        if (run.status === 'failed') await update($, flash, () => ({ kind: 'meteor', at }))
      }
    } else {
      // The main session answered: the prompt cache starts its hour again, and Clawd wakes.
      const at = await $.clock.now()
      // A task (a turn that used tools) just finished: Clawd says so.
      const act = await read($, activity)
      if (act && act.at > (await read($, answeredAt))) await speak($, tr().taskDone)
      await update($, answeredAt, () => at)
      if (await read($, isSleepy)) await update($, isSleepy, () => false)
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const s = tr()
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const list = await read($, agents)
    const f = await read($, flow)
    const p: Panel = await read($, panel)
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)

    const running = list.filter(a => a.status === 'running').reverse()
    const finished = list.filter(a => a.status !== 'running').reverse()
    const planned = plannedOf(f, list)
    const t = totals(list, at)
    // The pane's title says "Agents"; inside, only the flow's own name.
    const title = f && !f.isFinished ? f.title : ''

    const toggleCompact = (
      <Button
        key="compact"
        label={p.isCompact ? s.expand : s.collapse}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isCompact: !prev.isCompact }))}
      />
    )
    const toggleDone = (
      <Button
        key="done"
        label={`${p.isDoneCollapsed ? (isRtl() ? '◂' : '▸') : '▾'} ${s.finished} · ${finished.length}`}
        plain
        onPress={() => update($, panel, prev => ({ ...prev, isDoneCollapsed: !prev.isDoneCollapsed }))}
      />
    )
    const isEmpty = list.length === 0 && planned.length === 0
    const summary = `≈${fmtCost(t.cost)}, ${fmtTokens(t.tokens)} ${s.tokensWord}, ${fmtTime(t.time)}`

    if (e.surface === 'desktop' && 'Svg' in ui) {
      const { Svg } = ui
      const W = Math.max(240, Math.min(900, (e.props.bodyColumns || 40) * 8 - 8))
      const section = (key: string, text: string) => (
        <Text key={key} dimColor>
          {text}
        </Text>
      )

      // In Hebrew the column hugs the right edge: section heads and buttons right-aligned.
      const align = isRtl() ? 'flex-end' : undefined
      if (p.isCompact) {
        return (
          <Box flexDirection="column" gap={1} alignItems={align}>
            <Svg source={compactSvg(W, list, planned, t)} alt={`${list.length} ${s.agentsCount}, ${summary}`} width={W} height={32} />
            {toggleCompact}
          </Box>
        )
      }
      const shownDone = p.isDoneCollapsed ? 0 : finished.length
      const lines = 1 + (isEmpty ? 1 : 0) + (running.length > 0 ? 1 : 0) + (finished.length > 0 ? 1 : 0) + (planned.length > 0 ? 1 : 0)
      const gridH = headerHeight(title) + lines * LINE_H + (running.length + shownDone) * 66 + planned.length * 46
      return (
        <Box flexDirection="column">
          {/* The grid sizes the pane; the content is placed over it, as an
              absolute Box paints over the siblings before it. */}
          {gridTiles(gridH).map((tileH, i) => (
            <Svg key={`grid-${i}`} source={gridSvg(W, tileH)} alt="dotted grid" width={W} height={tileH} />
          ))}
          <Box flexDirection="column" position="absolute" top={0} left={0} right={0} alignItems={align}>
            <Svg source={headerSvg(W, title, t)} alt={title ? `${title}: ${summary}` : summary} width={W} height={headerHeight(title)} />
            {toggleCompact}
            {isEmpty && <Text dimColor>{s.empty}</Text>}
            {running.length > 0 && section('h-run', `${s.running} · ${running.length}`)}
            {running.map(a => (
              <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isRunning}`} width={W} height={66} />
            ))}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed &&
              finished.map(a => (
                <Svg key={a.id} source={agentSvg(W, a, at)} alt={`${a.description}: ${modelName(a.model)}, ${s.isFinished}`} width={W} height={66} />
              ))}
            {planned.length > 0 && section('h-plan', `${s.planned} · ${planned.length}`)}
            {planned.map(pl => (
              <Svg key={`plan-${pl.n}`} source={plannedSvg(W, pl)} alt={`${pl.n}. ${pl.title}: ${s.isPlanned}`} width={W} height={46} />
            ))}
          </Box>
        </Box>
      )
    }

    // Terminal: the same content in text rows.
    const cols = Math.max(24, e.props.bodyColumns || 40)
    const barW = Math.max(6, Math.min(20, cols - 34))
    const row = (a: AgentRun) => {
      const tier = tierOf(a.type)
      const color = colorOf(tier)
      const ctx = ctxOf(a)
      const progress = progressOf(a)
      const model = runModel(a)
      const steps = a.stepTotal ? `${a.stepDone ?? 0}/${a.stepTotal}${a.stepNote ? ' ' + a.stepNote : ''} · ` : ''
      return (
        <Box key={a.id} flexDirection="column" marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={color}>▣</Text>
            <Text bold wrap="truncate-end">
              {a.description || a.type}
            </Text>
            <Text color={a.status === 'failed' ? 'red' : a.status === 'done' ? 'green' : color}>{STATUS_GLYPH[a.status]}</Text>
          </Box>
          <Text dimColor wrap="truncate-end">
            {'  '}
            {tier === 'other' ? a.type : tierWord(tier)} · {model}
            {a.round > 1 ? ` · ${s.round} ${a.round}` : ''}
          </Text>
          <Text wrap="truncate-end">
            {'  '}
            {progress === null ? <Text dimColor>{ctxBar(ctx, barW)}</Text> : <Text color={color}>{ctxBar(progress * 100, barW)}</Text>}
            <Text dimColor>
              {' '}
              {steps}{s.ctx} {ctx}% · {fmtTokens(a.contextTokens)} ≈{fmtCost(a.costUsd)} {fmtTime(elapsed(a, at))}
            </Text>
          </Text>
        </Box>
      )
    }

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between">
          <Text bold wrap="truncate-end">
            {title}
          </Text>
          {toggleCompact}
        </Box>
        <Text dimColor>
          ≈{fmtCost(t.cost)} · {fmtTokens(t.tokens)} {s.tokensWord} · {fmtTime(t.time)}
        </Text>
        {p.isCompact ? (
          <Text wrap="truncate-end">
            {[...running, ...finished].map(a => (
              <Text key={a.id} color={colorOf(tierOf(a.type))}>
                {STATUS_GLYPH[a.status]}{' '}
              </Text>
            ))}
            {planned.map(pl => (
              <Text key={`plan-${pl.n}`} dimColor>
                ◷{' '}
              </Text>
            ))}
          </Text>
        ) : (
          <Box flexDirection="column" marginTop={1}>
            {isEmpty && <Text dimColor>{s.empty}</Text>}
            {running.length > 0 && <Text dimColor>{s.running} · {running.length}</Text>}
            {running.map(row)}
            {finished.length > 0 && toggleDone}
            {!p.isDoneCollapsed && finished.map(row)}
            {planned.length > 0 && <Text dimColor>{s.planned} · {planned.length}</Text>}
            {planned.map(pl => {
              const tier = pl.tier in TIER_COLOR ? pl.tier : 'other'
              return (
                <Box key={`plan-${pl.n}`} flexDirection="column" marginBottom={1}>
                  <Text dimColor wrap="truncate-end">
                    <Text color={colorOf(tier)}>▢</Text> {pl.n}. {pl.title} ◷
                  </Text>
                  <Text dimColor wrap="truncate-end">
                    {'  '}
                    {tierWord(tier)} · {tierModel(tier)}
                    {pl.after.length ? ` · ${s.after} ${pl.after.join(', ')}` : ''}
                  </Text>
                </Box>
              )
            })}
          </Box>
        )}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const f = await read($, flow)
    const list = await read($, agents)
    // Working while Claude itself is on a task, or while any agent runs.
    const isWorking = !!e.props.isWorking || list.some(a => a.status === 'running')
    // Always up; between tasks it rests without motion.
    if (e.props.hasSurvey) return next(e)
    // Draw this row with the other mods' bands beneath it. Claude Code's own placeholder ({ type: 'engine' }) is
    // never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const crew = list.length + plannedOf(f, list).length
    // Reading `now` redraws the time once a second, only while an agent runs.
    const at = Math.max(await read($, now), ...list.map(a => a.startedAt), 0)
    const cells = bandReadouts(f, list, at)
    const state: BandState = f?.isFinished ? 'complete' : isWorking ? 'working' : 'standby'
    const pct = f && (f.total || f.isFinished) ? ratio(f) : null
    const s = tr()
    const status = state === 'working' ? s.working : state === 'complete' ? s.complete : s.standby
    const clock = await $.clock.now()
    const said = await read($, say)
    const speech = said && clock - said.at < SAY_MS ? said.text : ''
    // What the agents are doing, while it is fresh and something runs.
    const act = await read($, activity)
    const doing = isWorking && act && clock - act.at < ACTIVITY_MS ? act.kind : null
    const shown = await read($, flash)
    const show = shown && clock - shown.at < FLASH_MS ? shown.kind : null
    const sleepy = await read($, isSleepy)
    const crewButton = (
      <Button key="savvy-agents" label={`×${crew}`} plain onPress={() => void togglePane($)} />
    )
    const summary = cells.map(c => `${c.label} ${c.value}`).join(', ')
    const dismiss = (
      <Button
        key="savvy-dismiss"
        label="✕"
        plain
        role="dismiss"
        onPress={() => update($, flow, () => null)}
      />
    )

    // The terminal's element table is completed with an `Svg` that draws nothing: test the surface too.
    if (e.surface !== 'terminal' && 'Svg' in ui) {
      const { Svg } = ui
      // About 8 CSS px per reported column; the rest is the count, the dismiss
      // and their gaps. No floor above the slot: a row wider than it would wrap.
      const width = Math.max(180, Math.min(1600, (e.props.bodyColumns || 100) * 8 - 96))
      return (
        <Box flexDirection="column">
          <Box flexDirection={isRtl() ? 'row-reverse' : 'row'} alignItems="center" gap={1}>
            <Svg
              source={bandSvg(cells, pct, state, width, speech, skySeed(await $.session.id()) + 3, doing, show, sleepy)}
              alt={`${status}. ${summary}${speech ? `. Clawd: ${speech}` : ''}`}
              width={width}
              height={H}
            />
            {crewButton}
            {dismiss}
          </Box>
          {below}
        </Box>
      )
    }

    // Terminal: the same readouts as LABEL value, the percent and the status word.
    const color = state === 'complete' ? DONE : CYAN
    return (
      <Box flexDirection="column">
        <Box flexDirection="row" gap={2}>
          <Text color={color} bold>
            ◎ {pct === null ? '—' : `${Math.round(pct * 100)}%`}
          </Text>
          {cells.map(c => (
            <Text key={c.label} wrap="truncate-end">
              <Text color={color} dimColor>
                {c.label.toUpperCase()}{' '}
              </Text>
              <Text bold>{c.value}</Text>
            </Text>
          ))}
          <Text color={color} dimColor={state === 'standby'}>
            ● {status}
          </Text>
          <Text color={CLAY}>▣</Text>
          {crewButton}
          {dismiss}
        </Box>
        {speech ? (
          <Text wrap="truncate-end">
            <Text color={CLAY}>▣ </Text>
            <Text dimColor>“{speech}”</Text>
          </Text>
        ) : null}
        {below}
      </Box>
    )
  })
}
