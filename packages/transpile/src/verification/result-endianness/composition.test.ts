/**
 * Independent verification of the whole path a measurement takes home.
 *
 * Nothing here consults the implementation's own reasoning. The oracle is a
 * dense statevector simulator written in this file, which reads the *emitted
 * OpenQASM 3 text* — physical qubit labels and all — and knows nothing about
 * layouts, decompositions or the transpiler's intentions. Three orders have to
 * agree for a hardware histogram to be right, and this file composes all three:
 *
 *   1. the program's physical qubits, chosen by placement;
 *   2. the classical register of the submitted program, which is what a device
 *      returns as a hexadecimal integer;
 *   3. decision D1's statevector index, which is what the chart draws.
 *
 * Every circuit used is asymmetric under a bit reversal on purpose. A Bell pair
 * is a fixed point of exactly the mistake being hunted.
 */

import { describe, expect, it } from 'vitest'
import { analyticMode, run } from '@qsim/core'
import {
  CIRCUIT_SCHEMA_VERSION,
  type Circuit,
  type Operation,
} from '@qsim/schema'

import { deviceGraph, type DeviceTarget } from '../../device.js'
import { transpile } from '../../transpile.js'
import { bitsOfSample, countsFromSamples } from '../../results.js'

/* ══════════════════════ the oracle: a slow simulator ═══════════════════ */

interface Amplitudes {
  readonly re: Float64Array
  readonly im: Float64Array
}

/** A parsed native-basis program over hardware qubits. */
interface Program {
  /** Physical qubits the program mentions, ascending. */
  readonly wires: readonly number[]
  /** `measures[clbit]` is the physical qubit written into it. */
  readonly measures: ReadonlyMap<number, number>
  /** Width of the declared classical register. */
  readonly clbits: number
  readonly registerName: string
  readonly amplitudes: Amplitudes
}

/**
 * Read and run an emitted program, with no knowledge of the transpiler.
 *
 * The only convention this function commits to is its own: amplitude index bit
 * `r` holds the physical qubit at rank `r` of `wires`. That is a private
 * numbering, translated back to physical qubits by `wires` before anything is
 * compared, so it cannot accidentally agree with the code under test.
 */
function runProgram(qasm: string): Program {
  const statements: string[] = []
  let clbits = 0
  let registerName = ''
  const wireSet = new Set<number>()
  const measures = new Map<number, number>()

  for (const raw of qasm.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('//')) continue
    if (line.startsWith('OPENQASM') || line.startsWith('include')) continue
    const declaration = /^bit\[(\d+)]\s+([A-Za-z_][A-Za-z0-9_]*)\s*;$/.exec(
      line
    )
    if (declaration !== null) {
      clbits = Number(declaration[1])
      registerName = declaration[2] as string
      continue
    }
    if (/^qubit\[/.test(line)) continue
    statements.push(line)
    for (const match of line.matchAll(/\$(\d+)/g)) {
      wireSet.add(Number(match[1]))
    }
  }

  const wires = [...wireSet].sort((a, b) => a - b)
  const rank = new Map(wires.map((wire, index) => [wire, index] as const))
  const size = 1 << wires.length
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  re[0] = 1

  const bit = (wire: string): number => {
    const position = rank.get(Number(wire.slice(1)))
    if (position === undefined) throw new Error(`unknown wire ${wire}`)
    return position
  }

  for (const line of statements) {
    const measure =
      /^([A-Za-z_][A-Za-z0-9_]*)\[(\d+)]\s*=\s*measure\s+(\$\d+)\s*;$/.exec(
        line
      )
    if (measure !== null) {
      if (measure[1] !== registerName) {
        throw new Error(`measurement into an undeclared register: ${line}`)
      }
      const clbit = Number(measure[2])
      const wire = Number((measure[3] as string).slice(1))
      if (measures.has(clbit)) {
        throw new Error(`classical bit ${clbit} written twice`)
      }
      measures.set(clbit, wire)
      continue
    }
    if (/^barrier\b/.test(line)) continue

    const two = /^cz\s+(\$\d+)\s*,\s*(\$\d+)\s*;$/.exec(line)
    if (two !== null) {
      applyCz(re, im, bit(two[1] as string), bit(two[2] as string))
      continue
    }
    const rotation = /^rz\(([^)]*)\)\s+(\$\d+)\s*;$/.exec(line)
    if (rotation !== null) {
      applyRz(
        re,
        im,
        bit(rotation[2] as string),
        angleOf(rotation[1] as string)
      )
      continue
    }
    const single = /^(sx|x|id)\s+(\$\d+)\s*;$/.exec(line)
    if (single !== null) {
      applySingle(re, im, bit(single[2] as string), single[1] as string)
      continue
    }
    throw new Error(`the oracle cannot read this statement: ${line}`)
  }

  return { wires, measures, clbits, registerName, amplitudes: { re, im } }
}

/**
 * An OpenQASM 3 angle as this project writes them: `pi`, `-pi/2`, `3*pi/4`, or
 * a decimal literal. Read independently of `@qsim/qasm`'s formatter, so that a
 * change in one is a failure here rather than a silent agreement.
 */
function angleOf(text: string): number {
  const trimmed = text.trim()
  const pi = /^(-)?(?:(\d+)\*)?pi(?:\/(\d+))?$/.exec(trimmed)
  if (pi !== null) {
    const sign = pi[1] === '-' ? -1 : 1
    const numerator = pi[2] === undefined ? 1 : Number(pi[2])
    const denominator = pi[3] === undefined ? 1 : Number(pi[3])
    return (sign * numerator * Math.PI) / denominator
  }
  const decimal = Number(trimmed)
  if (!Number.isFinite(decimal)) {
    throw new Error(`the oracle cannot read the angle "${text}"`)
  }
  return decimal
}

function applySingle(
  re: Float64Array,
  im: Float64Array,
  position: number,
  gate: string
): void {
  if (gate === 'id') return
  const stride = 1 << position
  const half = 0.5
  for (let index = 0; index < re.length; index++) {
    if ((index & stride) !== 0) continue
    const partner = index | stride
    const ar = re[index] as number
    const ai = im[index] as number
    const br = re[partner] as number
    const bi = im[partner] as number
    if (gate === 'x') {
      re[index] = br
      im[index] = bi
      re[partner] = ar
      im[partner] = ai
      continue
    }
    // sx = ½ [[1+i, 1−i], [1−i, 1+i]]
    re[index] = half * (ar - ai + br + bi)
    im[index] = half * (ar + ai - br + bi)
    re[partner] = half * (ar + ai + br - bi)
    im[partner] = half * (-ar + ai + br + bi)
  }
}

function applyRz(
  re: Float64Array,
  im: Float64Array,
  position: number,
  theta: number
): void {
  const stride = 1 << position
  const c0 = Math.cos(-theta / 2)
  const s0 = Math.sin(-theta / 2)
  const c1 = Math.cos(theta / 2)
  const s1 = Math.sin(theta / 2)
  for (let index = 0; index < re.length; index++) {
    const on = (index & stride) !== 0
    const c = on ? c1 : c0
    const s = on ? s1 : s0
    const ar = re[index] as number
    const ai = im[index] as number
    re[index] = ar * c - ai * s
    im[index] = ar * s + ai * c
  }
}

function applyCz(
  re: Float64Array,
  im: Float64Array,
  a: number,
  b: number
): void {
  const mask = (1 << a) | (1 << b)
  for (let index = 0; index < re.length; index++) {
    if ((index & mask) !== mask) continue
    re[index] = -(re[index] as number)
    im[index] = -(im[index] as number)
  }
}

/**
 * The one basis state a deterministic program ends in, as physical qubit
 * values. Refuses anything that is not deterministic, because a probabilistic
 * outcome would make the assertions below unfalsifiable.
 */
function certainOutcome(program: Program): ReadonlyMap<number, 0 | 1> {
  const { re, im } = program.amplitudes
  let chosen = -1
  for (let index = 0; index < re.length; index++) {
    const p = (re[index] as number) ** 2 + (im[index] as number) ** 2
    if (p > 1 - 1e-10) chosen = index
    else if (p > 1e-10) {
      throw new Error('the program does not end in a single basis state')
    }
  }
  if (chosen < 0) throw new Error('no basis state carries the probability')
  const values = new Map<number, 0 | 1>()
  for (const [position, wire] of program.wires.entries()) {
    values.set(wire, ((chosen >> position) & 1) as 0 | 1)
  }
  return values
}

/**
 * The hexadecimal sample a device would answer with, built from the program's
 * own measurements: bit `k` of the integer is classical bit `k`.
 */
function sampleOf(
  program: Program,
  values: ReadonlyMap<number, 0 | 1>
): string {
  let value = 0n
  for (const [clbit, wire] of program.measures) {
    if (values.get(wire) === 1) value |= 1n << BigInt(clbit)
  }
  return `0x${value.toString(16)}`
}

/* ═══════════════════════════ the fixtures ══════════════════════════════ */

/**
 * A device whose cheapest placement is a permutation, not the identity.
 *
 * The point of the error rates is to force `layout` to be non-monotonic: a
 * mapping that happened to be the identity would let every reversal in the
 * chain cancel out and the suite would prove nothing.
 */
function probeDevice(): DeviceTarget {
  const coupling = [
    { a: 0, b: 1, error: 5e-2 },
    { a: 1, b: 2, error: 5e-2 },
    { a: 2, b: 3, error: 5e-2 },
    { a: 3, b: 4, error: 5e-2 },
    { a: 4, b: 5, error: 5e-2 },
    { a: 5, b: 7, error: 1e-4 },
    { a: 6, b: 7, error: 5e-2 },
    { a: 6, b: 8, error: 5e-2 },
    { a: 3, b: 8, error: 5e-2 },
  ]
  const qubitProperties = Array.from({ length: 9 }, (_unused, qubit) => {
    if (qubit === 7) return { gateError: 1e-6, readoutError: 1e-4 }
    if (qubit === 5) return { gateError: 1e-5, readoutError: 1e-4 }
    if (qubit === 3) return { gateError: 1e-4, readoutError: 5e-4 }
    return { gateError: 1e-3, readoutError: 1e-2 }
  })
  return {
    name: 'probe_lattice',
    qubits: 9,
    basisGates: ['cz', 'id', 'rx', 'rz', 'rzz', 'sx', 'x'],
    coupling,
    qubitProperties,
    calibratedAt: '2026-08-15T00:00:00Z',
  }
}

/**
 * `x` on qubit 0 and a CNOT from 0 to 2, with the classical register crossed
 * on purpose: `c[0]` holds qubit 2 and `c[2]` holds qubit 0.
 *
 * Ideal outcome: qubits 0 and 2 are 1, qubit 1 is 0 — statevector index 5,
 * `formatKet` label "101". Reverse any one of the three orders and the answer
 * moves, which is the whole point.
 */
function crossedCircuit(): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 3,
    clbits: 3,
    operations: [
      { id: 'x0', gate: 'x', targets: [0], column: 0 },
      { id: 'cx', gate: 'cx', targets: [2], controls: [0], column: 1 },
      {
        id: 'm0',
        gate: 'measure',
        targets: [0],
        clbitTargets: [2],
        column: 2,
      },
      {
        id: 'm1',
        gate: 'measure',
        targets: [1],
        clbitTargets: [1],
        column: 2,
      },
      {
        id: 'm2',
        gate: 'measure',
        targets: [2],
        clbitTargets: [0],
        column: 2,
      },
    ],
  }
}

/** The same shape with the register in the document's natural order. */
function straightCircuit(): Circuit {
  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 3,
    clbits: 3,
    operations: [
      { id: 'x0', gate: 'x', targets: [0], column: 0 },
      { id: 'cx', gate: 'cx', targets: [2], controls: [0], column: 1 },
      { id: 'm0', gate: 'measure', targets: [0], clbitTargets: [0], column: 2 },
      { id: 'm1', gate: 'measure', targets: [1], clbitTargets: [1], column: 2 },
      { id: 'm2', gate: 'measure', targets: [2], clbitTargets: [2], column: 2 },
    ],
  }
}

/**
 * A circuit from a gate list and a register wiring.
 *
 * `wiring[clbit]` is the qubit that classical bit holds, which is the inverse
 * of the way a document is usually read and is deliberate: it is the direction
 * a *result* is read in, and writing the fixtures the other way round would
 * make the expected keys a translation of the same mistake being tested.
 */
function buildCircuit(
  gates: readonly (readonly (string | number)[])[],
  wiring: readonly number[]
): Circuit {
  const operations: Operation[] = gates.map((gate, index) => {
    const name = gate[0] as string
    if (name === 'x') {
      return {
        id: `g${String(index)}`,
        gate: 'x',
        targets: [gate[1] as number],
        column: index,
      }
    }
    if (name === 'cx') {
      return {
        id: `g${String(index)}`,
        gate: 'cx',
        targets: [gate[2] as number],
        controls: [gate[1] as number],
        column: index,
      }
    }
    if (name === 'swap') {
      return {
        id: `g${String(index)}`,
        gate: 'swap',
        targets: [gate[1] as number, gate[2] as number],
        column: index,
      }
    }
    throw new Error(`the fixture builder does not know "${name}"`)
  })

  const column = gates.length
  for (const [clbit, qubit] of wiring.entries()) {
    operations.push({
      id: `m${String(clbit)}`,
      gate: 'measure',
      targets: [qubit],
      clbitTargets: [clbit],
      column,
    })
  }

  return {
    schemaVersion: CIRCUIT_SCHEMA_VERSION,
    qubits: 3,
    clbits: wiring.length,
    operations,
  }
}

/** The one basis state the source document ends in, per `@qsim/core`. */
function idealIndex(circuit: Circuit): number {
  const result = run(
    {
      ...circuit,
      operations: circuit.operations.filter(
        (operation) => operation.gate !== 'measure'
      ),
    },
    analyticMode()
  )
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  const { state } = result
  let chosen = -1
  for (let index = 0; index < state.size; index++) {
    const p = (state.re[index] ?? 0) ** 2 + (state.im[index] ?? 0) ** 2
    if (p > 1 - 1e-10) chosen = index
    else if (p > 1e-10) throw new Error('the fixture is not deterministic')
  }
  if (chosen < 0) throw new Error('no basis state carries the probability')
  return chosen
}

/* ═══════════════════════════════ the checks ════════════════════════════ */

describe('the emitted program says what the document said', () => {
  it('places the circuit on a permutation, so the checks below can fail', () => {
    const plan = transpile(straightCircuit(), deviceGraph(probeDevice()))
    expect(plan.layout).toHaveLength(3)
    expect(new Set(plan.layout).size).toBe(3)
    // Non-identity and non-monotonic: `physicalQubits` is sorted, so a layout
    // that were already ascending would hide a sort-order mistake completely.
    const ascending = plan.layout.every(
      (wire, index) => index === 0 || wire > (plan.layout[index - 1] as number)
    )
    expect(ascending).toBe(false)
  })

  it('writes every measurement into the classical bit the document named', () => {
    for (const circuit of [straightCircuit(), crossedCircuit()]) {
      const plan = transpile(circuit, deviceGraph(probeDevice()))
      const program = runProgram(plan.qasm)
      expect(program.clbits).toBe(circuit.clbits)

      for (const operation of circuit.operations) {
        if (operation.gate !== 'measure') continue
        const clbit = operation.clbitTargets?.[0] as number
        const logical = operation.targets[0] as number
        // The composition under test: the document's clbit must hold the
        // physical qubit the document's logical qubit was placed on.
        expect(program.measures.get(clbit)).toBe(plan.layout[logical])
      }
    }
  })
})

describe('a returned sample becomes the outcome the circuit describes', () => {
  it('carries an X on qubit 0 through to the label "101"', () => {
    const circuit = straightCircuit()
    const plan = transpile(circuit, deviceGraph(probeDevice()))
    const program = runProgram(plan.qasm)
    const sample = sampleOf(program, certainOutcome(program))

    // Hand-derived: c[0]=q0=1, c[1]=q1=0, c[2]=q2=1 → 0b101 = 0x5.
    expect(sample).toBe('0x5')
    expect(countsFromSamples([sample, sample], program.clbits)).toEqual({
      '101': 2,
    })
  })

  it('carries the same circuit through a crossed register unchanged', () => {
    const circuit = crossedCircuit()
    const plan = transpile(circuit, deviceGraph(probeDevice()))
    const program = runProgram(plan.qasm)
    const sample = sampleOf(program, certainOutcome(program))

    // c[0]=q2=1, c[1]=q1=0, c[2]=q0=1 → still 0b101 for this state, which is
    // why the *next* case uses an outcome the crossing actually moves.
    expect(sample).toBe('0x5')
    expect(countsFromSamples([sample], program.clbits)).toEqual({ '101': 1 })
  })

  it('moves the label when only one qubit is set and the register is crossed', () => {
    // x on qubit 0 alone: qubit 0 is 1, qubits 1 and 2 are 0.
    const circuit: Circuit = {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: 3,
      clbits: 3,
      operations: [
        { id: 'x0', gate: 'x', targets: [0], column: 0 },
        // A cz keeps the placement search honest without changing the state:
        // qubit 1 is |0>, so cz(0,1) is the identity on this input.
        { id: 'cz', gate: 'cz', targets: [1], controls: [0], column: 1 },
        {
          id: 'm0',
          gate: 'measure',
          targets: [0],
          clbitTargets: [2],
          column: 2,
        },
        {
          id: 'm1',
          gate: 'measure',
          targets: [1],
          clbitTargets: [1],
          column: 2,
        },
        {
          id: 'm2',
          gate: 'measure',
          targets: [2],
          clbitTargets: [0],
          column: 2,
        },
      ],
    }
    const plan = transpile(circuit, deviceGraph(probeDevice()))
    const program = runProgram(plan.qasm)
    const sample = sampleOf(program, certainOutcome(program))

    // c[2] holds qubit 0, which is the only set bit → 0b100 = 0x4.
    expect(sample).toBe('0x4')
    expect(countsFromSamples([sample], 3)).toEqual({ '100': 1 })
    // And with the straight register the same state answers 0x1 / "001",
    // which is the asymmetry a Bell pair cannot show.
    expect(countsFromSamples(['0x1'], 3)).toEqual({ '001': 1 })
  })
})

describe('the whole composition, against an independent simulation', () => {
  /**
   * Deterministic circuits, each asymmetric under a bit reversal, each with
   * its classical register wired somewhere other than straight through.
   *
   * The expected outcome is written as the statevector index D1 defines — bit
   * `q` is qubit `q` — and computed a second time by `@qsim/core` from the
   * source document, so a wrong hand entry fails rather than being believed.
   */
  const sweep = [
    { name: 'x on the lowest wire only', gates: [['x', 0]], index: 1 },
    { name: 'x on the highest wire only', gates: [['x', 2]], index: 4 },
    {
      name: 'a CNOT chain that lights every wire',
      gates: [
        ['x', 0],
        ['cx', 0, 1],
        ['cx', 1, 2],
      ],
      index: 7,
    },
    {
      name: 'a CNOT that skips the middle wire',
      gates: [
        ['x', 0],
        ['cx', 0, 2],
      ],
      index: 5,
    },
    {
      name: 'a CNOT undone on its target',
      gates: [
        ['x', 0],
        ['cx', 0, 1],
        ['x', 1],
      ],
      index: 1,
    },
    {
      name: 'a swap that moves a one across the register',
      gates: [
        ['x', 0],
        ['swap', 0, 2],
      ],
      index: 4,
    },
  ] as const

  /** `c[k]` holds qubit `wiring[k]`; deliberately not the identity. */
  const wirings = [
    [0, 1, 2],
    [2, 1, 0],
    [1, 2, 0],
  ] as const

  for (const entry of sweep) {
    for (const wiring of wirings) {
      it(`${entry.name}, register ${wiring.join('')}`, () => {
        const circuit = buildCircuit(entry.gates, wiring)

        // The expected answer, twice: by hand and by the engine.
        expect(idealIndex(circuit)).toBe(entry.index)

        const plan = transpile(circuit, deviceGraph(probeDevice()))
        const program = runProgram(plan.qasm)
        const values = certainOutcome(program)

        /*
         * ORDERS ONE AND THREE. The physical qubit each logical one was placed
         * on must carry bit `logical` of the ideal statevector index — that is
         * the placement composed with D1, and nothing in `runProgram` knows
         * either of them.
         */
        for (let logical = 0; logical < circuit.qubits; logical++) {
          const physical = plan.layout[logical] as number
          expect(values.get(physical)).toBe((entry.index >> logical) & 1)
        }

        /*
         * ORDER TWO. The sample the device would send, folded by the one
         * function that folds them, must be the register the document asked
         * for: bit `k` of the key (counting from the right) is qubit
         * `wiring[k]`.
         */
        const label = Object.keys(
          countsFromSamples([sampleOf(program, values)], circuit.clbits)
        )[0] as string
        let expected = ''
        for (let clbit = circuit.clbits - 1; clbit >= 0; clbit--) {
          expected += String((entry.index >> (wiring[clbit] as number)) & 1)
        }
        expect(label).toBe(expected)
      })
    }
  }
})

describe('hexadecimal widths where a leading zero decides the answer', () => {
  it('pads to the declared register width and not to the value width', () => {
    expect(bitsOfSample('0x1', 5)).toBe('00001')
    expect(bitsOfSample('0x10', 5)).toBe('10000')
    expect(bitsOfSample('0x0', 8)).toBe('00000000')
    expect(bitsOfSample('0xff', 8)).toBe('11111111')
    expect(bitsOfSample('0x1', 64)).toBe(`${'0'.repeat(63)}1`)
  })

  it('reads a 60-bit register exactly, which a double cannot', () => {
    // 2^59 + 1: a Number would round the low bit away.
    const sample = `0x${((1n << 59n) + 1n).toString(16)}`
    const label = bitsOfSample(sample, 60)
    expect(label).toHaveLength(60)
    expect(label[0]).toBe('1')
    expect(label[59]).toBe('1')
    expect(label.slice(1, 59)).toBe('0'.repeat(58))
  })

  it('refuses a sample the declared width cannot hold', () => {
    expect(() => bitsOfSample('0x4', 2)).toThrow()
    expect(() => bitsOfSample('0b101', 3)).toThrow()
  })
})

/* ═════════════════ the one thing only a device can settle ══════════════ */

/**
 * A real answer from `ibm_marrakesh`, recorded so that no one has to buy it
 * twice.
 *
 * Everything above proves the pipeline is self-consistent. It cannot prove the
 * *provider's* half — that bit `k` of the hexadecimal integer is classical bit
 * `k` — because that is a fact about somebody else's serialiser, and the Open
 * Plan grants ten minutes of QPU time per twenty-eight days.
 *
 * So this is the recorded answer of a job that had already run: provider job
 * `da16cgu3kjvs7386btng`, 100 shots, read back for nothing. The program below
 * is its `params.pubs[0][0]` verbatim and the tally below is its
 * `results[0].data.c.samples`, folded.
 *
 * ── WHY IT SETTLES THE QUESTION ──────────────────────────────────────────
 *
 * The oracle above runs the program and finds it deterministic: `$154` ends at
 * 1 and `$155` at 0. The program measures `$154` into `c[0]` and `$155` into
 * `c[1]`, so under "bit k is c[k]" the answer is `0x1` — and 92 of 100 shots
 * are `0x1`, the rest `0x3`, which is one qubit's readout error and no more.
 * Under the reversed reading `0x1` would mean `$155 = 1, $154 = 0`, which is
 * *both* qubits reporting the opposite of the state they were prepared in, 92
 * times out of 100, on a chip whose measured error is near one percent. The
 * two readings are not close.
 *
 * ── AND WHY IT PROVES NOTHING ABOUT TODAY'S DECOMPOSITION ────────────────
 *
 * This program is **not** what the current tree emits for the circuit it was
 * evidently meant to be. Its second Euler triple is `rz(-pi/2) sx rz(pi/2)`,
 * which multiplies out to Ry(pi/2) and not to H, so the pair is not a CNOT: an
 * `x` on the control leaves the target at 0, which is exactly what the device
 * reported. The current emitter writes `rz(pi/2) sx rz(pi/2)` on both sides and
 * `runProgram` above confirms it produces a genuine CNOT. The fixture is
 * therefore evidence about the *sample encoding* and about nothing else, which
 * is the only thing it is used for here.
 */
const RECORDED_PROGRAM = `OPENQASM 3.0;
include "stdgates.inc";

// Generated by The Q Simulator - endianness probe - transpiled for
// ibm_marrakesh.
// Layout: qubit 0 -> $154, qubit 1 -> $155.

bit[2] c;

x $154;
rz(pi/2) $155;
sx $155;
rz(pi/2) $155;
cz $154, $155;
rz(-pi/2) $155;
c[0] = measure $154;
sx $155;
rz(pi/2) $155;
c[1] = measure $155;
`

/** `results[0].data.c.samples` of that job, folded. 100 shots, num_bits 2. */
const RECORDED_TALLY: Readonly<Record<string, number>> = {
  '0x1': 92,
  '0x3': 8,
}

describe('a device that has already answered', () => {
  it('agrees with the oracle about what its own program does', () => {
    const program = runProgram(RECORDED_PROGRAM)
    expect(program.clbits).toBe(2)
    expect(program.registerName).toBe('c')
    expect(program.measures.get(0)).toBe(154)
    expect(program.measures.get(1)).toBe(155)

    const values = certainOutcome(program)
    expect(values.get(154)).toBe(1)
    expect(values.get(155)).toBe(0)
    expect(sampleOf(program, values)).toBe('0x1')

    // 92 % of the shots are that sample, and the remainder is `0x3` — one bit
    // of readout error on `$155`. Under a reversed reading the majority sample
    // would have to be `0x2`.
    const majority = Object.entries(RECORDED_TALLY).sort(
      (left, right) => right[1] - left[1]
    )[0] as [string, number]
    expect(majority[0]).toBe('0x1')
    expect(majority[1] / 100).toBeGreaterThan(0.9)
  })

  it('folds into the label the chart draws', () => {
    const samples = Object.entries(RECORDED_TALLY).flatMap(([sample, count]) =>
      Array.from({ length: count }, () => sample)
    )
    // "01": highest classical bit first, so c[1] = 0 and c[0] = 1 — the qubit
    // the program applied `x` to is the one that reads 1.
    expect(countsFromSamples(samples, 2)).toEqual({ '01': 92, '11': 8 })
  })
})
