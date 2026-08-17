import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  CREDENTIAL_DOCUMENT_VERSION,
  NON_TERMINAL_JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  hardwarePredecessorsOf,
  isTerminalJobStatus,
  parseStoredProgram,
} from './hardware.js'
import { JobStatus } from './generated/prisma/enums.js'
import { KEY_BYTES, createCredentialCipher } from './secrets.js'

describe('the hardware job transition table', () => {
  it('covers every status of the Postgres enum', () => {
    for (const status of Object.values(JobStatus)) {
      expect(hardwarePredecessorsOf(status)).toBeDefined()
    }
  })

  it('lets nothing precede SUBMITTED — a job is created in it', () => {
    expect(hardwarePredecessorsOf(JobStatus.SUBMITTED)).toEqual([])
  })

  it('makes every terminal status final, including a repeat of itself', () => {
    for (const terminal of TERMINAL_JOB_STATUSES) {
      for (const next of Object.values(JobStatus)) {
        expect(hardwarePredecessorsOf(next)).not.toContain(terminal)
      }
    }
  })

  /*
   * A poll re-states what it read, because the write is also what refreshes
   * `lastPolledAt`. Refusing a self-transition would make a long-running job
   * the one case that never updates its bookkeeping — and the resume sweep
   * would then keep resuming a job that is being polled perfectly.
   */
  it('lets QUEUED and RUNNING be written over themselves', () => {
    expect(hardwarePredecessorsOf(JobStatus.QUEUED)).toContain(JobStatus.QUEUED)
    expect(hardwarePredecessorsOf(JobStatus.RUNNING)).toContain(
      JobStatus.RUNNING
    )
  })

  /* The user cancelling a job that has not been sent yet. */
  it('allows a cancel from every non-terminal status, including SUBMITTED', () => {
    expect(hardwarePredecessorsOf(JobStatus.CANCELLED)).toEqual([
      ...NON_TERMINAL_JOB_STATUSES,
    ])
  })

  it('never lets a job go back to QUEUED from RUNNING', () => {
    expect(hardwarePredecessorsOf(JobStatus.QUEUED)).not.toContain(
      JobStatus.RUNNING
    )
  })

  it('agrees with itself about what is terminal', () => {
    expect(Object.values(JobStatus).filter(isTerminalJobStatus)).toEqual([
      ...TERMINAL_JOB_STATUSES,
    ])
    expect(
      Object.values(JobStatus).filter((status) => !isTerminalJobStatus(status))
    ).toEqual([...NON_TERMINAL_JOB_STATUSES])
  })
})

describe('parseStoredProgram', () => {
  const program = {
    qasm: 'OPENQASM 3.0;\nbit[2] c;\n',
    register: 'c',
    clbits: 2,
    layout: [154, 155],
  }

  it('reads back what was written', () => {
    expect(parseStoredProgram(program)).toEqual(program)
  })

  it('answers null rather than half a program', () => {
    expect(parseStoredProgram(null)).toBeNull()
    expect(parseStoredProgram({ ...program, qasm: '' })).toBeNull()
    expect(parseStoredProgram({ ...program, register: 42 })).toBeNull()
    expect(parseStoredProgram({ ...program, clbits: 1.5 })).toBeNull()
    expect(parseStoredProgram({ ...program, layout: ['a'] })).toBeNull()
    expect(parseStoredProgram({ ...program, layout: 'nope' })).toBeNull()
  })
})

/**
 * The sealed document, exercised through the cipher rather than through
 * Postgres: what is being asserted is that both halves of an IBM credential
 * are inside the ciphertext, which is a property of the encoding and not of the
 * column.
 */
describe('the sealed credential document', () => {
  const cipher = createCredentialCipher(randomBytes(KEY_BYTES))
  const owner = '11111111-1111-4111-8111-111111111111'
  const apiKey = 'an-ibm-cloud-api-key-that-is-44-characters-x'
  const instance =
    'crn:v1:bluemix:public:quantum-computing:us-east:a/0000:1111::'

  it('hides the CRN as well as the key', () => {
    const plaintext = JSON.stringify({
      v: CREDENTIAL_DOCUMENT_VERSION,
      apiKey,
      instance,
    })
    const sealed = cipher.seal(plaintext, owner)
    const stored = Buffer.from(sealed.encryptedToken).toString('utf8')
    // A CRN names an account and an instance. Storing it in a plaintext column
    // beside the ciphertext would publish both to anybody who reads the table.
    expect(stored).not.toContain('crn:v1')
    expect(stored).not.toContain(apiKey)
    expect(cipher.open(sealed, owner)).toBe(plaintext)
  })
})
