'use strict'

// In-app colour picker popover (replaces <input type=color>). DOM only, built
// with createElement/textContent. One picker open at a time.
//   ColorPicker.open({ anchor, value, label, palette, strings, onInput })
//   ColorPicker.close()
// onInput(hex) fires while dragging (at most once a frame); the caller decides
// what that means (here: the draft and the preview, never a write).
;(function () {
  const C = window.ColorMath
  const COMMON = ['#ffffff', '#000000', '#ef4444', '#f59e0b', '#22c55e', '#3b82f6', '#8b5cf6', '#ec4899']
  const MARGIN = 8
  const GAP = 6

  let current = null // { root, anchor, ... }

  const make = (tag, className, text) => {
    const n = document.createElement(tag)

    if (className) {
      n.className = className
    }
    if (text !== undefined) {
      n.textContent = text
    }

    return n
  }
  const fill = (text, vars) => text.replace(/\{(\w+)\}/g, (_, k) => (vars[k] === undefined ? `{${k}}` : String(vars[k])))

  const close = ({ refocus = false } = {}) => {
    const p = current

    if (p === null) {
      return
    }
    // A typed hex counts, and the last dragged colour is delivered, before teardown.
    p.flush?.()
    current = null
    cancelAnimationFrame(p.raf)
    document.removeEventListener('pointerdown', p.outside, true)
    window.removeEventListener('resize', p.place)
    p.root.remove()
    p.anchor.setAttribute('aria-expanded', 'false')
    if (refocus) {
      p.anchor.focus()
    }
  }

  // Next to the anchor: below, or above when there is no room; never off-window.
  const placeNear = (root, anchor) => {
    const a = anchor.getBoundingClientRect()
    const w = root.offsetWidth
    const h = root.offsetHeight
    const vw = window.innerWidth
    const vh = window.innerHeight
    let top = a.bottom + GAP

    if (top + h > vh - MARGIN && a.top - GAP - h >= MARGIN) {
      top = a.top - GAP - h
    }
    let left = a.left

    if (left + w > vw - MARGIN) {
      left = a.right - w
    }
    root.style.left = `${Math.round(C.clamp(left, MARGIN, Math.max(MARGIN, vw - w - MARGIN)))}px`
    root.style.top = `${Math.round(C.clamp(top, MARGIN, Math.max(MARGIN, vh - h - MARGIN)))}px`
  }

  const open = ({ anchor, value, label, palette = [], strings: S, onInput }) => {
    close()
    const initial = C.parseHex(value) ?? '#000000'
    const hsv = C.hexToHsv(initial)
    const root = make('div', 'popover picker')

    root.setAttribute('role', 'dialog')
    root.setAttribute('aria-label', fill(S.pickerDialog, { label }))

    const sv = make('div', 'pk-sv')
    const svThumb = make('span', 'pk-sv-thumb')

    sv.append(make('span', 'pk-sv-white'), make('span', 'pk-sv-black'), svThumb)
    sv.tabIndex = 0
    sv.setAttribute('role', 'slider')
    sv.setAttribute('aria-label', S.pickerSV)

    const hue = make('div', 'pk-hue')
    const hueThumb = make('span', 'pk-hue-thumb')

    hue.append(hueThumb)
    hue.tabIndex = 0
    hue.setAttribute('role', 'slider')
    hue.setAttribute('aria-label', S.pickerHue)
    hue.setAttribute('aria-valuemin', '0')
    hue.setAttribute('aria-valuemax', '360')

    const was = make('button', 'pk-chip pk-was')
    const now = make('span', 'pk-chip pk-now')

    was.type = 'button'
    was.title = S.pickerInitial
    was.setAttribute('aria-label', `${S.pickerInitial} ${initial}`)
    was.style.backgroundColor = initial
    now.title = S.pickerCurrent
    const chips = make('div', 'pk-compare')

    chips.append(was, now)

    const hex = make('input', 'pk-hex')

    Object.assign(hex, { type: 'text', spellcheck: false, maxLength: 9 })
    hex.setAttribute('aria-label', S.pickerHex)
    hex.autocomplete = 'off'

    const row = make('div', 'pk-row')

    row.append(chips, hex)
    if (typeof window.EyeDropper === 'function') {
      const drop = make('button', 'pk-drop')

      drop.type = 'button'
      drop.title = S.pickerEyedropper
      drop.setAttribute('aria-label', S.pickerEyedropper)
      drop.append(make('span', 'pk-drop-icon'))
      drop.addEventListener('click', async () => {
        try {
          const r = await new window.EyeDropper().open()

          setHex(r.sRGBHex)
        } catch {
          // cancelled
        }
      })
      row.append(drop)
    }

    const seen = new Set()
    const unique = list => list.map(c => C.parseHex(c)).filter(c => c !== null && !seen.has(c) && seen.add(c))
    // One row of the skin's own colours (deduped), one row of common ones.
    const swatchList = [...unique(palette).slice(0, 8), ...unique(COMMON)]
    const swatches = make('div', 'pk-swatches')

    swatches.setAttribute('role', 'group')
    swatches.setAttribute('aria-label', S.pickerSwatches)
    for (const c of swatchList) {
      const b = make('button', 'pk-swatch')

      b.type = 'button'
      b.style.backgroundColor = c
      b.title = c
      b.setAttribute('aria-label', c)
      b.addEventListener('click', () => setHex(c))
      swatches.append(b)
    }

    root.append(sv, hue, row, swatches)

    const p = { root, anchor, raf: 0, pending: null }

    // Emit at most once per frame while dragging.
    const emit = hexValue => {
      p.pending = hexValue
      if (p.raf === 0) {
        p.raf = requestAnimationFrame(() => {
          p.raf = 0
          const v = p.pending

          p.pending = null
          if (v !== null && current === p) {
            onInput(v)
          }
        })
      }
    }

    const draw = () => {
      const h = C.hsvToHex(hsv)

      sv.style.backgroundColor = C.hsvToHex({ h: hsv.h, s: 1, v: 1 })
      svThumb.style.left = `${hsv.s * 100}%`
      svThumb.style.top = `${(1 - hsv.v) * 100}%`
      svThumb.style.backgroundColor = h
      hueThumb.style.left = `${(hsv.h / 360) * 100}%`
      now.style.backgroundColor = h
      now.setAttribute('aria-label', `${S.pickerCurrent} ${h}`)
      sv.setAttribute('aria-valuetext', fill(S.pickerSVValue, { s: Math.round(hsv.s * 100), v: Math.round(hsv.v * 100) }))
      hue.setAttribute('aria-valuenow', String(Math.round(hsv.h)))
      if (document.activeElement !== hex) {
        hex.value = h
      }

      return h
    }

    const changed = () => emit(draw())

    const setHex = text => {
      const h = C.parseHex(text)

      if (h === null) {
        return false
      }
      Object.assign(hsv, C.hexToHsv(h))
      hex.value = h
      changed()

      return true
    }

    const drag = (target, update) => {
      target.addEventListener('pointerdown', e => {
        if (e.button !== 0) {
          return
        }
        e.preventDefault()
        target.focus()
        target.setPointerCapture(e.pointerId)
        update(e)
        const move = ev => update(ev)
        const up = ev => {
          target.releasePointerCapture(ev.pointerId)
          target.removeEventListener('pointermove', move)
          target.removeEventListener('pointerup', up)
          target.removeEventListener('pointercancel', up)
        }

        target.addEventListener('pointermove', move)
        target.addEventListener('pointerup', up)
        target.addEventListener('pointercancel', up)
      })
    }

    drag(sv, e => {
      const r = sv.getBoundingClientRect()

      hsv.s = C.clamp((e.clientX - r.left) / r.width, 0, 1)
      hsv.v = 1 - C.clamp((e.clientY - r.top) / r.height, 0, 1)
      changed()
    })
    drag(hue, e => {
      const r = hue.getBoundingClientRect()

      hsv.h = C.clamp((e.clientX - r.left) / r.width, 0, 1) * 359.999
      changed()
    })

    sv.addEventListener('keydown', e => {
      const step = e.shiftKey ? 0.1 : 0.01
      const moves = { ArrowLeft: ['s', -step], ArrowRight: ['s', step], ArrowUp: ['v', step], ArrowDown: ['v', -step] }
      const m = moves[e.key]

      if (m) {
        e.preventDefault()
        hsv[m[0]] = C.clamp(hsv[m[0]] + m[1], 0, 1)
        changed()
      }
    })
    hue.addEventListener('keydown', e => {
      const step = e.shiftKey ? 10 : 1
      const d = { ArrowLeft: -step, ArrowDown: -step, ArrowRight: step, ArrowUp: step }[e.key]

      if (d !== undefined) {
        e.preventDefault()
        hsv.h = C.clamp(hsv.h + d, 0, 359.999)
        changed()
      } else if (e.key === 'Home' || e.key === 'End') {
        e.preventDefault()
        hsv.h = e.key === 'Home' ? 0 : 359.999
        changed()
      }
    })

    // Validated on Enter or blur; an invalid value goes back to the current colour.
    const commitHex = () => {
      const h = C.parseHex(hex.value)

      if (h === null) {
        hex.value = C.hsvToHex(hsv)
      } else if (h !== C.hsvToHex(hsv)) {
        setHex(h)
      } else {
        hex.value = h // same colour: no draft change
      }
    }

    hex.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault()
        commitHex()
      }
    })
    hex.addEventListener('blur', commitHex)
    was.addEventListener('click', () => setHex(initial))

    // Esc closes and keeps the current colour.
    root.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        close({ refocus: true })
      }
    })
    // Tabbing out of the popover closes it.
    root.addEventListener('focusout', e => {
      if (current === p && e.relatedTarget !== null && !root.contains(e.relatedTarget)) {
        close()
      }
    })
    p.flush = () => {
      if (document.activeElement === hex) {
        commitHex()
      }
      if (p.pending !== null) {
        const v = p.pending

        p.pending = null
        onInput(v)
      }
    }
    p.outside = e => {
      if (!root.contains(e.target) && !anchor.contains(e.target)) {
        close()
      }
    }
    p.place = () => placeNear(root, anchor)
    document.addEventListener('pointerdown', p.outside, true)
    window.addEventListener('resize', p.place)

    current = p
    draw()
    hex.value = initial
    // Right after the trigger in the DOM, so Tab moves into it and on out of it.
    anchor.after(root)
    anchor.setAttribute('aria-expanded', 'true')
    placeNear(root, anchor)
    sv.focus({ preventScroll: true })
  }

  window.ColorPicker = { open, close, isOpenFor: anchor => current !== null && current.anchor === anchor }
})()
