/**
 * The model behind the Bloch spheres: where each sphere sits, where a point
 * of Bloch space lands on screen, and what a vector's length says in words.
 *
 * No React, no three.js, no i18next — the same split `histogram.ts` makes,
 * and for the same reason. The physics is upstream of all of it: the partial
 * trace and the vector itself are `@qsim/core`'s (`metrics.ts`, §5.5), where
 * the adversarial suite lives. What is left here is presentation arithmetic,
 * and it is here rather than in a component because two renderers have to
 * agree on it exactly — see below.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ONE PROJECTION, TWO RENDERERS
 *
 * A sphere is drawn twice over: three.js paints the wireframe, the axes and
 * the arrow into a WebGL canvas, and an SVG layer on top of it paints the
 * labels — because §1.1 makes `Notation` the only sanctioned route for
 * invariant notation like `|0⟩`, and a WebGL texture is not that route.
 *
 * Two renderers over one picture only works if they share a camera. So the
 * projection is written once, here, and both sides read it: the scene builds
 * its orthographic camera from `viewDirection` and `viewUp`, and the overlay
 * places every label with `project`. A label that drifted off the tip of its
 * axis would not look like a bug in a matrix — it would look like the axis
 * was mislabelled, which is the one thing a diagram must never do.
 *
 * The frame it produces is the conventional Bloch picture: z straight up,
 * x towards the lower left, y towards the lower right.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE GRID IS ONE CANVAS, NOT ONE CANVAS PER QUBIT
 *
 * The obvious arrangement — a `<canvas>` per sphere — breaks at exactly the
 * size this app supports. Browsers cap the number of *live* WebGL contexts
 * (Chrome around sixteen) and silently kill the oldest when a new one is
 * created, so a twenty-qubit register would draw its last sixteen spheres
 * and quietly blank the first four. One context holding a grid of spheres
 * has no such ceiling, costs one draw call set instead of twenty, and is why
 * this module deals in cells rather than in canvases.
 *
 * There is no cap on how many spheres are drawn, and none is needed: the
 * histogram caps its bars because a register has 2ⁿ basis states, while it
 * has exactly n qubits. Twenty spheres is a grid; a million bars is not a
 * chart.
 */

import type { BlochVector } from '@qsim/core'

/* ──────────────────────────── the camera ────────────────────────────── */

/**
 * Where the camera stands, in Bloch coordinates: 30° around from the y axis
 * and 20° above the equator.
 *
 * Elevation is what makes the equator read as an ellipse rather than as a
 * line, which is the whole of the depth cue in an orthographic projection;
 * azimuth is what stops x and y from overlapping. Both are small on purpose —
 * a steeper view foreshortens z, and z is the axis carrying |0⟩ and |1⟩.
 */
export const VIEW_AZIMUTH = Math.PI / 6
export const VIEW_ELEVATION = Math.PI / 9

/** A point of Bloch space, or of the world the scene is built in. */
export interface Point3 {
  readonly x: number
  readonly y: number
  readonly z: number
}

/** A point on screen. In `project`'s output, y is up; in pixels, y is down. */
export interface Point2 {
  readonly x: number
  readonly y: number
}

/**
 * The unit vector from the origin towards the camera, at `azimuth`.
 *
 * The scene puts its camera on this ray. Because the projection below is
 * derived from the same two angles, "where three.js draws the tip of the x
 * axis" and "where the overlay writes the letter x" are the same arithmetic.
 */
export function viewDirection(azimuth: number): Point3 {
  const ce = Math.cos(VIEW_ELEVATION)
  return {
    x: Math.sin(azimuth) * ce,
    y: Math.cos(azimuth) * ce,
    z: Math.sin(VIEW_ELEVATION),
  }
}

/**
 * Which way is up for that camera: ẑ with the part along the view direction
 * removed, so the z axis always projects to a vertical line.
 *
 * That invariance is load-bearing for the overlay. Turning the camera in
 * azimuth leaves the poles exactly where they were on screen, which is why
 * `|0⟩` and `|1⟩` can be placed once and left alone while x and y follow the
 * rotation.
 */
export function viewUp(azimuth: number): Point3 {
  const se = Math.sin(VIEW_ELEVATION)
  return {
    x: -se * Math.sin(azimuth),
    y: -se * Math.cos(azimuth),
    z: Math.cos(VIEW_ELEVATION),
  }
}

/**
 * Which way is right on screen: `up × forward`, which for this camera works
 * out to `(−cos a, sin a, 0)` — horizontal, as it must be, since the camera
 * never rolls.
 *
 * The scene needs it as a vector rather than as a projection because the grid
 * is laid out *in the camera's plane*: a cell sits at `right·x + up·y`, so its
 * spheres stay in their rows however far the camera has turned, while their
 * own axes stay pinned to Bloch space and turn with it.
 */
export function viewRight(azimuth: number): Point3 {
  return { x: -Math.cos(azimuth), y: Math.sin(azimuth), z: 0 }
}

/**
 * Orthographic projection of a Bloch-space point, in sphere radii, with y up.
 *
 * The screen basis is (`viewRight`, `viewUp`), so this is two dot products
 * written out — and writing them out rather than calling the two functions
 * above keeps the label loop free of allocation while it runs on every frame.
 */
export function project(point: Point3, azimuth: number): Point2 {
  const sa = Math.sin(azimuth)
  const ca = Math.cos(azimuth)
  const se = Math.sin(VIEW_ELEVATION)
  const ce = Math.cos(VIEW_ELEVATION)
  return {
    x: -ca * point.x + sa * point.y,
    y: -se * sa * point.x - se * ca * point.y + ce * point.z,
  }
}

/* ──────────────────────────── the grid ──────────────────────────────── */

/**
 * How wide a cell is, in sphere radii. A sphere is 2 across, so 2.6 leaves
 * 0.3 of a radius on each side — room for the axis labels, which sit at 1.22.
 */
export const CELL_UNITS = 2.6

/** How wide a cell is drawn, in CSS pixels before the canvas is scaled. */
export const CELL_PIXELS = 120

/** Most spheres in a row. Beyond this the grid wraps rather than shrinks. */
const MAX_COLUMNS = 4

/** How far from the centre an axis label sits, in sphere radii. */
export const LABEL_RADIUS = 1.22

export interface SphereGrid {
  readonly qubits: number
  readonly columns: number
  readonly rows: number
  /** Pixels per sphere radius — the scale between world units and the SVG. */
  readonly radius: number
  readonly width: number
  readonly height: number
}

/**
 * The grid for `qubits` spheres.
 *
 * Rows are chosen first and columns derived from them, which is what keeps
 * the last row full: filling rows of four leaves five qubits as a row of four
 * and a lone sphere, where two rows of three reads as a block. The width of a
 * register is not a quantity anyone should have to infer from a ragged edge.
 */
export function sphereGrid(qubits: number): SphereGrid {
  const count = Math.max(1, Math.floor(qubits))
  const rows = Math.ceil(count / MAX_COLUMNS)
  const columns = Math.ceil(count / rows)
  return {
    qubits: count,
    columns,
    rows,
    radius: CELL_PIXELS / CELL_UNITS,
    width: columns * CELL_PIXELS,
    height: rows * CELL_PIXELS,
  }
}

/**
 * Where the centre of cell `index` sits relative to the middle of the grid,
 * in sphere radii, y up — the coordinates the scene positions a sphere at,
 * measured in the camera's own plane.
 */
export function cellOffset(grid: SphereGrid, index: number): Point2 {
  const column = index % grid.columns
  const row = Math.floor(index / grid.columns)
  return {
    x: (column - (grid.columns - 1) / 2) * CELL_UNITS,
    y: ((grid.rows - 1) / 2 - row) * CELL_UNITS,
  }
}

/**
 * The same point in SVG pixels, where y grows downwards.
 *
 * The overlay and the canvas are the same box at the same size, so a pixel
 * here is a pixel there whatever the browser scales the pair down to.
 */
export function cellCentrePx(grid: SphereGrid, index: number): Point2 {
  const offset = cellOffset(grid, index)
  return {
    x: grid.width / 2 + offset.x * grid.radius,
    y: grid.height / 2 - offset.y * grid.radius,
  }
}

/** How far the wire's name sits from the top-left corner of its cell. */
const WIRE_LABEL_INSET_X = 14
const WIRE_LABEL_INSET_Y = 10

/**
 * Where a sphere's wire name goes: the top-left corner of its cell, not the
 * top centre.
 *
 * The obvious place is above the sphere, and it is taken. `|0⟩` sits at 1.22
 * radii up the z axis, which in a 2.6-unit cell puts it seven pixels from the
 * top edge — so a name centred over the sphere printed straight through the
 * pole label. The corner is empty at every azimuth, because the equatorial
 * axes never rise above the equator and the poles never leave the vertical.
 */
export function wireLabelPx(grid: SphereGrid, index: number): Point2 {
  const centre = cellCentrePx(grid, index)
  const half = (CELL_UNITS / 2) * grid.radius
  return {
    x: centre.x - half + WIRE_LABEL_INSET_X,
    y: centre.y - half + WIRE_LABEL_INSET_Y,
  }
}

/** Where a point of the sphere at `index` lands, in SVG pixels. */
export function projectOnCell(
  grid: SphereGrid,
  index: number,
  point: Point3,
  azimuth: number
): Point2 {
  const centre = cellCentrePx(grid, index)
  const screen = project(point, azimuth)
  return {
    x: centre.x + screen.x * grid.radius,
    y: centre.y - screen.y * grid.radius,
  }
}

/* ─────────────────────────── what it reads ──────────────────────────── */

/**
 * What a vector's length says about its qubit.
 *
 * `pure`      |r| = 1. The qubit has a state of its own.
 * `shortened` in between. Partly entangled with the rest of the register.
 * `centre`    |r| = 0. Maximally entangled — half of a Bell pair.
 */
export type BlochReading = 'pure' | 'shortened' | 'centre'

/**
 * How close to 0 or 1 counts as being there: half of the last digit the table
 * prints.
 *
 * Deliberately not D6's 1e-10. The sentence sits in the same row as the
 * number, and a reader compares the two — so a row reading `1,0000` beside
 * "partly entangled" is a contradiction on screen whatever the seventh
 * decimal says. Tying the threshold to the printed precision makes the word
 * and the digits incapable of disagreeing, and the cost is that a qubit
 * entangled by less than a hundred-thousandth is called pure, which is also
 * what every digit on the row says it is.
 */
export const READING_TOLERANCE = 5e-5

export function readingOf(length: number): BlochReading {
  if (length >= 1 - READING_TOLERANCE) return 'pure'
  if (length <= READING_TOLERANCE) return 'centre'
  return 'shortened'
}

/** How many of these qubits do not reach the surface of their sphere. */
export function shortenedCount(vectors: readonly BlochVector[]): number {
  return vectors.filter((vector) => readingOf(vector.length) !== 'pure').length
}

/**
 * The name of a wire, as the canvas of M0.5 names an unlabelled one.
 *
 * Deliberately not the user's own `qubitLabels`, and deliberately not an
 * import of `defaultQubitLabel` from the document store — that module carries
 * Zustand and the whole undo history with it, for one template string.
 *
 * The first half of that is the substantive decision: what is drawn here is
 * read off a *state*, and a state has no labels. The circuit on screen may
 * already be one edit ahead of the answer being drawn (the panel's own
 * caption exists because of that lag), so a wire renamed while the worker was
 * running would put the new name on the old vector. An index cannot go stale.
 */
export function qubitName(index: number): string {
  return `q${index}`
}
