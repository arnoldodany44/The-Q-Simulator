/**
 * The timeline scrubber — §3.1, work plan M0.8.
 *
 * A bar that walks the circuit column by column while the analysis panel shows
 * the state at each stop. The work plan calls it the most powerful teaching
 * feature in the editor, and the reason is one sentence: a circuit diagram is a
 * static picture of something that happens in order, and this is the control
 * that puts the order back.
 *
 * ── What is here, and what is not ────────────────────────────────────────
 *
 * The physics is not here, and neither is the state. This component reads a
 * `Timeline` and reports intent, exactly as `ShotSampler` does with its
 * settings: the position lives in `useTimeline` (the canvas and the panel both
 * need it), the arithmetic lives in `timeline.ts`, and the state at a column
 * comes from `stateAfterColumn` on the worker, through the same request that
 * carries every other simulation. Nothing on this side ever computes an
 * amplitude.
 *
 * ── Why the bar is a native range ────────────────────────────────────────
 *
 * A `<div role="slider">` would have to re-implement, correctly, every key an
 * `<input type="range">` already answers — and they are precisely the keys
 * this milestone asks for: the arrows step one column, Home and End jump to
 * the ends, PageUp and PageDown move in larger hops. It also brings the
 * pointer and touch behaviour, the platform's high-contrast rendering, and an
 * accessible role no bug of ours can get wrong. What it does not know is what
 * a stop *means*, so `aria-valuetext` says it in words — the same fix the
 * shots slider and the angle slider make, and for the same reason: without it
 * a reader hears "4 of 13" and has to guess.
 *
 * ── Space, and the collision it would otherwise be ───────────────────────
 *
 * Space toggles playback, and it is bound **on the bar only**, never on the
 * editor. Inside the grid Space already means "pick this gate up" — it is
 * dnd-kit's keyboard drag, documented in `useKeyboardGrid.ts` and advertised
 * in the shortcuts panel — and a second meaning for the same key in the same
 * subtree is how an editor ends up doing two things per press.
 *
 * The isolation is not merely a convention here, it is enforced by code that
 * already exists: the editor's key handler classifies a keystroke by where it
 * came from, and anything originating inside an `input` is left alone
 * entirely (`originOf` in `useKeyboardGrid.ts`). So every key the bar answers
 * — the arrows included, which mean "move the grid cursor" three inches
 * higher up the page — stops at the bar. The play button and the speed menu
 * need nothing: Space and Enter on a button are the platform's own.
 *
 * ── It stays live on a small screen ──────────────────────────────────────
 *
 * The editor goes read-only below 768px (§10, risk 6) and this control does
 * not, because scrubbing is reading. Nothing here writes to the document; a
 * timeline is the one part of the editor that a phone can offer in full.
 */

import { useId, useMemo } from 'react'
import { useTranslation } from 'react-i18next'

import { TIMELINE_SPEEDS, type Timeline } from './useTimeline'

export interface TimelineScrubberProps {
  readonly timeline: Timeline
}

export function TimelineScrubber({ timeline }: TimelineScrubberProps) {
  const { t, i18n } = useTranslation('editor')
  const headingId = useId()
  const barId = useId()
  const speedId = useId()

  // Per-locale digits (D2/§1.1). Column numbers are small today and a circuit
  // may hold thousands of columns; French writes 1 024 and English 1,024, and
  // the caption beside this one in the analysis panel already knows that.
  const numbers = useMemo(
    () => new Intl.NumberFormat(i18n.language),
    [i18n.language]
  )

  const { position, stop, stops, playing, speed } = timeline

  /**
   * The position in words: what the slider announces and what the readout
   * beside it shows. One string, two consumers, so the two cannot disagree.
   */
  const reading =
    position === null
      ? t('timeline.at.end')
      : position < 0
        ? t('timeline.at.start')
        : t('timeline.at.column', { column: numbers.format(position) })

  return (
    <section className="timeline" aria-labelledby={headingId}>
      {/* h3, like the palette and the parameter editor: these three are
          siblings of the canvas under the page's own h2. */}
      <h3 id={headingId} className="timeline__heading">
        {t('timeline.heading')}
      </h3>

      <div className="timeline__controls">
        <button
          type="button"
          className="timeline__play"
          onClick={timeline.toggle}
        >
          {t(playing ? 'timeline.pause' : 'timeline.play')}
        </button>

        <label className="timeline__label" htmlFor={barId}>
          {t('timeline.position')}
        </label>
        <input
          id={barId}
          className="timeline__bar"
          type="range"
          min={0}
          max={stops - 1}
          step={1}
          value={stop}
          aria-valuetext={reading}
          onChange={(event) => {
            timeline.goTo(Number(event.target.value))
          }}
          onKeyDown={(event) => {
            // The one key a range input has no meaning for, which is what
            // makes it free to carry playback here — see the header.
            if (event.key !== ' ') return
            event.preventDefault()
            timeline.toggle()
          }}
        />

        {/*
         * A span rather than an `<output>`, the same call `ShotSampler` makes:
         * an output is a live region, and this one changes on every step of a
         * drag and on every tick of playback. A screen reader would recite the
         * whole circuit. The value is announced once, by the slider itself, at
         * the moment the slider announces it.
         */}
        <span className="timeline__reading" aria-hidden="true">
          {reading}
        </span>

        <label className="timeline__label" htmlFor={speedId}>
          {t('timeline.speed.label')}
        </label>
        <select
          id={speedId}
          className="timeline__speed"
          value={speed}
          onChange={(event) => {
            // Narrowed rather than cast: the value is a DOM string, and the
            // one thing a cast would buy is a `speed` the interval lookup
            // would resolve to `undefined` and hand to `setInterval` as a
            // delay of zero.
            const chosen = TIMELINE_SPEEDS.find(
              (option) => option === event.target.value
            )
            if (chosen !== undefined) timeline.setSpeed(chosen)
          }}
        >
          {TIMELINE_SPEEDS.map((option) => (
            <option key={option} value={option}>
              {t(`timeline.speed.${option}`)}
            </option>
          ))}
        </select>
      </div>

      {/*
       * The keyboard map for this control, in the open. It repeats what the
       * shortcuts panel says because that panel is a closed `<details>` about
       * the grid, and a key nobody can find is a key nobody has (§10).
       */}
      <p className="timeline__hint">{t('timeline.hint')}</p>
    </section>
  )
}
