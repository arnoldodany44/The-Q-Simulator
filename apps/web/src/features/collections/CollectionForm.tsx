/**
 * Creating a collection, and editing one — M1.9.
 *
 * One component for both, because they are one form over the same three
 * fields, and two would be two places for the visibility warning below to
 * drift.
 *
 * ── The visibility control explains what it does *not* do ─────────────────
 *
 * This is the one place in the product where a person could reasonably expect
 * a setting to be transitive, and it is not: making a collection PUBLIC
 * publishes the collection, and every circuit inside it keeps its own
 * visibility. The server enforces that (`readCollectionItems` in @qsim/db) —
 * what this control owes the user is *saying* so, before they publish
 * something expecting their private circuits to travel with it and find later
 * that half the list is invisible to their readers.
 */

import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  MAX_COLLECTION_DESCRIPTION_LENGTH,
  MAX_COLLECTION_TITLE_LENGTH,
  VISIBILITY_VALUES,
} from '@qsim/contract'
import type { Visibility } from '@qsim/contract'

export interface CollectionDraft {
  readonly title: string
  readonly description: string
  readonly visibility: Visibility
}

export interface CollectionFormProps {
  readonly initial?: CollectionDraft
  readonly submitLabel: string
  readonly pending: boolean
  readonly onSubmit: (draft: CollectionDraft) => void
  /** Rendered above the controls: whatever the mutation last said went wrong. */
  readonly error?: string | null
}

const EMPTY: CollectionDraft = {
  title: '',
  description: '',
  visibility: 'PRIVATE',
}

export function CollectionForm({
  initial = EMPTY,
  submitLabel,
  pending,
  onSubmit,
  error = null,
}: CollectionFormProps) {
  const { t } = useTranslation(['collections', 'circuits'])
  const [draft, setDraft] = useState<CollectionDraft>(initial)
  const titleId = useId()
  const descriptionId = useId()
  const visibilityId = useId()

  const empty = draft.title.trim() === ''

  return (
    <form
      className="collection-form"
      onSubmit={(event) => {
        event.preventDefault()
        if (pending || empty) return
        onSubmit(draft)
      }}
    >
      {error === null ? null : (
        <p className="auth-alert" role="alert">
          {error}
        </p>
      )}

      <div className="field">
        <label htmlFor={titleId}>{t('collections:form.title')}</label>
        <input
          id={titleId}
          type="text"
          value={draft.title}
          required
          maxLength={MAX_COLLECTION_TITLE_LENGTH}
          onChange={(event) => {
            setDraft({ ...draft, title: event.target.value })
          }}
        />
      </div>

      <div className="field">
        <label htmlFor={descriptionId}>
          {t('collections:form.description')}
        </label>
        <textarea
          id={descriptionId}
          value={draft.description}
          rows={3}
          maxLength={MAX_COLLECTION_DESCRIPTION_LENGTH}
          onChange={(event) => {
            setDraft({ ...draft, description: event.target.value })
          }}
        />
      </div>

      <div className="field">
        <label htmlFor={visibilityId}>{t('collections:form.visibility')}</label>
        <select
          id={visibilityId}
          value={draft.visibility}
          onChange={(event) => {
            setDraft({
              ...draft,
              visibility: event.target.value as Visibility,
            })
          }}
        >
          {VISIBILITY_VALUES.map((value) => (
            <option key={value} value={value}>
              {t(`circuits:visibility.${value}`)}
            </option>
          ))}
        </select>
        {/*
         * The sentence this form exists to say. Rendered always rather than
         * only for PUBLIC, because the moment it matters is the moment
         * *before* somebody switches.
         */}
        <p className="field__hint">{t('collections:form.visibilityNote')}</p>
      </div>

      <button
        className="page__cta"
        type="submit"
        /*
         * `aria-disabled`, never `disabled`: a disabled control cannot hold
         * focus, so a keyboard user who clears the title is dropped to the
         * document body. Announced as unavailable, still reachable, and the
         * handler declines.
         */
        aria-disabled={pending || empty}
      >
        {pending ? t('collections:form.saving') : submitLabel}
      </button>
    </form>
  )
}
