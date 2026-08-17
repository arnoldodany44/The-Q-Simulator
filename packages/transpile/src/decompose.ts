/**
 * Layer one: every gate in the catalog, rewritten into `{rz, sx, x, id, cz}`.
 *
 * This is known arithmetic and it is the half of the package that cannot be
 * clever. Each construction below is derived in a comment and every one of
 * them is multiplied out against `@qsim/core` in
 * `verification/decomposition.test.ts`, exhaustively over the catalog rather
 * than over a sample — that test is the entire safety net for this file,
 * because a decomposition that is wrong by a phase produces a circuit that
 * simulates plausibly, exports cleanly and computes the wrong thing.
 *
 * ── EVERYTHING IS UP TO GLOBAL PHASE, AND THAT IS EXACT ENOUGH ───────────
 *
 * |ψ⟩ and e^{iα}|ψ⟩ are the same state and no measurement distinguishes them,
 * so a decomposition equal to the original up to an overall factor is equal to
 * it. What is *not* allowed to drift is a phase on part of the register: the
 * moment a gate sits under a control, its "global" phase is a relative phase
 * between the control's two branches and is fully observable. Every
 * construction here that puts a control on something therefore carries the
 * phase explicitly — see `euler.ts` part one and `controlledRotation` below.
 *
 * ── THE FUSION PASS, AND THE RULE IT OBEYS ───────────────────────────────
 *
 * Decomposing gate by gate leaves runs of consecutive one-qubit gates on a
 * wire — a Hadamard from a CNOT next to a rotation from a controlled-U — and
 * the product of a run is one one-qubit gate, which costs at most two pulses.
 * So runs are folded.
 *
 * They are folded **only when the fold is cheaper**, measured first in pulses
 * — `rz` costs zero, because the hardware implements it as a frame change
 * (`basis.ts`) — and then, at equal pulse count, in instructions. That rule is
 * not a micro-optimisation, it is what keeps the output readable: the general
 * fold goes through `zyzOf`, whose angles come out of `atan2` and are
 * therefore never exactly `pi/2`, so a fold that saved nothing would turn
 * `rz(pi/2) sx rz(pi/2)` into three decimal literals for no gain. A fold that
 * removes a pulse has earned the ugliness; a run of *diagonal* gates does not
 * pay it at all, because those compose by adding angles and `foldRun` adds
 * them.
 *
 * A run of one gate is never folded, which is what leaves every gate a user
 * actually drew with its exact angles.
 */

import {
  CIRCUIT_SCHEMA_VERSION,
  GATES,
  MAX_COLUMNS,
  controlsOf,
  expandCircuit,
  lookupGate,
  resolveParams,
  type Circuit,
  type Condition,
  type GateId,
  type Operation,
} from '@qsim/schema'
import { dagger } from '@qsim/core'
import { orderedOperations } from '@qsim/qasm'

import { isPassthrough } from './basis.js'
import {
  matrixOf,
  multiply,
  sqrtOf,
  zyzOf,
  type EulerAngles,
  type Matrix2,
} from './complex2.js'
import {
  BASE_GATE_OF,
  eulerOf,
  isOneQubitCatalogId,
  pulseCost,
  zsxOf,
  type BasisRotation,
  type OneQubitCatalogId,
} from './euler.js'
import { TranspileRefusal } from './refusal.js'

/* ──────────────────────────── the step list ──────────────────────────── */

interface StepBase {
  /** Id of the source operation this step came from, for refusal messages. */
  readonly source: string
  readonly condition: Condition | undefined
}

/** A one-qubit gate, still as angles: fusion happens before `zsxOf` runs. */
interface RotationStep extends StepBase {
  readonly kind: 'rotation'
  readonly qubit: number
  readonly angles: EulerAngles
}

/** The catalog's `i`, kept rather than dropped — see `decomposeOperation`. */
interface IdentityStep extends StepBase {
  readonly kind: 'identity'
  readonly qubit: number
}

/** The one entangling gate. Symmetric, so `a` and `b` are interchangeable. */
interface CzStep extends StepBase {
  readonly kind: 'cz'
  readonly a: number
  readonly b: number
}

/** `barrier`, `reset` and `measure`, carried through untouched. */
interface PassStep extends StepBase {
  readonly kind: 'pass'
  readonly operation: Operation
}

type Step = RotationStep | IdentityStep | CzStep | PassStep

/* ─────────────────────────── the public shape ────────────────────────── */

/** A logical pair that must be physically adjacent, and how often it is used. */
export interface Interaction {
  readonly a: number
  readonly b: number
  /** Number of `cz` operations on this pair after decomposition. */
  readonly count: number
  /** Source operations that put it there. */
  readonly operationIds: readonly string[]
}

/** What layer one produces, and what layer two consumes. */
export interface Decomposition {
  /**
   * The circuit in the native basis, still on the document's own qubit
   * numbering. Simulatable by `@qsim/core` and comparable, gate for gate,
   * against the circuit it came from.
   */
  readonly circuit: Circuit
  /** Logical pairs needing adjacency, descending by `count`. */
  readonly interactions: readonly Interaction[]
  /** Pulses (`sx` and `x`) on each logical qubit, indexed by qubit. */
  readonly pulses: readonly number[]
  /** Logical qubits some `measure` reads, ascending. */
  readonly measured: readonly number[]
  /** Number of `cz` operations in total. */
  readonly twoQubitGates: number
}

/**
 * Rewrite a circuit into the native basis.
 *
 * Custom gates are expanded first, so a definition full of Hadamards is
 * decomposed like anything else rather than surviving as a `gate` block the
 * backend has never heard of.
 */
export function decomposeCircuit(circuit: Circuit): Decomposition {
  const flat = expand(circuit)
  const parameters = flat.parameters ?? []

  const steps: Step[] = []
  for (const operation of orderedOperations(flat.operations)) {
    steps.push(...decomposeOperation(operation, parameters))
  }

  const drafts = emit(fuse(steps))
  const operations = assignColumns(drafts)

  return {
    circuit: {
      schemaVersion: CIRCUIT_SCHEMA_VERSION,
      qubits: flat.qubits,
      clbits: flat.clbits,
      ...(flat.qubitLabels === undefined
        ? {}
        : { qubitLabels: flat.qubitLabels }),
      operations,
    },
    ...summarise(operations, flat.qubits),
  }
}

function expand(circuit: Circuit): Circuit {
  try {
    return expandCircuit(circuit).circuit
  } catch (cause) {
    throw new TranspileRefusal(
      'unsupported-gate',
      `The circuit's custom gates could not be expanded into primitives, so ` +
        `there is nothing to decompose: ${String(cause)}`,
      { reason: String(cause) }
    )
  }
}

/* ─────────────────────── one operation at a time ─────────────────────── */

function decomposeOperation(
  operation: Operation,
  parameters: readonly { name: string; value: number }[]
): readonly Step[] {
  const meta = lookupGate(operation.gate)
  if (meta === undefined) {
    throw new TranspileRefusal(
      'unsupported-gate',
      `Operation "${operation.id}" uses gate "${operation.gate}", which is ` +
        `not in the catalog. Custom gates are expanded before this point, so ` +
        `a name that survives is a name nothing defines.`,
      { gate: operation.gate },
      [operation.id]
    )
  }

  if (isPassthrough(operation.gate)) {
    return [
      { kind: 'pass', operation, source: operation.id, condition: undefined },
    ]
  }

  const params = angles(operation, parameters)
  const controls = controlsOf(operation)
  const context: Context = {
    source: operation.id,
    condition: operation.condition,
  }

  /*
   * A negative control fires on |0⟩. Flipping the wire on either side of the
   * whole block turns it into a positive one, exactly, and costs two `x`
   * pulses — the same trick OpenQASM's `negctrl @` names and every hardware
   * toolchain uses, because a chip has no notion of "controlled on zero".
   */
  const flips = controls
    .filter((control) => control.state === 0)
    .map((control) => control.qubit)
  const positive = controls.map((control) => control.qubit)

  const body = decomposeControlled(
    operation,
    meta.id,
    params,
    positive,
    context
  )
  if (flips.length === 0) return body
  const wrap = flips.map((qubit) => rotation(qubit, eulerOf('x'), context))
  return [...wrap, ...body, ...wrap]
}

interface Context {
  readonly source: string
  readonly condition: Condition | undefined
}

function decomposeControlled(
  operation: Operation,
  gate: GateId,
  params: readonly number[],
  controls: readonly number[],
  context: Context
): readonly Step[] {
  if (gate === 'swap' || gate === 'cswap' || gate === 'iswap') {
    return decomposeExchange(operation, gate, controls, context)
  }

  const base = isOneQubitCatalogId(gate) ? gate : BASE_GATE_OF[gate]
  if (base === undefined) {
    throw new TranspileRefusal(
      'unsupported-gate',
      `Gate "${gate}" is in the catalog but this package has no ` +
        `decomposition for it. That is a gap here, not in the circuit.`,
      { gate },
      [operation.id]
    )
  }

  const target = operation.targets[0]
  if (target === undefined || operation.targets.length !== 1) {
    throw new TranspileRefusal(
      'unsupported-gate',
      `Operation "${operation.id}" applies "${gate}" to ` +
        `${operation.targets.length} target(s); it takes exactly one.`,
      { gate, targets: operation.targets.length },
      [operation.id]
    )
  }

  const angles = eulerOfChecked(operation, base, params)

  switch (controls.length) {
    case 0:
      // The identity is the one gate whose decomposition is emptiness and
      // whose emptiness is wrong: the backend has an `id` and the user drew
      // one, so it survives as itself.
      return gate === 'i'
        ? [{ kind: 'identity', qubit: target, ...context }]
        : [rotation(target, angles, context)]
    case 1:
      return singlyControlled(
        base,
        angles,
        controls[0] as number,
        target,
        context
      )
    case 2:
      return doublyControlled(
        base,
        angles,
        controls[0] as number,
        controls[1] as number,
        target,
        context
      )
    default:
      throw new TranspileRefusal(
        'too-many-controls',
        `Operation "${operation.id}" carries ${controls.length} controls. ` +
          `Beyond two, a controlled gate needs either ancilla qubits or a ` +
          `ladder whose length grows with the control count, and either way ` +
          `it needs every control adjacent to the target — which no lattice ` +
          `in this package's target class offers. Build it from two-qubit ` +
          `gates yourself, or run it in the simulator.`,
        { controls: controls.length, limit: 2 },
        [operation.id]
      )
  }
}

/**
 * `swap`, `iswap` and `cswap`.
 *
 * ── swap ─────────────────────────────────────────────────────────────────
 * The three-CNOT identity, which is what the *user* asked for. Worth being
 * explicit about: `refusal.ts` argues at length that this package will not
 * insert a SWAP, and this is not that. A SWAP a user drew is an operation
 * they want; a SWAP a router inserts is an operation they never see.
 *
 * ── iswap ────────────────────────────────────────────────────────────────
 * S·S·H·CX·CX·H, which is Qiskit's own `iSwapGate` definition and the same
 * sequence `@qsim/qasm` emits for the same gate — deliberately the same, so
 * that the exported program and the transpiled one cannot disagree about what
 * `iswap` means.
 *
 * ── cswap ────────────────────────────────────────────────────────────────
 * CX·CCX·CX: for a control of 1 the outer CNOTs sandwich a Toffoli into the
 * alternating three-CNOT SWAP, and for a control of 0 they cancel.
 */
function decomposeExchange(
  operation: Operation,
  gate: 'swap' | 'iswap' | 'cswap',
  controls: readonly number[],
  context: Context
): readonly Step[] {
  const [first, second] = operation.targets
  if (first === undefined || second === undefined) {
    throw new TranspileRefusal(
      'unsupported-gate',
      `Operation "${operation.id}" applies "${gate}" to ` +
        `${operation.targets.length} qubit(s); it takes exactly two.`,
      { gate, targets: operation.targets.length },
      [operation.id]
    )
  }

  if (gate === 'iswap') {
    if (controls.length > 0) {
      throw new TranspileRefusal(
        'too-many-controls',
        `Operation "${operation.id}" is a controlled iswap, which this ` +
          `package does not build. Controlling a two-qubit exchange needs ` +
          `three mutually adjacent qubits.`,
        { gate, controls: controls.length },
        [operation.id]
      )
    }
    return [
      rotation(first, eulerOf('s'), context),
      rotation(second, eulerOf('s'), context),
      rotation(first, eulerOf('h'), context),
      ...cnot(first, second, context),
      ...cnot(second, first, context),
      rotation(second, eulerOf('h'), context),
    ]
  }

  if (controls.length === 0) {
    return [
      ...cnot(first, second, context),
      ...cnot(second, first, context),
      ...cnot(first, second, context),
    ]
  }
  if (controls.length === 1) {
    const control = controls[0] as number
    return [
      ...cnot(second, first, context),
      ...toffoli(control, first, second, context),
      ...cnot(second, first, context),
    ]
  }
  throw new TranspileRefusal(
    'too-many-controls',
    `Operation "${operation.id}" is a swap with ${controls.length} controls. ` +
      `One is the most this package builds.`,
    { gate, controls: controls.length, limit: 1 },
    [operation.id]
  )
}

/* ───────────────────────── the constructions ─────────────────────────── */

function rotation(
  qubit: number,
  angles: EulerAngles,
  context: Context
): RotationStep {
  return { kind: 'rotation', qubit, angles, ...context }
}

function cz(a: number, b: number, context: Context): CzStep {
  return { kind: 'cz', a, b, ...context }
}

/**
 * CNOT as `H_t · CZ · H_t`.
 *
 * The chip has no CNOT and has a CZ, and the two differ by a change of basis
 * on the target alone: CZ acts as the identity on the control's |0⟩ branch and
 * as Z on its |1⟩ branch, and H·Z·H is X. One `cz`, two Hadamards, and each
 * Hadamard is a single `sx` between two free frame changes — so the CNOT
 * everybody draws costs this device one entangling pulse and two one-qubit
 * ones.
 */
function cnot(
  control: number,
  target: number,
  context: Context
): readonly Step[] {
  return [
    rotation(target, eulerOf('h'), context),
    cz(control, target, context),
    rotation(target, eulerOf('h'), context),
  ]
}

/**
 * A controlled one-qubit gate, for any one-qubit gate.
 *
 * ── DERIVATION ───────────────────────────────────────────────────────────
 *
 * Write the gate as e^{iγ}·U(θ,φ,λ) and U as e^{i(φ+λ)/2}·rz(φ)·ry(θ)·rz(λ).
 * Then choose
 *
 *     A = rz(φ)·ry(θ/2)      B = ry(−θ/2)·rz(−(φ+λ)/2)      C = rz((λ−φ)/2)
 *
 * for which ABC = I by inspection (the ry's cancel, then the three rz angles
 * sum to zero), and, using X·ry(α)·X = ry(−α) and X·rz(α)·X = rz(−α),
 *
 *     A·(X B X)·C = rz(φ)·ry(θ)·rz(λ)
 *
 * So the circuit `C → CX → B → CX → A` is the identity when the control reads
 * |0⟩ (it runs ABC) and rz(φ)ry(θ)rz(λ) when it reads |1⟩. One phase remains:
 * the |1⟩ branch owes a factor of e^{i(γ + (φ+λ)/2)}, and a phase applied only
 * on the |1⟩ branch of a wire is exactly what `p` on the control is.
 *
 * ── WHY γ IS IN THAT SUM, AND WHAT BREAKS WITHOUT IT ─────────────────────
 *
 * Because `crz` and `cp` are different operations. `rz(α)` and `p(α)` differ
 * only by e^{−iα/2}, which is invisible on a wire — so a construction that
 * read the angles and forgot the phase would emit `cp(α)` for a document that
 * said `crz(α)`, and every test that compares final states of an *uncontrolled*
 * circuit would pass. With γ in place, `crz` comes out with `p(0)` on the
 * control (dropped, being nothing) and `cp` with `p(α/2)`, which is the whole
 * difference between them.
 *
 * ── THE TWO SHORTCUTS ────────────────────────────────────────────────────
 *
 * `x` under one control is a CNOT: one `cz` instead of the two this
 * construction spends. `z` under one control *is* `cz`, natively, with no
 * decomposition at all. Both are exact and both are the common case.
 */
function singlyControlled(
  base: OneQubitCatalogId,
  angles: EulerAngles,
  control: number,
  target: number,
  context: Context
): readonly Step[] {
  if (base === 'x') return cnot(control, target, context)
  if (base === 'z') return [cz(control, target, context)]

  const { theta, phi, lambda, phase } = angles
  return [
    rotation(target, eulerOf('rz', [(lambda - phi) / 2]), context),
    ...cnot(control, target, context),
    rotation(target, eulerOf('rz', [-(phi + lambda) / 2]), context),
    rotation(target, eulerOf('ry', [-theta / 2]), context),
    ...cnot(control, target, context),
    rotation(target, eulerOf('ry', [theta / 2]), context),
    rotation(target, eulerOf('rz', [phi]), context),
    rotation(control, eulerOf('p', [phase + (phi + lambda) / 2]), context),
  ]
}

/**
 * A doubly-controlled one-qubit gate.
 *
 * `CV(c₂,t) · CX(c₁,c₂) · CV†(c₂,t) · CX(c₁,c₂) · CV(c₁,t)` with V² = U. Walk
 * the four control settings: (0,0) applies nothing; (0,1) applies V then V†;
 * (1,0) applies V† then V; (1,1) applies V twice, which is U. The two CNOTs
 * leave the controls as they found them, so the construction is a gate rather
 * than a gate plus bookkeeping.
 *
 * `x` is special-cased to the six-CNOT Toffoli, which is both shorter and the
 * definition every other toolchain uses; `z` to the same Toffoli conjugated by
 * Hadamards on the target, which is what CCZ is.
 *
 * ── THIS SHAPE WILL NOT PLACE ON A HEAVY-HEX DEVICE, AND THAT IS FINE ────
 *
 * Every form above makes all three qubits interact pairwise, and a heavy-hex
 * lattice has no triangle — its shortest cycle is twelve qubits long. So layer
 * two will refuse a Toffoli on such a device, by name and with numbers. The
 * decomposition is still written and still proved, because the refusal is
 * about the *wiring* and not about the arithmetic: a device with a triangle
 * runs this unchanged.
 */
function doublyControlled(
  base: OneQubitCatalogId,
  angles: EulerAngles,
  first: number,
  second: number,
  target: number,
  context: Context
): readonly Step[] {
  if (base === 'x') return toffoli(first, second, target, context)
  if (base === 'z') {
    return [
      rotation(target, eulerOf('h'), context),
      ...toffoli(first, second, target, context),
      rotation(target, eulerOf('h'), context),
    ]
  }

  const root = sqrtOf(matrixOf(angles))
  const rootAngles = zyzOf(root)
  const inverseAngles = zyzOf(dagger(root))
  return [
    ...singlyControlled('u', rootAngles, second, target, context),
    ...cnot(first, second, context),
    ...singlyControlled('u', inverseAngles, second, target, context),
    ...cnot(first, second, context),
    ...singlyControlled('u', rootAngles, first, target, context),
  ]
}

/**
 * The six-CNOT Toffoli, gate for gate as Qiskit defines `CCXGate`.
 *
 * Written out rather than derived because it *is* the derivation everyone
 * quotes: the T and T† ladder implements a controlled-controlled phase in the
 * Hadamard-rotated basis of the target, and six CNOTs is the known minimum
 * for a Toffoli over CNOT and one-qubit gates.
 */
function toffoli(
  first: number,
  second: number,
  target: number,
  context: Context
): readonly Step[] {
  return [
    rotation(target, eulerOf('h'), context),
    ...cnot(second, target, context),
    rotation(target, eulerOf('tdg'), context),
    ...cnot(first, target, context),
    rotation(target, eulerOf('t'), context),
    ...cnot(second, target, context),
    rotation(target, eulerOf('tdg'), context),
    ...cnot(first, target, context),
    rotation(second, eulerOf('t'), context),
    rotation(target, eulerOf('t'), context),
    rotation(target, eulerOf('h'), context),
    ...cnot(first, second, context),
    rotation(first, eulerOf('t'), context),
    rotation(second, eulerOf('tdg'), context),
    ...cnot(first, second, context),
  ]
}

/* ───────────────────────────── the fusion ────────────────────────────── */

/**
 * Fold maximal runs of consecutive unconditioned one-qubit gates on a wire.
 *
 * A step that carries a classical condition is never folded and flushes every
 * pending run, which is conservative on purpose: reordering an unconditioned
 * gate across a measurement that writes the bit a neighbouring condition reads
 * would change what the circuit computes, and the saving is nil — the gates a
 * condition guards are the one-or-two-pulse corrections of a teleportation,
 * with nothing in them to fold.
 */
function fuse(steps: readonly Step[]): readonly Step[] {
  const pending = new Map<number, RotationStep[]>()
  const out: Step[] = []

  const flush = (qubit: number): void => {
    const run = pending.get(qubit)
    pending.delete(qubit)
    if (run === undefined || run.length === 0) return
    if (run.length === 1) {
      out.push(run[0] as RotationStep)
      return
    }
    const folded = foldRun(run)
    out.push(...folded)
  }
  const flushAll = (): void => {
    for (const qubit of [...pending.keys()]) flush(qubit)
  }

  for (const step of steps) {
    if (step.kind === 'rotation' && step.condition === undefined) {
      const run = pending.get(step.qubit)
      if (run === undefined) pending.set(step.qubit, [step])
      else run.push(step)
      continue
    }

    if (step.condition !== undefined || touchesClassical(step)) flushAll()
    else for (const qubit of qubitsOfStep(step)) flush(qubit)
    out.push(step)
  }
  flushAll()
  return out
}

/**
 * How far a folded angle may be from a round one and still be treated as it.
 *
 * ── THIS IS THE ONE TOLERANCE IN THE PACKAGE, AND IT IS NARROW ───────────
 *
 * `zsxOf` refuses to take a shorter path unless θ is **exactly** the constant
 * it needs, on the principle that a transpiler may not replace a rotation by a
 * nearby different one. That principle is untouched, because it governs the
 * angles a *user wrote*: a run of one gate is never folded, so every gate
 * somebody dragged onto a wire reaches `zsxOf` with the angle they gave it.
 *
 * A folded angle is a different object. It comes out of `atan2` applied to a
 * matrix product this file computed, and it is therefore only ever known to
 * about 1e-16 — the exact answer is not available at any tolerance. Two
 * concrete cases, both from a two-gate run:
 *
 *   h·h is the identity in exact arithmetic and the identity plus 2.2e-16 in
 *       Float64, so without this it emits `rz(2.220446049250313e-16)`.
 *   x·h has θ = π/2 exactly, and comes out one ulp above it — because
 *       `cos(π/4)` and `sin(π/4)` differ in their last bit — which pushes it
 *       off the single-pulse branch and onto the two-pulse one.
 *
 * The second is the argument. Preserving a 1e-16 difference in an angle, at
 * the price of one extra `sx` pulse, is a bad trade by seven orders of
 * magnitude: the pulse costs about 4e-4 of fidelity on the device this was
 * measured against, and the angle it protects is not observable at all. At
 * 1e-12 radians the amplitude difference is 5e-13, two orders below D6's 1e-10
 * tolerance for the whole project.
 */
const FOLD_DUST = 1e-12

/** The three θ values `zsxOf` has a shorter path for. */
const BRANCH_ANGLES: readonly number[] = [0, Math.PI / 2, Math.PI]

/**
 * Fold a run into one rotation, when that is cheaper.
 *
 * ── THE DIAGONAL FAST PATH IS NOT AN OPTIMISATION ────────────────────────
 *
 * A run of gates that are all diagonal — `z`, `s`, `t`, `rz`, `p`, and every
 * θ = 0 case — composes by *adding* its angles, which is exact. Going through
 * the matrix and back out via `atan2` would give the same number to within an
 * ulp and lose the property that makes `formatAngle` print `pi/2`: it
 * recognises the π form by `===` and by nothing else. So `s` followed by `sdg`
 * cancels to precisely nothing on this path and to `rz(1.1e-16)` on the
 * general one.
 */
function foldRun(run: readonly RotationStep[]): readonly RotationStep[] {
  const separate = run.reduce(
    (total, step) => total + pulseCost(zsxOf(step.angles)),
    0
  )
  const separateOperations = run.reduce(
    (total, step) => total + zsxOf(step.angles).length,
    0
  )

  const folded = run.every((step) => step.angles.theta === 0)
    ? diagonalFold(run)
    : withoutDust(zyzOf(generalFold(run)), run)

  const rotations = zsxOf(folded)
  const cheaper =
    pulseCost(rotations) < separate ||
    (pulseCost(rotations) === separate && rotations.length < separateOperations)
  if (!cheaper) return run

  const last = run[run.length - 1] as RotationStep
  return [
    {
      kind: 'rotation',
      qubit: last.qubit,
      angles: folded,
      source: last.source,
      condition: undefined,
    },
  ]
}

/** Diagonal gates compose by adding angles. Exact, so exact angles survive. */
function diagonalFold(run: readonly RotationStep[]): EulerAngles {
  let lambda = 0
  let phase = 0
  for (const step of run) {
    lambda += step.angles.phi + step.angles.lambda
    phase += step.angles.phase
  }
  return { theta: 0, phi: 0, lambda, phase }
}

/** Time order into matrix order: the last gate applied is the leftmost factor. */
function generalFold(run: readonly RotationStep[]): Matrix2 {
  let product = matrixOf((run[0] as RotationStep).angles)
  for (let i = 1; i < run.length; i++) {
    product = multiply(matrixOf((run[i] as RotationStep).angles), product)
  }
  return product
}

/**
 * A folded angle with this file's own rounding taken back out.
 *
 * φ and λ are pulled to zero, which removes a rotation nobody asked for. θ is
 * pulled to whichever of 0, π/2 and π it is within `FOLD_DUST` of, because
 * those are the three values `zsxOf` has a cheaper path for and being an ulp
 * away from one costs a physical pulse. See `FOLD_DUST` for the whole
 * argument, and note the guard: the run is left alone if *any* member of it
 * was itself an angle a user could have written near a branch point, so the
 * snap can only ever undo arithmetic this file did.
 */
function withoutDust(
  angles: EulerAngles,
  run: readonly RotationStep[]
): EulerAngles {
  const clean = (value: number): number =>
    Math.abs(value) < FOLD_DUST ? 0 : value
  const snap = (value: number): number => {
    for (const branch of BRANCH_ANGLES) {
      if (Math.abs(value - branch) < FOLD_DUST) return branch
    }
    return value
  }
  /*
   * If a member of the run is *itself* sitting just off a branch point, the
   * ulp in the fold might be theirs rather than ours, and it is not this
   * file's to remove. Rare enough to cost nothing and cheap enough to check.
   */
  const userIsNearABranch = run.some((step) =>
    BRANCH_ANGLES.some(
      (branch) =>
        step.angles.theta !== branch &&
        Math.abs(step.angles.theta - branch) < FOLD_DUST
    )
  )
  return {
    theta: userIsNearABranch ? angles.theta : snap(angles.theta),
    phi: clean(angles.phi),
    lambda: clean(angles.lambda),
    phase: angles.phase,
  }
}

function touchesClassical(step: Step): boolean {
  return step.kind === 'pass' && (step.operation.clbitTargets ?? []).length > 0
}

function qubitsOfStep(step: Step): readonly number[] {
  switch (step.kind) {
    case 'rotation':
    case 'identity':
      return [step.qubit]
    case 'cz':
      return [step.a, step.b]
    case 'pass':
      return step.operation.targets
  }
}

/* ─────────────────────── steps become operations ─────────────────────── */

/** An operation without its column, which `assignColumns` supplies. */
type Draft = Omit<Operation, 'column'>

function emit(steps: readonly Step[]): readonly Draft[] {
  const drafts: Draft[] = []
  let next = 0
  const id = (): string => `t${String(next++)}`

  for (const step of steps) {
    const condition =
      step.condition === undefined ? {} : { condition: step.condition }
    switch (step.kind) {
      case 'identity':
        drafts.push({
          id: id(),
          gate: 'i',
          targets: [step.qubit],
          ...condition,
        })
        break
      case 'cz':
        drafts.push({
          id: id(),
          gate: 'cz',
          targets: [step.b],
          controls: [step.a],
          ...condition,
        })
        break
      case 'pass':
        drafts.push({ ...step.operation, id: id() })
        break
      case 'rotation':
        for (const gate of zsxOf(step.angles)) {
          drafts.push(operationOf(id(), gate, step.qubit, condition))
        }
        break
    }
  }
  return drafts
}

function operationOf(
  id: string,
  gate: BasisRotation,
  qubit: number,
  condition: { condition?: Condition }
): Draft {
  return gate.gate === 'rz'
    ? {
        id,
        gate: 'rz',
        targets: [qubit],
        params: [gate.angle as number],
        ...condition,
      }
    : { id, gate: gate.gate, targets: [qubit], ...condition }
}

/**
 * As-soon-as-possible scheduling: each operation goes in the earliest column
 * where every wire it touches is free.
 *
 * Wires are qubits *and* classical bits, which is what keeps a condition after
 * the measurement that fills it. The list arrives in the order
 * `orderedOperations` produced — already the order a sequential language must
 * run it in — so walking it and taking the first free column can only preserve
 * that order on any wire two operations share, and operations sharing no wire
 * commute.
 */
function assignColumns(drafts: readonly Draft[]): Operation[] {
  const freeQubit = new Map<number, number>()
  const freeClbit = new Map<number, number>()
  const operations: Operation[] = []

  for (const draft of drafts) {
    const qubits = [
      ...draft.targets,
      ...(draft.controls ?? []).map((control) =>
        typeof control === 'number' ? control : control.qubit
      ),
    ]
    const clbits = [
      ...(draft.clbitTargets ?? []),
      ...(draft.condition === undefined ? [] : [draft.condition.clbit]),
    ]

    let column = 0
    for (const qubit of qubits)
      column = Math.max(column, freeQubit.get(qubit) ?? 0)
    for (const clbit of clbits)
      column = Math.max(column, freeClbit.get(clbit) ?? 0)
    if (column >= MAX_COLUMNS) {
      throw new TranspileRefusal(
        'too-deep',
        `The decomposition needs more than ${MAX_COLUMNS} columns, which is ` +
          `the contract's ceiling. A circuit this deep would not finish ` +
          `inside a hardware job's coherence time either.`,
        { columns: column, limit: MAX_COLUMNS }
      )
    }

    for (const qubit of qubits) freeQubit.set(qubit, column + 1)
    for (const clbit of clbits) freeClbit.set(clbit, column + 1)
    operations.push({ ...draft, column })
  }
  return operations
}

/* ──────────────────────────── the summary ────────────────────────────── */

function summarise(
  operations: readonly Operation[],
  qubits: number
): Omit<Decomposition, 'circuit'> {
  const pairs = new Map<
    string,
    { a: number; b: number; count: number; ids: Set<string> }
  >()
  const pulses: number[] = []
  const measured = new Set<number>()
  let twoQubitGates = 0

  for (const operation of operations) {
    if (operation.gate === 'cz') {
      const control = operation.controls?.[0]
      const a = typeof control === 'number' ? control : (control?.qubit ?? 0)
      const b = operation.targets[0] as number
      const low = Math.min(a, b)
      const high = Math.max(a, b)
      const key = `${String(low)}-${String(high)}`
      const entry = pairs.get(key) ?? {
        a: low,
        b: high,
        count: 0,
        ids: new Set<string>(),
      }
      entry.count++
      entry.ids.add(operation.id)
      pairs.set(key, entry)
      twoQubitGates++
      continue
    }
    if (operation.gate === 'sx' || operation.gate === 'x') {
      const qubit = operation.targets[0] as number
      pulses[qubit] = (pulses[qubit] ?? 0) + 1
      continue
    }
    if (operation.gate === 'measure') {
      for (const qubit of operation.targets) measured.add(qubit)
    }
  }

  return {
    interactions: [...pairs.values()]
      .map((entry) => ({
        a: entry.a,
        b: entry.b,
        count: entry.count,
        operationIds: [...entry.ids],
      }))
      .sort((left, right) => right.count - left.count || left.a - right.a),
    // Sized to the register rather than to the highest index written, so that
    // `pulses[q]` is a number for every declared wire and never `undefined`
    // for an idle one.
    pulses: Array.from({ length: qubits }, (_unused, i) => pulses[i] ?? 0),
    measured: [...measured].sort((a, b) => a - b),
    twoQubitGates,
  }
}

/* ─────────────────────────────── helpers ─────────────────────────────── */

function angles(
  operation: Operation,
  parameters: readonly { name: string; value: number }[]
): readonly number[] {
  try {
    return resolveParams(operation, parameters)
  } catch {
    throw new TranspileRefusal(
      'unsupported-parameter',
      `Operation "${operation.id}" references a parameter the circuit does ` +
        `not declare, so its angle has no value to compile.`,
      { operation: operation.id },
      [operation.id]
    )
  }
}

function eulerOfChecked(
  operation: Operation,
  base: OneQubitCatalogId,
  params: readonly number[]
): EulerAngles {
  try {
    return eulerOf(base, params)
  } catch (cause) {
    throw new TranspileRefusal(
      'unsupported-parameter',
      `Operation "${operation.id}" cannot be turned into Euler angles: ` +
        `${String(cause)}`,
      { operation: operation.id, gate: operation.gate },
      [operation.id]
    )
  }
}

/**
 * The catalog ids this file claims to handle, computed from `GATES` so that a
 * gate added to the contract shows up here rather than in a user's circuit.
 * Read only by `catalog-coverage.test.ts`.
 */
export function decomposableGateIds(): readonly GateId[] {
  return (Object.keys(GATES) as GateId[]).filter(
    (id) => GATES[id].category !== 'structural'
  )
}
