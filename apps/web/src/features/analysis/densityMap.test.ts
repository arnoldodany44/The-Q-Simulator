/**
 * The density heat map's model.
 *
 * The claim worth pinning is the encoding, because it is the one place in the
 * app where a sign becomes a colour: §10 says colour is phase through one
 * formula, so a positive real part is phase 0 and a negative one is phase π,
 * and the two imaginary signs are the quarter turns between. Getting that
 * backwards would paint a coherence as its own negation — a picture that is
 * exactly wrong and looks exactly right.
 *
 * The rest is about the cap and the floor being stated rather than silent.
 */

import { describe, expect, it } from 'vitest'

import type { DensityBlock } from '../simulation/protocol'
import { ENTRY_FLOOR, buildDensityMap } from './densityMap'

const DIGITS = 10

/** A block from a flat list of [re, im] pairs, row-major. */
function blockOf(
  labels: string[],
  entries: [number, number][],
  patch: Partial<DensityBlock> = {}
): DensityBlock {
  return {
    indices: labels.map((_unused, index) => index),
    labels,
    re: Float64Array.from(entries.map(([re]) => re)),
    im: Float64Array.from(entries.map(([, im]) => im)),
    hidden: 0,
    hiddenPopulation: 0,
    limit: 16,
    ...patch,
  }
}

/** ρ of a Bell pair: ½ everywhere, all real. */
function bellBlock(): DensityBlock {
  return blockOf(
    ['00', '11'],
    [
      [0.5, 0],
      [0.5, 0],
      [0.5, 0],
      [0.5, 0],
    ]
  )
}

describe('the colour encoding', () => {
  it('maps a positive real part to phase 0 and a negative one to phase π', () => {
    const map = buildDensityMap(
      blockOf(
        ['0', '1'],
        [
          [0.5, 0],
          [-0.5, 0],
          [-0.5, 0],
          [0.5, 0],
        ]
      )
    )
    expect(map.real[0]?.phase).toBeCloseTo(0, DIGITS)
    expect(map.real[1]?.phase).toBeCloseTo(Math.PI, DIGITS)
  })

  it('maps the imaginary signs to the quarter turns', () => {
    const map = buildDensityMap(
      blockOf(
        ['0', '1'],
        [
          [0, 0.5],
          [0, -0.5],
          [0, 0.5],
          [0, -0.5],
        ]
      )
    )
    expect(map.imaginary[0]?.phase).toBeCloseTo(Math.PI / 2, DIGITS)
    // Folded into [0, 2π) by `normalizePhase`, as every phase in this app is.
    expect(map.imaginary[1]?.phase).toBeCloseTo((3 * Math.PI) / 2, DIGITS)
  })

  it('measures opacity against the block’s own largest entry', () => {
    /*
     * Against the block rather than against 1, and that is what makes the map
     * readable at all: after a depolarising channel on eight qubits every entry
     * is a few thousandths, and a map scaled to 1 would be a uniformly blank
     * square claiming "nothing here" about a state whose structure is intact.
     * The peak is printed beside the map, so the scale is never a secret.
     */
    const map = buildDensityMap(
      blockOf(
        ['0', '1'],
        [
          [0.004, 0],
          [0.002, 0],
          [0.002, 0],
          [0.001, 0],
        ]
      )
    )
    expect(map.peak).toBeCloseTo(0.004, DIGITS)
    expect(map.real[0]?.weight).toBeCloseTo(1, DIGITS)
    expect(map.real[1]?.weight).toBeCloseTo(0.5, DIGITS)
    expect(map.real[3]?.weight).toBeCloseTo(0.25, DIGITS)
  })

  it('answers zero weights rather than dividing by zero for an empty block', () => {
    const map = buildDensityMap(
      blockOf(
        ['0', '1'],
        [
          [0, 0],
          [0, 0],
          [0, 0],
          [0, 0],
        ]
      )
    )
    expect(map.peak).toBe(0)
    for (const cell of map.real) expect(cell.weight).toBe(0)
  })
})

describe('the entry table', () => {
  it('lists every entry of a Bell pair, populations and coherences alike', () => {
    const map = buildDensityMap(bellBlock())
    expect(map.entries).toHaveLength(4)
    expect(map.entries.filter((entry) => entry.diagonal)).toHaveLength(2)
    expect(map.negligible).toBe(0)
  })

  it('names the two basis states an entry connects', () => {
    const map = buildDensityMap(bellBlock())
    const offDiagonal = map.entries.find((entry) => !entry.diagonal)
    expect(offDiagonal?.rowLabel).not.toBe(offDiagonal?.columnLabel)
    expect([offDiagonal?.rowLabel, offDiagonal?.columnLabel].sort()).toEqual([
      '00',
      '11',
    ])
  })

  it('drops residue below the floor and counts what it dropped', () => {
    // The floor is Float64 residue, not physics: an entry at 1e-14 is what a
    // sum over 2ⁿ terms leaves behind, and listing it as a coherence would be
    // inventing structure.
    const map = buildDensityMap(
      blockOf(
        ['0', '1'],
        [
          [1, 0],
          [ENTRY_FLOOR / 10, 0],
          [ENTRY_FLOOR / 10, 0],
          [0, 0],
        ]
      )
    )
    expect(map.entries).toHaveLength(1)
    expect(map.negligible).toBe(3)
    // The grids still have a cell for every position — they are drawn at zero
    // opacity, which is what "nothing here" looks like.
    expect(map.real).toHaveLength(4)
    expect(map.imaginary).toHaveLength(4)
  })

  it('lists the largest entries first, and ties in reading order', () => {
    // A maximally mixed ρ has an identical diagonal, and a sort that depended
    // on its own stability would list them in a different order per run.
    const map = buildDensityMap(
      blockOf(
        ['00', '01', '10', '11'],
        Array.from({ length: 16 }, (_unused, index) =>
          index % 5 === 0
            ? ([0.25, 0] as [number, number])
            : ([0, 0] as [number, number])
        )
      )
    )
    expect(map.entries.map((entry) => [entry.row, entry.column])).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
    ])
  })

  it('carries the cap through so the notice can quote it', () => {
    const map = buildDensityMap(
      blockOf(
        ['00', '11'],
        [
          [0.5, 0],
          [0, 0],
          [0, 0],
          [0.5, 0],
        ],
        { hidden: 6, hiddenPopulation: 0.25, limit: 16 }
      )
    )
    expect(map.hidden).toBe(6)
    expect(map.hiddenPopulation).toBeCloseTo(0.25, DIGITS)
    expect(map.limit).toBe(16)
    expect(map.labels).toEqual(['00', '11'])
  })
})
