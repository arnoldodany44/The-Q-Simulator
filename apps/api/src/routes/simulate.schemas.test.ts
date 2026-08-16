/**
 * The three declarations of one vocabulary, held side by side.
 *
 * `SimMode` and `RunStatus` are Postgres types. Prisma mirrors them into
 * `@qsim/db`; `@qsim/jobs` declares them again because the worker should not
 * learn what a mode is from the database; and `@qsim/contract` declares them a
 * third time because the browser may import neither (§12.3, rule 3).
 *
 * Three spellings of one enum is two chances to drift, and `apps/api` is the
 * only workspace that can see all three — the same argument, and the same test
 * shape, as the `Visibility` assertion in `circuits.schemas.test.ts`. The
 * failure this prevents is not a compile error anywhere: it is a run whose mode
 * the API accepts, the queue carries and Postgres rejects at the insert.
 *
 * The client ceiling gets the same treatment for the same reason. `apps/web`
 * owns the browser's copy and nothing may import it, so `clientCeilingsAgree`
 * exists to let a holder of both numbers say they match — and this file is that
 * holder, because the threshold in §8 is meaningless if the two ends disagree
 * about where the browser stops.
 */

import {
  RunStatus as ContractRunStatus,
  SIMULATION_MODE_VALUES,
  RUN_STATUS_VALUES,
  SimulationMode as ContractSimulationMode,
} from '@qsim/contract'
import {
  RunStatus as PrismaRunStatus,
  SimMode as PrismaSimMode,
} from '@qsim/db'
import {
  CLIENT_DENSITY_QUBITS,
  CLIENT_STATEVECTOR_QUBITS,
  RUN_STATUSES,
  SIMULATION_MODES,
  clientCeilingsAgree,
} from '@qsim/jobs'
import { describe, expect, it } from 'vitest'

describe('SimMode', () => {
  it('is the same set in Prisma, in the contract and in the queue package', () => {
    expect(Object.entries(ContractSimulationMode).sort()).toEqual(
      Object.entries(PrismaSimMode).sort()
    )
    expect([...SIMULATION_MODES].sort()).toEqual(
      Object.values(PrismaSimMode).sort()
    )
    expect([...SIMULATION_MODE_VALUES].sort()).toEqual(
      [...SIMULATION_MODES].sort()
    )
  })

  it('is structurally interchangeable, so no cast is needed at a boundary', () => {
    const fromContract: PrismaSimMode = ContractSimulationMode.TRAJECTORIES
    const fromPrisma: ContractSimulationMode = PrismaSimMode.TRAJECTORIES
    expect(fromContract).toBe(fromPrisma)
  })
})

describe('RunStatus', () => {
  it('is the same set in all three', () => {
    expect(Object.entries(ContractRunStatus).sort()).toEqual(
      Object.entries(PrismaRunStatus).sort()
    )
    expect([...RUN_STATUSES].sort()).toEqual(
      Object.values(PrismaRunStatus).sort()
    )
    expect([...RUN_STATUS_VALUES].sort()).toEqual([...RUN_STATUSES].sort())
  })

  it('is structurally interchangeable', () => {
    const fromContract: PrismaRunStatus = ContractRunStatus.RUNNING
    const fromPrisma: ContractRunStatus = PrismaRunStatus.RUNNING
    expect(fromContract).toBe(fromPrisma)
  })
})

describe('the client ceilings the §8 threshold is derived from', () => {
  it('match the numbers apps/web enforces in the browser', () => {
    /*
     * Restated rather than imported, because nothing here may import an app.
     * The browser's copies are `MAX_CLIENT_QUBITS` and
     * `MAX_DENSITY_CLIENT_QUBITS` in apps/web/src/features/simulation/
     * protocol.ts, and they are 20 and 12. If either moves, this fails and the
     * threshold is revisited deliberately — rather than the server quietly
     * offering to wait for work no browser would have sent it.
     */
    expect(CLIENT_STATEVECTOR_QUBITS).toBe(20)
    expect(CLIENT_DENSITY_QUBITS).toBe(12)
    expect(clientCeilingsAgree(20, 12)).toBe(true)
  })
})
