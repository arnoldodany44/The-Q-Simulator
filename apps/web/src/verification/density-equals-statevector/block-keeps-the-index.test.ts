/**
 * INDEPENDENT VERIFICATION — D1 SURVIVES THE TRIP FROM ρ TO THE HEAT MAP.
 *
 * LENS: density-equals-statevector, carried past the engine boundary. The
 * engine half is checked in
 * `packages/qsim/src/verification/density-equals-statevector.test.ts`; this is
 * the other half of the same question, because ρ never reaches a reader whole.
 * The worker cuts a block out of it (`noiseJob.blockOf`), ships two flat
 * `Float64Array`s across a thread boundary, and the panel re-indexes them
 * (`densityMap.buildDensityMap`). Each of those three steps re-derives "which
 * number belongs at (row, column)" from scratch, and each of them is a place a
 * transpose can be introduced *after* the physics was right.
 *
 * WHY A TRANSPOSE IS THE THING TO HUNT. ρ is Hermitian, so ρᵀ = conj(ρ): a
 * transposed block has the same diagonal, the same magnitudes, the same peak,
 * the same Hermiticity and the same trace. Every population is right, the
 * histogram beside it is right, and the accessible table lists exactly the
 * same entries. The single thing that changes is the SIGN OF EVERY IMAGINARY
 * PART — which is the sign of every coherence, which is the only quantity the
 * heat map exists to show. Nothing but a hand-derived expectation catches it.
 *
 * SO THE ORACLE IS ARITHMETIC DONE HERE. The expected ρ is |ψ⟩⟨ψ| written out
 * from ρ_rc = ψ_r · conj(ψ_c) over the statevector the *ideal* run produced —
 * the path that survived the M0.x audit — and, for the one circuit this file
 * leans on hardest, from a closed form derived by hand in the comment above
 * the test. No expectation below is read back from the module under test.
 */

import { NOISE_PROFILES, formatKet, probabilities, run } from '@qsim/core'
import type { Statevector } from '@qsim/core'
import { parseCircuit } from '@qsim/schema'
import type { Circuit, CircuitInput } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { buildDensityMap } from '../../features/analysis/densityMap'
import { runNoiseJob } from '../../features/simulation/noiseJob'
import type {
  DensityBlock,
  NoiseSpec,
} from '../../features/simulation/protocol'

/** D6's tolerance. */
const TOLERANCE = 1e-10

function circuitOf(input: CircuitInput): Circuit {
  return parseCircuit(input)
}

function stateOf(circuit: Circuit): Statevector {
  const result = run(circuit)
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

/** The noiseless spec: `ideal` has no channels, so ρ must stay |ψ⟩⟨ψ|. */
function idealSpec(patch: Partial<NoiseSpec> = {}): NoiseSpec {
  return {
    profile: NOISE_PROFILES.ideal,
    readout: false,
    method: 'density',
    shots: 1000,
    seed: 1,
    ...patch,
  }
}

function blockOf(circuit: Circuit): DensityBlock {
  const payload = runNoiseJob(circuit, stateOf(circuit), idealSpec())
  if (!payload.ok) throw new Error(`refused: ${payload.refusal.detail}`)
  const block = payload.reading.density
  if (block === null) throw new Error('expected a density block')
  return block
}

/* ═════════════════════════════════════════════════════════════════════════ */

describe('the block keeps the row as the ket and the column as the bra', () => {
  /**
   * THE HAND-DERIVED CASE.
   *
   * H then S on qubit 0, then CNOT from qubit 0 to qubit 2, on three wires:
   *
   *   |000⟩ --H--> (|000⟩ + |001⟩)/√2      (D1: qubit 0 set is index 1)
   *         --S--> (|000⟩ + i|001⟩)/√2
   *        --CX--> (|000⟩ + i|101⟩)/√2     (qubits 0 and 2 set is index 5)
   *
   * so ψ₀ = 1/√2, ψ₅ = i/√2, and every other amplitude is 0. From the
   * definition ρ_rc = ψ_r · conj(ψ_c):
   *
   *   ρ₀₀ = ρ₅₅ = ½
   *   ρ₀₅ = (1/√2)·conj(i/√2) = −i/2      →  re 0, im −½
   *   ρ₅₀ = (i/√2)·conj(1/√2) = +i/2      →  re 0, im +½
   *
   * Two occupied states, so the block is 2 × 2 with `indices = [0, 5]` and
   * `labels = ['000', '101']` — the kets printed highest-qubit-first, which is
   * `conventions.ts`'s rule and Qiskit's. Every number in the assertions below
   * comes from those five lines and from nothing the app computed.
   */
  const circuit = circuitOf({
    schemaVersion: 1,
    qubits: 3,
    operations: [
      { id: 'h', gate: 'h', targets: [0], column: 0 },
      { id: 's', gate: 's', targets: [0], column: 1 },
      { id: 'cx', gate: 'x', targets: [2], controls: [0], column: 2 },
    ],
  })

  it('selects the two occupied basis states and labels them D1-wise', () => {
    const block = blockOf(circuit)
    expect([...block.indices]).toEqual([0, 5])
    expect([...block.labels]).toEqual(['000', '101'])
    expect(block.hidden).toBe(0)
    expect(block.hiddenPopulation).toBeLessThan(TOLERANCE)
  })

  it('carries the coherence with the sign the definition gives it', () => {
    const block = blockOf(circuit)
    const size = block.indices.length
    expect(size).toBe(2)

    // Populations — the half a transposed block would also report correctly.
    expect(block.re[0 * size + 0]).toBeCloseTo(0.5, 12)
    expect(block.re[1 * size + 1]).toBeCloseTo(0.5, 12)

    // The coherence — the half it would not. ρ₀₅ is −i/2 and ρ₅₀ is +i/2, so
    // the magnitude is a half and the discriminating quantity is nowhere near
    // the tolerance: this assertion has teeth.
    expect(block.re[0 * size + 1]).toBeCloseTo(0, 12)
    expect(block.im[0 * size + 1]).toBeCloseTo(-0.5, 12)
    expect(block.re[1 * size + 0]).toBeCloseTo(0, 12)
    expect(block.im[1 * size + 0]).toBeCloseTo(0.5, 12)
  })

  it('hands the map an entry whose two labels are the right way round', () => {
    const map = buildDensityMap(blockOf(circuit))
    const coherence = map.entries.find(
      (entry) => entry.rowLabel === '000' && entry.columnLabel === '101'
    )
    expect(coherence).toBeDefined()
    expect(coherence?.im).toBeCloseTo(-0.5, 12)
    expect(coherence?.diagonal).toBe(false)

    const mirrored = map.entries.find(
      (entry) => entry.rowLabel === '101' && entry.columnLabel === '000'
    )
    expect(mirrored?.im).toBeCloseTo(0.5, 12)

    // And the imaginary grid paints those two cells with opposite phases,
    // which is the picture the sign is supposed to produce.
    const cellAt = (row: number, column: number): number | undefined =>
      map.imaginary.find((cell) => cell.row === row && cell.column === column)
        ?.value
    expect(cellAt(0, 1)).toBeCloseTo(-0.5, 12)
    expect(cellAt(1, 0)).toBeCloseTo(0.5, 12)
  })
})

describe('the block equals |ψ⟩⟨ψ| of the ideal run, entry for entry', () => {
  /**
   * The same statement generalised, over circuits whose ρ is dense enough that
   * a mis-selection or a mis-index has somewhere to hide. Everything the block
   * kept must equal ψ_i · conj(ψ_j) for the two basis indices it named, and
   * the distribution must be the Born rule of the same statevector.
   */
  const circuits: { name: string; circuit: Circuit }[] = [
    {
      name: 'GHZ on 3 wires, phased',
      circuit: circuitOf({
        schemaVersion: 1,
        qubits: 3,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 'x', targets: [1], controls: [0], column: 1 },
          { id: 'c', gate: 'x', targets: [2], controls: [1], column: 2 },
          { id: 'd', gate: 't', targets: [2], column: 3 },
        ],
      }),
    },
    {
      name: 'four wires, every wire in superposition',
      circuit: circuitOf({
        schemaVersion: 1,
        qubits: 4,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 'h', targets: [1], column: 0 },
          { id: 'c', gate: 'h', targets: [2], column: 0 },
          { id: 'd', gate: 'h', targets: [3], column: 0 },
          { id: 'e', gate: 'p', targets: [2], params: [0.9], column: 1 },
          { id: 'f', gate: 'rz', targets: [0], params: [-1.7], column: 1 },
          { id: 'g', gate: 'z', targets: [3], controls: [1], column: 2 },
          { id: 'h2', gate: 'iswap', targets: [3, 0], column: 3 },
          { id: 'i', gate: 'sx', targets: [1], column: 4 },
        ],
      }),
    },
    {
      name: 'five wires, non-adjacent controls and a negative one',
      circuit: circuitOf({
        schemaVersion: 1,
        qubits: 5,
        operations: [
          { id: 'a', gate: 'h', targets: [0], column: 0 },
          { id: 'b', gate: 'h', targets: [4], column: 0 },
          { id: 'c', gate: 's', targets: [4], column: 1 },
          {
            id: 'd',
            gate: 'x',
            targets: [2],
            controls: [{ qubit: 4, state: 1 }],
            column: 2,
          },
          {
            id: 'e',
            gate: 'h',
            targets: [3],
            controls: [{ qubit: 0, state: 0 }],
            column: 3,
          },
          { id: 'f', gate: 'swap', targets: [3, 1], column: 4 },
          {
            id: 'g',
            gate: 'u',
            targets: [0],
            params: [0.6, 1.2, -0.8],
            column: 5,
          },
        ],
      }),
    },
  ]

  for (const { name, circuit } of circuits) {
    it(`${name}: every kept entry is ψ_i·conj(ψ_j)`, () => {
      const state = stateOf(circuit)
      const payload = runNoiseJob(circuit, state, idealSpec())
      expect(payload.ok).toBe(true)
      if (!payload.ok) return
      const block = payload.reading.density
      expect(block).not.toBeNull()
      if (block === null) return

      const size = block.indices.length
      /*
       * `?? 0` on every read below, and it is exact rather than defensive: each
       * index is inside an array whose length this loop is bounded by, so the
       * fallback is unreachable. It is what `noUncheckedIndexedAccess` asks an
       * indexed read to state, and it is the convention the rest of the tree
       * uses — see `noiseJob.blockOf`.
       */
      for (let row = 0; row < size; row++) {
        const i = block.indices[row] ?? 0
        for (let column = 0; column < size; column++) {
          const j = block.indices[column] ?? 0
          // ρ_ij = ψ_i · conj(ψ_j), written out rather than imported.
          const reI = state.re[i] ?? 0
          const imI = state.im[i] ?? 0
          const reJ = state.re[j] ?? 0
          const imJ = state.im[j] ?? 0
          const expectedRe = reI * reJ + imI * imJ
          const expectedIm = imI * reJ - reI * imJ
          expect(
            Math.abs((block.re[row * size + column] ?? 0) - expectedRe),
            `re at (${i}, ${j})`
          ).toBeLessThan(TOLERANCE)
          expect(
            Math.abs((block.im[row * size + column] ?? 0) - expectedIm),
            `im at (${i}, ${j})`
          ).toBeLessThan(TOLERANCE)
        }
        // The label is the ket of the index it was cut from — D1 again, and
        // the only thing tying a drawn row to a basis state.
        expect(block.labels[row]).toBe(formatKet(i, circuit.qubits))
      }

      // The distribution the panel draws is the ideal one, index for index,
      // and at zero noise both fidelities are exactly 1.
      const ideal = probabilities(state)
      const noisy = payload.reading.distribution
      expect(noisy).not.toBeNull()
      if (noisy === null) return
      for (let index = 0; index < ideal.length; index++) {
        expect(
          Math.abs((noisy[index] ?? 0) - (ideal[index] ?? 0)),
          `p(${index})`
        ).toBeLessThan(TOLERANCE)
      }
      expect(Math.abs(payload.reading.distributionFidelity - 1)).toBeLessThan(
        TOLERANCE
      )
      /*
       * Both are `number | null` on the wire, because the sampled method never
       * forms a ρ and therefore cannot answer either question. This ran the
       * density method, so null here is a defect and not a shape to tolerate —
       * asserted rather than defaulted away.
       */
      const { stateFidelity, purity } = payload.reading
      expect(
        stateFidelity,
        'the density method reports a state fidelity'
      ).not.toBeNull()
      expect(purity, 'the density method reports a purity').not.toBeNull()
      expect(Math.abs((stateFidelity ?? 0) - 1)).toBeLessThan(TOLERANCE)
      // ρ came from a statevector, so it is pure: Tr(ρ²) = 1 exactly.
      expect(Math.abs((purity ?? 0) - 1)).toBeLessThan(TOLERANCE)
    })
  }
})
