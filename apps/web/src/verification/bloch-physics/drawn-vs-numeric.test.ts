/**
 * Does the picture draw the number?
 *
 * `BlochSpheres.tsx` prints r for every qubit and `BlochScene.tsx` draws an
 * arrow for it, and the two are only the same reading if the arrow's tip lands
 * exactly where the projection of (rx, ry, rz) says it should. Nothing in the
 * app can check that: the canvas is `aria-hidden` and its pixels are not a
 * queryable surface.
 *
 * So this file rebuilds the scene's geometry with three exactly as
 * `BlochScene.buildScene`/`draw` do — same camera frustum, same position, same
 * `up`, same per-cell placement, same `ArrowHelper` calls — and then asks
 * three where the arrow tip actually is, projects it through three's own
 * camera, and compares that pixel with `projectOnCell` from `bloch.ts`, which
 * is what places the SVG labels. Two independent renderers, one number.
 *
 * It also states the negative: an arrow drawn at unit length whatever the
 * reading (the thing §5.5 forbids) puts the tip of a Bell pair's arrow on the
 * surface instead of at the centre, and the assertions below would fail.
 */

import { blochVector, run, type Statevector } from '@qsim/core'
import { parseCircuit, type CircuitInput } from '@qsim/schema'
import { ArrowHelper, Group, OrthographicCamera, Scene, Vector3 } from 'three'
import { describe, expect, it } from 'vitest'

import {
  CELL_UNITS,
  LABEL_RADIUS,
  VIEW_AZIMUTH,
  cellCentrePx,
  cellOffset,
  projectOnCell,
  sphereGrid,
  viewDirection,
  viewRight,
  viewUp,
  type Point3,
  type SphereGrid,
} from '../../features/analysis/bloch'

const CAMERA_DISTANCE = 20

/** The camera `BlochScene.draw` builds, for a grid and an azimuth. */
function sceneCamera(grid: SphereGrid, azimuth: number): OrthographicCamera {
  const camera = new OrthographicCamera(
    (-grid.columns * CELL_UNITS) / 2,
    (grid.columns * CELL_UNITS) / 2,
    (grid.rows * CELL_UNITS) / 2,
    (-grid.rows * CELL_UNITS) / 2,
    1,
    CAMERA_DISTANCE * 2
  )
  const forward = viewDirection(azimuth)
  const up = viewUp(azimuth)
  camera.position.set(
    forward.x * CAMERA_DISTANCE,
    forward.y * CAMERA_DISTANCE,
    forward.z * CAMERA_DISTANCE
  )
  camera.up.set(up.x, up.y, up.z)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  camera.updateProjectionMatrix()
  return camera
}

/** The cell group `BlochScene.draw` positions, for one index. */
function cellGroup(grid: SphereGrid, index: number, azimuth: number): Group {
  const group = new Group()
  const offset = cellOffset(grid, index)
  const up = viewUp(azimuth)
  const right = viewRight(azimuth)
  group.position.set(
    right.x * offset.x + up.x * offset.y,
    right.y * offset.x + up.y * offset.y,
    right.z * offset.x + up.z * offset.y
  )
  return group
}

/**
 * Where three actually puts a point of a cell, in the same SVG pixels the
 * label overlay uses. NDC → pixels is the canvas's own mapping, and the canvas
 * and the overlay are the same box at the same size (`BlochScene.tsx`).
 */
function drawnPx(
  grid: SphereGrid,
  camera: OrthographicCamera,
  world: Vector3
): { x: number; y: number } {
  const ndc = world.clone().project(camera)
  return {
    x: ((ndc.x + 1) / 2) * grid.width,
    y: ((1 - ndc.y) / 2) * grid.height,
  }
}

/** The world position of the tip of the arrow the scene draws for `vector`. */
function arrowTipWorld(
  group: Group,
  vector: { x: number; y: number; z: number; length: number }
): Vector3 {
  const arrow = new ArrowHelper(
    new Vector3(0, 0, 1),
    new Vector3(0, 0, 0),
    1,
    0x000000,
    0.22,
    0.13
  )
  group.add(arrow)
  // Exactly the two calls BlochScene makes for a visible vector.
  arrow.setDirection(new Vector3(vector.x, vector.y, vector.z).normalize())
  arrow.setLength(
    vector.length,
    Math.min(0.22, vector.length * 0.4),
    Math.min(0.13, vector.length * 0.24)
  )
  // An ArrowHelper points along its own +Y; its length is the local extent.
  const tip = new Vector3(0, vector.length, 0)
  group.updateMatrixWorld(true)
  arrow.localToWorld(tip)
  return tip
}

function stateOf(input: CircuitInput): Statevector {
  const result = run(parseCircuit(input))
  if (result.mode !== 'analytic') throw new Error('expected an analytic run')
  return result.state
}

const op = (
  id: string,
  gate: string,
  targets: number[],
  column: number,
  controls?: number[]
) => ({ id, gate, targets, column, ...(controls ? { controls } : {}) })

describe('the arrow the scene draws is the vector the table prints', () => {
  /*
   * Three qubits, three different states, so a swapped cell or a flipped sign
   * cannot hide behind a symmetry:
   *   q0: H       → (1, 0, 0)
   *   q1: H, S    → (0, 1, 0)
   *   q2: Ry(π/3) → (sin 60°, 0, cos 60°)
   */
  const PRODUCT: CircuitInput = {
    schemaVersion: 1,
    qubits: 3,
    operations: [
      op('a', 'h', [0], 0),
      op('b', 'h', [1], 0),
      op('c', 's', [1], 1),
      { id: 'd', gate: 'ry', targets: [2], column: 0, params: [Math.PI / 3] },
    ],
  }

  it.each([0, VIEW_AZIMUTH, 1.1, 2.7, 5.9])(
    'lands the tip where projectOnCell says, at azimuth %s',
    (azimuth) => {
      const state = stateOf(PRODUCT)
      const grid = sphereGrid(state.qubits)
      const camera = sceneCamera(grid, azimuth)
      // The scene must be a real parent chain or `localToWorld` sees nothing.
      const scene = new Scene()

      for (let index = 0; index < state.qubits; index++) {
        const vector = blochVector(state, index)
        const group = cellGroup(grid, index, azimuth)
        scene.add(group)
        const tip = arrowTipWorld(group, vector)
        scene.updateMatrixWorld(true)

        const drawn = drawnPx(grid, camera, tip)
        const stated = projectOnCell(grid, index, vector, azimuth)

        expect(drawn.x).toBeCloseTo(stated.x, 6)
        expect(drawn.y).toBeCloseTo(stated.y, 6)
      }
    }
  )

  it('puts the x and y axis labels on the axes three draws', () => {
    const grid = sphereGrid(3)
    for (const azimuth of [0, VIEW_AZIMUTH, 2.2, 4.4]) {
      const camera = sceneCamera(grid, azimuth)
      const scene = new Scene()
      for (let index = 0; index < 3; index++) {
        const group = cellGroup(grid, index, azimuth)
        scene.add(group)
        scene.updateMatrixWorld(true)
        const tips: Point3[] = [
          { x: LABEL_RADIUS, y: 0, z: 0 },
          { x: 0, y: LABEL_RADIUS, z: 0 },
          { x: 0, y: 0, z: LABEL_RADIUS },
          { x: 0, y: 0, z: -LABEL_RADIUS },
        ]
        for (const tip of tips) {
          const world = new Vector3(tip.x, tip.y, tip.z)
          group.localToWorld(world)
          const drawn = drawnPx(grid, camera, world)
          const stated = projectOnCell(grid, index, tip, azimuth)
          expect(drawn.x).toBeCloseTo(stated.x, 6)
          expect(drawn.y).toBeCloseTo(stated.y, 6)
        }
      }
    }
  })

  it('keeps |0> above |1> and the cell centre between them at every azimuth', () => {
    const grid = sphereGrid(4)
    for (const azimuth of [0, 0.7, VIEW_AZIMUTH, 3.3, 6.0]) {
      for (let index = 0; index < 4; index++) {
        const north = projectOnCell(
          grid,
          index,
          { x: 0, y: 0, z: LABEL_RADIUS },
          azimuth
        )
        const south = projectOnCell(
          grid,
          index,
          { x: 0, y: 0, z: -LABEL_RADIUS },
          azimuth
        )
        const centre = cellCentrePx(grid, index)
        // |0> is +z and must be drawn above |1>: smaller y in SVG pixels.
        expect(north.y).toBeLessThan(south.y)
        // The poles never leave the vertical through the centre, which is the
        // invariant that lets the overlay place them once and never move them.
        expect(north.x).toBeCloseTo(centre.x, 9)
        expect(south.x).toBeCloseTo(centre.x, 9)
      }
    }
  })
})

describe('arbitrary directions, not only the axes', () => {
  /**
   * A deterministic spread of directions and lengths. Axis-aligned vectors
   * hide a transposed component behind a zero; these do not.
   */
  function* sample(): Generator<{
    qubit: number
    x: number
    y: number
    z: number
    length: number
  }> {
    let seed = 424242
    const next = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0
      return seed / 0x100000000
    }
    for (let i = 0; i < 40; i++) {
      const theta = Math.acos(2 * next() - 1)
      const phi = 2 * Math.PI * next()
      // Anything from a hair off the centre to the surface.
      const length = 0.02 + 0.98 * next()
      const x = length * Math.sin(theta) * Math.cos(phi)
      const y = length * Math.sin(theta) * Math.sin(phi)
      const z = length * Math.cos(theta)
      yield { qubit: i % 4, x, y, z, length }
    }
  }

  it('draws every one of them where projectOnCell says', () => {
    const grid = sphereGrid(4)
    for (const vector of sample()) {
      for (const azimuth of [0, VIEW_AZIMUTH, 2.9, 5.1]) {
        const camera = sceneCamera(grid, azimuth)
        const scene = new Scene()
        const group = cellGroup(grid, vector.qubit, azimuth)
        scene.add(group)
        const tip = arrowTipWorld(group, vector)
        scene.updateMatrixWorld(true)

        const drawn = drawnPx(grid, camera, tip)
        const stated = projectOnCell(grid, vector.qubit, vector, azimuth)
        expect(drawn.x).toBeCloseTo(stated.x, 6)
        expect(drawn.y).toBeCloseTo(stated.y, 6)
      }
    }
  })
})

describe('the arrow is never normalised', () => {
  const BELL: CircuitInput = {
    schemaVersion: 1,
    qubits: 2,
    operations: [op('h', 'h', [0], 0), op('cx', 'x', [1], 1, [0])],
  }

  const PARTIAL: CircuitInput = {
    schemaVersion: 1,
    qubits: 2,
    operations: [
      { id: 'r', gate: 'ry', targets: [0], column: 0, params: [Math.PI / 4] },
      op('cx', 'x', [1], 1, [0]),
    ],
  }

  it('hides the arrow entirely for a Bell pair rather than drawing a direction', () => {
    const state = stateOf(BELL)
    for (const qubit of [0, 1]) {
      const vector = blochVector(state, qubit)
      expect(vector.length).toBeLessThan(1e-12)
    }
  })

  it('draws a partially entangled arrow at exactly |r|, not at 1', () => {
    // Ry(π/4) then CNOT: |ψ⟩ = cos(π/8)|00⟩ + sin(π/8)|11⟩, so both halves
    // have r = (0, 0, cos π/4) and |r| = 0,70710678…
    const state = stateOf(PARTIAL)
    const grid = sphereGrid(2)
    const azimuth = VIEW_AZIMUTH
    const camera = sceneCamera(grid, azimuth)
    const scene = new Scene()

    for (const qubit of [0, 1]) {
      const vector = blochVector(state, qubit)
      expect(vector.length).toBeCloseTo(Math.SQRT1_2, 12)

      const group = cellGroup(grid, qubit, azimuth)
      scene.add(group)
      const tip = arrowTipWorld(group, vector)
      scene.updateMatrixWorld(true)

      const drawn = drawnPx(grid, camera, tip)
      const stated = projectOnCell(grid, qubit, vector, azimuth)
      expect(drawn.x).toBeCloseTo(stated.x, 6)
      expect(drawn.y).toBeCloseTo(stated.y, 6)

      // And it is visibly short of the pole the same qubit would reach if it
      // were unentangled: the drawn distance from the centre is |r| radii.
      const centre = cellCentrePx(grid, qubit)
      const drawnRadii = Math.hypot(drawn.x - centre.x, drawn.y - centre.y)
      const pole = projectOnCell(grid, qubit, { x: 0, y: 0, z: 1 }, azimuth)
      const poleRadii = Math.hypot(pole.x - centre.x, pole.y - centre.y)
      expect(drawnRadii).toBeLessThan(poleRadii)
    }
  })
})
