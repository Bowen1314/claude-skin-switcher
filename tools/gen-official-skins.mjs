// Generates the official skins (skin.json + scene.svg) into plugin/skins/.
// Run: node tools/gen-official-skins.mjs
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const OUT = join(ROOT, 'plugin', 'skins')

const r1 = n => Math.round(n * 10) / 10

// ---------------------------------------------------------------- Firefly Meadow

function fireflyMeadow() {
  const rand = (i, k) => {
    const x = Math.sin(i * 127.1 + k * 311.7) * 43758.5453

    return x - Math.floor(x)
  }

  const grass = (seed, baseY, height, count) => {
    let d = ''

    for (let i = 0; i < count; i++) {
      const x = (i / count) * 1640 - 20 + rand(i + seed, 1) * 18
      const h = height * (0.55 + rand(i + seed, 2) * 0.6)
      const lean = (rand(i + seed, 3) - 0.5) * 40
      const w = 5 + rand(i + seed, 4) * 5
      d += `M${r1(x)} ${baseY}Q${r1(x + lean * 0.4)} ${r1(baseY - h * 0.6)} ${r1(x + lean)} ${r1(baseY - h)}Q${r1(x + w + lean * 0.3)} ${r1(baseY - h * 0.5)} ${r1(x + w)} ${baseY}Z`
    }

    return d
  }

  const stars = Array.from({ length: 36 }, (_, i) =>
    `<circle class="star" cx="${r1(rand(i, 7) * 1600)}" cy="${r1(rand(i, 8) * 380)}" r="${r1(0.6 + rand(i, 9) * 1.1)}"/>`,
  ).join('')

  // 6 fireflies always, then 3 more for every 5% of the context window.
  const flies = Array.from({ length: 66 }, (_, i) => {
    let x = rand(i, 11) * 1600
    if (x > 620 && x < 980 && rand(i, 12) < 0.6) {
      x = x < 800 ? x - 360 : x + 360
    }
    const y = 360 + rand(i, 13) * 560
    const drift = 1 + Math.floor(rand(i, 14) * 4)
    const driftDur = r1(18 + rand(i, 15) * 22)
    const driftDelay = r1(rand(i, 16) * 30)
    const blinkDur = r1(3.2 + rand(i, 17) * 4.5)
    const blinkDelay = r1(rand(i, 18) * 8)
    const size = r1(0.75 + rand(i, 19) * 0.6)
    const ctx = i < 6 ? '' : ` data-ctx="${(Math.floor((i - 6) / 3) + 1) * 5 / 100}"`

    return (
      `<g transform="translate(${r1(x)} ${r1(y)}) scale(${size})"${ctx}>` +
      `<g class="dr d${drift}" style="animation-duration:${driftDur}s;animation-delay:-${driftDelay}s">` +
      `<g class="bl" opacity="0.8" style="animation-duration:${blinkDur}s;animation-delay:-${blinkDelay}s">` +
      `<circle r="16" fill="url(#glow)"/><circle class="core" r="2.4"/>` +
      `</g></g></g>`
    )
  }).join('\n')

  const scene = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
<style>
svg{--v-glow:#f5c24a;--v-size:1;--v-stars:1}
.s0{stop-color:#121230}.s1{stop-color:#2a2350}.s2{stop-color:#4b3760}.s3{stop-color:#6e4a62}
.hill1{fill:#20263a}.hill2{fill:#18202a}.bg{fill:#132019}.bgr{fill:#18281e}.fg{fill:#0d1712}
.star{fill:#f4efe0;opacity:calc(0.55 * var(--v-stars))}.moon{fill:#f3ead2;opacity:.85}
.g0{stop-color:#fff3b8}.g1{stop-color:var(--v-glow)}
.core{fill:#fff6cf}
.sz{transform:scale(var(--v-size))}
.dr{animation-timing-function:ease-in-out;animation-iteration-count:infinite;animation-direction:alternate}
.d1{animation-name:d1}.d2{animation-name:d2}.d3{animation-name:d3}.d4{animation-name:d4}
@keyframes d1{0%{transform:translate(0px,0px)}50%{transform:translate(46px,-34px)}100%{transform:translate(-18px,-70px)}}
@keyframes d2{0%{transform:translate(0px,0px)}50%{transform:translate(-52px,-22px)}100%{transform:translate(-20px,-64px)}}
@keyframes d3{0%{transform:translate(0px,0px)}50%{transform:translate(30px,26px)}100%{transform:translate(64px,-24px)}}
@keyframes d4{0%{transform:translate(0px,0px)}50%{transform:translate(-26px,30px)}100%{transform:translate(-60px,-12px)}}
.bl{animation-name:bl;animation-iteration-count:infinite;animation-timing-function:ease-in-out}
@keyframes bl{0%{opacity:.12}40%{opacity:1}60%{opacity:.9}100%{opacity:.12}}
.sway{transform-box:fill-box;transform-origin:50% 100%;animation:sway 9s ease-in-out infinite}
.sway2{transform-box:fill-box;transform-origin:50% 100%;animation:sway 12s ease-in-out infinite reverse}
@keyframes sway{0%{transform:skewX(0deg)}50%{transform:skewX(2.2deg)}100%{transform:skewX(0deg)}}
@media (prefers-color-scheme: light){
.s0{stop-color:#b9b4e0}.s1{stop-color:#d3c2e2}.s2{stop-color:#ecc8d0}.s3{stop-color:#f6d6b4}
.hill1{fill:#9aa59a}.hill2{fill:#80957f}.bg{fill:#6f8c66}.bgr{fill:#647f5c}.fg{fill:#56744f}
.star{opacity:0}.moon{fill:#fbf6ea;opacity:.7}
.g0{stop-color:#ffe08a}
.core{fill:#fff1c0}
}
</style>
<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1">
<stop class="s0" offset="0"/><stop class="s1" offset="0.38"/><stop class="s2" offset="0.62"/><stop class="s3" offset="0.78"/>
</linearGradient>
<radialGradient id="glow">
<stop class="g0" offset="0" stop-opacity="0.95"/><stop class="g1" offset="0.28" stop-opacity="0.45"/><stop class="g1" offset="1" stop-opacity="0"/>
</radialGradient>
</defs>
<rect width="1600" height="1000" fill="url(#sky)"/>
${stars}
<path class="moon" d="M1150 150a46 46 0 1 0 38 72a38 38 0 1 1 -38 -72Z"/>
<path class="hill1" d="M0 640C180 560 360 590 540 610S900 540 1100 570S1440 600 1600 560V1000H0Z"/>
<path class="hill2" d="M0 720C220 660 420 700 640 690S1040 640 1260 680S1500 700 1600 680V1000H0Z"/>
<path class="bg" d="M0 790C300 760 600 780 900 770S1400 760 1600 780V1000H0Z"/>
<path class="bgr sway" d="${grass(0, 1000, 150, 140)}"/>
${flies.replaceAll('<g class="bl"', '<g class="sz"><g class="bl"').replaceAll('</g></g></g>', '</g></g></g></g>')}
<path class="fg sway2" d="${grass(500, 1000, 90, 90)}"/>
</svg>
`

  const skin = {
    format: 1,
    slug: 'firefly-meadow',
    name: 'Firefly Meadow',
    description: 'Fireflies drift over a meadow at dusk; more gather as the context window fills.',
    author: 'official',
    version: 1,
    tags: ['animated', 'cozy', 'nature'],
    colors: {
      roles: { accent: '#e0a83a', danger: '#c8574e', success: '#6f9a5a', warning: '#d9783a', pro: '#a37fd2' },
      light: {
        anchors: {
          'surface-0': '#e7e2ee', 'surface-1': '#eee9f4', 'surface-2': '#f6f3f9', 'surface-3': '#f6f3f9',
          'text-primary': '#221e36', 'text-secondary': '#48425e', 'text-muted': '#5f5975',
        },
      },
      dark: {
        anchors: {
          'surface-0': '#141526', 'surface-1': '#1a1b2f', 'surface-2': '#202137', 'surface-3': '#25263e',
          'text-primary': '#ece8f4', 'text-secondary': '#c6c1d6', 'text-muted': '#9e99b3',
        },
      },
    },
    backdrop: { scene: true, glass: { blur: 14, opacity: 0.55 } },
    variables: [
      { key: 'glow', label: 'Firefly color', type: 'color', default: '#f5c24a' },
      { key: 'size', label: 'Firefly size', type: 'range', min: 0.6, max: 1.6, step: 0.05, default: 1 },
      { key: 'stars', label: 'Stars', type: 'toggle', default: true },
    ],
  }

  return { skin, scene }
}

// ---------------------------------------------------------------- Graphite Circuit

function graphiteCircuit() {
  const rand = (i, k) => {
    const x = Math.sin(i * 91.7 + k * 271.3) * 43758.5453

    return x - Math.floor(x)
  }
  const snap = n => Math.round(n / 8) * 8
  const PER_SIDE = 12
  const PADS = PER_SIDE * 4
  const litCount = step => 3 + Math.round((step * (PADS - 3)) / 20)

  const traces = Array.from({ length: PER_SIDE * 2 }, (_, i) => {
    const side = i % 2 === 0 ? 1 : -1
    const k = Math.floor(i / 2)
    const y0 = snap(70 + k * 74 + rand(i, 1) * 24)
    const x1 = snap(56 + rand(i, 2) * 200)
    const jog = [32, 48, 64][Math.floor(rand(i, 3) * 3)] ?? 32
    const dir = y0 < 120 ? 1 : y0 > 860 ? -1 : rand(i, 4) < 0.5 ? -1 : 1
    const x2 = Math.min(470, snap(x1 + jog + 60 + rand(i, 5) * 170))
    const y1 = y0 + dir * jog
    const X = x => (side === 1 ? x : 1600 - x)

    return { d: `M${X(0)} ${y0}H${X(x1)}L${X(x1 + jog)} ${y1}H${X(x2)}`, via: [X(x1 + jog), y1], end: [X(x2), y1] }
  })

  const order = Array.from({ length: PADS }, (_, i) => i).sort((a, b) => rand(a, 9) - rand(b, 9))
  const rank = new Map(order.map((id, r) => [id, r]))
  // The fill at which a pad of this rank lights: the first 5% step whose count passes it.
  const threshold = r => {
    for (let step = 0; step <= 20; step++) {
      if (litCount(step) > r) {
        return step * 0.05
      }
    }

    return 1
  }

  let marks = ''
  for (let x = 160; x < 1600; x += 160) {
    for (let y = 160; y < 1000; y += 160) {
      const isMiddle = x > 480 && x < 1120 && y > 200 && y < 800
      if (!isMiddle && rand(x, y) < 0.45) {
        marks += `M${x - 5} ${y}H${x + 5}M${x} ${y - 5}V${y + 5}`
      }
    }
  }

  let paths = ''
  let pads = ''
  let lit = ''
  traces.forEach((t, i) => {
    paths += `<path class="tr" d="${t.d}"/>`
    ;[t.via, t.end].forEach(([x, y], j) => {
      const id = i * 2 + j
      const isEnd = j === 1
      pads += isEnd
        ? `<rect class="pad" x="${x - 3.5}" y="${y - 3.5}" width="7" height="7"/>`
        : `<circle class="via" cx="${x}" cy="${y}" r="3.2"/>`
      const th = threshold(rank.get(id))
      const ctx = th > 0 ? ` data-ctx="${Number(th.toFixed(2))}"` : ''
      const dur = (5 + rand(id, 6) * 4).toFixed(1)
      const delay = (rand(id, 7) * 6).toFixed(1)
      lit +=
        `<g class="on" opacity="0.85"${ctx} style="animation-duration:${dur}s;animation-delay:-${delay}s">` +
        `<rect class="halo" x="${x - 9}" y="${y - 9}" width="18" height="18"/>` +
        (isEnd
          ? `<rect class="lit" x="${x - 3.5}" y="${y - 3.5}" width="7" height="7"/>`
          : `<circle class="lit" cx="${x}" cy="${y}" r="3.2"/>`) +
        `</g>\n`
    })
  })

  // 1 data packet always, one more every 15%.
  let packets = ''
  for (let p = 0; p < 7; p++) {
    const t = traces[Math.floor(rand(p, 8) * traces.length)]
    const ctx = p === 0 ? '' : ` data-ctx="${Number((p * 0.15).toFixed(2))}"`
    const dur = (7 + rand(p, 10) * 5).toFixed(1)
    const delay = (rand(p, 11) * 8).toFixed(1)
    packets += `<path class="pk" pathLength="100" d="${t.d}"${ctx} style="animation-duration:${dur}s;animation-delay:-${delay}s"/>`
  }

  const scene = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1600 1000" preserveAspectRatio="xMidYMid slice">
<style>
svg{--v-signal:#3ec6d8;--v-grid:1;--v-circuit:1}
.bgc{fill:#0b0d10}.dot{fill:#252a32}.maj{stroke:#171b21;stroke-width:1;fill:none}.mk{stroke:#3a424c;stroke-width:1;fill:none}
.grid{opacity:var(--v-grid)}.circ{opacity:var(--v-circuit)}
.tr{stroke:#26343a;stroke-width:1.4;fill:none;stroke-linejoin:round}
.pad{fill:#0b0d10;stroke:#33404a;stroke-width:1.2}.via{fill:#0b0d10;stroke:#2c3842;stroke-width:1.2}
.lit{fill:var(--v-signal)}.halo{fill:var(--v-signal);opacity:.12}
.pk{stroke:var(--v-signal);stroke-width:1.8;fill:none;stroke-linecap:square;stroke-dasharray:5 95;stroke-dashoffset:60;animation-name:run;animation-timing-function:linear;animation-iteration-count:infinite}
.on{animation-name:hum;animation-timing-function:ease-in-out;animation-iteration-count:infinite;animation-direction:alternate}
.f0{stop-color:#0b0d10}
@keyframes hum{0%{opacity:.55}100%{opacity:1}}
@keyframes run{0%{stroke-dashoffset:100}100%{stroke-dashoffset:0}}
@media (prefers-color-scheme: light){
.bgc{fill:#e8ebee}.dot{fill:#c3c9d0}.maj{stroke:#d9dde2}.mk{stroke:#aab2bb}
.tr{stroke:#b3c2c8}
.pad{fill:#e8ebee;stroke:#a7b3bb}.via{fill:#e8ebee;stroke:#b0bcc3}
.f0{stop-color:#e8ebee}
}
</style>
<defs>
<pattern id="dots" width="32" height="32" patternUnits="userSpaceOnUse"><circle class="dot" cx="16" cy="16" r="1"/></pattern>
<pattern id="major" width="160" height="160" patternUnits="userSpaceOnUse"><path class="maj" d="M160 0V160M0 160H160"/></pattern>
<radialGradient id="hush" cx="0.5" cy="0.5" r="0.5">
<stop class="f0" offset="0" stop-opacity="0.9"/><stop class="f0" offset="0.55" stop-opacity="0.55"/><stop class="f0" offset="1" stop-opacity="0"/>
</radialGradient>
</defs>
<rect class="bgc" width="1600" height="1000"/>
<g class="grid">
<rect width="1600" height="1000" fill="url(#major)"/>
<rect width="1600" height="1000" fill="url(#dots)"/>
<path class="mk" d="${marks}"/>
</g>
<g class="circ">
${paths}
${packets}
${pads}
${lit}</g>
<rect x="300" y="60" width="1000" height="880" fill="url(#hush)"/>
</svg>
`

  const skin = {
    format: 1,
    slug: 'graphite-circuit',
    name: 'Graphite Circuit',
    description: 'Graphite and one signal cyan over a faint circuit grid; more nodes light up as the context fills.',
    author: 'official',
    version: 1,
    tags: ['animated', 'minimal', 'tech'],
    colors: {
      roles: { accent: '#35b8c9', danger: '#e0524a', success: '#4fb37a', warning: '#d9a033', pro: '#8b7cf0' },
      light: {
        anchors: {
          'surface-0': '#eceef1', 'surface-1': '#f3f4f6', 'surface-2': '#fafbfc', 'surface-3': '#fafbfc',
          'text-primary': '#15181d', 'text-secondary': '#3b414b', 'text-muted': '#555c67',
        },
      },
      dark: {
        anchors: {
          'surface-0': '#0e1013', 'surface-1': '#14171b', 'surface-2': '#1a1d22', 'surface-3': '#1f2328',
          'text-primary': '#e6e9ee', 'text-secondary': '#b4bac4', 'text-muted': '#8a919c',
        },
      },
    },
    backdrop: { scene: true, glass: { blur: 10, opacity: 0.72 } },
    style: {
      Heading: { fontFamily: ['mono'], fontWeight: 'semibold', letterSpacing: 0.4 },
      UserMessage: { backgroundColor: 'surface-1', borderColor: 'border-strong', borderWidth: 1, radius: 3, shadow: 'none', paddingX: 14, paddingY: 10 },
      ToolUse: { fontFamily: ['mono'], backgroundColor: 'surface-1', borderColor: 'border', borderWidth: 1, radius: 2, paddingX: 8 },
    },
    variables: [
      { key: 'signal', label: 'Signal color', type: 'color', default: '#3ec6d8' },
      { key: 'grid', label: 'Grid strength', type: 'range', min: 0, max: 1, step: 0.05, default: 1 },
      { key: 'circuit', label: 'Circuit traces', type: 'toggle', default: true },
    ],
  }

  return { skin, scene }
}

for (const { skin, scene } of [fireflyMeadow(), graphiteCircuit()]) {
  const dir = join(OUT, `official.${skin.slug}`)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'skin.json'), `${JSON.stringify(skin, null, 2)}\n`)
  writeFileSync(join(dir, 'scene.svg'), scene)
  console.log(`${skin.slug}: scene ${scene.length} chars`)
}
