import { emptyCircuit } from '@qsim/schema'
import type { Circuit, Operation } from '@qsim/schema'
import { cleanup, render, screen, within } from '@testing-library/react'
import { createInstance, type i18n as I18n } from 'i18next'
import { I18nextProvider, initReactI18next } from 'react-i18next'
import { afterEach, describe, expect, it } from 'vitest'

import enCircuits from '../../i18n/locales/en/circuits.json'
import { CircuitDiffView } from './CircuitDiffView'

/**
 * The drawing and the words about it.
 *
 * `circuitDiff.test.ts` already proves what the comparison decides; what is
 * under test here is the half that decision reaches a reader through — and
 * above all the §10 rule that the four states are told apart by SHAPE, not by
 * hue. The assertion for that is deliberately about the geometry: four
 * distinct silhouettes in the `d` attribute, which is the thing that survives
 * a monochrome screen. A test that asserted four class names would pass just
 * as happily on four shades of the same circle.
 */

afterEach(cleanup)

function i18nFor(): I18n {
  const instance = createInstance()
  void instance.use(initReactI18next).init({
    lng: 'en',
    fallbackLng: false,
    ns: ['circuits'],
    defaultNS: 'circuits',
    resources: { en: { circuits: enCircuits } },
    interpolation: { escapeValue: false },
    react: { useSuspense: false },
  })
  return instance
}

function circuitOf(qubits: number, operations: readonly Operation[]): Circuit {
  return { ...emptyCircuit(qubits, qubits), operations: [...operations] }
}

function gate(
  id: string,
  name: string,
  targets: readonly number[],
  column: number,
  extra: Partial<Operation> = {}
): Operation {
  return { id, gate: name, targets: [...targets], column, ...extra }
}

function mount(before: Circuit, after: Circuit, from = 1, to = 2) {
  return render(
    <I18nextProvider i18n={i18nFor()}>
      <CircuitDiffView before={before} after={after} from={from} to={to} />
    </I18nextProvider>
  )
}

/** Every `d` on a mark badge, which is where the silhouettes live. */
function badgeShapes(container: HTMLElement): string[] {
  return [...container.querySelectorAll('.circuit-diff__badge-shape')].map(
    (node) => node.getAttribute('d') ?? ''
  )
}

describe('the picture and the list say the same thing', () => {
  it('names the two versions it is comparing', () => {
    mount(circuitOf(2, []), circuitOf(2, [gate('op_1', 'h', [0], 0)]), 3, 7)
    expect(
      screen.getByRole('heading', { name: /version 3 and version 7/u })
    ).toBeDefined()
  })

  it('lists one line per change, with the gate symbol as notation', () => {
    const { container } = mount(
      circuitOf(2, [gate('op_1', 'h', [0], 0)]),
      circuitOf(2, [
        gate('op_1', 'h', [0], 0),
        gate('op_2', 'cx', [1], 1, { controls: [0] }),
      ])
    )

    const changes = container.querySelectorAll('.circuit-diff__change')
    expect(changes).toHaveLength(1)
    const line = changes[0] as HTMLElement
    // The symbol goes through `Notation`, which marks it `translate="no"` —
    // that is what keeps a gate name out of the middle of a catalog string.
    expect(within(line).getByText('CNOT').getAttribute('translate')).toBe('no')
    expect(line.textContent).toContain('added on q0 and q1, moment 1')
  })

  it('says nothing changed when the two versions agree', () => {
    const same = circuitOf(2, [gate('op_1', 'h', [0], 0)])
    const { container } = mount(same, same)

    expect(screen.getByText(enCircuits.diff.identical)).toBeDefined()
    expect(container.querySelectorAll('.circuit-diff__change')).toHaveLength(0)
    expect(badgeShapes(container)).toEqual([])
  })

  it('reports a register change even when no operation moved', () => {
    const before = circuitOf(2, [gate('op_1', 'h', [0], 0)])
    const after = circuitOf(3, [gate('op_1', 'h', [0], 0)])
    mount(before, after)

    expect(screen.getByText(/from 2 to 3 qubits/u)).toBeDefined()
    // Not "identical", and not silent either: the summary says the operations
    // are the ones that did not change.
    expect(screen.getByText(enCircuits.diff.registersOnly)).toBeDefined()
  })
})

describe('the four states are distinguishable without colour', () => {
  /*
   * §10, applied to the case it was written for. Roughly one man in twelve
   * cannot separate the green from the red, and "what did this save change"
   * is precisely a question answered at a glance. So every kind carries a
   * silhouette of its own, and this is the test that keeps it that way.
   */
  it('draws a different silhouette for added, removed, moved and changed', () => {
    const before = circuitOf(3, [
      gate('op_1', 'h', [0], 0),
      gate('op_2', 'x', [1], 0),
      gate('op_3', 'rz', [2], 0, { params: [0] }),
    ])
    const after = circuitOf(3, [
      // op_1 removed, op_2 moved a column, op_3 retuned, op_4 added.
      gate('op_2', 'x', [1], 2),
      gate('op_3', 'rz', [2], 0, { params: [1] }),
      gate('op_4', 'y', [0], 3),
    ])

    const { container } = mount(before, after)

    const shapes = new Set(badgeShapes(container))
    // Each kind appears in both the tally and the change list, so the count
    // of *distinct* paths is what matters, not the count of paths.
    expect(shapes.size).toBe(4)
    for (const shape of shapes) expect(shape.length).toBeGreaterThan(0)
  })

  it('gives each kind its own dash pattern on the outlined cells', () => {
    const before = circuitOf(2, [gate('op_1', 'h', [0], 0)])
    const after = circuitOf(2, [gate('op_2', 'x', [1], 1)])
    const { container } = mount(before, after)

    // A removal and an addition, and the two outlines are not the same line.
    const added = container.querySelector(
      '.circuit-diff__mark--added .circuit-diff__cell'
    )
    const removed = container.querySelector(
      '.circuit-diff__mark--removed .circuit-diff__cell'
    )
    expect(added).not.toBeNull()
    expect(removed).not.toBeNull()
  })

  it('draws an arrow from where a moved gate was to where it is', () => {
    const before = circuitOf(2, [gate('op_1', 'h', [0], 0)])
    const after = circuitOf(2, [gate('op_1', 'h', [0], 4)])
    const { container } = mount(before, after)

    const arrow = container.querySelector('.circuit-diff__arrow line')
    expect(arrow).not.toBeNull()
    // Geometry, not hue: the head is further right than the tail because the
    // gate moved four columns to the right.
    const x1 = Number(arrow?.getAttribute('x1'))
    const x2 = Number(arrow?.getAttribute('x2'))
    expect(x2).toBeGreaterThan(x1)
  })
})

describe('the accessible account', () => {
  it('hides the drawing from a screen reader and describes it in words', () => {
    const { container } = mount(
      circuitOf(2, [gate('op_1', 'h', [0], 0)]),
      circuitOf(2, [gate('op_1', 'h', [1], 0)])
    )

    // The same arrangement `CircuitCanvas` makes: pixels for people who look,
    // sentences for people who listen.
    const plot = container.querySelector('.circuit-diff__plot')
    expect(plot?.getAttribute('aria-hidden')).toBe('true')

    const line = container.querySelector('.circuit-diff__change')
    expect(line?.textContent).toContain('moved from q0, moment 0, to q1')
  })

  it('spells out what changed about a gate that stayed put', () => {
    const { container } = mount(
      circuitOf(1, [gate('op_1', 'rz', [0], 0, { params: [0] })]),
      circuitOf(1, [gate('op_1', 'rz', [0], 0, { params: [1] })])
    )

    const line = container.querySelector('.circuit-diff__change')
    expect(line?.textContent).toContain('changed on q0, moment 0')
    expect(line?.textContent).toContain('different angles')
  })

  it('does not repeat the position in a moved gate’s detail', () => {
    // "moved from … to …" already said where it went; listing "a different
    // moment" beside it is the same fact twice in worse words.
    const { container } = mount(
      circuitOf(2, [gate('op_1', 'rz', [0], 0, { params: [0] })]),
      circuitOf(2, [gate('op_1', 'rz', [0], 3, { params: [1] })])
    )

    const line = container.querySelector('.circuit-diff__change')
    expect(line?.textContent).toContain('different angles')
    expect(line?.textContent).not.toContain('a different moment')
  })

  it('uses the wire names the circuit was saved with', () => {
    const before = circuitOf(2, [gate('op_1', 'h', [0], 0)])
    const after: Circuit = {
      ...circuitOf(2, [gate('op_1', 'h', [0], 0), gate('op_2', 'x', [1], 0)]),
      qubitLabels: ['control', 'ancilla'],
    }

    const { container } = mount(before, after)
    const text = container.textContent ?? ''
    expect(text).toContain('added on ancilla, moment 0')
  })
})

describe('a move whose origin and destination overlap', () => {
  it('draws one outline per cell, with keys React does not complain about', () => {
    /*
     * A CNOT on q0/q1 that becomes a CNOT on q1/q2 — which is what inserting a
     * qubit above it produces. Origin and destination are the same operation
     * object with the same id, so a rect per operation per cell put two
     * identical elements on the shared q1 cell: a doubled stroke, and
     * "Encountered two children with the same key" in the console on an
     * ordinary interaction.
     */
    const errors: unknown[][] = []
    const original = console.error
    console.error = (...args: unknown[]) => {
      errors.push(args)
    }

    try {
      const { container } = mount(
        circuitOf(3, [gate('b', 'cx', [1], 1, { controls: [0] })]),
        circuitOf(3, [gate('b', 'cx', [2], 1, { controls: [1] })])
      )

      const cells = [...container.querySelectorAll('.circuit-diff__cell')]
      const places = cells.map(
        (node) => `${node.getAttribute('x')}-${node.getAttribute('y')}`
      )
      expect(new Set(places).size).toBe(places.length)
      // Origin q0/q1 and destination q1/q2 share q1: three distinct cells.
      expect(places).toHaveLength(3)
    } finally {
      console.error = original
    }

    expect(
      errors.filter((args) => String(args[0]).includes('same key'))
    ).toEqual([])
  })
})

describe('the parts of a document the diagram cannot draw', () => {
  it('says a parameter was retuned rather than calling the versions equal', () => {
    const rz = gate('a', 'rz', [0], 0, { params: ['theta'] })
    const before: Circuit = {
      ...circuitOf(1, [rz]),
      parameters: [{ name: 'theta', value: 0 }],
    }
    const after: Circuit = {
      ...circuitOf(1, [rz]),
      parameters: [{ name: 'theta', value: Math.PI }],
    }

    const { container } = mount(before, after)
    const text = container.textContent ?? ''
    expect(text).toContain(enCircuits.diff.document.parameters)
    expect(text).not.toContain(enCircuits.diff.identical)
  })
})

describe('numbers reach the reader through Intl', () => {
  it('groups the version numbers in the heading', () => {
    // §10, and consistency with the history list beside this, which already
    // formatted the same magnitudes.
    mount(circuitOf(2, []), circuitOf(2, []), 4320, 4321)
    const heading = screen.getByRole('heading')
    expect(heading.textContent).toContain(
      new Intl.NumberFormat('en').format(4321)
    )
  })
})
