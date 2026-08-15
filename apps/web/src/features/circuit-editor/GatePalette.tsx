/**
 * The gate palette, grouped by what a gate *is* — one qubit, parametrised,
 * two, three, structural — because that is also the order in which the gates
 * stop being obvious.
 *
 * Every chip does the same thing by two routes, and they are equals rather
 * than a route and its fallback:
 *
 *  - **Pointer**: drag the chip onto a cell.
 *  - **Keyboard**: press the gate's key (or Enter on the chip) to *arm* it,
 *    then Enter on a cell of the grid. Space starts a dnd-kit keyboard drag
 *    instead, for users who prefer to move the gate rather than aim at it.
 *
 * The chips share one tab stop. Twenty-six gates, each its own stop, would
 * be twenty-six presses of Tab between the palette and the canvas — a
 * palette that is technically reachable and practically a wall. Arrow keys
 * move within it, which is the standard roving-tabindex model, and every
 * chip carries its `aria-keyshortcuts` so the key is not a secret.
 */

import { useDraggable } from '@dnd-kit/core'
import type { GateId, GateMeta } from '@qsim/schema'
import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import { GATE_KEYS, PALETTE, PALETTE_ORDER } from './gateCatalog'

export interface GatePaletteProps {
  /** The gate a cell will receive on Enter, if any. */
  readonly armed: GateId | null
  readonly onArm: (gate: GateId) => void
  readonly disabled?: boolean
}

/** dnd-kit identifier for a palette chip. */
function paletteDragId(gate: GateId): string {
  return `palette:${gate}`
}

export function GatePalette({
  armed,
  onArm,
  disabled = false,
}: GatePaletteProps) {
  const { t } = useTranslation(['gates', 'editor'])
  const [active, setActive] = useState(0)
  const [seenArmed, setSeenArmed] = useState<GateId | null>(armed)
  const container = useRef<HTMLDivElement | null>(null)

  // Arming a gate by keystroke moves the palette's single tab stop onto it,
  // so Tab lands on the chip the user just chose rather than on whichever
  // one they last arrowed past. Adjusting state during render is React's own
  // answer for "derived from a prop that changed"; an effect would paint one
  // frame with the tab stop in the wrong place.
  if (armed !== seenArmed) {
    setSeenArmed(armed)
    const index = armed === null ? -1 : PALETTE_ORDER.indexOf(armed)
    if (index >= 0) setActive(index)
  }

  const focusChip = (index: number) => {
    const wrapped = (index + PALETTE_ORDER.length) % PALETTE_ORDER.length
    setActive(wrapped)
    const chips =
      container.current?.querySelectorAll<HTMLButtonElement>('[data-gate]')
    chips?.item(wrapped)?.focus()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0
    if (step !== 0) {
      // Stopped here rather than left to bubble: the editor's own arrow keys
      // drive the grid cursor, and a palette that also moved it would make
      // one press do two things.
      event.preventDefault()
      event.stopPropagation()
      focusChip(active + step)
      return
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault()
      event.stopPropagation()
      focusChip(event.key === 'Home' ? 0 : PALETTE_ORDER.length - 1)
    }
  }

  return (
    <section className="gate-palette" aria-label={t('gates:paletteLabel')}>
      <p className="gate-palette__hint">{t('gates:hint')}</p>
      <div ref={container} onKeyDown={handleKeyDown}>
        {PALETTE.map((group) => (
          <PaletteGroup
            key={group.category}
            heading={t(`gates:category.${group.category}`)}
            gates={group.gates}
            armed={armed}
            activeGate={PALETTE_ORDER[active]}
            disabled={disabled}
            onArm={onArm}
          />
        ))}
      </div>
    </section>
  )
}

function PaletteGroup({
  heading,
  gates,
  armed,
  activeGate,
  disabled,
  onArm,
}: {
  heading: string
  gates: readonly GateMeta[]
  armed: GateId | null
  activeGate: GateId | undefined
  disabled: boolean
  onArm: (gate: GateId) => void
}) {
  const headingId = useId()
  return (
    <div
      className="gate-palette__group"
      role="group"
      aria-labelledby={headingId}
    >
      <h3 className="gate-palette__heading" id={headingId}>
        {heading}
      </h3>
      <div className="gate-palette__chips">
        {gates.map((meta) => (
          <PaletteChip
            key={meta.id}
            meta={meta}
            armed={armed === meta.id}
            tabbable={activeGate === meta.id}
            disabled={disabled}
            onArm={onArm}
          />
        ))}
      </div>
    </div>
  )
}

function PaletteChip({
  meta,
  armed,
  tabbable,
  disabled,
  onArm,
}: {
  meta: GateMeta
  armed: boolean
  tabbable: boolean
  disabled: boolean
  onArm: (gate: GateId) => void
}) {
  const { t } = useTranslation('gates')
  const { setNodeRef, attributes, listeners, isDragging } = useDraggable({
    id: paletteDragId(meta.id),
    disabled,
    data: { kind: 'palette', gate: meta.id },
  })

  const className = [
    'gate-palette__chip',
    armed ? 'gate-palette__chip--armed' : null,
    isDragging ? 'gate-palette__chip--dragging' : null,
  ]
    .filter((token) => token !== null)
    .join(' ')

  return (
    <button
      // dnd-kit's attributes come first so the ones that matter here — the
      // tab index of the roving model, the pressed state of the armed gate,
      // and a role description in the user's own language rather than
      // dnd-kit's English default — are the ones that survive.
      {...attributes}
      {...listeners}
      ref={setNodeRef}
      type="button"
      data-gate={meta.id}
      className={className}
      tabIndex={tabbable ? 0 : -1}
      aria-pressed={armed}
      aria-roledescription={t('draggable')}
      aria-keyshortcuts={GATE_KEYS[meta.id]}
      disabled={disabled}
      onClick={() => {
        onArm(meta.id)
      }}
    >
      <Notation className="gate-palette__symbol" value={meta.symbol} />
      <span className="gate-palette__key" aria-hidden="true">
        <Notation value={GATE_KEYS[meta.id]} />
      </span>
    </button>
  )
}
