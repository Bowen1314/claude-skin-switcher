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
  let current = null // { button, root, outside, place }

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
    document.removeEventListener('pointerdown', c.outside, true)
    window.removeEventListener('resize', c.place)
    c.root.remove()
    c.button.setAttribute('aria-expanded', 'false')
    c.button.removeAttribute('aria-activedescendant')
    if (refocus) {
      c.button.focus()
    }
  }

  const place = (root, button) => {
    const a = button.getBoundingClientRect()
    const h = root.offsetHeight
    const w = root.offsetWidth
    let top = a.bottom + GAP

    // Flip up when there is no room below and more room above.
    if (top + h > window.innerHeight - MARGIN && a.top - GAP - h >= MARGIN) {
      top = a.top - GAP - h
    }
    const left = Math.min(a.left, window.innerWidth - w - MARGIN)

    root.style.left = `${Math.round(Math.max(MARGIN, left))}px`
    root.style.top = `${Math.round(Math.max(MARGIN, Math.min(top, window.innerHeight - h - MARGIN)))}px`
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
      const placeIt = () => place(root, button)

      window.addEventListener('resize', placeIt)
      placeIt()
      current = { button, root, outside, place: placeIt }
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

  window.Dropdown = { upgrade, open: button => button.openList?.(), close }
})()
