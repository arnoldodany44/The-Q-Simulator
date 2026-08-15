/**
 * The examples strip — work plan M0.9.
 *
 * Six buttons, six circuits, one click each. This is the shortest route from
 * an empty page to something worth looking at, and §2 makes that the landing
 * page's whole job: someone who has never seen a circuit should understand
 * superposition and entanglement in under a minute, and they will not get
 * there by dragging gates they have no reason to trust.
 *
 * ── The name and the sentence are both in the button ─────────────────────
 *
 * Visibly the button carries the name alone, because six cards of prose is a
 * wall rather than a menu. The one-line summary is in the button too, hidden
 * from the eye and not from the accessibility tree — so the accessible name a
 * screen reader reads is "Bell. One H and one CNOT…" rather than a bare proper
 * noun that means nothing to a reader who has not seen the diagram. That is
 * the same split the canvas makes with its `aria-hidden` SVG and its
 * described table, applied to a control instead of a drawing.
 *
 * Names follow D2 exactly, and half of them are not translated: "Bell", "GHZ"
 * and "Deutsch–Jozsa" are people's names and go through `Notation`, which
 * marks them `translate="no"` so Chrome's page translator leaves them alone.
 * The argument, and why the catalog is asymmetric because of it, is in
 * `presets.ts`.
 *
 * ── Loading is an announcement, not a silence ────────────────────────────
 *
 * The visible result of pressing one of these is that a diagram the reader
 * may not be looking at changes completely. So the press is answered in a
 * live region, the same way every command in `useKeyboardGrid` is: the name of
 * what loaded, and the sentence describing it. The message is keyed by a
 * counter because loading the same preset twice produces the same string, and
 * React would leave the text node untouched — no mutation, no announcement,
 * and the second press would appear to have done nothing.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'
import { PRESETS, type Preset } from './presets'
import type { CircuitStore } from './useCircuitStore'

export interface PresetPickerProps {
  readonly store: CircuitStore
}

/**
 * Deliberately never disabled, unlike every other control that writes to the
 * document. A small screen puts the *editor* in read-only mode (§3.2), and
 * that is right — dragging gates on a 360px canvas is not a thing anyone
 * wants — but the closing criterion of Phase 0 is a stranger opening the link
 * on their phone, tapping "Bell", and understanding what happened. Loading an
 * example is the one write that has to work there.
 */
export function PresetPicker({ store }: PresetPickerProps) {
  const { t } = useTranslation('editor')
  const headingId = useId()
  const [loaded, setLoaded] = useState<{
    readonly preset: Preset
    readonly seq: number
  } | null>(null)

  return (
    <section className="preset-picker" aria-labelledby={headingId}>
      <h3 id={headingId} className="preset-picker__heading">
        {t('presets.heading')}
      </h3>
      <p className="preset-picker__hint">{t('presets.hint')}</p>

      <div className="preset-picker__chips">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="preset-picker__chip"
            onClick={() => {
              // `loadCircuit` is the store's door for whole documents: it
              // validates, drops the selection and clears the undo history,
              // so nobody can undo their way back into the circuit an example
              // replaced.
              const result = store.getState().loadCircuit(preset.circuit)
              if (!result.ok) return
              setLoaded((current) => ({
                preset,
                seq: (current?.seq ?? 0) + 1,
              }))
            }}
          >
            <PresetName preset={preset} />
            {/*
             * The separator is not cosmetic: the accessible name is the
             * concatenation of these two spans, and without it a reader hears
             * "BellTwo qubits entangled" as one word.
             */}{' '}
            <span className="visually-hidden">
              {t(`presets.${preset.id}.summary`)}
            </span>
          </button>
        ))}
      </div>

      <p className="preset-picker__status" role="status">
        <span key={loaded?.seq ?? 0}>
          {loaded === null ? null : (
            <>
              <PresetName preset={loaded.preset} /> {t('presets.loaded')}{' '}
              {t(`presets.${loaded.preset.id}.summary`)}
            </>
          )}
        </span>
      </p>
    </section>
  )
}

/**
 * A preset's name: a proper noun rendered as invariant notation, or an
 * ordinary word out of the catalog. See `presets.ts` for why the six split
 * into two groups.
 */
function PresetName({ preset }: { readonly preset: Preset }) {
  const { t } = useTranslation('editor')
  if (preset.properName !== null) {
    return (
      <Notation className="preset-picker__name" value={preset.properName} />
    )
  }
  return (
    <span className="preset-picker__name">
      {t(`presets.${preset.id}.name`)}
    </span>
  )
}
