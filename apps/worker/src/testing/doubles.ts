/**
 * In-memory stand-ins for the two ports a job touches.
 *
 * The run store is not a mock of the thing under test — it is a model of the
 * one property the real repository is built around: **every status write is a
 * compare-and-set**. If this double let a terminal row be overwritten, the
 * processor tests would pass while the real system ran a re-executed job twice
 * with visible effect, which is precisely the failure they exist to rule out.
 */

import { SimulationFailure, isTerminalStatus, predecessorsOf } from '@qsim/jobs'
import type {
  RunStatus,
  SimulationFailureCode,
  SimulationRunResult,
} from '@qsim/jobs'
import type { SimulationRunRepository, StoredRun } from '@qsim/db'
import type { SimulationPool } from '../pool.js'

export interface FakeRunStore extends SimulationRunRepository {
  /** Every row, by id, for a test to read the end state out of. */
  readonly rows: Map<string, StoredRun>
  seed(run: Partial<StoredRun> & { id: string }): StoredRun
}

export function fakeRunStore(): FakeRunStore {
  const rows = new Map<string, StoredRun>()

  function move(
    id: string,
    to: RunStatus,
    changes: Partial<StoredRun>
  ): boolean {
    const row = rows.get(id)
    if (row === undefined) return false
    // The whole point of the double: a transition the table forbids matches no
    // row, exactly as `updateMany` with a status predicate would.
    if (!predecessorsOf(to).includes(row.status)) return false
    rows.set(id, { ...row, ...changes, status: to })
    return true
  }

  return {
    rows,

    seed(run) {
      const row: StoredRun = {
        id: run.id,
        circuitId: run.circuitId ?? null,
        mode: run.mode ?? 'STATEVECTOR',
        shots: run.shots ?? null,
        status: run.status ?? 'QUEUED',
        result: run.result ?? null,
        errorMessage: run.errorMessage ?? null,
        durationMs: run.durationMs ?? null,
        createdAt: run.createdAt ?? new Date(0),
      }
      rows.set(row.id, row)
      return row
    },

    createRun(input) {
      const id = `run_${String(rows.size + 1).padStart(19, '0')}`
      return Promise.resolve(
        this.seed({
          id,
          circuitId: input.circuitId,
          mode: input.mode,
          shots: input.shots,
        })
      )
    },

    findReadableRun(id) {
      return Promise.resolve(rows.get(id) ?? null)
    },

    claimRun(id, options = {}) {
      const row = rows.get(id)
      if (row === undefined) return Promise.resolve(false)
      /*
       * The recovery claim, modelled the way the repository writes it: RUNNING
       * is claimable when the queue is re-delivering the job, because the
       * previous holder's lock has expired by then. A terminal row is refused
       * either way, which is the guard that makes two executions harmless.
       */
      if (options.recovery === true && row.status === 'RUNNING') {
        return Promise.resolve(true)
      }
      return Promise.resolve(move(id, 'RUNNING', {}))
    },

    runStatus(id) {
      return Promise.resolve(rows.get(id)?.status ?? null)
    },

    failStaleRuns({ before, code, limit }) {
      let moved = 0
      for (const row of [...rows.values()]) {
        if (moved >= limit) break
        if (isTerminalStatus(row.status)) continue
        if (row.createdAt.getTime() >= before.getTime()) continue
        rows.set(row.id, {
          ...row,
          status: 'FAILED',
          errorMessage: code,
          result: null,
          durationMs: null,
        })
        moved += 1
      }
      return Promise.resolve(moved)
    },

    completeRun({ id, result, durationMs }) {
      return Promise.resolve(
        move(id, 'DONE', {
          result: result as StoredRun['result'],
          errorMessage: null,
          durationMs,
        })
      )
    },

    failRun({ id, code, durationMs }) {
      return Promise.resolve(
        move(id, 'FAILED', { errorMessage: code, result: null, durationMs })
      )
    },

    discardRun({ id }) {
      const row = rows.get(id)
      if (row === undefined || isTerminalStatus(row.status)) {
        return Promise.resolve(false)
      }
      if (row.status !== 'QUEUED') return Promise.resolve(false)
      rows.delete(id)
      return Promise.resolve(true)
    },
  }
}

export interface FakePoolOptions {
  /** What a run resolves with. Ignored when `failWith` is set. */
  readonly result?: Partial<SimulationRunResult>
  /** Reject with this code instead of resolving. */
  readonly failWith?: SimulationFailureCode
  /** Progress the pool emits before it answers. */
  readonly progress?: readonly Parameters<
    NonNullable<Parameters<SimulationPool['run']>[1]>['onProgress'] & object
  >[0][]
  /** Resolve only when the returned `release` is called. */
  readonly hold?: boolean
}

export interface FakePool extends SimulationPool {
  /** Resolves a held run. Present only when `hold` was asked for. */
  release(): void
  readonly calls: number
}

export function fakePool(options: FakePoolOptions = {}): FakePool {
  let release: () => void = () => undefined
  let calls = 0

  const pool: FakePool = {
    async run(_payload, runOptions) {
      calls++
      for (const progress of options.progress ?? []) {
        runOptions?.onProgress?.(progress)
      }
      if (options.hold === true) {
        await new Promise<void>((resolve) => {
          release = resolve
        })
      }
      if (options.failWith !== undefined) {
        throw new SimulationFailure(
          options.failWith,
          'the fake pool was asked to fail'
        )
      }
      return {
        resultVersion: 1,
        mode: 'STATEVECTOR',
        qubits: 2,
        shots: null,
        seed: 7,
        noiseProfileId: null,
        outcomes: [{ state: '00', probability: 1, count: null }],
        hiddenOutcomes: 0,
        hiddenWeight: 0,
        purity: null,
        durationMs: 12,
        ...options.result,
      }
    },
    size: () => 0,
    close: () => Promise.resolve(),
    release: () => {
      release()
    },
    get calls() {
      return calls
    },
  }

  return pool
}
