/**
 * The scaffold landing page, unchanged in substance since M0.0: its job is
 * to prove the wiring works — both shared workspace packages resolve from
 * the app, and the three catalogs load and switch. The real landing arrives
 * with M0.9, which is why nothing here is worth polishing.
 *
 * M0.5c moved it behind the `/` route and gave it the one thing it was
 * missing: a way into the editor.
 */

import { formatKet } from '@qsim/core'
import { CIRCUIT_SCHEMA_VERSION } from '@qsim/schema'
import { useTranslation } from 'react-i18next'
import { Link } from 'react-router'

import { LanguagePicker } from '../components/LanguagePicker'
import { Notation } from '../components/Notation'
import { CircuitCanvas } from '../features/circuit-editor/CircuitCanvas'
import { useCircuitStore } from '../features/circuit-editor/useCircuitStore'

export function LandingRoute() {
  const { t } = useTranslation(['landing', 'common', 'editor'])

  // Only the data is subscribed to. Actions are reached through `getState()`
  // at the moment they run: they never change identity, so subscribing to
  // them would add a re-render path that can only ever fire spuriously.
  const circuit = useCircuitStore((state) => state.circuit)
  const selection = useCircuitStore((state) => state.selection)

  return (
    <main className="page">
      <header className="page__header">
        <h1>{t('common:appName')}</h1>
        <LanguagePicker />
      </header>

      <p className="tagline">{t('landing:tagline')}</p>
      <p>{t('landing:intro')}</p>

      <p className="notice">{t('landing:scaffoldNotice')}</p>

      <p>
        <Link className="page__cta" to="/new">
          {t('landing:openEditor')}
        </Link>
      </p>

      <h2 className="section-heading">{t('editor:title')}</h2>
      <CircuitCanvas
        circuit={circuit}
        selection={selection}
        onRemoveQubit={(index) => {
          useCircuitStore.getState().removeQubit(index)
        }}
        onInsertQubitBelow={(index) => {
          useCircuitStore.getState().addQubit(index + 1)
        }}
      />

      <dl className="wiring-check">
        <dt>
          <Notation value="@qsim/schema" />
        </dt>
        <dd>{CIRCUIT_SCHEMA_VERSION}</dd>
        <dt>
          <Notation value="@qsim/core" />
        </dt>
        <dd>
          <Notation value={`|${formatKet(5, 3)}⟩`} />
        </dd>
      </dl>
    </main>
  )
}
