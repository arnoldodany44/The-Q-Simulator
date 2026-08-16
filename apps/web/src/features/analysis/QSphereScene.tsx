/**
 * The drawn half of the Q-sphere: one WebGL canvas, an SVG layer of pole labels
 * over it, and nothing a screen reader is asked to read.
 *
 * **Loaded with `lazy()` (`QSphere.tsx`), and it shares its chunk with nothing.**
 * three.js is the largest dependency in the app and §9 keeps it out of the
 * editor's chunk; this module and `BlochScene.tsx` are its only importers, so a
 * reader who never scrolls to either panel never fetches it.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE CANVAS IS DECORATION. THE TABLE IS THE RENDERING.
 *
 * Both elements here are `aria-hidden`, exactly as the Bloch scene's and the
 * circuit canvas's are. A 3D scene is unreadable to a screen reader and
 * unusable without a pointer, so the meaning lives in the numbers `QSphere.tsx`
 * prints beside it — which is also what lets this component fail without taking
 * anything with it. No WebGL, a refused context, a GPU reset mid-session: it
 * says so and the panel keeps every fact it had.
 *
 * ────────────────────────────────────────────────────────────────────────
 * ONE CAMERA, SHARED WITH THE BLOCH SPHERES
 *
 * The projection comes from `bloch.ts` rather than being written again. Two
 * spheres on one page seen from two different angles would read as two
 * different conventions — and there is a concrete failure behind the tidiness:
 * the pole labels are SVG on top of the canvas (§1.1 makes `Notation` the only
 * sanctioned route for `|0⟩`, and a texture is not that route), so the overlay
 * and the scene have to agree about where the top of the sphere is. Sharing the
 * camera makes agreeing the only thing they can do.
 *
 * ────────────────────────────────────────────────────────────────────────
 * THE POOL OF NODES IS BUILT ONCE
 *
 * The cap is 32, the state changes on every keystroke, and rebuilding 32
 * meshes and 32 materials per answer would upload geometry to the driver at
 * the rate the user types. So the pool is allocated once per register size and
 * each answer only writes into it: a position, a scale, a colour, and a
 * visibility. A node with no state behind it is hidden rather than removed,
 * which is also what makes a shrinking superposition read as points fading out
 * rather than as the scene being rebuilt.
 */

import { useEffect, useRef } from 'react'
import {
  BufferGeometry,
  Color,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
  SphereGeometry,
  Vector3,
  WebGLRenderer,
} from 'three'

import { NotationText } from '../../components/Notation'
import { phaseToColour } from '../../lib/phase-colour'
import { VIEW_AZIMUTH, project, viewDirection, viewUp } from './bloch'
import {
  LABEL_RADIUS,
  STAGE_PIXELS,
  STAGE_RADIUS,
  STAGE_UNITS,
  type QSphereNode,
} from './qsphere'

/** A full turn every twenty-four seconds — the Bloch scene's rate, shared. */
const TURN_RATE = (2 * Math.PI) / 24_000

/** Orthographic, so this only has to clear the near plane. */
const CAMERA_DISTANCE = 20

/** Points on a unit circle, shared by every ring of the sphere. */
const CIRCLE_SEGMENTS = 96

/** Segments of a node's own little sphere. Small on screen; cheap is right. */
const NODE_SEGMENTS = 12

export interface QSphereSceneProps {
  readonly nodes: readonly QSphereNode[]
  readonly qubits: number
  /** How many nodes the pool must hold — the model's cap, not its length. */
  readonly capacity: number
  /** `prefers-reduced-motion`: render one frame instead of turning. */
  readonly frozen: boolean
  /** Called when WebGL cannot be had, or is taken away mid-session. */
  readonly onUnavailable: () => void
}

interface NodeObjects {
  readonly mesh: Mesh
  readonly line: Line
  readonly material: MeshBasicMaterial
  readonly lineMaterial: LineBasicMaterial
  readonly geometry: BufferGeometry
}

interface SceneObjects {
  readonly scene: Scene
  readonly camera: OrthographicCamera
  readonly nodes: readonly NodeObjects[]
  readonly dispose: () => void
}

/**
 * The scene's colours, read from the stylesheet rather than repeated here —
 * `BlochScene.tsx` argues why, and this is the same function for the same
 * reason. A second copy of §10's palette would be a second palette that nothing
 * measures.
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
    colour.setStyle(fallback)
  }
  return colour
}

export function QSphereScene({
  nodes,
  qubits,
  capacity,
  frozen,
  onUnavailable,
}: QSphereSceneProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const rendererRef = useRef<WebGLRenderer | null>(null)
  const sceneRef = useRef<SceneObjects | null>(null)
  const azimuthRef = useRef(VIEW_AZIMUTH)
  /*
   * Read through a ref so the renderer effect keeps an empty dependency list. A
   * parent passing a fresh closure — the normal thing — would otherwise tear
   * down and rebuild the WebGL context on every render of the analysis panel,
   * which is to say on every keystroke in the editor.
   */
  const unavailableRef = useRef(onUnavailable)
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
      unavailableRef.current()
      return
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
    renderer.setSize(STAGE_PIXELS, STAGE_PIXELS, false)
    rendererRef.current = renderer

    const onLost = (event: Event): void => {
      // Without this the canvas freezes on its last frame and goes on claiming
      // to describe the circuit on screen.
      event.preventDefault()
      unavailableRef.current()
    }
    canvas.addEventListener('webglcontextlost', onLost)

    return () => {
      canvas.removeEventListener('webglcontextlost', onLost)
      rendererRef.current = null
      // `dispose()` and deliberately not `forceContextLoss()` — see
      // `BlochScene.tsx` for the StrictMode remount this would otherwise break.
      renderer.dispose()
    }
  }, [])

  /* ── the scene graph: rebuilt when the register changes shape ──────── */
  useEffect(() => {
    const renderer = rendererRef.current
    if (renderer === null) return

    const objects = buildScene(qubits, capacity)
    sceneRef.current = objects

    return () => {
      sceneRef.current = null
      objects.dispose()
    }
  }, [qubits, capacity])

  /* ── the nodes: written onto the pool that already exists ──────────── */
  useEffect(() => {
    const objects = sceneRef.current
    if (objects === null) return

    objects.nodes.forEach((object, index) => {
      const node = nodes[index]
      // A pool slot with no state behind it is a register that shrank between
      // the answer and this frame. Hiding is the only honest thing to draw.
      if (node === undefined) {
        object.mesh.visible = false
        object.line.visible = false
        return
      }
      object.mesh.visible = true
      object.line.visible = true
      object.mesh.position.set(
        node.position.x,
        node.position.y,
        node.position.z
      )
      // The pooled geometry is a unit sphere, so the scale *is* the radius —
      // and the radius is exactly proportional to |a| with no floor under it
      // (`qsphere.ts`), so a vanishing amplitude vanishes.
      object.mesh.scale.setScalar(node.radius)
      object.material.color.setStyle(phaseToColour(node.phase))
      object.lineMaterial.color.setStyle(phaseToColour(node.phase))
      object.geometry.setFromPoints([
        new Vector3(0, 0, 0),
        new Vector3(node.position.x, node.position.y, node.position.z),
      ])
    })

    draw(rendererRef.current, sceneRef.current, azimuthRef.current)
  }, [nodes])

  /* ── the turn ──────────────────────────────────────────────────────── */
  useEffect(() => {
    if (frozen) {
      // One frame, from the angle the scene starts at — reset rather than
      // frozen where it happened to be, so turning the preference on gives the
      // same picture as loading the page with it on.
      azimuthRef.current = VIEW_AZIMUTH
      draw(rendererRef.current, sceneRef.current, azimuthRef.current)
      return
    }

    let handle = 0
    let previous = performance.now()
    const step = (now: number): void => {
      azimuthRef.current += (now - previous) * TURN_RATE
      previous = now
      draw(rendererRef.current, sceneRef.current, azimuthRef.current)
      handle = requestAnimationFrame(step)
    }
    handle = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(handle)
    }
  }, [frozen])

  const north = project({ x: 0, y: 0, z: LABEL_RADIUS }, VIEW_AZIMUTH)
  const south = project({ x: 0, y: 0, z: -LABEL_RADIUS }, VIEW_AZIMUTH)

  return (
    <div className="qsphere__stage" style={{ maxWidth: `${STAGE_PIXELS}px` }}>
      <canvas ref={canvasRef} className="qsphere__canvas" aria-hidden="true" />

      {/*
       * The two labels never move: the turn is about z, and `viewUp` keeps ẑ
       * projecting straight up at every azimuth, so the poles are nailed to the
       * top and bottom of the sphere. That is why this overlay is static where
       * the Bloch scene's is written from its frame loop.
       */}
      <svg
        className="qsphere__labels"
        viewBox={`0 0 ${STAGE_PIXELS} ${STAGE_PIXELS}`}
        width={STAGE_PIXELS}
        height={STAGE_PIXELS}
        aria-hidden="true"
        focusable="false"
      >
        <NotationText
          className="qsphere__pole"
          value={ketOf(0, qubits)}
          x={STAGE_PIXELS / 2 + north.x * STAGE_RADIUS}
          y={STAGE_PIXELS / 2 - north.y * STAGE_RADIUS}
        />
        <NotationText
          className="qsphere__pole"
          value={ketOf((1 << qubits) - 1, qubits)}
          x={STAGE_PIXELS / 2 + south.x * STAGE_RADIUS}
          y={STAGE_PIXELS / 2 - south.y * STAGE_RADIUS}
        />
      </svg>
    </div>
  )
}

/**
 * The two poles' kets, built here rather than imported from the model, because
 * they are properties of the *register* and not of the state: |0…0⟩ is the
 * north pole whether or not any amplitude reaches it, which is exactly what
 * makes a GHZ state's two points read as poles.
 */
function ketOf(index: number, qubits: number): string {
  let bits = ''
  for (let qubit = qubits - 1; qubit >= 0; qubit--) {
    bits += (index >> qubit) & 1
  }
  return `|${bits}⟩`
}

/* ───────────────────────────── the scene ────────────────────────────── */

/**
 * Everything that does not depend on the amplitudes: the sphere's wireframe,
 * one latitude ring per Hamming weight, and a pool of `capacity` nodes waiting
 * to be placed.
 *
 * THE LATITUDE RINGS ARE THE LEGEND. Without them the arrangement is a cloud of
 * dots; with them it is a register — the reader can see that one ring holds
 * every state with two ones in it, and that a W state is a ring while a GHZ
 * state is two poles. They are the one piece of scenery here that carries
 * information, which is why they are drawn in the axis colour rather than in
 * the fainter wire colour the meridians use.
 */
function buildScene(qubits: number, capacity: number): SceneObjects {
  const scene = new Scene()
  /*
   * ONE SCALE, SHARED WITH THE OVERLAY. The camera's frustum is exactly
   * `STAGE_UNITS` across and the canvas is exactly `STAGE_PIXELS` wide, so a
   * sphere radius is `STAGE_RADIUS` pixels in *both* renderings — which is what
   * the SVG places the pole labels with. Any other half-width here would put
   * `|0…0⟩` a few pixels off the top of the sphere, and that does not read as a
   * rounding error: it reads as a mislabelled diagram, which `bloch.ts` calls
   * the one thing a picture must never do.
   */
  const half = STAGE_UNITS / 2
  const camera = new OrthographicCamera(
    -half,
    half,
    half,
    -half,
    1,
    CAMERA_DISTANCE * 2
  )

  const unitCircle = Array.from(
    { length: CIRCLE_SEGMENTS },
    (_unused, step) => {
      const angle = (2 * Math.PI * step) / CIRCLE_SEGMENTS
      return new Vector3(Math.cos(angle), Math.sin(angle), 0)
    }
  )
  const circle = new BufferGeometry().setFromPoints(unitCircle)

  const wireMaterial = new LineBasicMaterial({
    color: tokenColour('--wire', '#5a65aa'),
  })
  const ringMaterial = new LineBasicMaterial({
    color: tokenColour('--chart-axis', '#8b93c4'),
    transparent: true,
    opacity: 0.55,
  })

  // Two meridians read the ball as a ball; a third would clutter the equator,
  // which on an odd-qubit register is not a latitude any state sits on.
  const meridianX = new LineLoop(circle, wireMaterial)
  meridianX.rotation.x = Math.PI / 2
  const meridianY = new LineLoop(circle, wireMaterial)
  meridianY.rotation.y = Math.PI / 2
  scene.add(meridianX, meridianY)

  const rings: LineLoop[] = []
  for (let weight = 0; weight <= qubits; weight++) {
    const z = qubits === 0 ? 1 : 1 - (2 * weight) / qubits
    const radius = Math.sqrt(Math.max(0, 1 - z * z))
    // The poles are rings of radius zero. Drawing them would put a dot of ring
    // colour exactly where the |0…0⟩ node goes and make an empty pole look
    // occupied.
    if (radius <= 0) continue
    const ring = new LineLoop(circle, ringMaterial)
    ring.position.set(0, 0, z)
    ring.scale.setScalar(radius)
    scene.add(ring)
    rings.push(ring)
  }

  // One unit sphere, scaled per node. Uploading `capacity` copies of the same
  // twelve-segment ball would be `capacity` buffers for the driver to keep.
  const ball = new SphereGeometry(1, NODE_SEGMENTS, NODE_SEGMENTS)
  const nodes: NodeObjects[] = []
  for (let index = 0; index < capacity; index++) {
    const material = new MeshBasicMaterial({ color: 0xffffff })
    const mesh = new Mesh(ball, material)
    mesh.visible = false

    // The spoke from the centre. It is what says the state is *there* when its
    // node is too small to see, which is the only rendering a vanishing
    // amplitude gets in the picture (the table has the number).
    const lineMaterial = new LineBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.45,
    })
    const geometry = new BufferGeometry().setFromPoints([
      new Vector3(0, 0, 0),
      new Vector3(0, 0, 1),
    ])
    const line = new Line(geometry, lineMaterial)
    line.visible = false

    const group = new Group()
    group.add(mesh, line)
    scene.add(group)
    nodes.push({ mesh, line, material, lineMaterial, geometry })
  }

  return {
    scene,
    camera,
    nodes,
    dispose: () => {
      circle.dispose()
      ball.dispose()
      wireMaterial.dispose()
      ringMaterial.dispose()
      for (const ring of rings) scene.remove(ring)
      for (const node of nodes) {
        node.material.dispose()
        node.lineMaterial.dispose()
        node.geometry.dispose()
      }
    },
  }
}

/** One frame: place the camera and draw. The scene itself never moves. */
function draw(
  renderer: WebGLRenderer | null,
  objects: SceneObjects | null,
  azimuth: number
): void {
  if (renderer === null || objects === null) return
  const forward = viewDirection(azimuth)
  const up = viewUp(azimuth)

  objects.camera.position.set(
    forward.x * CAMERA_DISTANCE,
    forward.y * CAMERA_DISTANCE,
    forward.z * CAMERA_DISTANCE
  )
  objects.camera.up.set(up.x, up.y, up.z)
  objects.camera.lookAt(0, 0, 0)
  renderer.render(objects.scene, objects.camera)
}
