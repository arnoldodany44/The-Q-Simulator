/**
 * Refusals, and the argument for preferring one to a worse answer.
 *
 * ── THE SWAP THAT IS NOT INSERTED ────────────────────────────────────────
 *
 * A circuit whose qubits must interact in a pattern the device's wiring
 * cannot hold has exactly two honest outcomes: rewrite it so that the pattern
 * changes (which means inserting SWAPs and *routing*), or say so.
 *
 * This package says so, and the reason is arithmetic. A SWAP is three CNOTs;
 * a CNOT on a Heron chip is one `cz` plus single-qubit pulses; and `cz` is the
 * noisiest calibrated operation on the device — the median two-qubit error on
 * the machine this was measured against is 3.4e-3, against 3.8e-4 for `sx`,
 * an order of magnitude worse. So each inserted SWAP costs about one percent
 * of the run's fidelity, and a router that needs a handful of them turns a
 * two-qubit demonstration into a histogram of noise. The result still arrives.
 * It still looks like a distribution. Nothing anywhere says it is meaningless.
 *
 * A refusal that names what the circuit needs and what the device has teaches
 * the reader something true — that connectivity, not qubit count, is what
 * bounds a NISQ machine — and costs them nothing. A half-good router teaches
 * them that the machine is bad at arithmetic.
 *
 * ── SO EVERY REFUSAL CARRIES NUMBERS ─────────────────────────────────────
 *
 * `code` is what the API and the three i18n catalogs key on; nothing here is
 * ever displayed verbatim, per decision D2 and the rule that the server
 * produces codes and the client translates them. `message` is for a
 * developer's console and for this package's own tests. `detail` is what the
 * translated sentence interpolates: "needs 4 neighbours, the device has at
 * most 3" is a fact, and a fact is what makes a refusal worth reading.
 */

/** Why a circuit cannot be run on a device, as a machine-readable code. */
export type RefusalCode =
  /** A gate neither in the catalog nor declared in `customGates`. */
  | 'unsupported-gate'
  /** More controls than any construction here can place without ancillas. */
  | 'too-many-controls'
  /** An angle that is not a finite number, or a parameter with no value. */
  | 'unsupported-parameter'
  /** The device does not offer the five gates this package emits. */
  | 'device-basis-mismatch'
  /** More qubits in the circuit than in the device. */
  | 'too-many-qubits'
  /** A qubit that must talk to more neighbours than any physical one has. */
  | 'degree-exceeded'
  /** An interaction cycle shorter than the shortest cycle the lattice has. */
  | 'cycle-too-short'
  /** The search finished and no injective placement satisfies the circuit. */
  | 'no-placement'
  /** The search hit its node budget before deciding. */
  | 'search-exhausted'
  /** The decomposed circuit needs more columns than the contract allows. */
  | 'too-deep'
  /** Nothing is measured, so a hardware run would return no bits at all. */
  | 'no-measurement'

/**
 * A circuit this package will not compile, with the numbers that say why.
 *
 * `detail` is deliberately a flat record of primitives: it crosses the wire to
 * the client as JSON and is interpolated into a translated sentence, so a
 * nested object or a class instance would be a shape the catalogs cannot
 * spell.
 */
export class TranspileRefusal extends Error {
  readonly code: RefusalCode
  readonly detail: Readonly<Record<string, string | number>>
  /** Source operations implicated, so a UI can point at them. */
  readonly operationIds: readonly string[]

  constructor(
    code: RefusalCode,
    message: string,
    detail: Readonly<Record<string, string | number>> = {},
    operationIds: readonly string[] = []
  ) {
    super(message)
    this.name = 'TranspileRefusal'
    this.code = code
    this.detail = detail
    this.operationIds = operationIds
  }
}

/** `transpile`, answering instead of throwing. */
export type TranspileOutcome<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: TranspileRefusal }
