import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Cache, Stats } from '../types'

// Responses shorter than this are mostly tool-call stubs: their timing is noise.
const MIN_TOKENS = 20
// A response that arrived in one burst cannot be timed; such readings are dropped.
const MIN_SECONDS = 0.5
const MAX_SPEED = 1000

const CACHE_TTL_MS = 60 * 60 * 1000
const CACHE_WARN_S = 20 * 60
const CACHE_ALERT_S = 10 * 60
// Minutes left at which the cache expiry is announced, once each per answer.
const CACHE_NOTIFY_MINUTES = [10, 5] as const

const SPEED = '#8b8cf8'
const MONEY = '#4caf6e'
const MUTED = '#8a8f8c'
const CONTEXT = '#5fa8d3'
const CACHE = '#4fb3a9'
const WARN = '#e2a94e'
const ALERT = '#e0846b'

const stats = atom({ plugin: 'session-band', key: 'stats' } as const, {
  turn: 0,
  speed: null,
  turnCost: null,
  total: 0,
  context: 0,
  costAtStart: 0,
} as Stats)

const cache = atom({ plugin: 'session-band', key: 'cache' } as const, {
  expiresAt: null,
  secondsLeft: null,
} as Cache)

// Closed with ×: stays hidden for the rest of the session.
const isHidden = atom({ plugin: 'session-band', key: 'isHidden' } as const, false)

// A turn is running: the cache stays warm, so no countdown warnings.
const isBusy = atom({ plugin: 'session-band', key: 'isBusy' } as const, false)

// The smallest CACHE_NOTIFY_MINUTES already announced since the last answer; 0 none.
const warned = atom({ plugin: 'session-band', key: 'warned' } as const, 0)

// The Cache mod's own deadline: seeds ours after a reload missed the last turn.complete.
const cacheModExpiresAt = atom({ plugin: 'Cache', key: 'expiresAt' } as const, null)

const ring = (color: string, glyph: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <circle cx="12" cy="12" r="10" fill="none" stroke="${color}" stroke-width="2"/>
    ${glyph}</svg>`

const SPEED_ICON = ring(
  SPEED,
  `<path d="M6.5 15a6 6 0 0 1 11 0" fill="none" stroke="${SPEED}" stroke-width="1.8" stroke-linecap="round"/>
   <path d="M12 15l3-4" stroke="${SPEED}" stroke-width="1.8" stroke-linecap="round"/>`,
)

const MONEY_ICON = ring(
  MONEY,
  `<text x="12" y="16.5" text-anchor="middle" font-family="-apple-system,sans-serif" font-size="13" font-weight="600" fill="${MONEY}">$</text>`,
)

// The ring itself fills with the context, around a page of lines.
const contextIcon = (percent: number) => {
  const c = 2 * Math.PI * 10
  const filled = (Math.min(100, percent) / 100) * c
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">
    <circle cx="12" cy="12" r="10" fill="none" stroke="${MUTED}" stroke-opacity="0.35" stroke-width="2"/>
    <circle cx="12" cy="12" r="10" fill="none" stroke="${CONTEXT}" stroke-width="2" stroke-linecap="round"
      stroke-dasharray="${filled.toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 12 12)"/>
    <g stroke="${CONTEXT}" stroke-width="1.6" stroke-linecap="round">
      <path d="M8.5 9h7M8.5 12h7M8.5 15h4.5"/>
    </g></svg>`
}

// An hourglass: the prompt cache running out.
const cacheIcon = (color: string) =>
  ring(
    color,
    `<g fill="none" stroke="${color}" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round">
       <path d="M8.5 6.5h7M8.5 17.5h7"/>
       <path d="M9.5 6.5c0 3 5 3.5 5 5.5s-5 2.5-5 5.5M14.5 6.5c0 3-5 3.5-5 5.5s5 2.5 5 5.5"/>
     </g>`,
  )

const pad = (n: number) => String(n).padStart(2, '0')

const contextBar = (percent: number) => {
  const color = percent >= 85 ? '#e0846b' : percent >= 65 ? '#e2a94e' : MONEY
  const w = Math.round((Math.min(100, percent) / 100) * 80)
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 80 6" width="80" height="6">
    <rect width="80" height="6" rx="3" fill="${MUTED}" fill-opacity="0.3"/>
    <rect width="${w}" height="6" rx="3" fill="${color}"/></svg>`
}

const usd = (n: number) => `$${n.toFixed(2)}`

// ---------------------------------------------------------------------------
// Desktop: a galaxy panel that blends into Claude. It takes Claude's own background
// and text colors in light and dark mode, with a faint galaxy haze and stars over it,
// a spiral galaxy in Claude's clay as its emblem, and readouts each named above their
// value. The cache readout and the panel's edge turn amber, then red, as the cache runs
// out. Only the galaxy turns, stars twinkle and a shooting star crosses, and only while
// Claude is working. Each session draws its own stars.

const PANEL_H = 38
const MONO = "'Cascadia Mono','SF Mono',Consolas,ui-monospace,monospace"
const SKY_CLAY = '#D97757'
const SKY_LILAC = '#8B5CF6'
const CELL_PAD = 12
const BAR_W = 44
const EMBLEM = 36

type Tone = 'warn' | 'alert'
type Readout = { label: string; value: string; tone?: Tone; bar?: number }

// Monospace runs about 0.62em a character.
const monoWidth = (s: string, size: number) => [...s].length * size * 0.62
const readoutWidth = (r: Readout) =>
  Math.max(monoWidth(r.label, 8) + r.label.length * 1.5, monoWidth(r.value, 12) + (r.bar === undefined ? 0 : BAR_W + 6)) + CELL_PAD * 2

const xml = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] ?? c)

// Deterministic noise: the same seed draws the same sky on every redraw.
const skyRand = (i: number, k: number) => {
  const s = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453
  return s - Math.floor(s)
}

// A seed for this session's sky, from its id.
const skySeed = (id: string) => [...id].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) % 9973, 7)

const skyStars = (W: number, H: number, seed: number) =>
  Array.from({ length: Math.round(W / 10) }, (_, i) => {
    const x = (skyRand(i, seed) * W).toFixed(1)
    const y = (skyRand(i, seed + 1) * H).toFixed(1)
    const r = skyRand(i, seed + 2) < 0.12 ? 0.85 : 0.45
    const o = (0.3 + skyRand(i, seed + 3) * 0.6).toFixed(2)
    const tw = i % 5 === 0 ? ` class="tw" style="animation-delay:-${(skyRand(i, 9) * 3).toFixed(2)}s"` : ''
    return `<circle${tw} cx="${x}" cy="${y}" r="${r}" opacity="${o}"/>`
  }).join('')

// The colors follow Claude's theme: its background and text, with the haze and the
// stars faint in light mode and brighter in dark mode.
const SKY_CSS = `.bg{fill:#F5F3EE}.edge{fill:none;stroke:#1F1E1D;stroke-opacity:.08}.haze{opacity:.5}.stars{fill:#6F6488;opacity:.45}
.lb{fill:#8A8780}.vl{fill:#1F1E1D}.sep{fill:#1F1E1D;fill-opacity:.08}.trk{stroke:#1F1E1D;stroke-opacity:.18}
.warn{fill:#B7791F;stroke:#B7791F}.alert{fill:#C2412F;stroke:#C2412F}.ok{fill:${SKY_CLAY};stroke:${SKY_CLAY}}
.edge.warn{stroke:#B7791F;stroke-opacity:.6;fill:none}.edge.alert{stroke:#C2412F;stroke-opacity:.6;fill:none}
@media (prefers-color-scheme: dark){.bg{fill:#2B2A27}.edge{stroke:#fff}.haze{opacity:1}.stars{fill:#fff;opacity:.85}
.lb{fill:#A6A39B}.vl{fill:#ECEAE4}.sep{fill:#fff;fill-opacity:.08}.trk{stroke:#fff;stroke-opacity:.2}
.warn{fill:#FFB547;stroke:#FFB547}.alert{fill:#FF7A66;stroke:#FF7A66}.edge.warn,.edge.alert{fill:none}}`

// Haze, stars and an optional shooting star, clipped to the panel's rounded box.
const skyBackdrop = (W: number, H: number, seed: number, isWorking: boolean) => `
<defs>
<radialGradient id="haze1" cx="${0.55 + skyRand(seed, 1) * 0.35}" cy="0.25" r="0.6"><stop offset="0" stop-color="#A78BFA" stop-opacity=".3"/><stop offset=".5" stop-color="${SKY_LILAC}" stop-opacity=".14"/><stop offset="1" stop-color="${SKY_LILAC}" stop-opacity="0"/></radialGradient>
<radialGradient id="haze2" cx="0.15" cy="1" r="0.5"><stop offset="0" stop-color="${SKY_CLAY}" stop-opacity=".14"/><stop offset="1" stop-color="${SKY_CLAY}" stop-opacity="0"/></radialGradient>
<linearGradient id="trail"><stop offset="0" stop-color="${SKY_CLAY}" stop-opacity="0"/><stop offset="1" stop-color="#fff" stop-opacity=".9"/></linearGradient>
<clipPath id="box"><rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10"/></clipPath>
</defs>
<rect class="bg" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10"/>
<g clip-path="url(#box)">
<g class="haze"><rect width="${W}" height="${H}" fill="url(#haze1)"/><rect width="${W}" height="${H}" fill="url(#haze2)"/></g>
<g class="stars">${skyStars(W, H, seed)}</g>
${isWorking ? `<g class="shoot"><rect width="46" height="1.2" rx=".6" fill="url(#trail)" transform="rotate(14)"/></g>` : ''}
</g>`

// The motion, written only while Claude is working.
const skyMotion = (W: number) => `.tw{animation:tw 2.4s ease-in-out infinite}@keyframes tw{50%{opacity:.1}}
.shoot{animation:shoot 5s ease-in infinite}@keyframes shoot{0%{transform:translate(-60px,-6px);opacity:0}8%{opacity:1}30%{transform:translate(${Math.round(W * 0.55)}px,24px);opacity:0}100%{transform:translate(${Math.round(W * 0.55)}px,24px);opacity:0}}
.swirl{animation:swirl 1.6s linear infinite}@keyframes swirl{to{stroke-dashoffset:-19}}
@media (prefers-reduced-motion: reduce){.tw,.shoot,.swirl{animation:none}}`

// A black hole: a purple halo, an accretion disk from lilac through violet to clay,
// a black core with a thin photon ring. The disk's far half passes behind the core
// and its near half in front. With `pct` the disk is a gauge: only that share of it
// is lit. While working, streaks swirl around the disk. `grow` (0 to 1, the context's
// fill) makes it bigger and its halo hotter; from 0.85 a red glow joins the halo.
const skyBlackHole = (cx: number, cy: number, isWorking: boolean, pct: number | null = null, isDone = false, grow = 0): string => {
  const k = 0.8 + 0.45 * Math.min(1, Math.max(0, grow))
  const heat = (0.3 + 0.5 * Math.min(1, Math.max(0, grow))).toFixed(2)
  const hot = grow >= 0.85 ? `<circle cx="${cx}" cy="${cy}" r="15" fill="url(#hot)"/>` : ''
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
<radialGradient id="halo"><stop offset=".35" stop-color="#8B5CF6" stop-opacity="${heat}"/><stop offset="1" stop-color="#8B5CF6" stop-opacity="0"/></radialGradient>
<radialGradient id="hot"><stop offset=".3" stop-color="#FF6B5A" stop-opacity=".45"/><stop offset="1" stop-color="#FF6B5A" stop-opacity="0"/></radialGradient>
<clipPath id="near"><rect x="${cx - 20}" y="${cy}" width="40" height="20"/></clipPath>
</defs>
<g transform="translate(${cx} ${cy}) scale(${k.toFixed(3)}) translate(${-cx} ${-cy})">
${hot}<circle cx="${cx}" cy="${cy}" r="14" fill="url(#halo)"/>
<g ${tilt}>${rings}</g>
<circle cx="${cx}" cy="${cy}" r="5.4" fill="#05030A"/>
<circle cx="${cx}" cy="${cy}" r="5.9" fill="none" stroke="#E9D5FF" stroke-opacity=".9" stroke-width=".7"/>
<g ${tilt} clip-path="url(#near)">${rings}</g>
</g>`
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

const panelSvg = (all: Readout[], W: number, isWorking: boolean, level: Tone | null, seed: number) => {
  // Readouts that would not fit are left out: SESSION first, then SPEED, then TURN.
  const cells = [...all]
  const fits = () => EMBLEM + cells.reduce((w, r) => w + readoutWidth(r), 0) <= W - 4
  for (const drop of ['SESSION', 'SPEED', 'TURN']) {
    if (fits()) break
    const i = cells.findIndex(r => r.label === drop)
    if (i >= 0) cells.splice(i, 1)
  }

  const H = PANEL_H
  const decor = skyDecorPair(seed)
  const parts: string[] = []
  let x = EMBLEM
  for (const r of cells) {
    parts.push(`<rect class="sep" x="${x}" y="9" width="1" height="${H - 18}"/>`)
    parts.push(`<text class="lb" x="${x + CELL_PAD}" y="15" font-family="${MONO}" font-size="8" letter-spacing="1.5">${xml(r.label)}</text>`)
    parts.push(`<text class="${r.tone ?? 'vl'}" x="${x + CELL_PAD}" y="29" font-family="${MONO}" font-size="12">${xml(r.value)}</text>`)
    if (r.bar !== undefined) {
      // An orbit line with a small planet riding it to the fill.
      const bx = x + CELL_PAD + monoWidth(r.value, 12) + 6
      const fw = Math.round(BAR_W * Math.min(1, Math.max(0, r.bar)))
      const tone = r.tone ?? 'ok'
      parts.push(`<path class="trk" d="M${bx} 25h${BAR_W}" stroke-dasharray="1.5 2"/>`)
      parts.push(`<path class="${tone}" d="M${bx} 25h${fw}" stroke-width="1.6" stroke-linecap="round" fill="none"/>`)
      parts.push(`<circle class="${tone}" cx="${bx + fw}" cy="25" r="2.4" stroke="none"/>`)
    }
    x += readoutWidth(r)
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
<style>${SKY_CSS}${isWorking ? skyMotion(W) : ''}</style>
${skyBackdrop(W, H, seed, isWorking)}
${W > 560 ? `<g clip-path="url(#box)">${skyDecor(decor[0], W * 0.8, H * 0.45, 1)}${skyDecor(decor[1], W * 0.93, H * 0.55, 2)}</g>` : ''}
${skyBlackHole(EMBLEM / 2 + 1, H / 2, isWorking, null, false, all.find(r => r.label === 'CONTEXT')?.bar ?? 0)}
${parts.join('')}
<rect class="edge${level ? ' ' + level : ''}" x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="10"/>
</svg>`
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)

    await $.command.register({
      name: 'session_data',
      description: 'Show or hide the session band; `demo <minutes>` previews the cache warning',
    })

    $.clock.every(1000, async () => {
      const expiresAt = (await read($, cache)).expiresAt ?? (await read($, cacheModExpiresAt))
      if (expiresAt === null) return

      const left = Math.max(0, Math.floor((expiresAt - (await $.clock.now())) / 1000))
      if (left !== (await read($, cache)).secondsLeft) {
        await update($, cache, c => ({ expiresAt: c.expiresAt ?? expiresAt, secondsLeft: left }))
      }

      const due = CACHE_NOTIFY_MINUTES.filter(m => left > 0 && left <= m * 60)
      if (due.length === 0 || (await read($, isBusy))) return

      const minutes = Math.min(...due)
      const last = await read($, warned)
      if (last !== 0 && last <= minutes) return

      await update($, warned, () => minutes)
      await notifyCacheExpiry($, Math.ceil(left / 60))
    })

    return result
  })

  on('command.run', { command: 'session_data' }, async ($, e) => {
    // `/session_data demo <minutes>` fakes the cache deadline to preview the warnings;
    // the next answer resets it.
    const demo = e.args.trim().match(/^demo\s+(\d+(?:\.\d+)?)$/)
    if (demo) {
      const seconds = Math.round(Number(demo[1]) * 60)
      const now = await $.clock.now()
      await update($, cache, () => ({ expiresAt: now + seconds * 1000, secondsLeft: seconds }))
      await update($, warned, () => 0)
      await update($, isHidden, () => false)

      return { text: `Cache demo: ${demo[1]} min left until the next answer resets it.` }
    }

    if (e.args.trim() === 'width') {
      const columns = lastColumns
      return { text: columns === null ? 'Band not drawn yet.' : `Band: ${columns} columns, tier ${tierFor(columns)}.` }
    }

    const hidden = !(await read($, isHidden))
    await update($, isHidden, () => hidden)

    return { text: hidden ? 'Session band hidden.' : 'Session band shown.' }
  })

  on('turn.start', async ($, e, next) => {
    const total = (await $.session.usage()).cost?.usd ?? 0
    await update($, stats, s => ({ ...s, turn: s.turn + 1, costAtStart: total, total }))
    await update($, isBusy, () => true)

    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    if (e.agentId !== undefined) return yield* next(e)

    // Measured from the response's first item (its envelope, message_start), so
    // time-to-first-token is excluded but thinking that streams hidden or in one
    // late burst is still timed: output_tokens counts it.
    let startedAt: number | null = null

    for await (const chunk of next(e)) {
      if (startedAt === null) {
        startedAt = await $.clock.now()
      }

      if (chunk.kind === 'stop' && chunk.usage !== null) {
        const tokens = chunk.usage.output_tokens
        const seconds = ((await $.clock.now()) - startedAt) / 1000
        const speed = tokens / seconds
        if (tokens >= MIN_TOKENS && seconds >= MIN_SECONDS && speed <= MAX_SPEED) {
          await update($, stats, s => ({ ...s, speed: Math.round(speed) }))
        }
      }

      yield chunk
    }

    await refresh($)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    await refresh($)

    if (e.agentId === undefined) {
      const now = await $.clock.now()
      await update($, cache, () => ({ expiresAt: now + CACHE_TTL_MS, secondsLeft: CACHE_TTL_MS / 1000 }))
      await update($, isBusy, () => false)
      await update($, warned, () => 0)
    }

    return result
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, stats)
    if (e.props.hasSurvey || s.turn === 0 || (await read($, isHidden))) return next(e)
    // Draw this row with the other mods' bands beneath it, so a band from another plugin
    // (savvy-progress's agents panel) still shows. Claude Code's own placeholder
    // ({ type: 'engine' }) is never nested: the desktop drops a band that nests it.
    const drawn = await Promise.resolve(next(e)).catch(() => null)
    const below = drawn && typeof drawn === 'object' && (drawn as { type?: string }).type !== 'engine' ? drawn : null

    const ui = $.ui.resolve(e)
    const { Box, Button, Text } = ui
    const Svg = 'Svg' in ui ? ui.Svg : null
    const speed = s.speed === null ? '—' : `${s.speed} tok/s`
    const turnCost = s.turnCost === null ? '—' : usd(s.turnCost)

    const { secondsLeft } = await read($, cache)
    const level =
      e.props.isWorking || secondsLeft === null
        ? null
        : secondsLeft <= CACHE_ALERT_S
          ? ALERT
          : secondsLeft <= CACHE_WARN_S
            ? WARN
            : null
    const cacheColor = level ?? CACHE
    const cacheText =
      e.props.isWorking ? '…'
      : secondsLeft === null ? '—'
      : secondsLeft === 0 ? 'expired'
      : `${pad(Math.floor(secondsLeft / 60))}:${pad(secondsLeft % 60)}`

    lastColumns = e.props.bodyColumns

    // Desktop: the JARVIS panel. The terminal's element table carries an `Svg` that
    // draws nothing, so the surface is tested too.
    if (Svg && e.surface !== 'terminal') {
      const hud: Tone | null = level === ALERT ? 'alert' : level === WARN ? 'warn' : null
      const ctxTone: Tone | undefined = s.context >= 85 ? 'alert' : s.context >= 65 ? 'warn' : undefined
      const cells: Readout[] = [
        { label: 'TURN', value: String(s.turn) },
        { label: 'SPEED', value: speed },
        { label: 'TURN COST', value: turnCost },
        { label: 'SESSION', value: usd(s.total) },
        { label: 'CACHE', value: cacheText === '…' ? 'warm' : cacheText, tone: hud ?? undefined },
        { label: 'CONTEXT', value: `${s.context}%`, tone: ctxTone, bar: s.context / 100 },
      ]
      // About 8 CSS px per reported column; the rest is the × and its gap.
      const width = Math.max(200, Math.min(1600, e.props.bodyColumns * 8 - 48))
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Svg
              source={panelSvg(cells, width, e.props.isWorking === true, hud, skySeed(await $.session.id()))}
              alt={cells.map(c => `${c.label} ${c.value}`).join(', ')}
              width={width}
              height={PANEL_H}
            />
            <Button key="hide" label="×" role="dismiss" plain dimColor onPress={() => update($, isHidden, () => true)} />
          </Box>
          {below}
        </Box>
      )
    }

    const tier = tierFor(e.props.bodyColumns)
    const icon = tier >= 3 ? 18 : 22

    return (
      <Box flexDirection="column">
        <Box
          flexDirection="row"
          alignItems="center"
          columnGap={GAPS[tier]}
          flexWrap="nowrap"
          overflow="hidden"
          paddingX={1}
          {...(level ? { borderStyle: 'round', borderColor: level } : {})}
        >
          {tier <= 2 ? (
            <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
              {tier <= 1 ? <Text dimColor>Turn</Text> : <Text dimColor>#</Text>}
              <Text bold>{String(s.turn)}</Text>
            </Box>
          ) : null}
          {tier <= 3 ? (
            <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
              {Svg ? <Svg source={SPEED_ICON} alt="speed" width={icon} height={icon} /> : <Text color={SPEED}>⚡</Text>}
              <Text bold wrap="truncate-end">{tier <= 1 || s.speed === null ? speed : `${s.speed}/s`}</Text>
            </Box>
          ) : null}
          <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {Svg ? <Svg source={MONEY_ICON} alt="cost" width={icon} height={icon} /> : <Text color={MONEY}>$</Text>}
            <Text bold color={MONEY}>{turnCost}</Text>
            {tier <= 2 ? <Text dimColor>|</Text> : null}
            {tier <= 2 ? <Text bold>{usd(s.total)}</Text> : null}
          </Box>
          <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {Svg ? <Svg source={cacheIcon(cacheColor)} alt="cache" width={icon} height={icon} /> : <Text color={cacheColor}>⧗</Text>}
            <Text bold color={level ?? undefined}>{cacheText}</Text>
          </Box>
          <Box flexGrow={1} flexShrink={1} />
          <Box flexDirection="row" alignItems="center" columnGap={1} flexShrink={0}>
            {Svg ? <Svg source={contextIcon(s.context)} alt="context" width={icon} height={icon} /> : null}
            {Svg && tier === 0 ? (
              <Svg source={contextBar(s.context)} alt={`context ${s.context}%`} width={80} height={6} />
            ) : null}
            <Text bold>{`${s.context}%`}</Text>
          </Box>
          <Button key="hide" label="×" role="dismiss" plain dimColor onPress={() => update($, isHidden, () => true)} />
        </Box>
        {below}
      </Box>
    )
  })
}
