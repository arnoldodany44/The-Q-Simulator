/**
 * The challenge screen — §3.6, Phase 3.
 *
 * The brief in one column, the real editor and the real analysis panel in the
 * other, a submit control between them, and the server's verdict underneath.
 * Not a copy of the editor: `CircuitEditor` is the component `/new` mounts,
 * with its palette, its keyboard grid, its scrubber and `SimulationPanel`. A
 * challenge is built with the product, not with a reduced imitation of it — and
 * the panel is what lets a learner see *why* their state is wrong before the
 * server tells them *that* it is.
 *
 * That is possible because the editor takes its store as a prop, a decision
 * M0.5 made for exactly this. The player builds its own, so a challenge never
 * touches the document somebody has open in another tab.
 *
 * ════════════════════════════════════════════════════════════════════════
 * TWO READINGS, AND THEY ARE NOT THE SAME KIND OF THING.
 *
 * The line above the submit button is computed **here**, from the reader's own
 * circuit: gate count, depth, gates outside the allowed set, the register. It
 * updates as they type and it never says "solved", because it cannot — the
 * target is on the server (§4, risk 5) and this process has never seen it.
 *
 * The panel below the button is the **server's**. It is the only thing that
 * says whether the circuit is right, it arrives after a round trip, and it is
 * cleared the moment the circuit changes: a verdict shown beside a circuit it
 * was not about is worse than no verdict at all.
 */

import { emptyCircuit } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import type { Challenge, ChallengeSubmissionResult } from '@qsim/contract'
import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'
import { useStore } from 'zustand'

import { SIGN_IN_PATH, useSession } from '../auth'
import { CircuitEditor } from '../circuit-editor/CircuitEditor'
import { createCircuitStore } from '../circuit-editor/useCircuitStore'
import { useApiErrorMessage, useSubmitChallenge } from '../../lib/api'
import { Notation } from '../../components/Notation'
import { ChallengeBrief } from './ChallengeBrief'
import { ChallengeVerdict } from './ChallengeVerdict'
import { readLocally } from './local'

export interface ChallengePlayerProps {
  readonly challenge: Challenge
}

export function ChallengePlayer({ challenge }: ChallengePlayerProps) {
  const { t } = useTranslation('challenges')
  const session = useSession()
  const submit = useSubmitChallenge(challenge.slug)
  const describeError = useApiErrorMessage()

  /*
   * One store per register width, built once, starting on the challenge's own
   * register — which is also the one rule a reader would otherwise have to
   * satisfy by hand before anything they built could be judged.
   *
   * The width and not the slug, because the width is the only thing about the
   * challenge this document depends on. `/challenges/:slug` remounts the route
   * on navigation anyway, so keying on the slug as well would only rebuild the
   * store — and throw away the reader's undo history — in the one case it must
   * not: a refetch that returns the same challenge.
   */
  const store = useMemo(
    () => createCircuitStore(emptyCircuit(challenge.qubitCount)),
    [challenge.qubitCount]
  )
  const circuit = useStore(store, (state) => state.circuit)

  /**
   * The last answer, and the exact document it was an answer *to*.
   *
   * The circuit is kept beside the result rather than the result being cleared
   * on every edit, and that is not a stylistic choice: a verdict shown beside a
   * circuit it was not about is the one thing this screen must never do — a
   * reader who fixes their phase and still sees "not yet" concludes the fix was
   * wrong — and clearing it from an effect means a render where the two are
   * inconsistent has already happened. Comparing by identity makes the stale
   * state unrepresentable instead: the store hands out a new `circuit` object
   * for every edit, undo, paste and preset alike, so `answered.circuit ===
   * circuit` is exactly "this answer is about what is on screen".
   */
  const [answered, setAnswered] = useState<{
    circuit: Circuit
    result: ChallengeSubmissionResult | null
    error: unknown
  } | null>(null)

  const current = answered?.circuit === circuit ? answered : null

  const reading = readLocally(circuit, challenge)
  const signedIn = session.status === 'authenticated'

  return (
    <div className="challenge-player">
      <section
        className="challenge-player__brief"
        aria-label={t('player.briefLabel')}
      >
        <ChallengeBrief challenge={challenge} />

        <div className="challenge-player__status">
          <p className="challenge-player__counts">
            {t('player.yourCircuit', {
              gates: reading.gateCount,
              depth: reading.depth,
            })}
          </p>

          {/*
           * Local warnings, in the order a reader can act on them. Each one is
           * a fact about their circuit — never about the target — and every one
           * is checked again on the server, which is the copy that counts.
           */}
          {reading.wrongRegister ? (
            <p className="challenge-player__warning">
              {t('local.wrongRegister', { qubits: challenge.qubitCount })}
            </p>
          ) : null}
          {reading.overBudget ? (
            <p className="challenge-player__warning">
              {t('local.overBudget', { max: challenge.maxGates ?? 0 })}
            </p>
          ) : null}
          {reading.disallowed.length === 0 ? null : (
            <p className="challenge-player__warning">
              {t('local.disallowed')}{' '}
              {reading.disallowed.map((gate) => (
                <Notation key={gate} value={gate} />
              ))}
            </p>
          )}

          {signedIn ? (
            <button
              type="button"
              className="challenge-player__submit"
              /*
               * Enabled even when the local reading has found something, and
               * deliberately: the local reading is advice, the server is the
               * judge, and a control disabled by advice would make this screen
               * quietly authoritative about a rule it does not own. Only a
               * request already in flight disables it.
               */
              disabled={submit.isPending}
              onClick={() => {
                const asked = circuit
                submit.mutate(asked, {
                  onSuccess: (result) => {
                    setAnswered({ circuit: asked, result, error: null })
                  },
                  onError: (error) => {
                    setAnswered({ circuit: asked, result: null, error })
                  },
                })
              }}
            >
              {submit.isPending ? t('player.submitting') : t('player.submit')}
            </button>
          ) : (
            <p className="challenge-player__signin">
              <Link to={SIGN_IN_PATH}>{t('player.signInToSubmit')}</Link>
            </p>
          )}

          {current === null || current.error === null ? null : (
            <p className="challenge-player__error" role="alert">
              {describeError(current.error)}
            </p>
          )}
        </div>

        {/*
         * ALWAYS IN THE DOM, EMPTY UNTIL THERE IS SOMETHING TO SAY.
         *
         * The verdict is the one moment challenge mode exists for, and it
         * used to be inserted as a live region that already contained its
         * text — the pattern `LessonStepPane` and `SimulationPanel` both
         * document as the one some readers never hear, because assistive
         * technology has no registered region to compare against. It was
         * worse across the loop than once: `current` drops the verdict on
         * every edit, so the region was torn down and re-inserted-with-content
         * on every submit rather than only on the first.
         *
         * So the region is this wrapper, which mounts with the screen and
         * never leaves, and the answer is what changes inside it.
         */}
        <div className="challenge-player__verdict" aria-live="polite">
          {current?.result == null ? null : (
            <ChallengeVerdict result={current.result} />
          )}
        </div>
      </section>

      <section
        className="challenge-player__lab"
        aria-label={t('player.labLabel')}
      >
        {/*
         * The real editor, over the player's own store. Everything below the
         * canvas — the histogram, the phasors, the amplitude table, the Bloch
         * spheres — comes with it, which is the point: the analysis panel is
         * what shows a learner *why* their answer is wrong, and the server only
         * says *that* it is.
         */}
        <CircuitEditor store={store} />
      </section>
    </div>
  )
}
