/**
 * The drawn half of the Bloch spheres: one WebGL canvas, one SVG layer of
 * labels over it, and nothing a screen reader is asked to read.
 *
 * **This module is the only importer of three.js in the app, and it is loaded
 * with `lazy()`** (`BlochSpheres.tsx`). §9 asks for that and the number says
 * why: three is around six hundred kilobytes unminified, for a panel a reader
 * may never scroll to, on a route that already pays for dnd-kit, Zod and the
 * document store. It has no dependencies of its own, so the split is clean —
 * the editor's chunk grows by nothing and this chunk carries exactly three.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CANVAS IS DECORATION. THE TABLE IS THE RENDERING.
 *
 * Both elements here are `aria-hidden`, exactly as the circuit canvas is: a
 * 3D scene is unreadable to a screen reader and unusable without a pointer,
 * so the meaning lives in the numbers `BlochSpheres.tsx` prints beside it.
 * That is not a consolation prize — it is why this component may fail without
 * taking anything with it. If WebGL is unavailable, or the context is lost
 * later (a GPU reset, a laptop switching cards, a browser reclaiming
 * contexts), it says so and the panel keeps every fact it had.
 *
 * ────────────────────────────────────────────────────────────────────────
 * WHY THE LABELS ARE SVG ON TOP RATHER THAN SPRITES INSIDE
 *
 * `|0⟩`, `|1⟩`, `x` and `y` are notation, and §1.1 gives notation exactly one
 * route: the `Notation` component, which marks it `translate="no"` so a
 * browser's page translator cannot turn a ket into a sentence. A texture
 * baked from a string is not that route, and it would also be the one part of
 * the picture that could not be selected, searched or zoomed.
 *
 * So the labels are `NotationText` in an SVG laid over the canvas, and the
 * two agree because they share a camera: `bloch.ts` owns the projection, the
 * scene builds its camera from it, and the overlay places every label with
 * it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE TURNTABLE, AND WHAT `prefers-reduced-motion` TAKES AWAY
 *
 * An orthographic sphere is ambiguous when still: an arrow pointing away from
 * the reader and one pointing towards them project to the same line. A slow
 * turn resolves it — the kinetic depth effect is the whole reason to spend a
 * WebGL context on this at all rather than draw a flat diagram.
 *
 * Under `prefers-reduced-motion` the turn stops and the scene renders one
 * frame, from the same angle it starts at. Nothing is substituted for it, and
 * nothing needs to be: unlike the phasors, whose *angle* was the datum being
 * animated (§10), the rotation here carries no information at all — the datum
 * is the arrow's direction and length, which one frame states as fully as a
 * thousand. What is lost is a depth cue, and the numbers below have never
 * depended on it.
 *
 * The turn is in azimuth only, about the Bloch z axis, which is what keeps
 * `|0⟩` and `|1⟩` nailed to the top and bottom of their sphere (`viewUp` in
 * `bloch.ts`). Only the x and y labels move, and they are written straight to
 * the DOM from the frame loop rather than through state — the same rule the
 * phasors follow, for the same reason: sixty React renders a second to move
 * two text nodes per sphere is a re-render of the whole analysis panel per
 * frame.
 */

import type { BlochVector } from '@qsim/core'
import { useEffect, useRef } from 'react'
import {
  ArrowHelper,
  BufferGeometry,
  Color,
  Group,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three'

import { NotationText } from '../../components/Notation'
import {
  CELL_UNITS,
  LABEL_RADIUS,
  READING_TOLERANCE,
  VIEW_AZIMUTH,
  cellOffset,
  projectOnCell,
  qubitName,
  viewDirection,
  viewRight,
  viewUp,
  wireLabelPx,
  type Point2,
  type SphereGrid,
} from './bloch'

/** A full turn every twenty-four seconds. Slow enough to read against. */
const TURN_RATE = (2 * Math.PI) / 24_000

/**
 * How far the camera stands off. Orthographic, so this changes nothing about
 * the picture — it only has to clear the near plane with room for a sphere.
 */
const CAMERA_DISTANCE = 20

/** Points on a unit circle, shared by all three great circles of a sphere. */
const CIRCLE_SEGMENTS = 96

/** The axes overshoot the sphere slightly, so their ends read as ends. */
const AXIS_REACH = 1.12

/**
 * The scene's colours, read from the stylesheet rather than repeated here.
 *
 * §10's palette lives in `index.css` as custom properties and is measured for
 * contrast by `verification/design/token-contrast.test.ts`; a second copy in
 * this file would be a second palette that nothing measures. three needs a
 * number rather than a string, so each token is read once at build time and
 * converted. The fallbacks cover a document that has no stylesheet at all —
 * a test environment — where the scene is never actually seen.
 */
function tokenColour(name: string, fallback: string): Color {
  const raw =
    typeof document === 'undefined'
      ? ''
      : getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  const colour = new Color()
  try {
    colour.setStyle(raw === '' ? fallback : raw)
  } catch {
    // An unparseable token is a stylesheet problem, not a reason to lose the
    // picture. `setStyle` warns on the console and leaves the colour black,
    // which would be invisible; the fallback is the honest recovery.
    colour.setStyle(fallback)
  }
  return colour
}

export interface BlochSceneProps {
  readonly vectors: readonly BlochVector[]
  readonly grid: SphereGrid
  /** `prefers-reduced-motion`: render one frame instead of turning. */
  readonly frozen: boolean
  /** Called when WebGL cannot be had, or is taken away mid-session. */
  readonly onUnavailable: () => void
}

interface CellObjects {
  readonly group: Group
  readonly arrow: ArrowHelper
}

interface SceneObjects {
  readonly scene: Scene
  readonly camera: OrthographicCamera
  readonly cells: readonly CellObjects[]
  readonly dispose: () => void
}

export function BlochScene({
  vectors,
  grid,
  frozen,
  onUnavailable,
}: BlochSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<WebGLRenderer | null>(null)
  const sceneRef = useRef<SceneObjects | null>(null)
  /** The two moving labels per sphere, addressed directly by the frame loop. */
  const labelsRef = useRef<(SVGTextElement | null)[][]>([])
  const azimuthRef = useRef(VIEW_AZIMUTH)
  /*
   * The callback is read through a ref so the renderer effect can keep an
   * empty dependency list. A parent that passed a fresh closure — which is
   * the normal thing to do — would otherwise tear down and rebuild the WebGL
   * context on every render of the analysis panel, which is to say on every
   * keystroke in the editor.
   */
  const unavailableRef = useRef(onUnavailable)
  /*
   * Kept current in an effect rather than written during render: a ref
   * assignment in the render body is what `react-hooks/refs` forbids, and it
   * is forbidden for a real reason — a render that React throws away would
   * still have written it. Declared *first*, so that on mount it runs before
   * the effect below can need it.
   */
  useEffect(() => {
    unavailableRef.current = onUnavailable
  }, [onUnavailable])

  /* ── the context: created once, and never by anything else ─────────── */
  useEffect(() => {
    const canvas = canvasRef.current
    if (canvas === null) return

    let renderer: WebGLRenderer
    try {
      renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true })
    } catch {
      // No WebGL, a blocked context, or a driver the browser distrusts. The
      // constructor is where all three arrive, as an exception.
      unavailableRef.current()
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    rendererRef.current = renderer

    const onLost = (event: Event): void => {
      // Without this the canvas freezes on its last frame and goes on
      // claiming to describe the circuit on screen. Cancelling the default
      // also gives up on restoration, which is right here: the numbers are
      // already the rendering, so there is nothing to restore *to*.
      event.preventDefault()
      unavailableRef.current()
    }
    canvas.addEventListener('webglcontextlost', onLost)

    return () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      rendererRef.current = null
      /*
       * `dispose()` and deliberately NOT `forceContextLoss()`.
       *
       * Handing the context back on the way out is the tidy-looking move, and
       * it is wrong here: losing a context is a property of the *canvas
       * element*, not of the renderer, and a canvas whose context has been
       * force-lost can never obtain another one. This canvas is rendered by
       * React, so React reuses the same element across an unmount and remount
       * — which StrictMode does to every effect on purpose. The second mount
       * then asked a dead canvas for a context, got nothing, and the panel
       * reported "this browser could not open a 3D view" on every machine in
       * development, WebGL working perfectly the whole time.
       *
       * `dispose()` frees the GPU resources, and the context goes with the
       * element once it is collected.
       */
      renderer.dispose()
    }
  }, [])

  /* ── the scene graph: rebuilt when the register changes shape ──────── */
  useEffect(() => {
    const renderer = rendererRef.current
    if (renderer === null) return

    const objects = buildScene(grid)
    sceneRef.current = objects
    renderer.setSize(grid.width, grid.height, false)

    return () => {
      sceneRef.current = null
      objects.dispose()
    }
  }, [grid])

  /* ── the vectors: written onto the arrows that already exist ───────── */
  useEffect(() => {
    const objects = sceneRef.current
    if (objects === null) return

    objects.cells.forEach((cell, index) => {
      const vector = vectors[index]
      // A sphere with no vector is a register that grew between the answer
      // and this frame. Hiding the arrow is the only honest thing to draw.
      const visible = vector !== undefined && vector.length > READING_TOLERANCE
      cell.arrow.visible = visible
      if (!visible || vector === undefined) return

      cell.arrow.setDirection(
        new Vector3(vector.x, vector.y, vector.z).normalize()
      )
      /*
       * Exactly proportional, never normalised. §5.5's whole point is that a
       * short arrow means an entangled qubit, so a renderer that drew every
       * arrow at full length would delete the reading and leave a confident
       * direction for a qubit that has none. The head shrinks with it, so a
       * quarter-length arrow is a quarter-length arrow rather than a
       * full-sized arrowhead on a stub.
       */
      cell.arrow.setLength(
        vector.length,
        Math.min(0.22, vector.length * 0.4),
        Math.min(0.13, vector.length * 0.24)
      )
    })

    draw(rendererRef.current, sceneRef.current, grid, labelsRef.current, {
      azimuth: azimuthRef.current,
    })
  }, [vectors, grid])

  /* ── the turn ──────────────────────────────────────────────────────── */
  useEffect(() => {
    if (frozen) {
      // One frame, from the angle the scene starts at. Reset rather than
      // frozen where it happened to be, so that turning the preference on
      // gives the same picture as loading the page with it on.
      azimuthRef.current = VIEW_AZIMUTH
      draw(rendererRef.current, sceneRef.current, grid, labelsRef.current, {
        azimuth: azimuthRef.current,
      })
      return
    }

    let handle = 0
    let previous = performance.now()
    const step = (now: number): void => {
      azimuthRef.current += (now - previous) * TURN_RATE
      previous = now
      draw(rendererRef.current, sceneRef.current, grid, labelsRef.current, {
        azimuth: azimuthRef.current,
      })
      handle = requestAnimationFrame(step)
    }
    handle = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(handle)
    }
  }, [frozen, grid])

  return (
    <div className="bloch__stage" style={{ maxWidth: `${grid.width}px` }}>
      <canvas ref={canvasRef} className="bloch__canvas" aria-hidden="true" />

      <svg
        className="bloch__labels"
        viewBox={`0 0 ${grid.width} ${grid.height}`}
        width={grid.width}
        height={grid.height}
        aria-hidden="true"
        focusable="false"
      >
        {vectors.map((vector, index) => (
          <CellLabels
            key={vector.qubit}
            grid={grid}
            index={index}
            qubit={vector.qubit}
            register={(axis, element) => {
              const row = (labelsRef.current[index] ??= [null, null])
              row[axis] = element
            }}
          />
        ))}
      </svg>
    </div>
  )
}

/** Index into a cell's moving-label pair. */
const X_LABEL = 0
const Y_LABEL = 1

interface CellLabelsProps {
  readonly grid: SphereGrid
  readonly index: number
  readonly qubit: number
  readonly register: (axis: number, element: SVGTextElement | null) => void
}

/**
 * One sphere's labels.
 *
 * The poles and the wire's name are placed by React and never move: a turn
 * about z leaves ẑ projecting straight up whatever the azimuth, so `|0⟩` and
 * `|1⟩` are where they were. The equatorial pair does move, so it is placed
 * once here — correct on the very first paint, before any frame has run — and
 * then written by the loop.
 */
function CellLabels({ grid, index, qubit, register }: CellLabelsProps) {
  const name = wireLabelPx(grid, index)
  const pole = (z: number): Point2 =>
    projectOnCell(grid, index, { x: 0, y: 0, z }, VIEW_AZIMUTH)
  const north = pole(LABEL_RADIUS)
  const south = pole(-LABEL_RADIUS)
  const xTip = projectOnCell(
    grid,
    index,
    { x: LABEL_RADIUS, y: 0, z: 0 },
    VIEW_AZIMUTH
  )
  const yTip = projectOnCell(
    grid,
    index,
    { x: 0, y: LABEL_RADIUS, z: 0 },
    VIEW_AZIMUTH
  )

  return (
    <g className="bloch__cell">
      <NotationText
        className="bloch__wire"
        value={qubitName(qubit)}
        x={name.x}
        y={name.y}
      />
      <NotationText
        className="bloch__pole"
        value="|0⟩"
        x={north.x}
        y={north.y}
      />
      <NotationText
        className="bloch__pole"
        value="|1⟩"
        x={south.x}
        y={south.y}
      />
      <NotationText
        className="bloch__axis"
        value="x"
        x={xTip.x}
        y={xTip.y}
        ref={(element) => {
          register(X_LABEL, element)
        }}
      />
      <NotationText
        className="bloch__axis"
        value="y"
        x={yTip.x}
        y={yTip.y}
        ref={(element) => {
          register(Y_LABEL, element)
        }}
      />
    </g>
  )
}

/* ───────────────────────────── the scene ────────────────────────────── */

/**
 * Everything that does not depend on the vectors: the wireframes, the axes
 * and one arrow per sphere waiting to be pointed.
 *
 * Geometries and materials are built once and shared by every cell. Twenty
 * spheres are twenty copies of the same three circles, and uploading that
 * geometry twenty times would be twenty buffers for the driver to keep — the
 * kind of waste that only shows up on the machines least able to afford it.
 */
function buildScene(grid: SphereGrid): SceneObjects {
  const scene = new Scene()
  const camera = new OrthographicCamera(
    (-grid.columns * CELL_UNITS) / 2,
    (grid.columns * CELL_UNITS) / 2,
    (grid.rows * CELL_UNITS) / 2,
    (-grid.rows * CELL_UNITS) / 2,
    1,
    CAMERA_DISTANCE * 2
  )

  const circle = new BufferGeometry().setFromPoints(
    Array.from({ length: CIRCLE_SEGMENTS }, (_unused, step) => {
      const angle = (2 * Math.PI * step) / CIRCLE_SEGMENTS
      return new Vector3(Math.cos(angle), Math.sin(angle), 0)
    })
  )
  const axes = new BufferGeometry().setFromPoints([
    new Vector3(-AXIS_REACH, 0, 0),
    new Vector3(AXIS_REACH, 0, 0),
    new Vector3(0, -AXIS_REACH, 0),
    new Vector3(0, AXIS_REACH, 0),
    new Vector3(0, 0, -AXIS_REACH),
    new Vector3(0, 0, AXIS_REACH),
  ])
  // Big enough to be seen on its own, because on a Bell pair it is the only
  // thing left in the sphere — the arrow is gone, and a marker too small to
  // notice would read as a rendering that failed rather than as a vector of
  // length zero.
  const hub = new SphereGeometry(0.075, 12, 8)

  const wireMaterial = new LineBasicMaterial({
    color: tokenColour('--wire', '#5a65aa'),
  })
  const axisMaterial = new LineBasicMaterial({
    color: tokenColour('--text-muted', '#8b93c4'),
  })
  const accent = tokenColour('--accent', '#5ac8fa')
  const hubMaterial = new MeshBasicMaterial({ color: accent })

  const cells: CellObjects[] = []
  for (let index = 0; index < grid.qubits; index++) {
    const group = new Group()

    // The three great circles: the equator, and the meridians through the x
    // and y axes. Enough to read the sphere as a sphere, and few enough that
    // the arrow is never lost in a mesh of lines.
    const equator = new LineLoop(circle, wireMaterial)
    const meridianX = new LineLoop(circle, wireMaterial)
    meridianX.rotation.x = Math.PI / 2
    const meridianY = new LineLoop(circle, wireMaterial)
    meridianY.rotation.y = Math.PI / 2
    group.add(equator, meridianX, meridianY)

    group.add(new LineSegments(axes, axisMaterial))
    // The centre, marked in the same colour as the arrow — so a qubit whose
    // arrow has vanished still shows something *at the centre*, which is the
    // picture §3.2 is asking for rather than an empty sphere.
    group.add(new Mesh(hub, hubMaterial))

    const arrow = new ArrowHelper(
      new Vector3(0, 0, 1),
      new Vector3(0, 0, 0),
      1,
      accent,
      0.22,
      0.13
    )
    group.add(arrow)

    scene.add(group)
    cells.push({ group, arrow })
  }

  return {
    scene,
    camera,
    cells,
    dispose: () => {
      for (const cell of cells) cell.arrow.dispose()
      circle.dispose()
      axes.dispose()
      hub.dispose()
      wireMaterial.dispose()
      axisMaterial.dispose()
      hubMaterial.dispose()
    },
  }
}

interface Frame {
  readonly azimuth: number
}

/**
 * One frame: place the camera, place the cells in its plane, draw, and move
 * the two labels that the turn carries with it.
 *
 * The cells are repositioned rather than the camera being pointed at a fixed
 * grid, because the grid is a *screen* arrangement: rows have to stay rows
 * however far the camera has come round. Putting a cell at
 * `right·x + up·y` does that by construction, and it is also what makes the
 * overlay's fixed `cellCentrePx` correct at every azimuth — that position
 * projects back to exactly (x, y).
 */
function draw(
  renderer: WebGLRenderer | null,
  objects: SceneObjects | null,
  grid: SphereGrid,
  labels: readonly (SVGTextElement | null)[][],
  frame: Frame
): void {
  if (renderer === null || objects === null) return
  const { azimuth } = frame

  const forward = viewDirection(azimuth)
  const up = viewUp(azimuth)
  const right = viewRight(azimuth)

  objects.camera.position.set(
    forward.x * CAMERA_DISTANCE,
    forward.y * CAMERA_DISTANCE,
    forward.z * CAMERA_DISTANCE
  )
  objects.camera.up.set(up.x, up.y, up.z)
  objects.camera.lookAt(0, 0, 0)

  objects.cells.forEach((cell, index) => {
    const offset = cellOffset(grid, index)
    cell.group.position.set(
      right.x * offset.x + up.x * offset.y,
      right.y * offset.x + up.y * offset.y,
      right.z * offset.x + up.z * offset.y
    )
  })

  renderer.render(objects.scene, objects.camera)

  labels.forEach((pair, index) => {
    place(pair[X_LABEL], projectOnCell(grid, index, X_AXIS, azimuth))
    place(pair[Y_LABEL], projectOnCell(grid, index, Y_AXIS, azimuth))
  })
}

const X_AXIS = { x: LABEL_RADIUS, y: 0, z: 0 }
const Y_AXIS = { x: 0, y: LABEL_RADIUS, z: 0 }

function place(element: SVGTextElement | null | undefined, at: Point2): void {
  if (!element) return
  element.setAttribute('x', String(at.x))
  element.setAttribute('y', String(at.y))
}
