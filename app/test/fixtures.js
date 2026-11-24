'use strict'

// The same tiny skin and scene as plugin/tests/bridge.test.tsx.
const TINY_SCENE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><style>svg{--v-glow:#ffffff;--v-size:1;--v-stars:1}.a{fill:var(--v-glow)}</style><circle class="a" r="5"/><g data-ctx="0.3"><circle r="2"/></g><g data-ctx="0.75"><circle r="3"/></g></svg>`

const tinySkin = (extra = {}) => ({
  format: 1,
  slug: 'tiny',
  name: 'Tiny',
  colors: {
    roles: { accent: '#35b8c9' },
    dark: { anchors: { 'surface-0': '#101114', 'surface-1': '#16181c', 'text-primary': '#e8e9eb', 'text-muted': '#8b9099' } },
    light: { anchors: { 'surface-0': '#eceef1', 'surface-1': '#f3f4f6', 'text-primary': '#15181d', 'text-muted': '#555c67' } },
  },
  backdrop: { scene: true, glass: { blur: 10, opacity: 0.7 } },
  style: { UserMessage: { radius: 3, borderWidth: 1 } },
  variables: [
    { key: 'glow', label: 'Glow', type: 'color', default: '#f5c24a' },
    { key: 'size', label: 'Size', type: 'range', min: 0.5, max: 2, step: 0.1, default: 1 },
    { key: 'stars', label: 'Stars', type: 'toggle', default: true },
  ],
  ...extra,
})

module.exports = { TINY_SCENE, tinySkin }
