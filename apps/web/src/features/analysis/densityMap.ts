/**
 * The model behind the density heat map — §3.2's advanced mode: "matriz de
 * densidad: mapa de calor de la parte real e imaginaria".
 *
 * No React and no i18next, the same split every model here makes. No physics
 * either: ρ is built by `runNoisyDensity` on the worker and the block that
 * reaches this module is already chosen and already cut down to size
 * (`simulation/noiseJob.ts`). What is left is what a cell looks like.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHAT THE PICTURE IS FOR
 *
 * The diagonal of ρ is the histogram — every population, already drawn above.
 * The reason to draw the matrix at all is the *off*-diagonal: ρ_ij for i ≠ j is
 * the coherence between two basis states, it is what a superposition is made
 * of, and it is what noise removes first. A phase-damping channel leaves every
 * population untouched and empties the off-diagonals, which is a change no
 * histogram in this app can show — the bars do not move at all. On this map the
 * corners fade out while the diagonal stays put, and that is the whole lesson.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE COLOUR IS THE PHASE MAPPING, NOT A SECOND PALETTE
 *
 * §10's rule is that colour is phase, through one formula, once. A real part is
 * a complex number whose phase is 0 when it is positive and π when it is
 * negative; an imaginary part is one whose phase is π/2 or 3π/2. So the four
 * signs of the two grids are the four cardinal phases, and the cells are
 * painted by `phaseToColour` with no new colours invented and no new contrast
 * to measure — the sweep in `verification/design/token-contrast.test.ts`
 * already proved every hue on that circle clears 3:1 on all three surfaces.
 *
 * A reader who has learned "opposite colours cancel" from the phasors reads a
 * positive and a negative coherence as opposite colours here, which is true and
 * is the same fact.
 *
 * MAGNITUDE IS OPACITY, AND THE OUTLINE IS WHAT STAYS. A cell fades as its
 * entry goes to zero, because an entry of zero is *nothing there* and drawing
 * it as a solid block of a pale colour would be drawing a coherence the state
 * does not have. What does not fade is the cell's outline, in `--chart-grid`,
 * which is what keeps the grid legible as a grid — the same division `index.css`
 * already makes for the histogram's track: "fill for the hint, hairline for the
 * boundary".
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE TABLE IS THE RENDERING, AND IT IS VISIBLE
 *
 * A cell's colour and opacity are not a length anyone can compare by eye, so
 * this panel is in the same position the Bloch spheres are and takes the same
 * decision: the grids are `aria-hidden` decoration and the numbers beside them
 * carry the meaning, *visibly*, because a low-vision reader who does not use a
 * screen reader would otherwise have no rendering at all.
 *
 * It is a table of entries rather than a grid of cells, and that is a decision
 * about what a table is for. A 16 × 16 grid transcribed cell by cell is 256
 * cells of `a + bi` — sixteen columns of eighteen characters, which no screen
 * reader can navigate and no scroller can make readable. A matrix at these
 * sizes is overwhelmingly zeros, so the honest table is a list of the entries
 * that are *not*: row state, column state, real part, imaginary part,
 * magnitude, one row each, largest first. Everything it leaves out is below the
 * floor, and the notice says how many.
 */

import type { DensityBlock } from '../simulation/protocol'
import { normalizePhase } from '../../lib/phase-colour'

/**
 * Below this an entry is Float64 residue rather than a coherence the circuit
 * produced.
 *
 * Applied to |ρ_ij| rather than to its square, so it is the amplitude-scale
 * counterpart of `PROBABILITY_FLOOR` and is derived from it for the reason
 * `format.ts` derives `AMPLITUDE_FLOOR` the same way: a cell the map paints is
 * a cell this table must list, and a cell the map leaves blank is residue the
 * table may drop.
 */
export const ENTRY_FLOOR = 1e-6

/** Which of the two grids a cell belongs to. */
export type MapPart = 'real' | 'imaginary'

/** One cell of one grid. */
export interface DensityCell {
  /** Position within the block, not the statevector index. */
  readonly row: number
  readonly column: number
  /** The signed value this cell paints. */
  readonly value: number
  /**
   * The phase this cell's colour comes from: 0 or π for the real grid, π/2 or
   * 3π/2 for the imaginary one. Zero-valued cells take the positive phase and
   * are painted at zero opacity, so nothing about them is visible anyway.
   */
  readonly phase: number
  /** |value| scaled against the block's largest entry, in `[0, 1]`. */
  readonly weight: number
}

/** One entry of the matrix, as the accessible table lists it. */
export interface DensityEntry {
  readonly row: number
  readonly column: number
  /** `formatKet` labels of the two basis states this entry connects. */
  readonly rowLabel: string
  readonly columnLabel: string
  readonly re: number
  readonly im: number
  readonly magnitude: number
  /** Whether this is a population (a diagonal entry) or a coherence. */
  readonly diagonal: boolean
}

export interface DensityMap {
  /** Basis-state labels of the rows and columns, in ascending index order. */
  readonly labels: readonly string[]
  readonly real: readonly DensityCell[]
  readonly imaginary: readonly DensityCell[]
  /** Entries above the floor, largest magnitude first. */
  readonly entries: readonly DensityEntry[]
  /** Entries of the drawn block that fell below the floor. */
  readonly negligible: number
  /** The largest |ρ_ij| in the block — what `weight` is measured against. */
  readonly peak: number
  /** Basis states with population that the block's cap left out. */
  readonly hidden: number
  /** The population those states hold between them. */
  readonly hiddenPopulation: number
  /** The cap the block was built with, for the notice to quote. */
  readonly limit: number
}

/**
 * Two grids and one list of entries, from the block the worker sent.
 *
 * `weight` is measured against the block's own largest entry rather than
 * against 1, and that is what makes the picture readable at all: after a
 * depolarising channel on eight qubits every entry is a few thousandths, and a
 * map scaled to 1 would be a uniformly blank square that says "nothing here"
 * about a state whose structure is perfectly intact. The peak is printed beside
 * the map so the scale is never a secret.
 */
export function buildDensityMap(block: DensityBlock): DensityMap {
  const size = block.indices.length
  const at = (row: number, column: number): { re: number; im: number } => ({
    re: block.re[row * size + column] ?? 0,
    im: block.im[row * size + column] ?? 0,
  })

  let peak = 0
  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const { re, im } = at(row, column)
      peak = Math.max(peak, Math.hypot(re, im))
    }
  }

  const real: DensityCell[] = []
  const imaginary: DensityCell[] = []
  const entries: DensityEntry[] = []
  let negligible = 0

  for (let row = 0; row < size; row++) {
    for (let column = 0; column < size; column++) {
      const { re, im } = at(row, column)
      real.push(cellOf(row, column, re, 0, Math.PI, peak))
      imaginary.push(cellOf(row, column, im, Math.PI / 2, -Math.PI / 2, peak))

      const magnitude = Math.hypot(re, im)
      if (magnitude <= ENTRY_FLOOR) {
        negligible += 1
        continue
      }
      entries.push({
        row,
        column,
        rowLabel: block.labels[row] ?? '',
        columnLabel: block.labels[column] ?? '',
        re,
        im,
        magnitude,
        diagonal: row === column,
      })
    }
  }

  // Largest first, ties by position, so a maximally mixed ρ — where every
  // diagonal entry is identical — lists them in reading order rather than in
  // whichever order the sort happened to leave them.
  entries.sort(
    (a, b) => b.magnitude - a.magnitude || a.row - b.row || a.column - b.column
  )

  return {
    labels: block.labels,
    real,
    imaginary,
    entries,
    negligible,
    peak,
    hidden: block.hidden,
    hiddenPopulation: block.hiddenPopulation,
    limit: block.limit,
  }
}

function cellOf(
  row: number,
  column: number,
  value: number,
  positivePhase: number,
  negativePhase: number,
  peak: number
): DensityCell {
  return {
    row,
    column,
    value,
    phase: normalizePhase(value < 0 ? negativePhase : positivePhase),
    // A block of exactly zero has no scale, and every weight in it is 0 — which
    // is the right picture and not a division by zero.
    weight: peak <= 0 ? 0 : Math.min(1, Math.abs(value) / peak),
  }
}
