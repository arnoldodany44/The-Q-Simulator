/**
 * The angle editor for the selected gate: a slider and a numeric field for
 * each parameter, showing the same number twice on purpose.
 *
 * The two controls are not alternatives, they answer different questions.
 * The slider answers "what happens as I turn this", which is the whole
 * reason the analysis panel exists; the field answers "make it exactly
 * 0,7854". They stay in sync because neither owns the value — both read the
 * circuit and both write through `setParam`, so there is no local copy to
 * drift.
 *
 * Every number is formatted with `Intl.NumberFormat` bound to the active
 * locale (D2, §1.1): French writes `1,5708`, and a hardcoded decimal point
 * is not a cosmetic slip, it is an angle that reads as a thousands
 * separator for a third of the users. Parsing is deliberately looser than
 * formatting — see `angles.ts`.
 *
 * Alongside the radians, the π form: `π/2` says "a quarter turn" in a way
 * `1,5708` never will, and the slider's sixteenths-of-π resolution is
 * chosen so that dragging almost always lands on one.
 *
 * Symbolic parameters (`theta`, for sweeps) are shown but not edited here.
 * They are identifiers, not quantities, and they belong to the circuit's
 * parameter list rather than to one gate.
 *
 * ## One gesture, one undo step
 *
 * Dragging a slider from 0 to π fires a `change` for every stop it passes,
 * and each one is a real edit of the document — that is the point, the
 * phasors have to turn while the drag is happening. What none of them is, is
 * a place the user ever wants to come back to: undoing a single drag once
 * cost dozens of presses, and a handful of drags emptied the whole undo
 * history of everything that mattered.
 *
 * So this component marks where a gesture starts and where it ends, and the
 * store groups everything between into one step (`beginTransaction` /
 * `endTransaction`). The boundaries are where a person would draw them:
 *
 *  - a pointer drag is `pointerdown` to `pointerup`;
 *  - one arrow key press is one gesture, so a user stepping the slider
 *    without a pointer gets one undo per press (§10) — but auto-repeat from
 *    a held key belongs to the press that started it;
 *  - a typing session in the field runs from the first keystroke that parses
 *    to the blur, the Enter, or the selection change that ends it.
 *
 * Every one of those has an end that fires even when the gesture is
 * interrupted, and the row closes any gesture still open when it unmounts —
 * a gesture left open would leave history recording nothing at all.
 *
 * ## Only one gesture is open at a time, and the panel is what knows it
 *
 * The boundaries above are only true if a new gesture can *displace* an old
 * one, because the browser does not deliver them in tidy order. Pressing the
 * slider while the numeric field still has focus produces, in Chrome:
 * `slider:pointerdown` and only then `field:blur`. With one open/closed flag
 * per row, the pointerdown was a no-op — a gesture was already open — and
 * the blur that followed closed the drag that had just started, so the rest
 * of it recorded one undo step per stop and the number the user had typed
 * was swallowed as the drag's first value. The same ordering across two rows
 * of a `u` gate did the same thing, because the store's transactions do not
 * nest either.
 *
 * So the panel owns a single broker keyed by which control is speaking:
 * beginning a gesture ends whichever one was open first, and an `end` from a
 * control that has already been displaced is ignored rather than closing
 * somebody else's gesture.
 */

import { lookupGate, type Operation } from '@qsim/schema'
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import {
  ANGLE_STEPS,
  formatNumber,
  fromSliderStep,
  parseAngle,
  readAngle,
  toSliderStep,
} from './angles'

/**
 * Parameter names as the literature spells them, matching the canvas's own
 * mapping in `operationRoles.ts`. `theta` is what survives OpenQASM, `θ` is
 * what a physicist reads.
 */
const PARAM_SYMBOLS: Readonly<Record<string, string>> = {
  theta: 'θ',
  phi: 'φ',
  lambda: 'λ',
}

export interface ParameterEditorProps {
  /** The selected operation, or `null` when the selection is not a gate. */
  readonly operation: Operation | null
  readonly onChange: (index: number, value: number) => void
  /**
   * A continuous edit is starting. Required rather than optional: a caller
   * that forgets it gets one undo step per slider stop back, silently, and
   * the type system is the only thing that can stop that happening twice.
   */
  readonly onGestureStart: () => void
  /** That edit is over — the values in between were one change. */
  readonly onGestureEnd: () => void
  readonly disabled?: boolean
}

export function ParameterEditor({
  operation,
  onChange,
  onGestureStart,
  onGestureEnd,
  disabled = false,
}: ParameterEditorProps) {
  const { t } = useTranslation('editor')
  const params = operation?.params ?? []
  const names = lookupGate(operation?.gate ?? '')?.paramNames ?? []
  // One broker for the whole panel: a `u` gate has three rows, and a drag
  // started on one of them while another was still being typed into has to
  // close that one rather than be swallowed by it.
  const gesture = useGestureBroker(onGestureStart, onGestureEnd)

  return (
    <section className="parameter-editor" aria-label={t('parameters.title')}>
      <h3 className="parameter-editor__heading">{t('parameters.title')}</h3>
      {params.length === 0 ? (
        <p className="parameter-editor__empty">{t('parameters.none')}</p>
      ) : (
        params.map((value, index) => (
          <ParameterRow
            // The operation id is part of the key so that selecting another
            // gate resets the in-progress text rather than carrying half a
            // number across to a different angle.
            key={`${operation?.id ?? ''}:${index}`}
            // And it names the row's gestures for the same reason: two rows
            // of one gate, and the same row of two gates, are different
            // gestures and must not close each other's transactions.
            gestureId={`${operation?.id ?? ''}:${index}`}
            symbol={PARAM_SYMBOLS[names[index] ?? ''] ?? names[index] ?? ''}
            value={value}
            disabled={disabled}
            onChange={(next) => {
              onChange(index, next)
            }}
            gesture={gesture}
          />
        ))
      )}
    </section>
  )
}

function ParameterRow({
  gestureId,
  symbol,
  value,
  disabled,
  onChange,
  gesture,
}: {
  gestureId: string
  symbol: string
  value: number | string
  disabled: boolean
  onChange: (value: number) => void
  gesture: GestureBroker
}) {
  const { t, i18n } = useTranslation('editor')
  const labelId = useId()

  if (typeof value === 'string') {
    return (
      <div
        className="parameter-editor__row"
        role="group"
        aria-labelledby={labelId}
      >
        <span className="parameter-editor__symbol" id={labelId}>
          <Notation value={symbol} />
        </span>
        <p className="parameter-editor__symbolic">
          {t('parameters.symbolic')} <Notation value={value} />
        </p>
      </div>
    )
  }

  return (
    <AngleRow
      labelId={labelId}
      gestureId={gestureId}
      symbol={symbol}
      value={value}
      locale={i18n.language}
      disabled={disabled}
      onChange={onChange}
      gesture={gesture}
    />
  )
}

/**
 * Opens and closes gestures for the whole panel, at most one at a time.
 *
 * Every call names the control it speaks for — `"op_1:0:slider"` — and the
 * name is what makes the two failure modes impossible:
 *
 *  - **Repeat calls are free.** A drag produces `pointerup` *and*
 *    `lostpointercapture`; a key press that moves focus produces `keyup`
 *    somewhere else and a `blur` here. Both ends fire more than once, from
 *    more than one event, on purpose.
 *  - **A late `end` cannot close somebody else's gesture.** The blur of the
 *    field the user just left arrives *after* the pointerdown of the slider
 *    they went to, and closing the drag at that point is precisely the bug
 *    this replaced: the rest of the drag then recorded a history step per
 *    stop. An `end` whose name is not the open one is stale by definition,
 *    since beginning a gesture is what displaced it.
 */
export interface GestureBroker {
  readonly begin: (id: string) => void
  readonly end: (id: string) => void
}

function useGestureBroker(onStart: () => void, onEnd: () => void) {
  const open = useRef<string | null>(null)
  // Held in a ref, and refreshed after each render rather than during one,
  // so `begin` and `end` keep a stable identity. That matters more than it
  // looks: the parent passes fresh arrows on every render, and a cleanup
  // keyed on them would close the gesture in the middle of the drag that is
  // causing those renders.
  const callbacks = useRef({ onStart, onEnd })
  useEffect(() => {
    callbacks.current = { onStart, onEnd }
  })

  const begin = useCallback((id: string) => {
    if (open.current === id) return
    // A gesture already running belongs to a control the user has left. It
    // ends here, with its own value intact as one history step, rather than
    // being closed later by an event that has nothing to do with it.
    if (open.current !== null) callbacks.current.onEnd()
    open.current = id
    callbacks.current.onStart()
  }, [])

  const end = useCallback((id: string) => {
    if (open.current !== id) return
    open.current = null
    callbacks.current.onEnd()
  }, [])

  // The panel outlives every row, so the last gesture is closed here: a
  // gesture left open would leave history paused for the rest of the session.
  useEffect(
    () => () => {
      if (open.current === null) return
      open.current = null
      callbacks.current.onEnd()
    },
    []
  )

  return useMemo<GestureBroker>(() => ({ begin, end }), [begin, end])
}

function AngleRow({
  labelId,
  gestureId,
  symbol,
  value,
  locale,
  disabled,
  onChange,
  gesture,
}: {
  labelId: string
  gestureId: string
  symbol: string
  value: number
  locale: string
  disabled: boolean
  onChange: (value: number) => void
  gesture: GestureBroker
}) {
  const { t } = useTranslation('editor')
  // `null` means "show the stored value"; a string means the user is in the
  // middle of typing one, and clobbering it on every keystroke would make
  // `-` and `1,` impossible to type.
  const [typed, setTyped] = useState<string | null>(null)
  // The slider and the field of one row are two gestures, not one: releasing
  // the slider must not close a typing session, and a keystroke in the field
  // must not be absorbed into a drag.
  const sliderGesture = `${gestureId}:slider`
  const fieldGesture = `${gestureId}:field`
  const { begin, end } = gesture
  // The row goes away when the selection changes or the gate is deleted, and
  // whatever it had open goes with it. `end` ignores a name that is not the
  // open one, so this closes exactly the row's own gesture and nothing else.
  useEffect(
    () => () => {
      end(sliderGesture)
      end(fieldGesture)
    },
    [end, sliderGesture, fieldGesture]
  )
  const reading = readAngle(value, locale)
  const text = typed ?? formatNumber(value, locale)

  return (
    <div
      className="parameter-editor__row"
      role="group"
      aria-labelledby={labelId}
    >
      <span className="parameter-editor__symbol" id={labelId}>
        <Notation value={symbol} />
      </span>

      <input
        className="parameter-editor__slider"
        type="range"
        min={-ANGLE_STEPS}
        max={ANGLE_STEPS}
        step={1}
        value={toSliderStep(value)}
        disabled={disabled}
        aria-label={t('parameters.slider')}
        // Without this a screen reader announces the slider's own integer
        // step count, which is a number the user has never been shown.
        aria-valuetext={reading.pi ?? reading.radians}
        onChange={(event) => {
          setTyped(null)
          onChange(fromSliderStep(Number(event.target.value)))
        }}
        onPointerDown={() => {
          begin(sliderGesture)
        }}
        onPointerUp={() => {
          end(sliderGesture)
        }}
        onPointerCancel={() => {
          end(sliderGesture)
        }}
        // A drag released off the element still ends here, because the
        // browser captures the pointer for the thumb.
        onLostPointerCapture={() => {
          end(sliderGesture)
        }}
        onKeyDown={(event) => {
          // `repeat` is a held key, which is one continuous change of mind
          // and belongs to the gesture its first press opened. A separate
          // press is a separate step, which is what makes the slider undo
          // one stop at a time for a user with no pointer.
          if (!event.repeat) begin(sliderGesture)
        }}
        onKeyUp={() => {
          end(sliderGesture)
        }}
        // Tab away mid-press: the keyup lands on whatever has focus next.
        onBlur={() => {
          end(sliderGesture)
        }}
      />

      <input
        className="parameter-editor__field"
        // Not `type="number"`: its parsing is locale-independent while its
        // rendering is not, so a French user would be shown `1,5708` and be
        // unable to type it back. Text plus `inputMode` gives the numeric
        // keypad on a phone and leaves the parsing to `parseAngle`.
        type="text"
        inputMode="decimal"
        value={text}
        disabled={disabled}
        aria-label={t('parameters.field')}
        onChange={(event) => {
          const next = event.target.value
          setTyped(next)
          const parsed = parseAngle(next)
          if (parsed === null) return
          // Typing `1`, `1.`, `1.5` is one edit with three keystrokes, so
          // the gesture opens on the first one that means a number and runs
          // until the field is left. A keystroke that parses to nothing
          // starts nothing: `-` alone has not changed the angle yet.
          begin(fieldGesture)
          onChange(parsed)
        }}
        onKeyDown={(event) => {
          // Enter is how a user says "that is the number", even though the
          // field keeps focus afterwards.
          if (event.key === 'Enter') end(fieldGesture)
        }}
        onBlur={() => {
          end(fieldGesture)
          setTyped(null)
        }}
      />

      <output className="parameter-editor__reading">
        <Notation value={reading.radians} />
        {reading.pi === null ? null : (
          <Notation className="parameter-editor__pi" value={reading.pi} />
        )}
      </output>
    </div>
  )
}
