/**
 * The Bloch spheres' presentation model.
 *
 * Two claims here are load-bearing enough that the picture is wrong without
 * them, and neither is visible in a screenshot:
 *
 *  1. **The camera and the projection are the same camera.** three.js draws
 *     the sphere and an SVG layer writes the labels, so if the two disagree
 *     by a degree the letter `x` sits beside the x axis rather than on it —
 *     which does not read as a rounding error, it reads as a mislabelled
 *     diagram. The test for it is that a cell placed where the scene places
 *     it projects back to exactly where the overlay expects it.
 *
 *  2. **A turn about z leaves z where it was.** That invariance is what lets
 *     `|0⟩` and `|1⟩` be placed once by React and left alone while the frame
 *     loop moves only `x` and `y`. If it failed, the poles would drift off
 *     their axis at every azimuth but the first.
 */

import { describe, expect, it } from 'vitest'

import {
  CELL_UNITS,
  LABEL_RADIUS,
  READING_TOLERANCE,
  VIEW_AZIMUTH,
  VIEW_ELEVATION,
  cellCentrePx,
  cellOffset,
  project,
  projectOnCell,
  qubitName,
  readingOf,
  shortenedCount,
  sphereGrid,
  viewDirection,
  viewRight,
  viewUp,
  type Point3,
} from './bloch'

const DIGITS = 10

const AZIMUTHS = [0, VIEW_AZIMUTH, 1, Math.PI / 2, 2.7, Math.PI, 5.5]

const dot = (a: Point3, b: Point3): number => a.x * b.x + a.y * b.y + a.z * b.z
const cross = (a: Point3, b: Point3): Point3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
})

describe('the camera frame', () => {
  it('is orthonormal and right-handed at every azimuth', () => {
    for (const azimuth of AZIMUTHS) {
      const forward = viewDirection(azimuth)
      const up = viewUp(azimuth)
      const right = viewRight(azimuth)

      expect(dot(forward, forward)).toBeCloseTo(1, DIGITS)
      expect(dot(up, up)).toBeCloseTo(1, DIGITS)
      expect(dot(right, right)).toBeCloseTo(1, DIGITS)

      expect(dot(forward, up)).toBeCloseTo(0, DIGITS)
      expect(dot(forward, right)).toBeCloseTo(0, DIGITS)
      expect(dot(up, right)).toBeCloseTo(0, DIGITS)

      // right = up × forward, which is what makes the picture the right way
      // round rather than mirrored.
      const expected = cross(up, forward)
      expect(right.x).toBeCloseTo(expected.x, DIGITS)
      expect(right.y).toBeCloseTo(expected.y, DIGITS)
      expect(right.z).toBeCloseTo(expected.z, DIGITS)
    }
  })

  it('never rolls: right stays horizontal', () => {
    for (const azimuth of AZIMUTHS) {
      expect(viewRight(azimuth).z).toBeCloseTo(0, DIGITS)
    }
  })

  it('looks down on the equator from above it', () => {
    // A positive z component is what turns the equator from a line into an
    // ellipse, which is the whole of the depth cue in an orthographic view.
    expect(viewDirection(VIEW_AZIMUTH).z).toBeCloseTo(
      Math.sin(VIEW_ELEVATION),
      DIGITS
    )
    expect(viewDirection(VIEW_AZIMUTH).z).toBeGreaterThan(0)
  })
})

describe('the projection', () => {
  it('sends z straight up, at every azimuth', () => {
    for (const azimuth of AZIMUTHS) {
      const north = project({ x: 0, y: 0, z: 1 }, azimuth)
      const south = project({ x: 0, y: 0, z: -1 }, azimuth)

      expect(north.x).toBeCloseTo(0, DIGITS)
      expect(north.y).toBeCloseTo(Math.cos(VIEW_ELEVATION), DIGITS)
      expect(south.x).toBeCloseTo(0, DIGITS)
      expect(south.y).toBeCloseTo(-Math.cos(VIEW_ELEVATION), DIGITS)
    }
  })

  it('puts x to the left and y to the right, both below the equator', () => {
    // The conventional Bloch picture, and the reason the labels do not
    // collide: at the starting azimuth the two equatorial axes go to
    // opposite sides of the sphere.
    const xTip = project({ x: 1, y: 0, z: 0 }, VIEW_AZIMUTH)
    const yTip = project({ x: 0, y: 1, z: 0 }, VIEW_AZIMUTH)

    expect(xTip.x).toBeLessThan(0)
    expect(yTip.x).toBeGreaterThan(0)
    expect(xTip.y).toBeLessThan(0)
    expect(yTip.y).toBeLessThan(0)
  })

  it('is the dot product with the camera frame', () => {
    const point = { x: 0.3, y: -0.7, z: 0.42 }
    for (const azimuth of AZIMUTHS) {
      const screen = project(point, azimuth)
      expect(screen.x).toBeCloseTo(dot(point, viewRight(azimuth)), DIGITS)
      expect(screen.y).toBeCloseTo(dot(point, viewUp(azimuth)), DIGITS)
    }
  })

  it('never magnifies: a unit vector lands inside the unit circle', () => {
    for (const azimuth of AZIMUTHS) {
      for (const point of [
        { x: 1, y: 0, z: 0 },
        { x: 0, y: 1, z: 0 },
        { x: 0, y: 0, z: 1 },
        { x: 0.5773, y: 0.5773, z: 0.5773 },
      ]) {
        const screen = project(point, azimuth)
        expect(Math.hypot(screen.x, screen.y)).toBeLessThanOrEqual(1 + 1e-12)
      }
    }
  })
})

describe('the scene and the overlay share one camera', () => {
  /*
   * The claim that keeps the labels on their axes. `BlochScene` positions a
   * cell at `right·x + up·y` in world space; the overlay assumes that point
   * projects to (x, y). If those two ever drift apart, every label in the
   * grid is offset by the same wrong amount — a picture that looks fine and
   * is mislabelled.
   */
  it('projects a cell placed in the camera plane back to its own offset', () => {
    const grid = sphereGrid(7)
    for (const azimuth of AZIMUTHS) {
      const right = viewRight(azimuth)
      const up = viewUp(azimuth)

      for (let index = 0; index < grid.qubits; index++) {
        const offset = cellOffset(grid, index)
        const world = {
          x: right.x * offset.x + up.x * offset.y,
          y: right.y * offset.x + up.y * offset.y,
          z: right.z * offset.x + up.z * offset.y,
        }
        const screen = project(world, azimuth)
        expect(screen.x).toBeCloseTo(offset.x, DIGITS)
        expect(screen.y).toBeCloseTo(offset.y, DIGITS)
      }
    }
  })

  it('keeps the poles at a fixed pixel position however far it has turned', () => {
    const grid = sphereGrid(4)
    const reference = projectOnCell(
      grid,
      2,
      { x: 0, y: 0, z: LABEL_RADIUS },
      VIEW_AZIMUTH
    )
    for (const azimuth of AZIMUTHS) {
      const moved = projectOnCell(
        grid,
        2,
        { x: 0, y: 0, z: LABEL_RADIUS },
        azimuth
      )
      expect(moved.x).toBeCloseTo(reference.x, DIGITS)
      expect(moved.y).toBeCloseTo(reference.y, DIGITS)
    }
  })

  it('does move the equatorial labels — which is why they are written live', () => {
    const grid = sphereGrid(1)
    const at = (azimuth: number) =>
      projectOnCell(grid, 0, { x: LABEL_RADIUS, y: 0, z: 0 }, azimuth)

    const start = at(VIEW_AZIMUTH)
    const later = at(VIEW_AZIMUTH + 1)
    expect(Math.hypot(later.x - start.x, later.y - start.y)).toBeGreaterThan(1)
  })
})

describe('the grid', () => {
  it('fits every qubit, in rows no more than four wide', () => {
    for (let qubits = 1; qubits <= 20; qubits++) {
      const grid = sphereGrid(qubits)
      expect(grid.columns).toBeLessThanOrEqual(4)
      expect(grid.columns * grid.rows).toBeGreaterThanOrEqual(qubits)
      expect(grid.width).toBe(grid.columns * (grid.radius * CELL_UNITS))
    }
  })

  it('balances the rows rather than leaving a lone sphere', () => {
    // Five qubits are two rows of three, not a row of four and a straggler.
    expect(sphereGrid(5)).toMatchObject({ columns: 3, rows: 2 })
    expect(sphereGrid(6)).toMatchObject({ columns: 3, rows: 2 })
    expect(sphereGrid(4)).toMatchObject({ columns: 4, rows: 1 })
    expect(sphereGrid(20)).toMatchObject({ columns: 4, rows: 5 })
    expect(sphereGrid(1)).toMatchObject({ columns: 1, rows: 1 })
  })

  it('keeps every sphere, labels and all, inside the canvas', () => {
    for (const qubits of [1, 2, 5, 9, 20]) {
      const grid = sphereGrid(qubits)
      for (let index = 0; index < qubits; index++) {
        for (const point of [
          { x: LABEL_RADIUS, y: 0, z: 0 },
          { x: -LABEL_RADIUS, y: 0, z: 0 },
          { x: 0, y: LABEL_RADIUS, z: 0 },
          { x: 0, y: 0, z: LABEL_RADIUS },
          { x: 0, y: 0, z: -LABEL_RADIUS },
        ]) {
          for (const azimuth of AZIMUTHS) {
            const at = projectOnCell(grid, index, point, azimuth)
            expect(at.x).toBeGreaterThanOrEqual(0)
            expect(at.x).toBeLessThanOrEqual(grid.width)
            expect(at.y).toBeGreaterThanOrEqual(0)
            expect(at.y).toBeLessThanOrEqual(grid.height)
          }
        }
      }
    }
  })

  it('centres a lone sphere on the canvas', () => {
    const grid = sphereGrid(1)
    expect(cellCentrePx(grid, 0)).toEqual({
      x: grid.width / 2,
      y: grid.height / 2,
    })
  })

  it('lays cells out left to right, top to bottom', () => {
    const grid = sphereGrid(6)
    const first = cellCentrePx(grid, 0)
    const second = cellCentrePx(grid, 1)
    const fourth = cellCentrePx(grid, 3)

    expect(second.x).toBeGreaterThan(first.x)
    expect(second.y).toBe(first.y)
    expect(fourth.y).toBeGreaterThan(first.y)
    expect(fourth.x).toBe(first.x)
  })
})

describe('what a length reads as', () => {
  it('calls a full-length vector pure', () => {
    expect(readingOf(1)).toBe('pure')
    expect(readingOf(1 - READING_TOLERANCE / 2)).toBe('pure')
  })

  it('calls a zero vector the centre', () => {
    expect(readingOf(0)).toBe('centre')
    expect(readingOf(READING_TOLERANCE / 2)).toBe('centre')
  })

  it('calls everything between them shortened', () => {
    expect(readingOf(0.5)).toBe('shortened')
    expect(readingOf(0.999)).toBe('shortened')
    expect(readingOf(0.001)).toBe('shortened')
  })

  it('never contradicts the four decimals printed beside it', () => {
    /*
     * The tolerance is half of the last printed digit, so anything the table
     * shows as 1,0000 reads as pure and anything it shows as 0,0000 reads as
     * the centre. A word disagreeing with the number in the same row is the
     * defect this pins.
     */
    const printsAsOne = 1 - 4.9e-5
    const printsAsZero = 4.9e-5
    expect(readingOf(printsAsOne)).toBe('pure')
    expect(readingOf(printsAsZero)).toBe('centre')
  })

  it('counts the qubits that fall short', () => {
    const vectors = [
      { qubit: 0, x: 0, y: 0, z: 0, length: 0 },
      { qubit: 1, x: 0, y: 0, z: 0, length: 0 },
      { qubit: 2, x: 1, y: 0, z: 0, length: 1 },
      { qubit: 3, x: 0.5, y: 0, z: 0, length: 0.5 },
    ]
    expect(shortenedCount(vectors)).toBe(3)
    expect(shortenedCount([])).toBe(0)
  })
})

describe('wire names', () => {
  it('names wires the way an unlabelled canvas does', () => {
    expect(qubitName(0)).toBe('q0')
    expect(qubitName(11)).toBe('q11')
  })
})
