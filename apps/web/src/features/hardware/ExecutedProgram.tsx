/**
 * The circuit somebody drew, beside the program the device ran — §3.7.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THIS IS NOT A FOOTNOTE, IT IS THE EXPLANATION
 *
 * The panel above shows three distributions and one of them has moved. Without
 * this section the only available reading is "hardware is noisy", which is true
 * and teaches nothing. What actually happened is that the reader drew two gates
 * and the machine ran ten, because a Heron processor has no Hadamard and no
 * CNOT — and each of those ten is an opportunity for the state to decay.
 *
 * So both programs are on the page: the counts, the gates each side is made of,
 * and the submitted text in full. `program.ts` argues why both sides are
 * counted the same way and why the executed gates are grouped by what they
 * cost — six frame changes and one entangling gate are not seven equal things,
 * and a panel that presented them as seven would overstate the damage while
 * hiding where it came from.
 *
 * ════════════════════════════════════════════════════════════════════════
 * THE SOURCE IS SHOWN, NOT SUMMARISED
 *
 * It is the user's own circuit, it names no account, and it is the only
 * artefact on the page that is *exactly* what the machine received. A reader
 * who does not believe the counts can read it; a reader who wants to run the
 * same thing in Qiskit can copy it. `HardwareProgramResponse` in the contract
 * carries it deliberately and says so.
 *
 * It is rendered inside `Notation`'s sibling treatment — a monospace block with
 * `translate="no"` — because a browser-level page translator rewriting `measure`
 * into `mesurer` inside a program listing would produce something that looks
 * like source and is not.
 */

import { useTranslation } from 'react-i18next'

import { formatCount } from '../analysis/format'
import { GATE_COSTS, type GateTally, type ProgramComparison } from './program'

export interface ExecutedProgramProps {
  readonly comparison: ProgramComparison
  readonly qasm: string
  readonly backend: string
  /** `layout[logical]` is the physical qubit it ran on. */
  readonly layout: readonly number[]
}

export function ExecutedProgram({
  comparison,
  qasm,
  backend,
  layout,
}: ExecutedProgramProps) {
  const { t, i18n } = useTranslation('hardware')
  const language = i18n.language
  const { drawn, executed } = comparison

  return (
    <section className="executed-program">
      <h3 className="executed-program__heading">{t('program.heading')}</h3>
      <p className="executed-program__lead">{t('program.lead')}</p>

      <p className="executed-program__growth">
        {comparison.extra <= 0
          ? t('program.growthNone')
          : `${t('program.growth', {
              count: drawn.gates,
              drawn: formatCount(drawn.gates, language),
              executed: formatCount(executed.gates, language),
            })}${
              comparison.factor === null
                ? ''
                : ` ${t('program.growthFactor', {
                    factor: formatCount(
                      Math.round(comparison.factor * 10) / 10,
                      language
                    ),
                  })}`
            }`}
      </p>

      {comparison.hasDefinitions ? (
        <p className="executed-program__warning">{t('program.notFlat')}</p>
      ) : null}

      <div className="executed-program__sides">
        <Side
          title={t('program.drawn')}
          side={drawn}
          language={language}
          labels={{
            gates: t('program.gates'),
            measurements: t('program.measurements'),
            qubits: t('program.qubits'),
          }}
        />
        <Side
          title={t('program.executed', { backend })}
          side={executed}
          language={language}
          labels={{
            gates: t('program.gates'),
            measurements: t('program.measurements'),
            qubits: t('program.qubits'),
          }}
        />
      </div>

      <h4 className="executed-program__subheading">
        {t('program.cost.heading')}
      </h4>
      <dl className="executed-program__costs">
        {GATE_COSTS.map((cost) => (
          <div className="executed-program__cost" key={cost}>
            <dt>{t(`program.cost.${cost}`)}</dt>
            <dd className="tabular-numbers">
              {formatCount(comparison.cost[cost], language)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="executed-program__note">{t('program.cost.note')}</p>

      <h4 className="executed-program__subheading">{t('program.source')}</h4>
      <p className="executed-program__note">{t('program.sourceNote')}</p>
      <ul className="executed-program__layout">
        {layout.map((physical, logical) => (
          <li key={physical} translate="no">
            {t('device.layoutEntry', {
              logical: formatCount(logical, language),
              physical: `$${formatCount(physical, language)}`,
            })}
          </li>
        ))}
      </ul>
      {/*
       * `translate="no"` for the reason `components/Notation.tsx` gives: this is
       * source code, and a page translator that rewrote a keyword inside it
       * would produce something that looks like a program and does not parse.
       */}
      {/*
       * `tabIndex={0}` and a name, because this box scrolls: `max-height` plus
       * `overflow: auto` means a transpiled program of more than about
       * twenty-eight lines has its tail below the fold, and without a tab stop
       * a keyboard user cannot reach it at all (WCAG 2.2 SC 2.1.1). A focusable
       * region needs an accessible name, hence the label — and `role="region"`
       * rather than leaving it a bare `<pre>`, so the name is announced.
       */}
      <pre
        className="executed-program__source"
        translate="no"
        tabIndex={0}
        role="region"
        aria-label={t('program.sourceLabel')}
      >
        <code>{qasm}</code>
      </pre>
    </section>
  )
}

/**
 * One side of the comparison: three counts and the gates it is made of.
 *
 * The two sides render through one component so they cannot disagree about what
 * they are counting — which is the property `program.ts` spends its header on,
 * expressed as markup: a difference that was partly a layout change would be
 * read as the transpiler's doing.
 */
function Side({
  title,
  side,
  language,
  labels,
}: {
  readonly title: string
  readonly side: ProgramComparison['drawn']
  readonly language: string
  readonly labels: {
    readonly gates: string
    readonly measurements: string
    readonly qubits: string
  }
}) {
  return (
    <div className="executed-program__side">
      <h4 className="executed-program__side-title">{title}</h4>
      <dl className="executed-program__counts">
        <div>
          <dt>{labels.gates}</dt>
          <dd className="tabular-numbers">
            {formatCount(side.gates, language)}
          </dd>
        </div>
        <div>
          <dt>{labels.measurements}</dt>
          <dd className="tabular-numbers">
            {formatCount(side.measurements, language)}
          </dd>
        </div>
        <div>
          <dt>{labels.qubits}</dt>
          <dd className="tabular-numbers">
            {formatCount(side.qubits, language)}
          </dd>
        </div>
      </dl>
      <ul className="executed-program__tally">
        {side.tally.map((gate: GateTally) => (
          <li key={gate.name}>
            {/* A gate name is an identifier in the machine's own language, not
                a word: `sx` must not become `sx` translated. */}
            <span className="executed-program__gate" translate="no">
              {gate.name}
            </span>
            <span className="tabular-numbers">
              {formatCount(gate.count, language)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}
