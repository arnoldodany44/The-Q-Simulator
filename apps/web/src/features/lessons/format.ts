/**
 * The lesson format — §3.6, Phase 3.
 *
 * A lesson is text, a circuit and an objective, stepped through. This file is
 * the shape of that, and it is written before any lesson is, because nine
 * lessons against a weak format is nine rewrites.
 *
 * Four questions, four decisions, and each one is visible to a reader.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 1. A STEP NAMES ITS CIRCUIT AS A DIFF (`patch.ts` carries the argument).
 *
 * `patch` is the change from the previous step, so "now add a CNOT" is one
 * line of data beside one sentence of prose, and the reader watches a gate
 * appear on the canvas they were already looking at instead of watching the
 * document be replaced.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 2. WHAT TO NOTICE IS A NAMED PANEL PLUS A SENTENCE — NOT A DRAWING.
 *
 * `focus` names one region of the live analysis panel: the histogram, the
 * amplitude table, the Bloch spheres, the Q-sphere, the entanglement metrics,
 * or the circuit itself. The player scrolls it into view and outlines it; the
 * sentence that says *what* about it lives in the catalog beside the step's
 * prose (`<slug>.steps.<id>.notice`).
 *
 * Two things this deliberately is not. It is not a coordinate — "point at the
 * phasor at x=214" breaks the first time a bar moves, and the histogram
 * reorders whenever the circuit does. And it is not a copy of the panel with
 * annotations drawn on it: §3.2's charts are the product, a lesson that
 * illustrated them with a picture of them would teach a picture, and the
 * moment the real panel changed the lesson would be lying. So the target is
 * the coarsest thing that is still useful and still stable — a panel — and the
 * prose does the pointing, which is what prose is good at.
 *
 * The consequence is a coupling worth naming: the player finds these regions
 * by the class names §10's stylesheet already gives them
 * (`LESSON_FOCUS_SELECTORS` below). A rename in `features/analysis` would
 * silently stop the outline working, so `LessonPlayer.test.tsx` renders the
 * real panel and asserts every target resolves.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 3. AN OBJECTIVE IS A READING OF THE STATE, AND THE BROWSER DECIDES IT.
 *
 * Some steps are "press next" — `{ kind: 'read' }`, and they are the majority,
 * because most of a lesson is watching. The good ones are "build this and
 * see": `{ kind: 'build', check }`, where `check` is a question asked of the
 * *simulated state* rather than of the circuit text. That distinction is the
 * whole value. A check written against the gates would accept exactly one
 * construction and reject every equivalent one — H then Z, or S twice, or a
 * Ry(π/2) — which teaches the reader to reproduce a picture instead of to
 * produce a state.
 *
 * **The check runs in this tab, and that is deliberate.** §11 and risk 5 make
 * validation authoritative on the server *for challenges*, and the reason is
 * named there: a challenge has a leaderboard, so a client that lies gains a
 * position it did not earn. A lesson has nothing to win. Nobody is ranked, no
 * row is written that another reader can see, and the only thing a reader
 * could obtain by lying to this function is the sentence "well done" — which
 * they can also obtain by pressing Next, because the objective does not gate
 * navigation either (see 4 below). Putting a round trip in front of every
 * keystroke of a two-qubit circuit would buy nothing and would make the panel
 * stop answering while the network was slow. `@qsim/core` runs the same engine
 * here that the server would run there; what differs is who is trusted, and
 * for a lesson the answer is that nobody needs to be.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 4. THE OBJECTIVE REPORTS; IT DOES NOT LOCK.
 *
 * "Next" is enabled on every step, whether or not the check passes. A lesson
 * that refuses to advance strands the reader who built something equivalent
 * the checker does not recognise, and it turns the one part of the product
 * that is supposed to be an explanation into an exam. What the objective does
 * instead is *say where they are* — not yet, or done — and offer "show me",
 * which applies the step's own patch so the reader can see the answer and
 * carry on. The place where passing matters, and therefore where the server
 * decides, is the challenge mode of §3.6.
 *
 * ────────────────────────────────────────────────────────────────────────
 * 5. THE PROSE LIVES IN THE CATALOGS, ONE PARAGRAPH PER KEY (D2).
 *
 * Not in Markdown files beside the lesson, which is the arrangement that reads
 * best and is the one thing D2 forbids: "every user-facing string through
 * i18next into all three catalogs", and `locale-parity.test.ts` is what makes
 * three languages stay three languages. A lesson's prose is the largest body
 * of translated text in the product, so it is the last place to make an
 * exception.
 *
 * What that costs is readability, and it is paid down twice rather than
 * accepted:
 *
 *   - **A body is an array of paragraphs, not one string with `\n\n` in it.**
 *     One JSON string per paragraph is a length a person can read in a diff,
 *     and `flattenKeys` in the parity test descends into arrays — so a French
 *     translation that drops the third paragraph is a build failure naming
 *     `superposition.steps.turn.body.2`, rather than a page that is quietly
 *     shorter in one language.
 *   - **Notation inside prose is written between backticks.** `H`, `|0⟩` and
 *     `Rz(θ)` are the things D2 says are identical in every language, and
 *     `Notation` is the only sanctioned way to render them (§1.1). Interpolated
 *     components would put `<0>` markers in the catalog, which is exactly the
 *     unreviewable JSON this decision is trying to avoid; a backtick is one
 *     character, it is the convention every technical writer already has, and
 *     `prose.ts` turns each span into a `<Notation>` — which also marks it
 *     `translate="no"`, so Chrome's page translator cannot turn a `CNOT` into
 *     something else.
 *
 * The structure — patches, focus, objectives — stays in TypeScript, where it
 * is type-checked and where a test can run it. The catalogs hold words and
 * nothing else, and `catalog/lessonKeys.test.ts` is the bridge: it asserts
 * that every step every lesson declares has exactly the keys its shape
 * requires, in all three languages. Parity alone cannot see that, because
 * parity compares catalogs against each other and three catalogs can agree
 * perfectly on a lesson that no longer exists.
 */

import type { Circuit } from '@qsim/schema'

import { foldPatches, lessonBaseCircuit, type CircuitPatch } from './patch'

/**
 * The regions of the live panel a step can point at.
 *
 * `circuit` is the editor's canvas; the other five are §3.2's charts. The list
 * is closed on purpose: a lesson author picking a target should be choosing
 * from the things that exist, and a new chart earns an entry here at the same
 * time it earns a place on screen.
 */
export const LESSON_FOCUS_TARGETS = [
  'circuit',
  'histogram',
  'amplitudes',
  'bloch',
  'qsphere',
  'entanglement',
] as const

export type LessonFocusTarget = (typeof LESSON_FOCUS_TARGETS)[number]

/**
 * How the player finds each region in its own subtree.
 *
 * These are the class names §10's stylesheet gives those components, which
 * makes this the one place the lesson feature reaches into the analysis
 * feature's markup. Written down as data rather than spread through the
 * player so the coupling is a single list somebody can check, and checked by
 * `LessonPlayer.test.tsx` against the real components rather than trusted.
 */
export const LESSON_FOCUS_SELECTORS: Record<LessonFocusTarget, string> = {
  circuit: '.circuit-canvas',
  histogram: '.histogram',
  amplitudes: '.amplitudes',
  bloch: '.bloch',
  qsphere: '.qsphere',
  entanglement: '.entanglement',
}

/**
 * The three shapes of question a build step can ask of a state.
 *
 * Three rather than one because they differ in how much they leave open, and
 * that is the pedagogy rather than an implementation detail:
 *
 *   - `state` is the tightest: the reader's circuit must produce the step's
 *     own state, up to global phase. It is for "build this".
 *   - `probabilities` ignores phase entirely, so every state with the right
 *     measurement statistics passes. It is for "make both outcomes equally
 *     likely", where insisting on a phase would be insisting on an answer the
 *     question did not ask for.
 *   - `entangled` names no state at all — it asks for one number, the von
 *     Neumann entropy of a qubit, to be above a threshold. It is for "entangle
 *     these two", which has infinitely many answers and should.
 *   - `outcomes` names no basis state either — it asks how many bars the
 *     histogram has, and whether they are the same height. It is for "make the
 *     histogram have two bars instead of four", where naming *which* two would
 *     be naming a labelling the question never asked about.
 *
 * The fourth exists because of a defect the third could not fix. The
 * interference lesson's eraser step asked for `|00⟩` and `|11⟩` at a half
 * each, and its own hint offered `Ry` at a quarter turn as an equivalent
 * answer — which it is, physically: `H` and `Ry(±π/2)` all read the marker
 * wire in the X basis and differ only in which of `|+⟩`/`|−⟩` they call zero.
 * So `Ry(+π/2)` produced `|01⟩` and `|10⟩`, two bars, a perfectly correct
 * quantum eraser, and was told "Not there yet". That is precisely the failure
 * decision 3 above says this feature exists to avoid, arriving through the
 * `expected` map rather than through the gates.
 */
export type LessonCheck =
  | {
      readonly kind: 'state'
      /**
       * `|⟨ψ|φ⟩|²` against the step's own circuit. 0.999 rather than 1 because
       * D6 fixes Float64 and a reader who builds the state out of rotations
       * lands a few ulps away from one built out of `h`.
       */
      readonly minFidelity?: number
    }
  | {
      readonly kind: 'probabilities'
      /**
       * Basis state to probability, the state written in the app's own
       * little-endian ket order (D1) — `'01'` is q1 = 0, q0 = 1. States not
       * listed must carry no probability.
       */
      readonly expected: Readonly<Record<string, number>>
      /** Absolute, per basis state. Defaults to 0.01 — a bar's width. */
      readonly tolerance?: number
    }
  | {
      readonly kind: 'entangled'
      /** The qubit whose reduced state is examined. */
      readonly qubit: number
      /** Von Neumann entropy in bits, above which the qubit counts. */
      readonly minEntropy?: number
    }
  | {
      readonly kind: 'outcomes'
      /**
       * How many basis states carry probability. They must be equally likely:
       * "two bars" and "two bars of the same height" are the same sentence in
       * every lesson that asks this, and asking for one without the other
       * would accept a 0.99/0.01 split as a pair.
       */
      readonly count: number
      /** Absolute, per basis state. Defaults to 0.01 — a bar's width. */
      readonly tolerance?: number
    }

export type LessonObjective =
  | { readonly kind: 'read' }
  | { readonly kind: 'build'; readonly check: LessonCheck }

export interface LessonStep {
  /**
   * Stable within its lesson, and part of a catalog key — so renaming one
   * orphans three translations, which `lessonKeys.test.ts` reports.
   *
   * A name rather than an index because the index moves the moment a step is
   * inserted, and moving an index silently repoints every translation.
   */
  readonly id: string
  /** The change from the previous step's circuit. See `patch.ts`. */
  readonly patch: CircuitPatch
  /** Which region of the live panel the step's `notice` is about. */
  readonly focus?: LessonFocusTarget
  readonly objective: LessonObjective
}

/*
 * ────────────────────────────────────────────────────────────────────────
 * THE ONE VERB THIS FORMAT DELIBERATELY DOES NOT HAVE: "park the scrubber".
 *
 * A step cannot say "show the state after column 1". It is the omission worth
 * naming, because the scrubber is the editor's most explanatory control
 * (§3.1) and a lesson is exactly where somebody would want to drive it.
 *
 * It is absent because the timeline is *owned by the editor* (M0.8:
 * `useTimeline` lives in `CircuitEditor` because the canvas and the analysis
 * panel both read it), and because §3.1's frozen decision puts the bar back at
 * the end whenever the document is replaced — which is what every lesson step
 * with a patch does. Wiring a step's position through would therefore mean
 * either a prop that fights that reset on every step, or moving timeline
 * ownership out of a shipped component for the sake of one field. Neither is
 * this milestone's to do, and shipping a field that does nothing is worse than
 * shipping neither.
 *
 * What a lesson does instead is what steps 4 to 6 of the superposition lesson
 * do: split the circuit across steps so that the reader watches the same
 * change the scrubber would have shown them, one column at a time, with the
 * prose beside it. That is a weaker tool and a clearer one.
 */

export interface Lesson {
  /** The URL segment, the catalog prefix, and the progress key. One string. */
  readonly slug: string
  /** Qubits and clbits the lesson starts from, before its first patch. */
  readonly base: { readonly qubits: number; readonly clbits?: number }
  readonly steps: readonly LessonStep[]
  /**
   * A proper noun for lessons named after a person or a construction — Bell,
   * Grover, Deutsch–Jozsa — rendered through `Notation` and never translated
   * (D2), or `null` when the title is an ordinary word the catalogs carry
   * under `lessons:<slug>.title`. Exactly the rule `presets.ts` follows, and
   * for the same reason.
   */
  readonly properName: string | null
}

/** The catalog key for one of a lesson's own strings. */
export function lessonKey(slug: string, field: string): string {
  return `${slug}.${field}`
}

/** The catalog key for one of a step's strings. */
export function stepKey(slug: string, stepId: string, field: string): string {
  return `${slug}.steps.${stepId}.${field}`
}

/**
 * Every catalog key a lesson requires, in the order a translator meets them.
 *
 * The shape decides the list, which is what lets a test hold three catalogs to
 * a lesson rather than only to each other: a step with a `focus` owes a
 * `notice`, a build step owes a `hint`, and a step that has neither owes
 * neither. That is also the rule an author is following whether or not they
 * know it, so writing it down here means they cannot follow it wrongly.
 */
export function requiredKeys(lesson: Lesson): string[] {
  const keys = [
    lessonKey(lesson.slug, 'summary'),
    lessonKey(lesson.slug, 'goal'),
  ]
  // A lesson with a proper noun takes its title from `Notation`, so there is
  // nothing in the catalog to translate and nothing to keep in parity.
  if (lesson.properName === null) keys.push(lessonKey(lesson.slug, 'title'))

  for (const step of lesson.steps) {
    keys.push(stepKey(lesson.slug, step.id, 'title'))
    keys.push(stepKey(lesson.slug, step.id, 'body'))
    if (step.focus !== undefined) {
      keys.push(stepKey(lesson.slug, step.id, 'notice'))
    }
    if (step.objective.kind === 'build') {
      keys.push(stepKey(lesson.slug, step.id, 'task'))
      keys.push(stepKey(lesson.slug, step.id, 'hint'))
    }
  }
  return keys
}

/**
 * The circuits a lesson passes through, one per step, computed from the
 * lesson alone.
 *
 * `null` at a position means that step's patch does not apply to the step
 * before it — a bug in the lesson, which `lessons.test.ts` fails on rather
 * than leaving for a reader to find at step 4.
 */
export function stepCircuits(lesson: Lesson): readonly (Circuit | null)[] {
  return lesson.steps.map((_, index) => circuitAtStep(lesson, index))
}

/** The empty register a lesson's first patch is applied to. */
export function baseCircuitOf(lesson: Lesson): Circuit {
  return lessonBaseCircuit(lesson.base.qubits, lesson.base.clbits ?? 0)
}

/**
 * The lesson's own circuit at step `index`: the fold of every patch up to and
 * including it. See `patch.ts` for why folding from zero is always available.
 *
 * `null` means the lesson is broken at that step rather than that the reader
 * did something — the fold starts from the empty register and never sees the
 * document on screen.
 */
export function circuitAtStep(lesson: Lesson, index: number): Circuit | null {
  const patches: CircuitPatch[] = lesson.steps
    .slice(0, index + 1)
    .map((step) => step.patch)
  const result = foldPatches(baseCircuitOf(lesson), patches)
  return result.ok ? result.circuit : null
}
