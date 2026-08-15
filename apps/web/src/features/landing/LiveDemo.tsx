/**
 * The live demonstration — the landing page's reason to exist (§2, M0.9b).
 *
 * Four stages, each one a real circuit simulated by `@qsim/core` at the moment
 * it is shown. Nothing here is a recording and nothing is a screenshot: the
 * percentages under the bars are computed from the amplitudes the engine
 * produced, by the same chart the editor draws.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE SEQUENCE HAS TO WORK WITH THE SOUND OFF.
 *
 * §2's criterion is understanding, not reading, so the argument is carried by
 * the pictures and the prose only names what the pictures already did:
 *
 *   1  one bar        two qubits, nothing done to them
 *   2  two bars       one gate, and the certainty is gone      — superposition
 *   3  four bars      the same gate on the other wire          — two coins
 *   4  two bars       a CNOT instead, and half the outcomes    — entanglement
 *
 * Stage 3 is the one an introduction is tempted to skip and the one that makes
 * stage 4 mean anything: without it, "two bars" is something the reader has
 * already seen at stage 2. `stages.ts` argues the point at length.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CHART IS DRAWN OVER A FIXED BASIS, AND THAT IS THE ARGUMENT.
 *
 * `fullBasis` keeps a row for every reading the pair can give, including the
 * ones that carry nothing. Without it the stage 3 → 4 transition — which *is*
 * the page's whole point — rendered as a re-layout rather than as two bars
 * disappearing: |01⟩ and |10⟩ left the DOM, |11⟩ jumped two rows up, both
 * survivors doubled in length, the chart lost 48 px of height and the prose
 * under it reflowed. Every visual channel changed at once and no row kept its
 * address, so "two of the four outcomes are gone" was the one thing a reader
 * could not see. §3.2's own model of this picture is a bar that shrinks until
 * it vanishes, and that needs the row to still be there at zero.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CHART BORROWS THE EDITOR'S DRAWING, NOT THE EDITOR'S VOCABULARY.
 *
 * `ProbabilityHistogram` normally titles itself "Probability by basis state",
 * explains that each arrow points along the phase of its amplitude, and counts
 * how many basis states have a non-zero probability. Every one of those terms
 * is unearned here — this page is four paragraphs old and has just introduced
 * the word "qubit" — and "basis state" would be a second name for the thing the
 * reading below it already calls an outcome, eight inches away. So the landing
 * passes its own heading and its own sentence.
 *
 * The phasors go with them, and not only for vocabulary: every amplitude in all
 * four stages is real and positive, so the arrows point the same way in every
 * row of every stage and never once move. The note promising that "two arrows
 * pointing opposite ways are two paths cancelling" was describing a phenomenon
 * this demonstration is incapable of showing. Interference has its own preset,
 * one click away, where the arrows do turn.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE THREE READINGS ARE THE ARGUMENT IN NUMBERS.
 *
 * Between stages 3 and 4 the two marginals do not move — each qubit still
 * reads 1 half the time — while the agreement goes from a half to certainty.
 * That pair of facts is what entanglement *is*, and it is on screen as two
 * numbers a reader can check against the bars beside them, in their own
 * locale's digits (D2: French writes 50 %, with a comma when there are
 * decimals).
 *
 * At the last stage each reading also carries what it read at the stage
 * before. "The two figures below have not moved" is a claim about two numbers,
 * and the previous ones had been replaced instantly by an automatic
 * transition — so the reader was asked to verify a comparison against a value
 * that was no longer anywhere on the page.
 *
 * "The two agree" is shown only from stage 3, where the comparison it belongs
 * to begins. It reads 100 % at stage 4 and it also reads 100 % at stage 1,
 * where the pair agrees with certainty for the boring reason that there is only
 * one outcome — so a reader who took that number for the signature of
 * entanglement had it falsified by the first picture they were shown.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT IS AND IS NOT A LIVE REGION.
 *
 * Nothing here is. The demo advances by itself, and a live region on the
 * narration would recite four paragraphs at a reader who is somewhere else on
 * the page — the same ruling `TimelineScrubber` makes about its position
 * readout, for the same reason. What a screen-reader user gets instead is
 * better: four named buttons that each announce their own pressed state, in
 * reading order immediately before the text they change. Autoplay never starts
 * for a reader who asked for reduced motion, and the pause control is the first
 * thing in the group for everyone else — WCAG 2.2.2.
 *
 * ────────────────────────────────────────────────────────────────────────
 * UNDER `prefers-reduced-motion` THE FOUR STAGES ARE FOUR PANELS.
 *
 * The tour does not start for that reader, which used to mean the page rested
 * on stage 1 for ever: one bar at 100 %, an ordinary pair of bits, and neither
 * of the two ideas §2 names anywhere on the page. The only ways forward were a
 * button labelled "Play" and four numbered buttons, and nothing on the page
 * asked anyone to press them.
 *
 * The setting is a statement about things that move, and swapping panels of
 * content is not motion — but it is also not necessary. Drawing all four stages
 * at once delivers the argument whole, with nothing moving at all, and puts
 * stage 3 directly above stage 4 where the comparison between them is the
 * point. It is the same four panels the tour shows one at a time.
 */

import { useId } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import { formatCount, formatProbability } from '../analysis/format'
import { ProbabilityHistogram } from '../analysis/ProbabilityHistogram'
import { DemoDiagram } from './DemoDiagram'
import { DEMO_STAGES, stageAnalysis, wireLabel, type DemoStage } from './stages'
import { useStageTour } from './useStageTour'

/**
 * The notation the catalogs interpolate into their sentences.
 *
 * Gate symbols and wire names are identical in all three languages (D2), so
 * they never enter a catalog — they are passed *into* one, which is the same
 * shape the editor uses for `wire.remove` and for every cell description.
 */
const NOTATION = {
  h: 'H',
  cnot: 'CNOT',
  q0: 'q0',
  q1: 'q1',
} as const

/** How a two-qubit reading is written, for the note that explains the labels. */
const KET = '|q1 q0⟩'

/**
 * The first stage that has a comparison to make. Before it, "the two agree"
 * describes a certainty rather than a correlation — see the header.
 */
const FIRST_COMPARABLE_STAGE = 2

export interface LiveDemoProps {
  /**
   * Off in tests, which would otherwise be racing a timer they did not start.
   * Production leaves it alone and the sequence plays once through.
   */
  readonly autoPlay?: boolean
}

export function LiveDemo({ autoPlay }: LiveDemoProps) {
  const { t, i18n } = useTranslation('landing')
  const language = i18n.language
  const headingId = useId()

  // Destructured rather than read off `tour` at the `ref=` site: a member of
  // an object used as a ref makes the whole object look like one to
  // `react-hooks/refs`, and every other reading of it then reads as a ref
  // access during render.
  const { section, ...tour } = useStageTour(
    autoPlay === undefined ? {} : { autoPlay }
  )

  return (
    <section className="demo" aria-labelledby={headingId} ref={section}>
      <h2 id={headingId} className="demo__heading">
        {t('demo.heading')}
      </h2>
      <p className="demo__intro">{t('demo.intro')}</p>

      {tour.reducedMotion ? (
        /*
         * No controls, because there is nothing to control: every stage is on
         * the page, in order, and the reader moves through them by reading.
         */
        <ol className="demo__stack">
          {DEMO_STAGES.map((stage, index) => (
            <li className="demo__stack-item" key={stage.id}>
              <h3 className="demo__stack-name">
                <span className="demo__step-index" aria-hidden="true">
                  {formatCount(index + 1, language)}
                </span>
                {t(`demo.stages.${stage.id}.name`)}
              </h3>
              <StagePanel stage={stage} index={index} />
            </li>
          ))}
        </ol>
      ) : (
        <>
          <div className="demo__controls">
            <button type="button" className="demo__play" onClick={tour.toggle}>
              {t(tour.playing ? 'demo.pause' : 'demo.play')}
            </button>

            {/*
             * A group rather than a tablist. `role="tablist"` would promise
             * arrow-key navigation and a focus model this does not implement,
             * and a half-kept ARIA promise is worse than none: these are four
             * buttons, they say which one is current with `aria-pressed`, and
             * Tab reaches every one of them the way it reaches every other
             * button on the page.
             */}
            <div
              className="demo__steps"
              role="group"
              aria-label={t('demo.steps')}
            >
              {DEMO_STAGES.map((candidate, index) => (
                <StageButton
                  key={candidate.id}
                  stage={candidate}
                  index={index}
                  current={index === tour.index}
                  onSelect={tour.goTo}
                />
              ))}
            </div>
          </div>

          <StagePanel
            stage={tour.stage}
            index={tour.index}
            {...(tour.index === DEMO_STAGES.length - 1
              ? { previous: DEMO_STAGES[tour.index - 1] }
              : {})}
          />
        </>
      )}
    </section>
  )
}

/** The active language, for the number formatters. */
function useLanguage(): string {
  const { i18n } = useTranslation('landing')
  return i18n.language
}

function StageButton({
  stage,
  index,
  current,
  onSelect,
}: {
  readonly stage: DemoStage
  readonly index: number
  readonly current: boolean
  readonly onSelect: (index: number) => void
}) {
  const { t } = useTranslation('landing')
  const language = useLanguage()

  return (
    <button
      type="button"
      className={current ? 'demo__step demo__step--current' : 'demo__step'}
      aria-pressed={current}
      onClick={() => {
        onSelect(index)
      }}
    >
      <span className="demo__step-index" aria-hidden="true">
        {formatCount(index + 1, language)}
      </span>
      {t(`demo.stages.${stage.id}.name`)}
    </button>
  )
}

/**
 * One stage, whole: the circuit, the chart, the sentence and the readings.
 *
 * The same component draws the tour's current stage and every panel of the
 * reduced-motion stack, so the two layouts cannot drift into saying different
 * things about the same circuit.
 */
function StagePanel({
  stage,
  index,
  previous,
}: {
  readonly stage: DemoStage
  readonly index: number
  /** The stage before this one, when its figures are worth comparing against. */
  readonly previous?: DemoStage
}) {
  const { t } = useTranslation('landing')
  const language = useLanguage()

  /*
   * One run of the engine per stage, cached for the life of the tab
   * (`stages.ts`) — and deliberately on the main thread, where every other
   * simulation in the app crosses into a worker. Four amplitudes of arithmetic
   * do not repay a round trip on the page whose entire purpose is to be
   * understood within a minute of arriving.
   */
  const { state, reading } = stageAnalysis(stage)
  const before = previous === undefined ? null : stageAnalysis(previous).reading

  return (
    <>
      <div className="demo__panels">
        {/*
         * The drawing and the sentence that says what it draws. The SVG is
         * `aria-hidden` — the same split the circuit canvas and the histogram
         * make — and this caption is its counterpart, visible rather than
         * hidden because a reader who *can* see the diagram still benefits
         * from being told which gate is which the first time they meet one.
         */}
        <figure className="demo__figure">
          <DemoDiagram circuit={stage.circuit} />
          <figcaption className="demo__figcaption">
            {t(`demo.stages.${stage.id}.circuit`, NOTATION)}
          </figcaption>
        </figure>

        <div className="demo__chart">
          <ProbabilityHistogram
            state={state}
            fullBasis
            phasors={false}
            heading={t('demo.chart.heading')}
            summary={t('demo.chart.caption')}
          />
        </div>
      </div>

      {/*
       * Directly under the chart, because that is where the reader first meets
       * `|00⟩`. It used to be the last element of the demonstration, 250 px
       * below the fold, after four stages of labels nothing had explained —
       * and the little-endian order it explains is the single most confusing
       * convention a newcomer meets here.
       */}
      <p className="demo__notation">
        {t('demo.notation.before')} <Notation value={KET} />{' '}
        {t('demo.notation.after')}
      </p>

      {/*
       * The same `NOTATION` values as the caption, and for the same reason:
       * the narration names wires too, and a sentence that interpolated them
       * in one place and not the other would print `{{q0}}` at a reader.
       */}
      <p className="demo__story">
        {t(`demo.stages.${stage.id}.story`, NOTATION)}
      </p>

      <dl className="demo__readings">
        <div className="demo__reading">
          <dt>{t('demo.reading.outcomes')}</dt>
          <dd>
            {formatCount(reading.outcomes, language)}
            <Before
              value={
                before === null ? null : formatCount(before.outcomes, language)
              }
            />
          </dd>
        </div>

        {reading.marginals.map((probability, qubit) => (
          <div className="demo__reading" key={qubit}>
            {/* Named from the register rather than from `NOTATION`, so a
                third wire would be `q2` and not silently `q1`. */}
            <dt>{t('demo.reading.marginal', { wire: wireLabel(qubit) })}</dt>
            <dd>
              {formatProbability(probability, language)}
              <Before
                value={
                  before === null
                    ? null
                    : formatProbability(before.marginals[qubit] ?? 0, language)
                }
              />
            </dd>
          </div>
        ))}

        {index >= FIRST_COMPARABLE_STAGE ? (
          <div className="demo__reading demo__reading--pair">
            <dt>{t('demo.reading.agreement')}</dt>
            <dd>
              {formatProbability(reading.agreement, language)}
              <Before
                value={
                  before === null
                    ? null
                    : formatProbability(before.agreement, language)
                }
              />
            </dd>
          </div>
        ) : null}
      </dl>
    </>
  )
}

/**
 * What this reading said at the stage before.
 *
 * The point of the last stage is that two of these three numbers did not
 * change and the third did, and a reader cannot check that against a value the
 * transition has already taken off the page.
 */
function Before({ value }: { readonly value: string | null }) {
  const { t } = useTranslation('landing')
  if (value === null) return null
  return (
    <span className="demo__reading-before">
      {t('demo.reading.before', { value })}
    </span>
  )
}
