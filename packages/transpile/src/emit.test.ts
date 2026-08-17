import { describe, expect, it } from 'vitest'

import { deviceGraph } from './device.js'
import { emitPhysicalQasm } from './emit.js'
import { transpile } from './transpile.js'
import { HERON } from './testing/heron.js'
import { asymmetricPair, bellPair, sequence } from './testing/circuits.js'

const heron = deviceGraph(HERON)

/** Every gate call in a program, as `name` plus its operands. */
function statements(qasm: string): readonly string[] {
  return qasm
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== '' &&
        !line.startsWith('//') &&
        !line.startsWith('OPENQASM') &&
        !line.startsWith('include') &&
        !line.startsWith('qubit[') &&
        !line.startsWith('bit[')
    )
}

describe('the hardware style', () => {
  const plan = transpile(bellPair(), heron, { title: 'Bell pair' })

  it('leaves no virtual register behind', () => {
    expect(plan.qasm).not.toContain('q[')
    expect(plan.qasm).not.toMatch(/^qubit\[/m)
  })

  it('names physical qubits with the hardware-qubit syntax', () => {
    for (const physical of plan.physicalQubits) {
      expect(plan.qasm).toContain(`$${String(physical)}`)
    }
  })

  it('keeps the classical register, which is the document s own', () => {
    expect(plan.qasm).toContain('bit[2] c;')
    expect(plan.qasm).toMatch(/c\[0] = measure \$\d+;/)
    expect(plan.qasm).toMatch(/c\[1] = measure \$\d+;/)
  })

  it('uses only the five native gates plus measure', () => {
    const allowed = new Set([
      'rz',
      'sx',
      'x',
      'id',
      'cz',
      'measure',
      'barrier',
      'reset',
    ])
    for (const statement of statements(plan.qasm)) {
      const name = /^(?:c\[\d+] = )?([a-z]+)/.exec(statement)?.[1]
      expect(
        allowed.has(name ?? ''),
        `unexpected statement: ${statement}`
      ).toBe(true)
    }
  })

  it('says which device, which calibration and where each qubit went', () => {
    expect(plan.qasm).toContain('ibm_marrakesh')
    expect(plan.qasm).toContain(HERON.calibratedAt as string)
    expect(plan.qasm).toContain(
      `qubit 0 -> $${String(plan.layout[0] as number)}`
    )
    expect(plan.qasm).toContain('Bell pair')
  })

  it('writes its own prose in ASCII, so no parser has to guess', () => {
    const header = plan.qasm
      .split('\n')
      .filter((line) => line.trim().startsWith('//'))
      .join('\n')
    // The caller's title is exempt on purpose; this circuit's is ASCII.
    expect(/^[\x20-\x7e\n]*$/.test(header)).toBe(true)
  })
})

describe('the register style', () => {
  const plan = transpile(bellPair(), heron, { style: 'register' })

  it('declares a register as wide as the device and indexes it physically', () => {
    expect(plan.qasm).toContain(`qubit[${String(HERON.qubits)}] q;`)
    expect(plan.qasm).not.toContain('$')
    for (const physical of plan.physicalQubits) {
      expect(plan.qasm).toContain(`q[${String(physical)}]`)
    }
  })

  it('says the same thing as the hardware style, statement for statement', () => {
    const hardware = transpile(bellPair(), heron).qasm
    const rewritten = statements(plan.qasm).map((line) =>
      line.replace(/q\[(\d+)]/g, (_m, digits: string) => `$${digits}`)
    )
    expect(rewritten).toEqual(statements(hardware))
  })
})

describe('the rewrite itself', () => {
  it('refuses an index the layout has no qubit for', () => {
    const circuit = sequence(2, 0, [{ gate: 'x', targets: [1] }])
    expect(() => emitPhysicalQasm(circuit, [7])).toThrowError(/only 1 qubits/)
  })

  it('does not rewrite anything inside a comment', () => {
    const circuit = sequence(1, 0, [{ gate: 'x', targets: [0] }])
    const qasm = emitPhysicalQasm(circuit, [42], {
      header: ['A comment mentioning q[0] and nothing else.'],
    })
    expect(qasm).toContain('// A comment mentioning q[0] and nothing else.')
    expect(qasm).toContain('x $42;')
  })

  it('carries a classical condition through with its block intact', () => {
    const circuit = sequence(2, 1, [
      { gate: 'measure', targets: [0], clbitTargets: [0] },
      { gate: 'x', targets: [1], condition: { clbit: 0, equals: 1 } },
    ])
    const plan = transpile(circuit, heron)
    expect(plan.qasm).toContain('if (c[0] == true) {')
    expect(plan.qasm).toMatch(/if \(c\[0] == true\) \{\n {2}x \$\d+;\n}/)
  })

  it('carries a barrier through, remapped to physical qubits', () => {
    const circuit = sequence(2, 1, [
      { gate: 'h', targets: [0] },
      { gate: 'barrier', targets: [0, 1] },
      { gate: 'measure', targets: [0], clbitTargets: [0] },
    ])
    const plan = transpile(circuit, heron)
    const a = plan.layout[0] as number
    const b = plan.layout[1] as number
    expect(plan.qasm).toContain(`barrier $${String(a)}, $${String(b)};`)
  })
})

describe('the layout is not a permutation of the classical register', () => {
  it('measures into the bits the source document named', () => {
    // The source measures qubit 0 into c[1] and qubit 1 into c[0]. Whatever
    // the layout did to the qubits, those two bit indices are unchanged.
    const plan = transpile(asymmetricPair(), heron)
    const zero = plan.layout[0] as number
    const one = plan.layout[1] as number
    expect(plan.qasm).toContain(`c[1] = measure $${String(zero)};`)
    expect(plan.qasm).toContain(`c[0] = measure $${String(one)};`)
  })
})
