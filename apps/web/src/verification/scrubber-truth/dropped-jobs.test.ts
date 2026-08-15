/**
 * The scrubber against a worker that drops work — the failure the checkpoint
 * accounting exists for, driven from the other end.
 *
 * `scheduler.ts` keeps `dirtyFrom` as an accumulated minimum that only an
 * *analytic result* clears, because a job that is dropped, cancelled or run in
 * trajectories mode proves nothing about how far the worker's cache caught up.
 * The consequence it protects is exactly this lens's subject: a scrub step that
 * resumed from a checkpoint an edit had already contradicted would return a
 * perfectly normalised statevector belonging to no circuit, and nothing
 * downstream could tell.
 *
 * So this drives the real scheduler and the real `runJob` over one persistent
 * cache, through a transport that behaves like the worker's inbox — newest
 * request only, everything queued behind it dropped unrun — and compares the
 * outcome against a whole circuit truncated at the cut and run from |0…0⟩ with
 * no cache at all. The expectation shares no code with the thing it checks.
 */

import {
  analyticMode,
  createCheckpoints,
  run,
  type Statevector,
} from '@qsim/core'
import { CIRCUIT_SCHEMA_VERSION, type Circuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { runJob } from '../../features/simulation/job'
import type {
  SimulateRequest,
  SimulationOutcome,
} from '../../features/simulation/protocol'
import {
  createSimulationScheduler,
  type RunOptions,
} from '../../features/simulation/scheduler'

const TOLERANCE = 1e-10

function truncate(circuit: Circuit, through: number): Circuit {
  return {
    ...circuit,
    operations: circuit.operations.filter((op) => op.column <= through),
  }
}

function expected(circuit: Circuit, through: number): Statevector {
  const result = run(truncate(circuit, through), analyticMode())
  if (result.mode !== 'analytic') throw new Error('analytic mode asked for')
  return result.state
}

function compare(label: string, got: Statevector, want: Statevector): void {
  expect(got.size, `${label}: size`).toBe(want.size)
  for (let index = 0; index < want.size; index++) {
    const gotRe = got.re[index] ?? 0
    const gotIm = got.im[index] ?? 0
    const wantRe = want.re[index] ?? 0
    const wantIm = want.im[index] ?? 0
    if (
      Math.abs(gotRe - wantRe) > TOLERANCE ||
      Math.abs(gotIm - wantIm) > TOLERANCE
    ) {
      throw new Error(
        `${label}: amplitude ${index} is ${gotRe}+${gotIm}i, ` +
          `expected ${wantRe}+${wantIm}i`
      )
    }
  }
}

/** A gate per column, cycled, so a long circuit is not a long copy-paste. */
const CYCLE = ['h', 't', 's', 'x', 'y', 'z', 'sx'] as const

function cycled(index: number): string {
  return CYCLE[index % CYCLE.length] ?? 'h'
}

/**
 * The main thread and a worker, wired together in one process.
 *
 * `dropQueued` is the worker's own policy (`simulation.worker.ts`): while a run
 * blocks the thread everything behind it piles up, and only the newest survives.
 */
function harness(options: { readonly dropQueued?: boolean } = {}) {
  const cache = createCheckpoints()
  const scheduler = createSimulationScheduler({ debounceMs: 0 })
  const inbox: SimulateRequest[] = []
  let cancelledThrough = 0
  let ran = 0

  scheduler.connect((request) => {
    if (request.kind === 'cancel') {
      cancelledThrough = Math.max(cancelledThrough, request.id)
      return
    }
    inbox.push(request)
  })

  function drain(): void {
    while (inbox.length > 0) {
      const request = options.dropQueued
        ? inbox[inbox.length - 1]
        : inbox.shift()
      if (options.dropQueued) inbox.length = 0
      if (request === undefined || request.id <= cancelledThrough) continue
      ran += 1
      scheduler.receive(runJob(cache, request, false).response)
    }
  }

  function outcome(): SimulationOutcome {
    const snapshot = scheduler.getSnapshot()
    if (snapshot.outcome === null) {
      throw new Error(`no outcome: ${JSON.stringify(snapshot.failure)}`)
    }
    return snapshot.outcome
  }

  return {
    runs: (): number => ran,
    status: (): string => scheduler.getSnapshot().status,
    schedule: (circuit: Circuit, request: RunOptions): void => {
      scheduler.schedule(circuit, request)
    },
    /** Let the debounce fire, then let the worker work. */
    settle: async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 2))
      drain()
    },
    /** Let the debounce fire and throw the request away unrun. */
    starve: async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 2))
      inbox.length = 0
    },
    analytic: (): { state: Statevector; throughColumn: number | null } => {
      const result = outcome()
      if (result.mode !== 'analytic') throw new Error('analytic asked for')
      return { state: result.state, throughColumn: result.throughColumn }
    },
  }
}

const long: Circuit = {
  schemaVersion: CIRCUIT_SCHEMA_VERSION,
  qubits: 3,
  clbits: 0,
  operations: Array.from({ length: 60 }, (_, index) => ({
    id: `op${index}`,
    gate: cycled(index),
    targets: [index % 3],
    column: index,
  })),
}

function edited(circuit: Circuit, column: number, gate: string): Circuit {
  return {
    ...circuit,
    operations: circuit.operations.map((op) =>
      op.column === column ? { ...op, gate } : op
    ),
  }
}

describe('a scrub step after work the worker never did', () => {
  it('does not resume past an edit whose job was dropped', async () => {
    const app = harness()
    app.schedule(long, { throughColumn: null })
    await app.settle()

    const changed = edited(long, 3, 'y')
    app.schedule(changed, { throughColumn: null })
    await app.starve()

    app.schedule(changed, { throughColumn: 50 })
    await app.settle()

    const shown = app.analytic()
    expect(shown.throughColumn).toBe(50)
    compare('after a dropped edit', shown.state, expected(changed, 50))
  })

  it('answers the newest of a burst the worker could not keep up with', async () => {
    const app = harness({ dropQueued: true })
    app.schedule(long, { throughColumn: null })
    await app.settle()

    const changed = edited(long, 10, 'y')
    app.schedule(changed, { throughColumn: null })
    for (let cut = 0; cut < 30; cut++) {
      app.schedule(changed, { throughColumn: cut })
    }
    await app.settle()

    compare('newest of a burst', app.analytic().state, expected(changed, 29))
  })

  it('leaves the final answer intact after a walk and an edit', async () => {
    const app = harness()
    app.schedule(long, { throughColumn: null })
    await app.settle()

    for (const cut of [40, 5, 22, -1, 59, 12]) {
      app.schedule(long, { throughColumn: cut })
      await app.settle()
      compare(`cut ${cut}`, app.analytic().state, expected(long, cut))
    }

    const changed = edited(long, 7, 'y')
    app.schedule(changed, { throughColumn: 12 })
    await app.settle()
    compare(
      'edited at 7, read at 12',
      app.analytic().state,
      expected(changed, 12)
    )

    app.schedule(changed, { throughColumn: null })
    await app.settle()
    compare('and then the end', app.analytic().state, expected(changed, 59))
  })

  it('survives a trajectories run in the middle of the walk', async () => {
    const app = harness()
    const measuring: Circuit = {
      ...long,
      clbits: 1,
      operations: [
        ...long.operations,
        {
          id: 'm',
          gate: 'measure',
          targets: [0],
          clbitTargets: [0],
          column: 60,
        },
      ],
    }
    app.schedule(long, { throughColumn: null })
    await app.settle()

    // A measurement arrives, so the panel switches modes; sampling never
    // touches the checkpoint cache and therefore proves nothing about it.
    app.schedule(measuring, { mode: 'trajectories', shots: 8 })
    await app.settle()

    const changed = edited(long, 2, 'y')
    app.schedule(changed, { throughColumn: 30 })
    await app.settle()
    compare('after the detour', app.analytic().state, expected(changed, 30))
  })

  it('sends a scrub step without waiting out the debounce', async () => {
    const app = harness()
    app.schedule(long, { throughColumn: null })
    await app.settle()
    const before = app.runs()

    app.schedule(long, { throughColumn: 4 })
    // No timer has been advanced: the request is already on its way.
    expect(app.status()).toBe('running')

    await app.settle()
    expect(app.runs()).toBe(before + 1)
    compare('immediate scrub', app.analytic().state, expected(long, 4))
  })
})
