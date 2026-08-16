/**
 * Putting a circuit into a collection — M1.9.
 *
 * ── Why the picker lists the caller's own circuits ────────────────────────
 *
 * The server will accept any circuit the caller can *read*, including somebody
 * else's public one, and that is deliberate — collecting other people's work is
 * most of what a collection is for. What this control offers is the caller's
 * own, because that is the list a browser can hold: "every circuit you may
 * read" is the gallery, and a select element is not a gallery. Adding
 * somebody else's is done from the card it appears on, which is a Phase 2
 * shape (`GET /circuits/:id/collections` already exists for it).
 *
 * ── It offers only what would change something ────────────────────────────
 *
 * Circuits already in the collection are filtered out. The server is
 * idempotent — adding twice is a 200 and not a second row — so this is not a
 * correctness guard; it is the difference between a control that does nothing
 * and one that is not there.
 */

import { useState } from 'react'
import { useTranslation } from 'react-i18next'

import {
  useAddCollectionItem,
  useApiErrorMessage,
  useCircuits,
} from '../../lib/api'

export interface AddCircuitToCollectionProps {
  readonly collectionId: string
  /** Ids already in the collection, so they are not offered again. */
  readonly present: readonly string[]
}

/** One page of the caller's own circuits is enough to choose from. */
const PER_PAGE = 100

export function AddCircuitToCollection({
  collectionId,
  present,
}: AddCircuitToCollectionProps) {
  const { t } = useTranslation('collections')
  const describeError = useApiErrorMessage()
  const mine = useCircuits({ perPage: PER_PAGE })
  const add = useAddCollectionItem()
  const [chosen, setChosen] = useState('')

  const held = new Set(present)
  const options = (mine.data?.items ?? []).filter(
    (circuit) => !held.has(circuit.id)
  )

  if (mine.isPending) {
    return (
      <p className="page__loading" role="status">
        {t('add.loading')}
      </p>
    )
  }

  if (options.length === 0) {
    return <p className="field__hint">{t('add.none')}</p>
  }

  return (
    <form
      className="collection-add"
      onSubmit={(event) => {
        event.preventDefault()
        if (add.isPending || chosen === '') return
        add.mutate(
          { id: collectionId, circuit: chosen },
          {
            onSuccess: () => {
              setChosen('')
            },
          }
        )
      }}
    >
      {add.isError ? (
        <p className="auth-alert" role="alert">
          {describeError(add.error)}
        </p>
      ) : null}

      <div className="field">
        <label htmlFor="collection-add-circuit">{t('add.label')}</label>
        <select
          id="collection-add-circuit"
          value={chosen}
          onChange={(event) => {
            setChosen(event.target.value)
          }}
        >
          <option value="">{t('add.placeholder')}</option>
          {options.map((circuit) => (
            /*
             * Addressed by slug rather than id: a slug also reaches an
             * UNLISTED circuit, which is the case where somebody is collecting
             * something they hold a link to. See `StarVariables` for the same
             * rule.
             */
            <option key={circuit.id} value={circuit.slug}>
              {circuit.title}
            </option>
          ))}
        </select>
      </div>

      <button
        className="page__cta page__cta--quiet"
        type="submit"
        aria-disabled={add.isPending || chosen === ''}
      >
        {add.isPending ? t('add.adding') : t('add.submit')}
      </button>
    </form>
  )
}
