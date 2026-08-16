/*
 * What a custom gate MEANS, checked against an independent implementation of
 * that meaning — §3.1's five decisions on subcircuits, verified rather than
 * asserted.
 *
 * `expandCircuit` is the only thing between a document that uses a block and
 * the engine, and its two jobs — renaming the body's qubits onto the wires the
 * instance was placed on, and binding the formals to the arguments — are
 * exactly the two a reader cannot check by looking. So this file writes the
 * semantics a second time, the slow obvious way, and compares.
 *
 * The reference never calls `expandCircuit`. It walks the NESTED document:
 * a custom gate is "run the body, in column order, with the qubits renamed by
 * the instance's targets and the formals bound to the arguments". Everything
 * is applied as a dense 1-qubit matrix with explicit controls over a plain
 * array of 2ⁿ complex amplitudes, so nothing about column arithmetic, id
 * minting or the kernel's index pairing is shared with the code under test.
 */
import { analyticMode, run } from '@qsim/core'
import {
  depth,
  expandCircuit,
  gateCount,
  normalizeControl,
  parseCircuit,
  type Circuit,
  type Control,
  type CustomGate,
  type Operation,
  type ParamValue,
} from '@qsim/schema'
import { describe, expect, it } from 'vitest'

type Amp = { re: number; im: number }
type Matrix = [Amp, Amp, Amp, Amp] // row-major 2x2

const c = (re: number, im = 0): Amp => ({ re, im })
const mul = (a: Amp, b: Amp): Amp => ({
  re: a.re * b.re - a.im * b.im,
  im: a.re * b.im + a.im * b.re,
})
const add = (a: Amp, b: Amp): Amp => ({ re: a.re + b.re, im: a.im + b.im })

const SQRT_HALF = Math.SQRT1_2

function fixedMatrix(gate: string): Matrix | null {
  switch (gate) {
    case 'i':
      return [c(1), c(0), c(0), c(1)]
    case 'x':
      return [c(0), c(1), c(1), c(0)]
    case 'y':
      return [c(0), c(0, -1), c(0, 1), c(0)]
    case 'z':
      return [c(1), c(0), c(0), c(-1)]
    case 'h':
      return [c(SQRT_HALF), c(SQRT_HALF), c(SQRT_HALF), c(-SQRT_HALF)]
    case 's':
      return [c(1), c(0), c(0), c(0, 1)]
    case 'sdg':
      return [c(1), c(0), c(0), c(0, -1)]
    case 't':
      return [c(1), c(0), c(0), c(SQRT_HALF, SQRT_HALF)]
    case 'tdg':
      return [c(1), c(0), c(0), c(SQRT_HALF, -SQRT_HALF)]
    case 'sx':
      return [c(0.5, 0.5), c(0.5, -0.5), c(0.5, -0.5), c(0.5, 0.5)]
    default:
      return null
  }
}

function rotationMatrix(gate: string, params: number[]): Matrix | null {
  const [a = 0, b = 0, d = 0] = params
  switch (gate) {
    case 'rx':
      return [
        c(Math.cos(a / 2)),
        c(0, -Math.sin(a / 2)),
        c(0, -Math.sin(a / 2)),
        c(Math.cos(a / 2)),
      ]
    case 'ry':
      return [
        c(Math.cos(a / 2)),
        c(-Math.sin(a / 2)),
        c(Math.sin(a / 2)),
        c(Math.cos(a / 2)),
      ]
    case 'rz':
      return [
        c(Math.cos(a / 2), -Math.sin(a / 2)),
        c(0),
        c(0),
        c(Math.cos(a / 2), Math.sin(a / 2)),
      ]
    case 'p':
      return [c(1), c(0), c(0), c(Math.cos(a), Math.sin(a))]
    case 'u': {
      const cos = Math.cos(a / 2)
      const sin = Math.sin(a / 2)
      return [
        c(cos),
        mul(c(-Math.cos(d), -Math.sin(d)), c(sin)),
        mul(c(Math.cos(b), Math.sin(b)), c(sin)),
        mul(c(Math.cos(b + d), Math.sin(b + d)), c(cos)),
      ]
    }
    default:
      return null
  }
}

interface Ref {
  readonly qubits: number
  readonly amps: Amp[]
}

function ground(qubits: number): Ref {
  const amps = Array.from({ length: 1 << qubits }, () => c(0))
  amps[0] = c(1)
  return { qubits, amps }
}

/** One-qubit matrix on `target`, gated by `controls`. Index-by-index. */
function apply1(
  state: Ref,
  matrix: Matrix,
  target: number,
  controls: readonly { qubit: number; state: 0 | 1 }[]
): void {
  const size = 1 << state.qubits
  const done = new Set<number>()
  for (let index = 0; index < size; index++) {
    if (done.has(index)) continue
    if ((index >> target) & 1) continue
    const partner = index | (1 << target)
    done.add(index)
    done.add(partner)
    const enabled = controls.every(
      (control) => ((index >> control.qubit) & 1) === control.state
    )
    if (!enabled) continue
    const zero = state.amps[index] as Amp
    const one = state.amps[partner] as Amp
    state.amps[index] = add(mul(matrix[0], zero), mul(matrix[1], one))
    state.amps[partner] = add(mul(matrix[2], zero), mul(matrix[3], one))
  }
}

function applySwap(
  state: Ref,
  a: number,
  b: number,
  controls: readonly { qubit: number; state: 0 | 1 }[]
): void {
  const size = 1 << state.qubits
  const next = state.amps.slice()
  for (let index = 0; index < size; index++) {
    const enabled = controls.every(
      (control) => ((index >> control.qubit) & 1) === control.state
    )
    if (!enabled) continue
    const bitA = (index >> a) & 1
    const bitB = (index >> b) & 1
    if (bitA === bitB) continue
    const swapped = index ^ (1 << a) ^ (1 << b)
    next[swapped] = state.amps[index] as Amp
  }
  state.amps.splice(0, size, ...next)
}

interface RefFrame {
  /** definition qubit → circuit qubit */
  readonly wire: (qubit: number) => number
  /** formal name → the value it stands for */
  readonly bind: (param: ParamValue) => number
}

const IDENTITY_FRAME: RefFrame = {
  wire: (qubit) => qubit,
  bind: () => {
    throw new Error('unbound')
  },
}

function numeric(
  circuit: Circuit,
  frame: RefFrame,
  params: readonly ParamValue[] | undefined
): number[] {
  return (params ?? []).map((param) => {
    if (typeof param === 'number') return param
    if (frame === IDENTITY_FRAME) {
      const declared = (circuit.parameters ?? []).find(
        (candidate) => candidate.name === param
      )
      if (declared === undefined) throw new Error(`unknown parameter ${param}`)
      return declared.value
    }
    return frame.bind(param)
  })
}

function controlsIn(
  operation: Operation,
  frame: RefFrame
): { qubit: number; state: 0 | 1 }[] {
  return (operation.controls ?? []).map((control: Control) => {
    const spec = normalizeControl(control)
    return { qubit: frame.wire(spec.qubit), state: spec.state }
  })
}

function ordered(operations: readonly Operation[]): Operation[] {
  return [...operations].sort((left, right) => left.column - right.column)
}

function runReference(
  state: Ref,
  circuit: Circuit,
  operations: readonly Operation[],
  frame: RefFrame,
  depthLeft: number
): void {
  if (depthLeft < 0) throw new Error('too deep')
  for (const operation of ordered(operations)) {
    const definition: CustomGate | undefined = Object.hasOwn(
      circuit.customGates ?? {},
      operation.gate
    )
      ? circuit.customGates?.[operation.gate]
      : undefined

    if (definition !== undefined) {
      const targets = operation.targets.map((qubit) => frame.wire(qubit))
      const args = numeric(circuit, frame, operation.params)
      const formals = definition.params ?? []
      const inner: RefFrame = {
        wire: (qubit) => targets[qubit] as number,
        bind: (param) => {
          if (typeof param === 'number') return param
          const index = formals.indexOf(param)
          if (index === -1) throw new Error(`unknown formal ${param}`)
          return args[index] as number
        },
      }
      runReference(state, circuit, definition.operations, inner, depthLeft - 1)
      continue
    }

    const targets = operation.targets.map((qubit) => frame.wire(qubit))
    const controls = controlsIn(operation, frame)
    const params = numeric(circuit, frame, operation.params)

    if (operation.gate === 'barrier') continue
    if (operation.gate === 'swap') {
      applySwap(state, targets[0] as number, targets[1] as number, controls)
      continue
    }
    if (operation.gate === 'cswap') {
      applySwap(state, targets[0] as number, targets[1] as number, controls)
      continue
    }
    // The catalog stores `cx` as "x with one control", and so on; the
    // reference applies the one-qubit half and lets `controls` do the rest.
    const kernel =
      operation.gate === 'cx' || operation.gate === 'ccx'
        ? 'x'
        : operation.gate === 'cz'
          ? 'z'
          : operation.gate === 'crz'
            ? 'rz'
            : operation.gate === 'cp'
              ? 'p'
              : operation.gate
    const matrix = fixedMatrix(kernel) ?? rotationMatrix(kernel, params)
    if (matrix === null) {
      throw new Error(`reference has no matrix for "${operation.gate}"`)
    }
    apply1(state, matrix, targets[0] as number, controls)
  }
}

/** The nested semantics: run the document without ever expanding it. */
function reference(circuit: Circuit): Amp[] {
  const state = ground(circuit.qubits)
  runReference(state, circuit, circuit.operations, IDENTITY_FRAME, 64)
  return state.amps
}

/** The system under test: expand, then run the real engine. */
function engine(circuit: Circuit): Amp[] {
  const flat = expandCircuit(circuit).circuit
  const result = run(flat, analyticMode())
  if (result.mode !== 'analytic') throw new Error('not analytic')
  const out: Amp[] = []
  for (let index = 0; index < result.state.size; index++) {
    out.push(c(result.state.re[index] as number, result.state.im[index]))
  }
  return out
}

function expectAgree(circuit: Circuit, label: string): void {
  const left = reference(circuit)
  const right = engine(circuit)
  expect(right.length).toBe(left.length)
  for (let index = 0; index < left.length; index++) {
    const a = left[index] as Amp
    const b = right[index] as Amp
    const gap = Math.hypot(a.re - b.re, a.im - b.im)
    if (gap >= 1e-10) {
      throw new Error(
        `${label}: amplitude ${index} differs by ${gap} — reference ` +
          `${a.re}${a.im < 0 ? '' : '+'}${a.im}i vs engine ` +
          `${b.re}${b.im < 0 ? '' : '+'}${b.im}i`
      )
    }
  }
}

/* ─────────────────────── calibrate the reference ─────────────────────── */

describe('the reference agrees with the engine on primitives', () => {
  it('every one-qubit gate, with and without controls', () => {
    const gates = ['i', 'x', 'y', 'z', 'h', 's', 'sdg', 't', 'tdg', 'sx']
    const operations: unknown[] = [
      { id: 'seed0', gate: 'h', targets: [0], column: 0 },
      { id: 'seed1', gate: 'h', targets: [1], column: 0 },
      { id: 'seed2', gate: 't', targets: [2], column: 0 },
    ]
    gates.forEach((gate, index) => {
      operations.push({
        id: `g${index}`,
        gate,
        targets: [index % 3],
        column: index + 1,
      })
    })
    operations.push(
      { id: 'p1', gate: 'rx', targets: [0], params: [0.31], column: 20 },
      { id: 'p2', gate: 'ry', targets: [1], params: [-1.2], column: 21 },
      { id: 'p3', gate: 'rz', targets: [2], params: [2.4], column: 22 },
      { id: 'p4', gate: 'p', targets: [0], params: [0.9], column: 23 },
      {
        id: 'p5',
        gate: 'u',
        targets: [1],
        params: [0.4, 1.1, -0.6],
        column: 24,
      },
      { id: 'q1', gate: 'cx', targets: [2], controls: [0], column: 25 },
      { id: 'q2', gate: 'cz', targets: [1], controls: [2], column: 26 },
      {
        id: 'q3',
        gate: 'crz',
        targets: [0],
        controls: [1],
        params: [0.77],
        column: 27,
      },
      {
        id: 'q4',
        gate: 'cp',
        targets: [2],
        controls: [1],
        params: [1.3],
        column: 28,
      },
      { id: 'q5', gate: 'swap', targets: [0, 2], column: 29 },
      { id: 'q6', gate: 'ccx', targets: [2], controls: [0, 1], column: 30 },
      { id: 'q7', gate: 'cswap', targets: [0, 1], controls: [2], column: 31 },
      {
        id: 'q8',
        gate: 'x',
        targets: [0],
        controls: [{ qubit: 1, state: 0 }],
        column: 32,
      }
    )
    const circuit = parseCircuit({
      schemaVersion: 1,
      qubits: 3,
      operations,
    })
    expectAgree(circuit, 'calibration')
  })
})

/* ───────────────────────── the property under test ───────────────────── */

/** Deterministic 32-bit generator, so a failure is reproducible by seed. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state >>>= 0
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x100000000
  }
}

const ONE_QUBIT = ['x', 'y', 'z', 'h', 's', 't', 'sx'] as const
const ROTATIONS = ['rx', 'ry', 'rz', 'p'] as const

interface Built {
  operations: Operation[]
  next: number
}

/**
 * Random operations over `qubits` wires, in `columns` columns, drawing from
 * the primitives and from `available` definitions (name → arity/params).
 */
function randomBody(
  next: () => number,
  qubits: number,
  columns: number,
  available: { name: string; qubits: number; params: number }[],
  formals: string[],
  idPrefix: string,
  start: number
): Built {
  const operations: Operation[] = []
  let counter = start
  for (let column = 0; column < columns; column++) {
    const free = new Set(Array.from({ length: qubits }, (_, i) => i))
    const attempts = 1 + Math.floor(next() * qubits)
    for (let attempt = 0; attempt < attempts; attempt++) {
      const usable = available.filter((entry) => entry.qubits <= free.size)
      const useBlock = usable.length > 0 && next() < 0.4
      if (useBlock) {
        const choice = usable[Math.floor(next() * usable.length)] as {
          name: string
          qubits: number
          params: number
        }
        const wires = [...free]
        const targets: number[] = []
        for (let i = 0; i < choice.qubits; i++) {
          const pick = Math.floor(next() * wires.length)
          targets.push(wires.splice(pick, 1)[0] as number)
        }
        for (const wire of targets) free.delete(wire)
        const params: ParamValue[] = Array.from(
          { length: choice.params },
          () =>
            formals.length > 0 && next() < 0.5
              ? (formals[Math.floor(next() * formals.length)] as string)
              : Number((next() * 6 - 3).toFixed(4))
        )
        operations.push({
          id: `${idPrefix}${counter++}`,
          gate: choice.name,
          targets,
          column,
          ...(params.length === 0 ? {} : { params }),
        })
        continue
      }
      if (free.size === 0) break
      const wires = [...free]
      const target = wires.splice(
        Math.floor(next() * wires.length),
        1
      )[0] as number
      free.delete(target)
      const wantsControl = wires.length > 0 && next() < 0.4
      const control = wantsControl
        ? (() => {
            const pick = wires.splice(
              Math.floor(next() * wires.length),
              1
            )[0] as number
            free.delete(pick)
            return pick
          })()
        : null
      const parametrised = next() < 0.4
      const gate = parametrised
        ? (ROTATIONS[Math.floor(next() * ROTATIONS.length)] as string)
        : (ONE_QUBIT[Math.floor(next() * ONE_QUBIT.length)] as string)
      const params: ParamValue[] = parametrised
        ? [
            formals.length > 0 && next() < 0.5
              ? (formals[Math.floor(next() * formals.length)] as string)
              : Number((next() * 6 - 3).toFixed(4)),
          ]
        : []
      operations.push({
        id: `${idPrefix}${counter++}`,
        gate,
        targets: [target],
        column,
        ...(control === null
          ? {}
          : {
              controls: [
                next() < 0.25 ? { qubit: control, state: 0 } : control,
              ],
            }),
        ...(params.length === 0 ? {} : { params }),
      })
    }
  }
  return { operations, next: counter }
}

function randomCircuit(seed: number): Circuit {
  const next = rng(seed)
  const qubits = 3 + Math.floor(next() * 3)
  const customGates: Record<string, CustomGate> = {}
  const available: { name: string; qubits: number; params: number }[] = []
  const definitionCount = 1 + Math.floor(next() * 3)
  for (let index = 0; index < definitionCount; index++) {
    const arity = 1 + Math.floor(next() * Math.min(3, qubits))
    const paramCount = Math.floor(next() * 3)
    const formals = Array.from(
      { length: paramCount },
      (_, position) => `f${index}_${position}`
    )
    const columns = 1 + Math.floor(next() * 3)
    const body = randomBody(
      next,
      arity,
      columns,
      available.filter((entry) => entry.qubits <= arity),
      formals,
      `d${index}_`,
      0
    )
    const name = `blk${index}`
    customGates[name] = {
      qubits: arity,
      ...(paramCount === 0 ? {} : { params: formals }),
      operations: body.operations,
    }
    available.push({ name, qubits: arity, params: paramCount })
  }

  const parameterNames = ['alpha', 'beta']
  const top = randomBody(
    next,
    qubits,
    1 + Math.floor(next() * 4),
    available,
    parameterNames,
    'op_',
    0
  )

  return parseCircuit({
    schemaVersion: 1,
    qubits,
    parameters: [
      { name: 'alpha', value: 0.613 },
      { name: 'beta', value: -1.907 },
    ],
    operations: top.operations,
    customGates,
  })
}

describe('a custom gate means its body, at any offset and any depth', () => {
  it('agrees with the nested reference over 300 random documents', () => {
    let checked = 0
    for (let seed = 1; seed <= 300; seed++) {
      let circuit: Circuit
      try {
        circuit = randomCircuit(seed)
      } catch {
        continue // generator produced something the contract refuses
      }
      if (circuit.operations.length === 0) continue
      expectAgree(circuit, `seed ${seed}`)
      checked++
    }
    expect(checked).toBeGreaterThan(100)
  })

  /*
   * The random suite covers these too, but a named case is what a reader
   * looks at when the suite goes red — and these are the three shapes the
   * offset mapping is most likely to get wrong.
   */
  it('places one definition at two different offsets in one column', () => {
    const circuit = parseCircuit({
      schemaVersion: 1,
      qubits: 4,
      operations: [
        { id: 'op_1', gate: 'bell', targets: [0, 1], column: 0 },
        { id: 'op_2', gate: 'bell', targets: [3, 2], column: 0 },
      ],
      customGates: {
        bell: {
          qubits: 2,
          operations: [
            { id: 'a', gate: 'h', targets: [0], column: 0 },
            { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
          ],
        },
      },
    })
    expectAgree(circuit, 'two offsets')
    expect(gateCount(circuit)).toBe(4)
    expect(depth(circuit)).toBe(2)
  })

  it('maps wires through a definition placed in reverse order', () => {
    const circuit = parseCircuit({
      schemaVersion: 1,
      qubits: 3,
      operations: [{ id: 'op_1', gate: 'bell', targets: [2, 0], column: 0 }],
      customGates: {
        bell: {
          qubits: 2,
          operations: [
            { id: 'a', gate: 'h', targets: [0], column: 0 },
            { id: 'b', gate: 'cx', targets: [1], controls: [0], column: 1 },
          ],
        },
      },
    })
    expectAgree(circuit, 'reversed targets')
  })

  it('binds an angle through three levels of nesting', () => {
    const circuit = parseCircuit({
      schemaVersion: 1,
      qubits: 2,
      parameters: [{ name: 'alpha', value: 0.7 }],
      operations: [
        {
          id: 'op_1',
          gate: 'outer',
          targets: [0, 1],
          params: ['alpha'],
          column: 0,
        },
      ],
      customGates: {
        outer: {
          qubits: 2,
          params: ['t'],
          operations: [
            {
              id: 'o1',
              gate: 'mid',
              targets: [1, 0],
              params: ['t'],
              column: 0,
            },
          ],
        },
        mid: {
          qubits: 2,
          params: ['u'],
          operations: [
            { id: 'm1', gate: 'inner', targets: [0], params: ['u'], column: 0 },
            { id: 'm2', gate: 'cx', targets: [1], controls: [0], column: 1 },
          ],
        },
        inner: {
          qubits: 1,
          params: ['v'],
          operations: [
            { id: 'n1', gate: 'h', targets: [0], column: 0 },
            { id: 'n2', gate: 'rz', targets: [0], params: ['v'], column: 1 },
          ],
        },
      },
    })
    expectAgree(circuit, 'three deep')
    expect(gateCount(circuit)).toBe(3)
    expect(depth(circuit)).toBe(3)
  })
})
