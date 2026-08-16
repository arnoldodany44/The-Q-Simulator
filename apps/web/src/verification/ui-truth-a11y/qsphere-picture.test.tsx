/**
 * Independent verification (lens: ui-truth-a11y) — does the Q-sphere paint the
 * phase with the one mapping this app has, and is the picture hidden from the
 * readers it cannot serve?
 *
 * The scene is WebGL, so jsdom cannot run it and cannot be asked to. What it can
 * do is stand in for three.js and record what the component *asks the driver to
 * draw*: one colour, one scale and one position per basis state. Those three are
 * the whole encoding (§3.2: "radio proporcional a la amplitud y color por
 * fase"), so recording them is recording the picture.
 *
 * Every expected value is written out here from §10's rule and from the
 * geometry, never taken from `qsphere.ts`:
 *
 *     hue = phase · 180/π      colour = hsl(hue, 85%, 66%)
 *     radius = NODE_RADIUS · |a|            (proportional, no floor)
 *     z = 1 − 2·weight/n                    latitude is Hamming weight
 *     x² + y² = 1 − z²                      the node sits on the sphere
 *
 * The saturation and the lightness are spelled out as literals on purpose: they
 * are §10's numbers, and importing them from the module under test would make
 * this file agree with a re-tuned palette instead of catching one.
 */

import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { buildQSphere, popcount } from '../../features/analysis/qsphere'
import type { Statevector } from '@qsim/core'

/* ─────────────────── a three.js that records instead of drawing ─────────── */

/** What a drawn object exposes to an assertion. */
interface Drawn {
  visible: boolean
  position: { x: number; y: number; z: number }
  scaleValue: number
  material: { color: { style: string } }
}

const recorded = vi.hoisted(() => ({
  meshes: [] as Drawn[],
  lines: [] as Drawn[],
  loops: [] as Drawn[],
  frames: 0,
  reset(): void {
    this.meshes.length = 0
    this.lines.length = 0
    this.loops.length = 0
    this.frames = 0
  },
}))

vi.mock('three', () => {
  class Colour {
    style = ''
    setStyle(value: string): this {
      this.style = value
      return this
    }
  }
  class Vec {
    constructor(
      public x = 0,
      public y = 0,
      public z = 0
    ) {}
    set(x: number, y: number, z: number): this {
      this.x = x
      this.y = y
      this.z = z
      return this
    }
  }
  class Geometry {
    points: Vec[] = []
    setFromPoints(points: Vec[]): this {
      this.points = points
      return this
    }
    dispose(): void {}
  }
  class Material {
    color = new Colour()
    dispose(): void {}
  }
  class Object3D {
    visible = true
    position = new Vec()
    rotation = new Vec()
    scaleValue = 1
    scale = {
      setScalar: (value: number): void => {
        this.scaleValue = value
      },
    }
    children: Object3D[] = []
    add(...items: Object3D[]): this {
      this.children.push(...items)
      return this
    }
    remove(): this {
      return this
    }
  }
  class Mesh extends Object3D {
    constructor(
      public geometry: Geometry,
      public material: Material
    ) {
      super()
      // The instance itself, read at assertion time: three.js is written
      // against mutable objects and so is the component, so a snapshot taken
      // here would record the pool before anything was placed in it.
      recorded.meshes.push(this)
    }
  }
  class Line extends Object3D {
    constructor(
      public geometry: Geometry,
      public material: Material
    ) {
      super()
      recorded.lines.push(this)
    }
  }
  class LineLoop extends Line {
    constructor(geometry: Geometry, material: Material) {
      super(geometry, material)
      // A ring is not a spoke: drop the entry `Line` just recorded so that
      // `recorded.lines` holds one entry per node, in node order.
      recorded.lines.pop()
      recorded.loops.push(this)
    }
  }
  class Camera extends Object3D {
    up = new Vec()
    constructor(
      public left = 0,
      public right = 0,
      public top = 0,
      public bottom = 0,
      public near = 0,
      public far = 0
    ) {
      super()
    }
    lookAt(): void {}
  }
  class Renderer {
    constructor(public options: { canvas: HTMLCanvasElement }) {}
    setPixelRatio(): void {}
    setSize(): void {}
    render(): void {
      recorded.frames += 1
    }
    dispose(): void {}
  }

  return {
    BufferGeometry: Geometry,
    Color: Colour,
    Group: Object3D,
    Line,
    LineBasicMaterial: Material,
    LineLoop,
    Mesh,
    MeshBasicMaterial: Material,
    OrthographicCamera: Camera,
    Scene: Object3D,
    SphereGeometry: Geometry,
    Vector3: Vec,
    WebGLRenderer: Renderer,
  }
})

/* ────────────────────────── the reference arithmetic ────────────────────── */

/** §10's rule, written out. The two percentages are the specification's. */
function expectedColour(phase: number): string {
  const wrapped = phase - 2 * Math.PI * Math.floor(phase / (2 * Math.PI))
  const degrees = (wrapped * 180) / Math.PI
  const hue = Math.round(degrees * 100) / 100
  return `hsl(${hue} 85% 66%)`
}

function stateOf(
  qubits: number,
  amplitudes: readonly (readonly [number, number, number])[]
): Statevector {
  const size = 1 << qubits
  const re = new Float64Array(size)
  const im = new Float64Array(size)
  let norm = 0
  for (const [index, real, imaginary] of amplitudes) {
    re[index] = real
    im[index] = imaginary
    norm += real * real + imaginary * imaginary
  }
  const scale = 1 / Math.sqrt(norm)
  for (let i = 0; i < size; i++) {
    re[i] = (re[i] ?? 0) * scale
    im[i] = (im[i] ?? 0) * scale
  }
  return { qubits, size, re, im }
}

/** Node radius at |a| = 1, from `qsphere.ts`'s stated proportionality. */
const NODE_RADIUS = 0.11

async function drawScene(state: Statevector, frozen = false) {
  const model = buildQSphere(state)
  const { QSphereScene } = await import('../../features/analysis/QSphereScene')
  const view = render(
    <QSphereScene
      nodes={model.nodes}
      qubits={model.qubits}
      capacity={model.limit}
      frozen={frozen}
      onUnavailable={() => undefined}
    />
  )
  return { model, view }
}

beforeEach(() => {
  recorded.reset()
})

afterEach(cleanup)

describe('the Q-sphere draws what the table says', () => {
  /**
   * Four states of a three-qubit register, each with a phase of its own, so a
   * hue that came from anything but the phase would show on at least one.
   */
  const state = stateOf(3, [
    [0b000, 1, 0], // phase 0
    [0b001, 0, 1], // phase π/2
    [0b011, -1, 0], // phase π
    [0b111, 0, -0.5], // phase 3π/2, half the magnitude
  ])

  it('paints every node with §10’s phase-to-hue formula', async () => {
    const { model } = await drawScene(state)
    expect(model.nodes.length).toBe(4)

    model.nodes.forEach((node, index) => {
      const mesh = recorded.meshes[index]
      expect(mesh, `node ${node.label}`).toBeDefined()
      expect(mesh?.material.color.style, `node ${node.label}`).toBe(
        expectedColour(node.phase)
      )
    })
    // The four phases really are four different hues, so the assertion above
    // could not have passed on a constant.
    expect(
      new Set(
        recorded.meshes.slice(0, 4).map((mesh) => mesh.material.color.style)
      ).size
    ).toBe(4)
  })

  it('paints the spoke in the same hue as its node', async () => {
    // The spoke is what says a vanishing amplitude is still *there*. A spoke in
    // a different colour would be a second, contradictory phase reading.
    const { model } = await drawScene(state)
    model.nodes.forEach((node, index) => {
      expect(recorded.lines[index]?.material.color.style, node.label).toBe(
        expectedColour(node.phase)
      )
    })
  })

  it('scales every node by |a| exactly, with no floor under it', async () => {
    const { model } = await drawScene(state)
    model.nodes.forEach((node, index) => {
      const magnitude = Math.sqrt(node.probability)
      expect(recorded.meshes[index]?.scaleValue, node.label).toBeCloseTo(
        NODE_RADIUS * magnitude,
        12
      )
    })
    // |111⟩ carries half the amplitude of the others, so the radii are not all
    // the same number and "proportional" means something here.
    const scales = model.nodes.map(
      (_node, index) => recorded.meshes[index]?.scaleValue ?? 0
    )
    expect(new Set(scales).size).toBeGreaterThan(1)
  })

  it('places every node on the ring for its Hamming weight', async () => {
    const { model } = await drawScene(state)
    model.nodes.forEach((node, index) => {
      const position = recorded.meshes[index]?.position
      expect(position, node.label).toBeDefined()
      const weight = popcount(node.index)
      // Latitude from the weight, and the node is on the unit sphere.
      expect(position?.z ?? NaN, node.label).toBeCloseTo(
        1 - (2 * weight) / model.qubits,
        12
      )
      const ring = Math.hypot(position?.x ?? 0, position?.y ?? 0)
      expect(ring, node.label).toBeCloseTo(
        Math.sqrt(Math.max(0, 1 - (position?.z ?? 0) ** 2)),
        12
      )
    })
  })

  it('draws a latitude ring for every weight that has one', async () => {
    const { model } = await drawScene(state)
    // Weights 0…n, minus the two poles, whose rings have radius zero.
    const expected: number[] = []
    for (let weight = 0; weight <= model.qubits; weight++) {
      const z = 1 - (2 * weight) / model.qubits
      const radius = Math.sqrt(Math.max(0, 1 - z * z))
      if (radius > 0) expected.push(z)
    }
    // Two meridians are LineLoops too, and they sit at z = 0 with radius 1.
    const rings = recorded.loops.filter((loop) => loop.scaleValue !== 1)
    expect(rings.map((ring) => ring.position.z).sort()).toEqual(expected.sort())
  })

  it('hides the canvas and the label overlay from assistive technology', async () => {
    const { view } = await drawScene(state)
    const canvas = view.container.querySelector('canvas')
    expect(canvas).not.toBeNull()
    expect(canvas?.getAttribute('aria-hidden')).toBe('true')

    const svg = view.container.querySelector('svg')
    expect(svg?.getAttribute('aria-hidden')).toBe('true')
    expect(svg?.getAttribute('focusable')).toBe('false')

    // And nothing in the picture is reachable by keyboard.
    expect(view.container.querySelectorAll('[tabindex]').length).toBe(0)
  })

  it('does not turn under prefers-reduced-motion', async () => {
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame')
    await drawScene(state, true)
    expect(frames).not.toHaveBeenCalled()
    // Still drawn: one frame, so the picture exists and simply does not move.
    expect(recorded.frames).toBeGreaterThan(0)
    frames.mockRestore()
  })

  it('turns when motion is allowed', async () => {
    // The complement of the assertion above: if the scene never animated at
    // all, "reduced motion is respected" would be true and empty.
    const frames = vi.spyOn(globalThis, 'requestAnimationFrame')
    await drawScene(state, false)
    expect(frames).toHaveBeenCalled()
    frames.mockRestore()
  })
})
