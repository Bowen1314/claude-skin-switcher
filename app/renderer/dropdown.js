'use strict'

// In-app dropdown (replaces native <select>). Upgrades a <button> in place and
// keeps the select-like surface the rest of the renderer uses:
//   Dropdown.upgrade(button)
//   button.setOptions([{ value, label }])   rebuild the options
//   button.value / button.value = v         read or set the selection (no event)
//   'change' event on the button            when the person picks an option
//   Dropdown.open(button)                   open it (screenshot mode)
// Listbox pattern: role=listbox / option, aria-expanded, aria-activedescendant.
;(function () {
  const MARGIN = 8
  const GAP = 4
  let seq = 0
  let current = null // { button, root, outside, place, onScroll, frame }

  // Where the list goes for a trigger rect `a`, list size `size` and viewport
  // `view`: 4px under the trigger, flipped up when only the space above fits,
  // always kept inside the viewport margin.
  const position = (a, size, view) => {
    let top = a.bottom + GAP

    if (top + size.height > view.height - MARGIN && a.top - GAP - size.height >= MARGIN) {
      top = a.top - GAP - size.height
    }
    const left = Math.min(a.left, view.width - size.width - MARGIN)

    return {
      left: Math.round(Math.max(MARGIN, left)),
      top: Math.round(Math.max(MARGIN, Math.min(top, view.height - size.height - MARGIN))),
    }
  }

  // True when some of rect `a` is inside every clip rect (scrolling ancestors
  // and the viewport), i.e. the trigger can still be seen.
  const visibleIn = (a, clips) =>
    a.width > 0 && a.height > 0 && clips.every(c => a.bottom > c.top && a.top < c.bottom && a.right > c.left && a.left < c.right)

  // Ancestors that clip the trigger (any overflow other than visible), plus the viewport.
  const clipRects = el => {
    const out = [{ top: 0, left: 0, bottom: window.innerHeight, right: window.innerWidth }]

    for (let n = el.parentElement; n && n !== document.body && n !== document.documentElement; n = n.parentElement) {
      const cs = getComputedStyle(n)

      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        out.push(n.getBoundingClientRect())
      }
    }

    return out
  }

  const same = (a, b) => b !== null && a.top === b.top && a.left === b.left && a.bottom === b.bottom && a.right === b.right

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

  const close = (refocus = true) => {
    const c = current

    if (c === null) {
      return
    }
    current = null
    cancelAnimationFrame(c.frame)
    document.removeEventListener('pointerdown', c.outside, true)
    document.removeEventListener('scroll', c.onScroll, true)
    window.removeEventListener('resize', c.place)
    c.root.remove()
    c.button.setAttribute('aria-expanded', 'false')
    c.button.removeAttribute('aria-activedescendant')
    if (refocus) {
      c.button.focus()
    }
  }

  // Keeps the open list attached to its trigger. Closes it (without moving
  // focus, which would scroll the trigger back) when the trigger is gone,
  // hidden, or scrolled out of its container. Returns the rect it used.
  const place = (root, button, last = null) => {
    if (!button.isConnected || button.getClientRects().length === 0) {
      close(false)

      return null
    }
    const a = button.getBoundingClientRect()

    if (same(a, last)) {
      return last
    }
    if (!visibleIn(a, clipRects(button))) {
      close(false)

      return null
    }
    const p = position(a, { width: root.offsetWidth, height: root.offsetHeight }, { width: window.innerWidth, height: window.innerHeight })

    root.style.left = `${p.left}px`
    root.style.top = `${p.top}px`

    return a
  }

  const upgrade = button => {
    const state = { options: [], value: '' }
    const label = make('span', 'dd-label')
    const chev = make('span', 'dd-chev')

    chev.setAttribute('aria-hidden', 'true')
    button.replaceChildren(label, chev)
    button.setAttribute('aria-haspopup', 'listbox')
    button.setAttribute('aria-expanded', 'false')
    const listId = `dd-list-${++seq}`

    const draw = () => {
      const o = state.options.find(x => x.value === state.value) ?? state.options[0]

      label.textContent = o ? o.label : ''
    }

    Object.defineProperty(button, 'value', {
      configurable: true,
      get: () => state.value,
      set: v => {
        const s = String(v ?? '')

        state.value = state.options.some(o => o.value === s) ? s : (state.options[0]?.value ?? '')
        draw()
      },
    })
    button.setOptions = list => {
      state.options = list.map(o => ({ value: String(o.value), label: String(o.label) }))
      if (!state.options.some(o => o.value === state.value)) {
        state.value = state.options[0]?.value ?? ''
      }
      draw()
      if (current?.button === button) {
        close(false)
      }
    }

    const pick = value => {
      const changed = value !== state.value

      state.value = value
      draw()
      close()
      if (changed) {
        button.dispatchEvent(new Event('change', { bubbles: true }))
      }
    }

    const open = () => {
      close(false)
      if (state.options.length === 0) {
        return
      }
      const root = make('ul', 'popover dd-list')

      root.id = listId
      root.tabIndex = -1
      root.setAttribute('role', 'listbox')
      const name = button.getAttribute('aria-label')

      if (name) {
        root.setAttribute('aria-label', name)
      }
      let active = Math.max(0, state.options.findIndex(o => o.value === state.value))
      const items = state.options.map((o, i) => {
        const li = make('li', 'dd-option')

        li.id = `${listId}-${i}`
        li.setAttribute('role', 'option')
        li.setAttribute('aria-selected', o.value === state.value ? 'true' : 'false')
        li.append(make('span', 'dd-check', o.value === state.value ? '✓' : ''), make('span', 'dd-text', o.label))
        li.addEventListener('click', () => pick(o.value))
        li.addEventListener('pointermove', () => setActive(i, false))
        root.append(li)

        return li
      })
      const setActive = (i, scroll = true) => {
        active = (i + items.length) % items.length
        items.forEach((li, j) => li.classList.toggle('active', j === active))
        root.setAttribute('aria-activedescendant', items[active].id)
        if (scroll) {
          items[active].scrollIntoView({ block: 'nearest' })
        }
      }
      let typed = ''
      let typedAt = 0

      root.addEventListener('keydown', e => {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
          e.preventDefault()
          setActive(active + (e.key === 'ArrowDown' ? 1 : -1))
        } else if (e.key === 'Home' || e.key === 'End') {
          e.preventDefault()
          setActive(e.key === 'Home' ? 0 : items.length - 1)
        } else if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          pick(state.options[active].value)
        } else if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          close()
        } else if (e.key === 'Tab') {
          e.preventDefault()
          close()
        } else if (e.key.length === 1 && /\S/.test(e.key)) {
          // Type-ahead: first letters jump to the next match.
          const now = Date.now()

          typed = now - typedAt > 700 ? e.key.toLowerCase() : typed + e.key.toLowerCase()
          typedAt = now
          const start = typed.length === 1 ? active + 1 : active
          const order = state.options.map((_, k) => (start + k) % items.length)
          const hit = order.find(k => state.options[k].label.toLowerCase().startsWith(typed))

          if (hit !== undefined) {
            setActive(hit)
          }
        }
      })
      const outside = e => {
        if (!root.contains(e.target) && !button.contains(e.target)) {
          close(false)
        }
      }

      document.addEventListener('pointerdown', outside, true)
      document.body.append(root)
      root.style.minWidth = `${Math.round(button.getBoundingClientRect().width)}px`
      let last = null
      const placeIt = () => {
        last = place(root, button, last)
      }
      const replace = () => {
        last = place(root, button, null)
      }
      // Scrolling any container (but not the list itself) moves the trigger.
      const onScroll = e => {
        if (!(e.target instanceof Node && root.contains(e.target))) {
          placeIt()
        }
      }
      const entry = { button, root, outside, place: replace, onScroll, frame: 0 }
      // Layout changes that fire no event (content above the trigger growing,
      // a re-render, the view being hidden) are caught once per frame.
      const tick = () => {
        if (current !== entry) {
          return
        }
        placeIt()
        if (current === entry) {
          entry.frame = requestAnimationFrame(tick)
        }
      }

      current = entry
      window.addEventListener('resize', replace)
      document.addEventListener('scroll', onScroll, true)
      placeIt()
      if (current !== entry) {
        return
      }
      entry.frame = requestAnimationFrame(tick)
      button.setAttribute('aria-expanded', 'true')
      button.setAttribute('aria-controls', listId)
      setActive(active)
      root.focus({ preventScroll: true })
    }

    button.addEventListener('click', () => (current?.button === button ? close() : open()))
    button.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault()
        open()
      }
    })
    button.openList = open
    draw()

    return button
  }

  if (typeof window !== 'undefined') {
    window.Dropdown = { upgrade, open: button => button.openList?.(), close }
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { position, visibleIn }
  }
})()
