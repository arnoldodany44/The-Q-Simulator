/**
 * Which stage of the landing demo is on screen, and whether it is advancing on
 * its own (M0.9b).
 *
 * The shape is `useTimeline`'s, deliberately: the editor already has a control
 * that walks a sequence with a play button, and a landing page that invented a
 * second set of rules for the same gesture would be two answers to one
 * question. What is kept from it, and why:
 *
 * ── PLAYBACK STOPS AT THE END, AND `playing` IS DERIVED ──────────────────
 *
 * `playing` is *asked to play* and *not yet at the last stage*, computed rather
 * than stored, so reaching the end stops the timer without a second piece of
 * state chasing the first. It stops instead of looping because the last stage
 * is the conclusion — the entangled pair is what the reader is meant to be
 * looking at when the motion ends, not a lap marker. Pressing play there
 * rewinds first, which is what a play button at the end of a track means
 * everywhere else.
 *
 * ── IT STARTS WHEN THE READER CAN SEE IT, NOT WHEN THE PAGE MOUNTS ───────
 *
 * The sequence used to begin on a mount timer and finish 10,5 s later whether
 * or not the demonstration had ever been on screen. On a 390×844 phone the
 * chart's top edge is 1 056 px down — entirely below the fold — so a reader who
 * spent a perfectly ordinary ten seconds on the hero before scrolling arrived
 * at stage 3 or 4: the conclusion, with the premises already gone. Since the
 * plan's Phase 0 criterion is a stranger opening the link *on a phone*, that is
 * the reader the page was built for and the one it was failing.
 *
 * So the tour is gated on an `IntersectionObserver` around the demo section,
 * and `section` below is the ref to attach. Where the API is missing — jsdom,
 * a server render — the demonstration is treated as visible immediately, which
 * is the behaviour that existed before and cannot be worse than it.
 *
 * ── IT AUTOPLAYS, AND `prefers-reduced-motion` REFUSES THAT ──────────────
 *
 * Autoplay is the one thing this hook has that the timeline does not switch on
 * by default, and it is the whole point of the page: §2 asks that a stranger
 * *understand* superposition and entanglement in under a minute, and a
 * sequence nobody presses play on is a sequence most readers never see.
 *
 * A reader who has asked for reduced motion gets none of it. That is a refusal
 * rather than a slowdown, for `useTimeline`'s reason — the setting is a
 * statement about things that move on their own — and `LiveDemo` is what makes
 * it cost that reader nothing: it draws all four stages at once instead, so the
 * argument arrives whole with nothing moving. Pressing play still plays, if
 * they ask.
 *
 * Because it starts by itself, it owes WCAG 2.2.2 a way to stop: the pause
 * control is rendered beside the stage buttons and is the first thing in the
 * group, not hidden behind a hover.
 */

import { useCallback, useEffect, useRef, useState } from 'react'

import { usePrefersReducedMotion } from '../../lib/usePrefersReducedMotion'
import { DEMO_STAGES, stageAt, type DemoStage } from './stages'

/**
 * How long each stage holds, in milliseconds.
 *
 * PACED FOR READING, because the prose is half of what each stage says. It was
 * 3 500 ms, which is about a quarter of the time a stage's own paragraph takes
 * to read: at 238 words per minute the second stage needs 14,6 s in English,
 * 16,1 s in Spanish and 16,6 s in French, and the sentence "That is
 * superposition." was on screen for three and a half seconds and then gone for
 * good. The reader had no way of knowing it had been there.
 *
 * Nine seconds is a compromise rather than a full reading pace: it is long
 * enough to take the picture in and to read the shorter half of the prose, and
 * four of them is 27 s — comfortably inside the minute §2 allows, with time
 * left over to go back through the stage buttons, which is what they are for.
 */
export const STAGE_DWELL_MS = 9000

/**
 * How much of the demonstration has to be on screen before it starts. A
 * quarter, so a reader who has only just scrolled it into view still sees
 * stage 1 rather than arriving mid-argument.
 */
const VISIBLE_FRACTION = 0.25

export interface StageTour {
  /** Index into `DEMO_STAGES`. */
  readonly index: number
  readonly stage: DemoStage
  readonly playing: boolean
  /** Whether the reader has asked for no motion; the demo never autostarts. */
  readonly reducedMotion: boolean
  /**
   * Ref for the element whose visibility starts the tour. Attach it to the
   * demonstration itself, not to the page.
   */
  readonly section: (node: HTMLElement | null) => void
  // Properties holding closures rather than methods, the convention the
  // editor's hooks follow: every one is handed straight to a JSX prop.
  /** Show a stage. Stops playback: two hands on the same wheel. */
  readonly goTo: (index: number) => void
  /** Start or stop. Pressing play at the last stage rewinds first. */
  readonly toggle: () => void
}

const LAST = DEMO_STAGES.length - 1

export interface StageTourOptions {
  /** Off in tests that would otherwise race a timer they never started. */
  readonly autoPlay?: boolean
  readonly dwellMs?: number
}

/** Whether this environment can tell us when an element comes into view. */
function canObserve(): boolean {
  return typeof IntersectionObserver !== 'undefined'
}

export function useStageTour({
  autoPlay = true,
  dwellMs = STAGE_DWELL_MS,
}: StageTourOptions = {}): StageTour {
  const reducedMotion = usePrefersReducedMotion()
  const autoStart = autoPlay && !reducedMotion

  const [index, setIndex] = useState(0)
  /*
   * Where there is no observer there is nothing to wait for, so the tour keeps
   * the behaviour it had: it starts with the page. Everywhere else it waits.
   */
  const [visible, setVisible] = useState(() => !canObserve())
  const [requested, setRequested] = useState(autoStart && !canObserve())
  /** Autoplay fires once. A reader who scrolls away and back is not restarted. */
  const started = useRef(requested)

  const observer = useRef<IntersectionObserver | null>(null)
  const section = useCallback((node: HTMLElement | null) => {
    observer.current?.disconnect()
    observer.current = null
    if (node === null || !canObserve()) return
    const watch = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return
        // One shot: the question is "has the reader arrived", and it only has
        // one interesting answer.
        watch.disconnect()
        setVisible(true)
      },
      { threshold: VISIBLE_FRACTION }
    )
    watch.observe(node)
    observer.current = watch
  }, [])

  useEffect(() => {
    if (!autoStart || !visible || started.current) return
    started.current = true
    setIndex(0)
    setRequested(true)
  }, [autoStart, visible])

  const playing = requested && index < LAST

  const goTo = useCallback((next: number) => {
    // A reader who chose a stage has taken over; autoplay must not start
    // underneath them if the section only now scrolls into view.
    started.current = true
    setRequested(false)
    setIndex(clamp(next))
  }, [])

  const toggle = useCallback(() => {
    started.current = true
    if (playing) {
      setRequested(false)
      return
    }
    // Play at the end rewinds: there is nothing ahead to show, and a play
    // button that does nothing is a play button that looks broken.
    setIndex((current) => (current >= LAST ? 0 : current))
    setRequested(true)
  }, [playing])

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      setIndex((current) => Math.min(LAST, current + 1))
    }, dwellMs)
    return () => {
      clearInterval(timer)
    }
  }, [playing, dwellMs])

  return {
    index,
    stage: stageAt(index),
    playing,
    reducedMotion,
    section,
    goTo,
    toggle,
  }
}

function clamp(index: number): number {
  return Math.min(LAST, Math.max(0, index))
}
