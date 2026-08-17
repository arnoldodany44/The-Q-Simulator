import { cleanup, render, screen } from '@testing-library/react'
import { CHALLENGE_FEEDBACK_CODES, CHALLENGE_SLUGS } from '@qsim/contract'
import type {
  Challenge,
  ChallengeSubmissionResult,
  LeaderboardEntry,
} from '@qsim/contract'
import { CIRCUIT_SCHEMA_VERSION, emptyCircuit } from '@qsim/schema'
import type { Circuit } from '@qsim/schema'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enChallenges from '../../i18n/locales/en/challenges.json'
import esChallenges from '../../i18n/locales/es/challenges.json'
import frChallenges from '../../i18n/locales/fr/challenges.json'
import { ChallengeBrief } from './ChallengeBrief'
import { ChallengeLeaderboard } from './ChallengeLeaderboard'
import type { ChallengeLeaderboardProps } from './ChallengeLeaderboard'
import { ChallengeVerdict } from './ChallengeVerdict'
import { renderable } from './catalog'
import { readLocally } from './local'

/**
 * The challenge surfaces, without a server.
 *
 * Three properties, and the first two are the ones no other gate can see:
 *
 *   1. **The catalog covers exactly the published slugs, in three languages.**
 *      The API sends a slug and this bundle owns the words, so a challenge
 *      seeded without prose would render `catalog.x.title` on the page. Locale
 *      parity cannot catch it — the key is missing from all three at once.
 *   2. **Every feedback code has a sentence.** The codes are published by
 *      `@qsim/contract` and produced by the server; a code with no catalog
 *      entry is a diagnosis that reaches a reader as an identifier. Same
 *      arrangement, and same test, as `errors.json` already has.
 *   3. The brief renders the rules and never anything the API did not send.
 *   4. **The board prints the rank it was given.** The server ranks everybody
 *      and then withholds the readers who asked not to be listed, so a gap in
 *      the numbers is a correct table — and renumbering it here would be the
 *      one change that lets somebody gain a place by persuading the person
 *      above them to hide.
 */

afterEach(cleanup)

type Language = 'en' | 'es' | 'fr'

const CATALOGS: Record<Language, unknown> = {
  en: enChallenges,
  es: esChallenges,
  fr: frChallenges,
}

function i18nFor(language: Language): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: language,
    fallbackLng: 'en',
    ns: ['challenges'],
    defaultNS: 'challenges',
    resources: {
      en: { challenges: enChallenges },
      es: { challenges: esChallenges },
      fr: { challenges: frChallenges },
    },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

const BELL: Challenge = {
  slug: 'bell-pair',
  difficulty: 2,
  qubitCount: 2,
  targetType: 'state',
  allowedGates: ['h', 'cx'],
  maxGates: 4,
  fidelityThreshold: 0.99,
  orderIndex: 2,
}

/** An i18next key rendered as text — the defect `no-raw-keys.spec.ts` exists for. */
const KEY_SHAPE = /^[a-z][a-zA-Z]*(\.[a-zA-Z-]+)+$/

function rawKeysIn(container: HTMLElement): string[] {
  const found = new Set<string>()
  for (const element of container.querySelectorAll('*')) {
    if (element.children.length > 0) continue
    const text = (element.textContent ?? '').trim()
    if (text && KEY_SHAPE.test(text)) found.add(text)
  }
  return [...found]
}

describe('the prose catalog', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'covers exactly the published slugs in "%s"',
    (language) => {
      const catalog = CATALOGS[language] as {
        catalog: Record<string, { title: string; prompt: string }>
      }
      expect(Object.keys(catalog.catalog).sort()).toEqual(
        [...CHALLENGE_SLUGS].sort()
      )
      for (const entry of Object.values(catalog.catalog)) {
        expect(entry.title.length).toBeGreaterThan(0)
        expect(entry.prompt.length).toBeGreaterThan(0)
      }
    }
  )

  it.each(['en', 'es', 'fr'] as const)(
    'has a sentence for every feedback code in "%s"',
    (language) => {
      const catalog = CATALOGS[language] as {
        feedback: Record<string, string>
      }
      expect(Object.keys(catalog.feedback).sort()).toEqual(
        [...CHALLENGE_FEEDBACK_CODES].sort()
      )
    }
  )

  it.each(['en', 'es', 'fr'] as const)(
    'has a note for every target kind in "%s"',
    (language) => {
      const catalog = CATALOGS[language] as {
        brief: { targetNote: Record<string, string> }
      }
      expect(Object.keys(catalog.brief.targetNote).sort()).toEqual([
        'state',
        'truth_table',
        'unitary',
      ])
    }
  )
})

describe('the brief', () => {
  it.each(['en', 'es', 'fr'] as const)(
    'renders the rules with no raw keys in "%s"',
    (language) => {
      const { container } = render(
        <I18nextProvider i18n={i18nFor(language)}>
          <ChallengeBrief challenge={BELL} />
        </I18nextProvider>
      )
      expect(rawKeysIn(container)).toEqual([])
      // The gate ids are notation and identical in every language.
      expect(screen.getByText('cx')).toBeTruthy()
      expect(screen.getByText('h')).toBeTruthy()
    }
  )

  it('says a challenge with no gate list allows anything, rather than nothing', () => {
    render(
      <I18nextProvider i18n={i18nFor('en')}>
        <ChallengeBrief
          challenge={{ ...BELL, allowedGates: [], maxGates: null }}
        />
      </I18nextProvider>
    )
    expect(screen.getByText(enChallenges.brief.anyGate)).toBeTruthy()
    expect(screen.getByText(enChallenges.brief.noLimit)).toBeTruthy()
  })
})

describe('the verdict', () => {
  const resultWith = (
    codes: readonly string[],
    passed = false
  ): ChallengeSubmissionResult => ({
    submission: {
      passed,
      fidelity: 0.8331,
      gateCount: 3,
      depth: 2,
      createdAt: new Date(0),
    },
    feedback: codes.map((code) => ({
      code: code as ChallengeSubmissionResult['feedback'][number]['code'],
      value: 2,
      gate: code === 'gate-not-allowed' ? 'sx' : null,
    })),
  })

  it.each(['en', 'es', 'fr'] as const)(
    'turns every code into a sentence in "%s"',
    (language) => {
      const { container } = render(
        <I18nextProvider i18n={i18nFor(language)}>
          <ChallengeVerdict result={resultWith(CHALLENGE_FEEDBACK_CODES)} />
        </I18nextProvider>
      )
      expect(rawKeysIn(container)).toEqual([])
    }
  )

  /*
   * §10: colour is never the only carrier. The verdict has to say which it is
   * in words, or a reader with no colour vision has a green border and no
   * result.
   */
  it('says pass or fail in words, not only in colour', () => {
    const { rerender } = render(
      <I18nextProvider i18n={i18nFor('en')}>
        <ChallengeVerdict result={resultWith(['solved'], true)} />
      </I18nextProvider>
    )
    expect(screen.getByText(enChallenges.verdict.passed)).toBeTruthy()

    rerender(
      <I18nextProvider i18n={i18nFor('en')}>
        <ChallengeVerdict result={resultWith(['nearly-there'])} />
      </I18nextProvider>
    )
    expect(screen.getByText(enChallenges.verdict.failed)).toBeTruthy()
  })

  it('renders a disallowed gate as notation beside its sentence', () => {
    render(
      <I18nextProvider i18n={i18nFor('fr')}>
        <ChallengeVerdict result={resultWith(['gate-not-allowed'])} />
      </I18nextProvider>
    )
    const gate = screen.getByText('sx')
    expect(gate.getAttribute('translate')).toBe('no')
  })

  /**
   * D2 does not stop at words (§1.1), and this is where it used to.
   *
   * Every number on this panel went through `new Intl.NumberFormat(undefined,
   * …)`, and `undefined` is the RUNTIME's default locale — `navigator.language`
   * — rather than the language the reader chose. So all three languages
   * rendered byte-identically, and which of the three was wrong depended on
   * the machine: on an `en-US` developer's browser the French verdict wrote
   * `0.833`, and on an `fr-FR` browser the English one wrote `0,833`.
   *
   * The old suite rendered all three languages and asserted only that no raw
   * key survived, which is why it passed throughout. This asserts the digits.
   */
  it.each([
    { language: 'en' as const, fidelity: '0.833', angle: '-1.57' },
    { language: 'es' as const, fidelity: '0,833', angle: '-1,57' },
    { language: 'fr' as const, fidelity: '0,833', angle: '-1,57' },
  ])(
    'writes its numbers in the reader’s language, not the machine’s ($language)',
    ({ language, fidelity, angle }) => {
      const { container } = render(
        <I18nextProvider i18n={i18nFor(language)}>
          <ChallengeVerdict
            result={{
              submission: {
                passed: false,
                fidelity: 0.8331,
                gateCount: 3,
                depth: 2,
                createdAt: new Date(0),
              },
              feedback: [
                { code: 'nearly-there', value: 0.8331, gate: null },
                { code: 'global-phase-ignored', value: -1.5708, gate: null },
              ],
            }}
          />
        </I18nextProvider>
      )
      const text = container.textContent ?? ''
      expect(text).toContain(fidelity)
      expect(text).toContain(angle)
    }
  )

  /**
   * The threshold and the achieved fidelity are the same quantity under the
   * same definition, and a learner is asked to read one against the other. The
   * brief used to print `99 %` beside a verdict printing `0.985`, with nothing
   * on screen saying they were commensurable.
   */
  it.each(['en', 'es', 'fr'] as const)(
    'shows the threshold in the same unit as the fidelity in "%s"',
    (language) => {
      const point = language === 'en' ? '.' : ','
      const { container } = render(
        <I18nextProvider i18n={i18nFor(language)}>
          <ChallengeBrief challenge={{ ...BELL, fidelityThreshold: 0.99 }} />
        </I18nextProvider>
      )
      expect(container.textContent).toContain(`0${point}990`)
      expect(container.textContent).not.toContain('%')
    }
  )
})

describe('the leaderboard', () => {
  const entry = (
    rank: number,
    username: string,
    gateCount: number,
    depth: number
  ): LeaderboardEntry => ({
    rank,
    username,
    displayName: null,
    gateCount,
    depth,
    createdAt: new Date(0),
  })

  const standing = (
    rank: number,
    listed = true
  ): ChallengeLeaderboardProps['standing'] => ({
    rank,
    gateCount: 4,
    depth: 3,
    createdAt: new Date(0),
    listed,
  })

  function board(
    props: Partial<ChallengeLeaderboardProps>,
    language: Language = 'en'
  ) {
    return render(
      <I18nextProvider i18n={i18nFor(language)}>
        <ChallengeLeaderboard
          entries={[]}
          standing={null}
          signedIn={false}
          loading={false}
          {...props}
        />
      </I18nextProvider>
    )
  }

  it.each(['en', 'es', 'fr'] as const)(
    'renders every state of the table with no raw keys in "%s"',
    (language) => {
      for (const props of [
        { loading: true },
        {},
        { signedIn: true },
        { entries: [entry(1, 'ada', 2, 2)], signedIn: true },
        {
          entries: [entry(1, 'ada', 2, 2), entry(3, 'grace', 4, 3)],
          standing: standing(3),
          signedIn: true,
        },
        { standing: standing(1, false), signedIn: true },
      ] satisfies Partial<ChallengeLeaderboardProps>[]) {
        const { container } = board(props, language)
        expect(rawKeysIn(container)).toEqual([])
        cleanup()
      }
    }
  )

  /**
   * The server ranks everybody and then withholds the readers who asked not to
   * be listed, so a gap is a correct table. Renumbering here would let anyone
   * gain a place by persuading the person above them to hide — and would make
   * this table disagree with the standing printed under it.
   */
  it('prints the rank it was given, gaps and all', () => {
    const { container } = board({
      entries: [entry(1, 'ada', 2, 2), entry(4, 'grace', 5, 4)],
      signedIn: true,
    })
    // The rank column, read as a column: 1 then 4, with 2 and 3 belonging to
    // readers this table is not allowed to name.
    const ranks = [...container.querySelectorAll('tbody tr')].map(
      (row) => row.querySelector('td')?.textContent
    )
    expect(ranks).toEqual(['1', '4'])
  })

  /*
   * §10: colour is never the only carrier. The reader's own row is announced
   * with `aria-current` and marked in text; the tint is reinforcement.
   */
  it('marks the reader’s own row in words and in the accessibility tree', () => {
    board({
      entries: [entry(1, 'ada', 2, 2), entry(2, 'grace', 4, 3)],
      standing: standing(2),
      signedIn: true,
    })
    const mine = screen.getByText('grace').closest('tr')
    expect(mine?.getAttribute('aria-current')).toBe('true')
    expect(mine?.textContent).toContain(enChallenges.board.you.trim())

    const theirs = screen.getByText('ada').closest('tr')
    expect(theirs?.getAttribute('aria-current')).toBeNull()
  })

  it('tells a reader where they stand even when they are off the page', () => {
    board({
      entries: [entry(1, 'ada', 2, 2)],
      standing: standing(9),
      signedIn: true,
    })
    // Nine is not in the table and the sentence still says it.
    expect(screen.getByText(/9/)).toBeTruthy()
  })

  /**
   * A withheld reader is not on the table they are looking at, so without this
   * the page would tell the only person who solved the challenge that nobody
   * had.
   */
  it('does not tell a hidden solver that nobody has solved it', () => {
    board({ entries: [], standing: standing(1, false), signedIn: true })
    expect(screen.queryByText(enChallenges.board.empty)).toBeNull()
    expect(screen.getByText(enChallenges.board.noneListed)).toBeTruthy()
    expect(screen.getByText(enChallenges.board.withheld)).toBeTruthy()
  })

  it('does not invite an anonymous reader to a standing they cannot have', () => {
    board({ entries: [entry(1, 'ada', 2, 2)], signedIn: false })
    expect(screen.queryByText(enChallenges.board.youUnranked)).toBeNull()
  })

  it('publishes no circuit, because a solution is a spoiler', () => {
    const { container } = board({
      entries: [entry(1, 'ada', 2, 2)],
      standing: standing(1),
      signedIn: true,
    })
    // Four columns: rank, who, gates, depth. There is nowhere to draw one.
    expect(container.querySelectorAll('th')).toHaveLength(4)
  })

  /**
   * Every column header is a WORD, in every language.
   *
   * The rank column was headed `#`, which NVDA at its default punctuation
   * level does not speak at all and VoiceOver reads as "number sign" — so the
   * one column that says where somebody placed was the one announced without a
   * name, while its three neighbours were announced properly. The table is
   * built as a real table precisely so headers travel with cells; a header
   * that is not a name spends that.
   *
   * The old assertion counted the headers and never read one.
   */
  it.each(['en', 'es', 'fr'] as const)(
    'gives every column a spoken name in "%s"',
    (language) => {
      const { container } = board(
        { entries: [entry(1, 'ada', 2, 2)], standing: null, signedIn: false },
        language
      )
      const headers = [...container.querySelectorAll('th')].map(
        (cell) => cell.textContent ?? ''
      )
      expect(headers).toHaveLength(4)
      for (const header of headers) {
        expect(header.trim().length).toBeGreaterThan(1)
        expect(header).toMatch(/\p{Letter}/u)
      }
    }
  )
})

describe('the local reading', () => {
  const bell = (): Circuit => ({
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 2,
    clbits: 0,
    operations: [
      { id: 'a', gate: 'h', targets: [0], column: 0 },
      { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
    ],
  })

  it('counts what the server counts', () => {
    const reading = readLocally(bell(), BELL)
    expect(reading.gateCount).toBe(2)
    expect(reading.depth).toBe(2)
    expect(reading.blocked).toBe(false)
  })

  it('sees a forbidden gate, including one inside a block', () => {
    const packaged: Circuit = {
      ...emptyCircuit(2),
      operations: [{ id: 'a', gate: 'sneaky', targets: [0], column: 0 }],
      customGates: {
        sneaky: {
          qubits: 1,
          operations: [{ id: 'cg', gate: 'sx', targets: [0], column: 0 }],
        },
      },
    }
    expect(readLocally(packaged, BELL).disallowed).toEqual(['sx'])
  })

  it('notices the wrong register and the gate budget', () => {
    expect(readLocally(emptyCircuit(3), BELL).wrongRegister).toBe(true)
    const long: Circuit = {
      ...bell(),
      operations: [
        ...bell().operations,
        { id: 'c', gate: 'h', targets: [0], column: 2 },
        { id: 'd', gate: 'h', targets: [0], column: 3 },
        { id: 'e', gate: 'h', targets: [0], column: 4 },
      ],
    }
    expect(readLocally(long, BELL).overBudget).toBe(true)
  })

  /*
   * The one thing this side must never claim. A circuit with nothing locally
   * wrong is not a solved circuit — only the server holds the target — so the
   * reading has no field that could be read as "correct".
   */
  it('has no opinion about whether the answer is right', () => {
    expect(Object.keys(readLocally(bell(), BELL)).sort()).toEqual([
      'blocked',
      'depth',
      'disallowed',
      'gateCount',
      'overBudget',
      'wrongRegister',
    ])
  })
})

describe('an API ahead of this bundle', () => {
  it('skips a challenge this bundle has no prose for', () => {
    const future: Challenge = { ...BELL, slug: 'challenge-from-the-future' }
    expect(renderable([BELL, future])).toEqual([BELL])
  })
})
