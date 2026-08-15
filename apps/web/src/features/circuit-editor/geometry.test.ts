import { emptyCircuit, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_METRICS,
  MIN_COLUMNS,
  cellBounds,
  cellCenter,
  classicalY,
  columnCount,
  columnX,
  gateBounds,
  gridSizeOf,
  nearestCell,
  plotHeight,
  plotWidth,
  pointToCell,
  qubitY,
  type GridMetrics,
  type GridSize,
} from './geometry'

/**
 * The round trip is the whole point of this module, so it is checked over
 * every cell of several grids rather than over a handful of samples. A hit
 * test that is right in the middle of a cell and wrong at its edge is
 * exactly the bug this catches: it only shows up when a user drops a gate
 * near a boundary, and by then the symptom is "the gate went somewhere
 * else", which says nothing about where to look.
 */

/** Small, typical, and past the browser's practical qubit ceiling. */
const SIZES: readonly GridSize[] = [
  { qubits: 1, clbits: 0, columns: 1 },
  { qubits: 3, clbits: 0, columns: 8 },
  { qubits: 3, clbits: 2, columns: 8 },
  { qubits: 5, clbits: 1, columns: 2 },
  { qubits: 20, clbits: 64, columns: 40 },
]

/** A second, deliberately odd geometry, to catch anything tuned to the first. */
const DENSE: GridMetrics = {
  columnWidth: 31,
  rowHeight: 27,
  padX: 7,
  padY: 3,
  gateSize: 21,
  registerGap: 9,
}

const METRICS: readonly GridMetrics[] = [DEFAULT_METRICS, DENSE]

/** Small enough to stay inside a cell, large enough to survive rounding. */
const NUDGE = 0.001

function everyCell(size: GridSize): { qubit: number; column: number }[] {
  const cells = []
  for (let qubit = 0; qubit < size.qubits; qubit++) {
    for (let column = 0; column < size.columns; column++) {
      cells.push({ qubit, column })
    }
  }
  return cells
}

describe('cell ↔ point round trip', () => {
  it.each(METRICS.flatMap((m) => SIZES.map((s) => [s, m] as const)))(
    'maps every cell centre back to its own cell (%j)',
    (size, metrics) => {
      for (const cell of everyCell(size)) {
        expect(pointToCell(cellCenter(cell, metrics), size, metrics)).toEqual(
          cell
        )
      }
    }
  )

  it.each(METRICS.flatMap((m) => SIZES.map((s) => [s, m] as const)))(
    'assigns every corner of a cell to that cell (%j)',
    (size, metrics) => {
      for (const cell of everyCell(size)) {
        const box = cellBounds(cell, metrics)
        const corners = [
          { x: box.x, y: box.y },
          { x: box.x + box.width - NUDGE, y: box.y },
          { x: box.x, y: box.y + box.height - NUDGE },
          { x: box.x + box.width - NUDGE, y: box.y + box.height - NUDGE },
        ]
        for (const corner of corners) {
          expect(pointToCell(corner, size, metrics)).toEqual(cell)
        }
      }
    }
  )

  it('tiles the plot without gaps: a cell ends where the next begins', () => {
    const size = SIZES[4]!
    for (const cell of everyCell(size)) {
      const box = cellBounds(cell)
      if (cell.column + 1 < size.columns) {
        expect(cellBounds({ ...cell, column: cell.column + 1 }).x).toBe(
          box.x + box.width
        )
      }
      if (cell.qubit + 1 < size.qubits) {
        expect(cellBounds({ ...cell, qubit: cell.qubit + 1 }).y).toBe(
          box.y + box.height
        )
      }
    }
  })

  it('centres a cell inside its own bounds', () => {
    for (const metrics of METRICS) {
      for (const cell of everyCell(SIZES[1]!)) {
        const box = cellBounds(cell, metrics)
        const centre = cellCenter(cell, metrics)
        expect(centre.x).toBeCloseTo(box.x + box.width / 2, 10)
        expect(centre.y).toBeCloseTo(box.y + box.height / 2, 10)
      }
    }
  })
})

describe('pointToCell outside the grid', () => {
  const size: GridSize = { qubits: 3, clbits: 1, columns: 4 }

  it('refuses the padding before column 0 and above qubit 0', () => {
    expect(pointToCell({ x: 0, y: qubitY(0) }, size)).toBeNull()
    expect(pointToCell({ x: columnX(0), y: 0 }, size)).toBeNull()
  })

  it('refuses points past the last column and the last qubit', () => {
    expect(pointToCell({ x: columnX(size.columns), y: qubitY(0) }, size)).toBe(
      null
    )
    expect(pointToCell({ x: columnX(0), y: qubitY(size.qubits) }, size)).toBe(
      null
    )
  })

  /*
   * Nothing is ever placed on the classical wire — a measurement reaches it
   * from its qubit. Reporting a cell there would let a drag drop a gate onto
   * the register.
   */
  it('refuses the classical register wire', () => {
    expect(pointToCell({ x: columnX(1), y: classicalY(size) }, size)).toBeNull()
  })
})

describe('nearestCell', () => {
  const size: GridSize = { qubits: 4, clbits: 0, columns: 6 }

  it('agrees with pointToCell everywhere inside the grid', () => {
    for (const cell of everyCell(size)) {
      expect(nearestCell(cellCenter(cell), size)).toEqual(cell)
    }
  })

  it('clamps a point in the padding to the nearest edge cell', () => {
    expect(nearestCell({ x: -500, y: -500 }, size)).toEqual({
      qubit: 0,
      column: 0,
    })
    expect(nearestCell({ x: 5000, y: 5000 }, size)).toEqual({
      qubit: size.qubits - 1,
      column: size.columns - 1,
    })
  })
})

describe('plot dimensions', () => {
  it('leaves the same padding after the last wire as before the first', () => {
    const size: GridSize = { qubits: 6, clbits: 0, columns: 3 }
    const lastWireBottom =
      qubitY(size.qubits - 1) + DEFAULT_METRICS.rowHeight / 2
    expect(plotHeight(size)).toBe(lastWireBottom + DEFAULT_METRICS.padY)
  })

  it('makes room for the classical wire only when there is one', () => {
    const withRegister: GridSize = { qubits: 2, clbits: 3, columns: 3 }
    const without: GridSize = { ...withRegister, clbits: 0 }
    expect(plotHeight(withRegister) - plotHeight(without)).toBe(
      DEFAULT_METRICS.registerGap + DEFAULT_METRICS.rowHeight
    )
    expect(classicalY(withRegister) + DEFAULT_METRICS.rowHeight / 2).toBe(
      plotHeight(withRegister) - DEFAULT_METRICS.padY
    )
  })

  it('keeps the classical wire below the last qubit', () => {
    const size: GridSize = { qubits: 3, clbits: 1, columns: 1 }
    expect(classicalY(size)).toBeGreaterThan(
      qubitY(size.qubits - 1) + DEFAULT_METRICS.rowHeight / 2
    )
  })

  it('widens with the column count', () => {
    const narrow: GridSize = { qubits: 1, clbits: 0, columns: 4 }
    const wide: GridSize = { ...narrow, columns: 9 }
    expect(plotWidth(wide) - plotWidth(narrow)).toBe(
      5 * DEFAULT_METRICS.columnWidth
    )
  })
})

describe('gateBounds', () => {
  it('never spills into the neighbouring column', () => {
    for (const label of ['H', '√X', 'iSWAP', 'CSWAP', 'a-very-long-name']) {
      const box = gateBounds(
        { qubit: 0, column: 2 },
        DEFAULT_METRICS,
        label.length
      )
      const cell = cellBounds({ qubit: 0, column: 2 })
      expect(box.x).toBeGreaterThanOrEqual(cell.x)
      expect(box.x + box.width).toBeLessThanOrEqual(cell.x + cell.width)
    }
  })

  it('is never smaller than the nominal gate size', () => {
    const box = gateBounds({ qubit: 0, column: 0 })
    expect(box.width).toBeGreaterThanOrEqual(DEFAULT_METRICS.gateSize)
    expect(box.height).toBe(DEFAULT_METRICS.gateSize)
  })

  it('stays centred on its cell', () => {
    const box = gateBounds({ qubit: 1, column: 3 }, DEFAULT_METRICS, 5)
    const centre = cellCenter({ qubit: 1, column: 3 })
    expect(box.x + box.width / 2).toBeCloseTo(centre.x, 10)
    expect(box.y + box.height / 2).toBeCloseTo(centre.y, 10)
  })
})

describe('grid size from a circuit', () => {
  function circuitWithColumns(columns: readonly number[]): Circuit {
    return {
      ...emptyCircuit(2),
      operations: columns.map((column, index) => ({
        id: `op_${index}`,
        gate: 'h',
        targets: [0],
        column,
      })),
    }
  }

  it('counts columns as one past the last one used, gaps included', () => {
    expect(columnCount(emptyCircuit(2))).toBe(0)
    expect(columnCount(circuitWithColumns([0, 7]))).toBe(8)
    expect(columnCount(circuitWithColumns([3]))).toBe(4)
  })

  it('pads a short circuit out to somewhere to drop the next gate', () => {
    expect(gridSizeOf(emptyCircuit(3)).columns).toBe(MIN_COLUMNS)
    expect(gridSizeOf(emptyCircuit(3), 20).columns).toBe(20)
  })

  it('never truncates a circuit that is wider than the minimum', () => {
    const wide = circuitWithColumns([0, 30])
    expect(gridSizeOf(wide).columns).toBe(31)
  })

  it('carries the registers through unchanged', () => {
    const size = gridSizeOf(emptyCircuit(4, 2))
    expect(size.qubits).toBe(4)
    expect(size.clbits).toBe(2)
  })
})
