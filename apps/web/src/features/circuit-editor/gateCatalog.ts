/**
 * The palette's view of the gate catalog: what order the gates appear in,
 * and which key arms each one.
 *
 * The gates themselves, their arity and their symbols come from
 * `@qsim/schema`. Nothing is redefined here — this module only decides
 * presentation, so a gate added to the contract shows up in the palette
 * automatically and the compiler demands a key for it.
 *
 * ## Why every gate gets a key
 *
 * "Operable from the keyboard alone" is a requirement of §10, not a
 * courtesy, and a palette of twenty-six gates reachable only by twenty-six
 * presses of Tab satisfies it on paper and fails it in practice. One press
 * arms one gate.
 *
 * They are live while the grid or the palette has focus, and nowhere else in
 * the editor. WCAG 2.1.4 allows a single-character shortcut only if it can
 * be switched off, remapped, or is confined to the component it belongs to,
 * and the third is the one this editor can honestly claim today. It is also
 * the better behaviour: `c` used to arm a CNOT while the user was reaching
 * for the Copy button.
 *
 * The keys are hand-assigned rather than generated because mnemonics beat
 * consistency here: `h` for H and `c` for CNOT are guessable, and a scheme
 * that produced `g` for CNOT to keep some rule intact would be worse for
 * everyone. Where the mnemonic is already taken the gate falls back to a
 * digit — `s` belongs to S, so S† takes `2`. `KEY_COLLISIONS` in the test
 * proves the map stays injective.
 */

import {
  GATES,
  GATE_IDS,
  type GateCategory,
  type GateId,
  type GateMeta,
} from '@qsim/schema'

/**
 * Palette order. It is arity order, which is also difficulty order: a
 * beginner reads down the list and meets one-qubit gates before Toffoli.
 */
export const PALETTE_CATEGORIES = [
  'single',
  'parametrised',
  'two',
  'three',
  'structural',
] as const satisfies readonly GateCategory[]

/**
 * One key per gate, lower case, matched against `KeyboardEvent.key`.
 *
 * Typed as a total record so a new gate in the contract cannot ship without
 * a key. Digits fill in for the gates whose initial is already spoken for.
 */
export const GATE_KEYS: Readonly<Record<GateId, string>> = {
  i: '1',
  x: 'x',
  y: 'y',
  z: 'z',
  h: 'h',
  s: 's',
  sdg: '2',
  t: 't',
  tdg: '3',
  sx: '4',

  rx: 'r',
  ry: '5',
  rz: '6',
  p: 'p',
  u: 'u',

  cx: 'c',
  cz: '7',
  swap: 'w',
  iswap: '8',
  crz: '9',
  cp: '0',

  // Toffoli and Fredkin, by the names everyone actually says out loud.
  ccx: 'o',
  cswap: 'f',

  barrier: 'b',
  // `r` is Rx, so reset takes its second letter.
  reset: 'e',
  measure: 'm',
}

export interface PaletteGroup {
  readonly category: GateCategory
  readonly gates: readonly GateMeta[]
}

/** The palette, grouped and in order. */
export const PALETTE: readonly PaletteGroup[] = PALETTE_CATEGORIES.map(
  (category) => ({
    category,
    gates: GATE_IDS.map((id) => GATES[id]).filter(
      (meta) => meta.category === category
    ),
  })
)

/** Every gate in palette order, flattened — the roving tabindex's list. */
export const PALETTE_ORDER: readonly GateId[] = PALETTE.flatMap((group) =>
  group.gates.map((meta) => meta.id)
)

const BY_KEY = new Map<string, GateId>(
  (Object.entries(GATE_KEYS) as [GateId, string][]).map(([id, key]) => [
    key,
    id,
  ])
)

/**
 * The gate a keystroke arms, or `undefined` when the key means nothing here.
 * Case is folded so Shift does not silently disarm the palette.
 */
export function gateForKey(key: string): GateId | undefined {
  return key.length === 1 ? BY_KEY.get(key.toLowerCase()) : undefined
}
