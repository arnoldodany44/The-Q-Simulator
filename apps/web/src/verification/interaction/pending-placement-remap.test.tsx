/**
 * Adversarial verification — the wire transforms a pending placement is
 * subjected to, exercised one at a time on the hook that owns them.
 *
 * The sibling file drives the editor's own controls; this one reaches the
 * commands the gutter does not expose yet (`reorderQubits`) and the shapes a
 * pointer would take several seconds to build (a Toffoli half-placed across
 * three wires). Both are needed: a rule implemented in the hook and never
 * reached by a control is as broken as one that was never written, and a rule
 * reached by every control but wrong on three picks is worse.
 */

import { MAX_QUBITS, type Circuit } from '@qsim/schema'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useKeyboardGrid } from '../../features/circuit-editor/useKeyboardGrid'
import {
  createCircuitStore,
  type CircuitStore,
} from '../../features/circuit-editor/useCircuitStore'

afterEach(cleanup)

const NAMES = ['alice', 'bob', 'carol', 'dave'] as const

function named(names: readonly string[] = NAMES): Circuit {
  return {
    schemaVersion: 1,
    qubits: names.length,
    clbits: names.length,
    qubitLabels: [...names],
    operations: [],
  }
}

function grid(circuit: Circuit) {
  const store = createCircuitStore(circuit)
  const { result } = renderHook(() =>
    useKeyboardGrid({ store, columns: 6, readOnly: false })
  )
  return { store, grid: result }
}

/** The wires a pending placement currently holds, named. */
function claimed(store: CircuitStore, picks: readonly number[]): string[] {
  const labels = store.getState().circuit.qubitLabels ?? []
  return picks.map((qubit) => labels[qubit] ?? `#${qubit}`)
}

describe('the wire transforms applied to a pending placement', () => {
  it('carries three picks through an insertion between them', () => {
    const { store, grid: view } = grid(named())

    act(() => {
      view.current.arm('ccx') // one target, two controls
    })
    act(() => {
      view.current.activate({ qubit: 0, column: 0 })
    })
    act(() => {
      view.current.activate({ qubit: 2, column: 0 })
    })
    expect(claimed(store, view.current.pending?.picks ?? [])).toEqual([
      'alice',
      'carol',
    ])

    act(() => {
      view.current.addQubit(1) // between the two picks
    })

    expect(claimed(store, view.current.pending?.picks ?? [])).toEqual([
      'alice',
      'carol',
    ])
  })

  it('leaves the picks alone when the new wire goes below them', () => {
    const { store, grid: view } = grid(named())

    act(() => {
      view.current.arm('cx')
    })
    act(() => {
      view.current.activate({ qubit: 1, column: 0 })
    })
    act(() => {
      view.current.addQubit(3)
    })

    expect(claimed(store, view.current.pending?.picks ?? [])).toEqual(['bob'])
  })

  it('cancels when a wire holding a later pick — not the anchor — is deleted', () => {
    const { grid: view } = grid(named())

    act(() => {
      view.current.arm('ccx')
    })
    act(() => {
      view.current.activate({ qubit: 0, column: 0 }) // target: alice
    })
    act(() => {
      view.current.activate({ qubit: 3, column: 0 }) // first control: dave
    })
    act(() => {
      view.current.removeQubit(3)
    })

    expect(view.current.pending).toBeNull()
    expect(view.current.announcement?.message).toEqual({
      kind: 'refused',
      code: 'cancelled-by-register-edit',
    })
  })

  it('follows the wires through a reorder', () => {
    const { store, grid: view } = grid(named())

    act(() => {
      view.current.arm('ccx')
    })
    act(() => {
      view.current.activate({ qubit: 1, column: 0 }) // bob
    })
    act(() => {
      view.current.activate({ qubit: 3, column: 0 }) // dave
    })
    act(() => {
      // dave, carol, bob, alice
      view.current.reorderQubits([3, 2, 1, 0])
    })

    expect(store.getState().circuit.qubitLabels).toEqual([
      'dave',
      'carol',
      'bob',
      'alice',
    ])
    expect(claimed(store, view.current.pending?.picks ?? [])).toEqual([
      'bob',
      'dave',
    ])
  })

  it('does not renumber the picks when the register edit is refused', () => {
    const full = Array.from({ length: MAX_QUBITS }, (_, index) => `w${index}`)
    const { store, grid: view } = grid(named(full))

    act(() => {
      view.current.arm('cx')
    })
    act(() => {
      view.current.activate({ qubit: 2, column: 0 })
    })
    act(() => {
      view.current.addQubit(0) // refused: the register is at its ceiling
    })

    expect(store.getState().circuit.qubits).toBe(MAX_QUBITS)
    expect(claimed(store, view.current.pending?.picks ?? [])).toEqual(['w2'])
  })

  it('completes onto the wires it was pointed at after a reorder', () => {
    const { store, grid: view } = grid(named())

    act(() => {
      view.current.arm('cx')
    })
    act(() => {
      view.current.activate({ qubit: 0, column: 0 }) // target: alice
    })
    act(() => {
      view.current.reorderQubits([1, 2, 3, 0]) // alice goes to the bottom
    })
    act(() => {
      view.current.activate({ qubit: 0, column: 0 }) // control: bob
    })

    const circuit = store.getState().circuit
    const labels = circuit.qubitLabels ?? []
    const operation = circuit.operations[0]
    expect(operation?.targets.map((qubit) => labels[qubit])).toEqual(['alice'])
    expect(
      (operation?.controls ?? []).map(
        (control) =>
          labels[typeof control === 'number' ? control : control.qubit]
      )
    ).toEqual(['bob'])
  })
})
