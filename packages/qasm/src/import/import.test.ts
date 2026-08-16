/**
 * What an imported file means — the semantics, dialect by dialect.
 *
 * The round trip in `roundtrip.test.ts` checks that this package agrees with
 * itself. This file checks it against files it did not write: OpenQASM 2 as
 * Qiskit emits it, OpenQASM 3 as the specification defines it, and the
 * hand-written shapes in between. A parser tested only against its own writer
 * proves nothing about anyone else's files, which is why the two halves were
 * written apart.
 */

import { describe, expect, it } from 'vitest'

import { detectQasmVersion, importOpenQasm, QasmImportError } from './index.js'

/** The circuit, for the common case where nothing else is being asserted. */
function circuitOf(source: string) {
  return importOpenQasm(source).circuit
}

function gatesOf(source: string): string[] {
  return circuitOf(source).operations.map((operation) => operation.gate)
}

function capture(source: string): QasmImportError {
  try {
    importOpenQasm(source)
  } catch (cause) {
    if (cause instanceof QasmImportError) return cause
    throw cause
  }
  throw new Error('expected a QasmImportError')
}

/* ─────────────────────────── which dialect ───────────────────────────── */

describe('the version is detected, never asked for', () => {
  it.each([
    ['OPENQASM 2.0;\nqreg q[1];\nx q[0];', 2],
    ['OPENQASM 3.0;\nqubit[1] q;\nx q[0];', 3],
    ['OPENQASM 3;\nqubit[1] q;\nx q[0];', 3],
  ])('believes a declared header (%#)', (source, version) => {
    expect(detectQasmVersion(source)).toBe(version)
    expect(importOpenQasm(source).versionDeclared).toBe(true)
  })

  it.each([
    ['qreg q[1];\nx q[0];', 2],
    ['creg c[1];\nqreg q[1];\nx q[0];', 2],
    ['qubit[1] q;\nx q[0];', 3],
    ['bit c;\nqubit q;\nx q;', 3],
  ])(
    'infers from the syntax when there is no header (%#)',
    (source, version) => {
      expect(detectQasmVersion(source)).toBe(version)
      expect(importOpenQasm(source).versionDeclared).toBe(false)
    }
  )

  it('falls back to 3, the current language', () => {
    // A fragment pasted out of a notebook, with neither header nor register
    // declaration in the paste. Nothing distinguishes the dialects here, and
    // the newer one is the better default.
    expect(detectQasmVersion('gate g a { x a; }')).toBe(3)
  })

  it('refuses a version it does not have', () => {
    const error = capture('OPENQASM 4.0;\nqubit[1] q;')
    expect(error.code).toBe('unsupported')
    expect(error.construct).toBe('OPENQASM 4.0')
  })
})

/**
 * The one place the dialects mean different things, and it is invisible without
 * a control.
 *
 * OpenQASM 2's `U(θ,φ,λ)` is Rz(φ)·Ry(θ)·Rz(λ), which carries a global phase
 * e^(−i(φ+λ)/2); OpenQASM 3's is the bare matrix. Uncontrolled the difference is
 * unobservable and both import as one `u`. Under `ctrl @` — which only version 3
 * has — the phase becomes a `p` on the control, and that is the whole reason
 * `gphase` survives lowering as a primitive.
 */
describe('the built-in U differs between the dialects', () => {
  it('imports version 3’s U as the catalog u, with nothing attached', () => {
    const circuit = circuitOf(
      'OPENQASM 3;\nqubit[1] q;\nU(0.3, 0.4, 0.5) q[0];'
    )
    expect(circuit.operations).toHaveLength(1)
    expect(circuit.operations[0]?.gate).toBe('u')
    expect(circuit.operations[0]?.params).toEqual([0.3, 0.4, 0.5])
  })

  it('imports version 2’s U as the same gate, its phase dropped', () => {
    // Dropped because it is global and nothing in version 2 can control it:
    // the dialect has no modifiers at all.
    const circuit = circuitOf(
      'OPENQASM 2.0;\nqreg q[1];\nU(0.3, 0.4, 0.5) q[0];'
    )
    expect(circuit.operations).toHaveLength(1)
    expect(circuit.operations[0]?.gate).toBe('u')
  })

  it('turns u3’s global phase into a phase on the control when controlled', () => {
    const circuit = circuitOf(
      'OPENQASM 3;\ninclude "stdgates.inc";\nqubit[2] q;\n' +
        'ctrl @ u3(0.3, 0.4, 0.5) q[0], q[1];'
    )
    // `p(−(φ+λ)/2)` on the control, then the controlled `u`. Without the first
    // of those the imported circuit is a different unitary, and no measurement
    // of the uncontrolled gate could ever have shown it.
    expect(circuit.operations.map((operation) => operation.gate)).toEqual([
      'p',
      'u',
    ])
    expect(circuit.operations[0]?.targets).toEqual([0])
    expect(circuit.operations[0]?.params).toEqual([-(0.4 + 0.5) / 2])
    expect(circuit.operations[1]?.controls).toEqual([{ qubit: 0, state: 1 }])
  })
})

/* ───────────────────────────── registers ─────────────────────────────── */

describe('registers', () => {
  it('reads both spellings of a declaration', () => {
    expect(circuitOf('qreg q[3];\ncreg c[2];\nx q[0];').qubits).toBe(3)
    expect(circuitOf('qubit[3] q;\nbit[2] c;\nx q[0];').clbits).toBe(2)
    expect(circuitOf('qubit q;\nbit c;\nx q;').qubits).toBe(1)
  })

  it('concatenates several registers in declaration order', () => {
    const circuit = circuitOf(
      'qreg alice[2];\nqreg bob[3];\nx bob[0];\ny alice[1];'
    )
    expect(circuit.qubits).toBe(5)
    // `bob[0]` is qubit 2 — the flattening, made visible.
    expect(circuit.operations[0]?.targets).toEqual([2])
    expect(circuit.operations[1]?.targets).toEqual([1])
    expect(circuit.qubitLabels).toEqual([
      'alice[0]',
      'alice[1]',
      'bob[0]',
      'bob[1]',
      'bob[2]',
    ])
  })

  it('leaves the labels off when there is only one register', () => {
    // `q[2]` is qubit 2 and the canvas already says so; a column of labels
    // repeating the index is noise.
    expect(circuitOf('qreg q[2];\nx q[0];').qubitLabels).toBeUndefined()
  })

  it('refuses a register declared twice', () => {
    expect(capture('qreg q[2];\nqreg q[2];\nx q[0];').code).toBe('semantic')
  })

  it('refuses an index past the end of its register', () => {
    const error = capture('qreg q[2];\nx q[5];')
    expect(error.code).toBe('semantic')
    expect(error.position.line).toBe(2)
  })

  it('refuses a file with no qubits at all', () => {
    expect(capture('creg c[2];').code).toBe('semantic')
  })
})

describe('register broadcast', () => {
  it('applies a one-qubit gate to every wire of a register', () => {
    expect(gatesOf('qreg q[3];\nh q;')).toEqual(['h', 'h', 'h'])
  })

  it('pairs two registers index by index', () => {
    const circuit = circuitOf('qreg a[2];\nqreg b[2];\ncx a, b;')
    expect(circuit.operations).toHaveLength(2)
    expect(circuit.operations[0]?.targets).toEqual([2])
    expect(circuit.operations[1]?.targets).toEqual([3])
  })

  it('repeats a single bit against a register', () => {
    const circuit = circuitOf('qreg a[1];\nqreg b[3];\ncx a[0], b;')
    expect(circuit.operations).toHaveLength(3)
    expect(
      circuit.operations.every(
        (operation) =>
          operation.controls?.[0] === 0 ||
          (operation.controls?.[0] as { qubit: number }).qubit === 0
      )
    ).toBe(true)
  })

  it('refuses a broadcast between registers of different sizes', () => {
    expect(capture('qreg a[2];\nqreg b[3];\ncx a, b;').code).toBe('semantic')
  })
})

/* ──────────────────────────── measurement ────────────────────────────── */

describe('measurement', () => {
  it('reads the arrow form, which is all OpenQASM 2 has', () => {
    const circuit = circuitOf(
      'OPENQASM 2.0;\nqreg q[1];\ncreg c[1];\nmeasure q[0] -> c[0];'
    )
    expect(circuit.operations[0]).toMatchObject({
      gate: 'measure',
      targets: [0],
      clbitTargets: [0],
    })
  })

  it('reads the assignment form of OpenQASM 3', () => {
    const circuit = circuitOf('qubit[1] q;\nbit[1] c;\nc[0] = measure q[0];')
    expect(circuit.operations[0]).toMatchObject({
      gate: 'measure',
      clbitTargets: [0],
    })
  })

  it('reads the arrow form in OpenQASM 3 too', () => {
    // Still in the grammar, and files in the wild use it.
    expect(gatesOf('qubit[1] q;\nbit[1] c;\nmeasure q[0] -> c[0];')).toEqual([
      'measure',
    ])
  })

  it('refuses the OpenQASM 3 assignment inside an OpenQASM 2 file', () => {
    const error = capture(
      'OPENQASM 2.0;\nqreg q[1];\ncreg c[1];\nc[0] = measure q[0];'
    )
    expect(error.code).toBe('unsupported')
  })

  it('broadcasts a whole-register measurement', () => {
    const circuit = circuitOf('qreg q[2];\ncreg c[2];\nmeasure q -> c;')
    expect(circuit.operations).toHaveLength(2)
    expect(circuit.operations[1]?.clbitTargets).toEqual([1])
  })

  it('refuses a measurement with nowhere to write', () => {
    const error = capture('qubit[1] q;\nmeasure q[0];')
    expect(error.code).toBe('unsupported')
    expect(error.construct).toBe('measure without a target')
  })

  it('refuses a mismatched measurement', () => {
    expect(capture('qreg q[2];\ncreg c[1];\nmeasure q -> c;').code).toBe(
      'semantic'
    )
  })
})

/* ─────────────────────────── conditionals ────────────────────────────── */

describe('conditionals', () => {
  it('reads OpenQASM 2’s comparison of a one-bit register', () => {
    const circuit = circuitOf(
      'OPENQASM 2.0;\nqreg q[2];\ncreg c[1];\n' +
        'measure q[0] -> c[0];\nif(c==1) x q[1];'
    )
    expect(circuit.operations[1]?.condition).toEqual({ clbit: 0, equals: 1 })
  })

  it('reads OpenQASM 3’s bit comparison, in all its spellings', () => {
    const prelude = 'qubit[2] q;\nbit[2] c;\nc[0] = measure q[0];\n'
    for (const [text, equals] of [
      ['if (c[0] == true) { x q[1]; }', 1],
      ['if (c[0] == false) { x q[1]; }', 0],
      ['if (c[0] == 1) x q[1];', 1],
      ['if (c[0]) { x q[1]; }', 1],
    ] as const) {
      const circuit = circuitOf(prelude + text)
      expect(circuit.operations[1]?.condition).toEqual({ clbit: 0, equals })
    }
  })

  it('reads `else` as the opposite value of the same bit', () => {
    const circuit = circuitOf(
      'qubit[3] q;\nbit[1] c;\nc[0] = measure q[0];\n' +
        'if (c[0] == true) { x q[1]; } else { y q[2]; }'
    )
    expect(circuit.operations[1]?.condition).toEqual({ clbit: 0, equals: 1 })
    expect(circuit.operations[2]?.condition).toEqual({ clbit: 0, equals: 0 })
  })

  it('refuses a comparison against a whole multi-bit register, by name', () => {
    const error = capture(
      'OPENQASM 2.0;\nqreg q[2];\ncreg c[2];\nif(c==3) x q[0];'
    )
    expect(error.code).toBe('unsupported')
    // The message has to say what the reader can do about it, because the
    // construct is perfectly ordinary OpenQASM 2 and their file is not wrong.
    expect(error.message).toContain('tests one classical bit')
  })

  it('refuses a conditional inside a conditional', () => {
    const error = capture(
      'qubit[2] q;\nbit[2] c;\nc[0] = measure q[0];\n' +
        'if (c[0]) { if (c[1]) { x q[1]; } }'
    )
    expect(error.code).toBe('unsupported')
    expect(error.construct).toBe('nested if')
  })

  it('refuses a condition richer than an equality', () => {
    const error = capture(
      'qubit[2] q;\nbit[2] c;\nif (c[0] && c[1]) { x q[0]; }'
    )
    expect(error.code).toBe('unsupported')
  })
})

/* ───────────────────────── the standard library ──────────────────────── */

describe('the standard gate libraries', () => {
  it.each([
    ['x q[0];', ['x']],
    ['id q[0];', ['i']],
    ['sdg q[0];', ['sdg']],
    ['sx q[0];', ['sx']],
    ['p(0.5) q[0];', ['p']],
    ['u1(0.5) q[0];', ['p']],
    ['phase(0.5) q[0];', ['p']],
    ['cx q[0], q[1];', ['cx']],
    ['CX q[0], q[1];', ['cx']],
    ['cz q[0], q[1];', ['cz']],
    ['cp(0.5) q[0], q[1];', ['cp']],
    ['cphase(0.5) q[0], q[1];', ['cp']],
    ['crz(0.5) q[0], q[1];', ['crz']],
    ['swap q[0], q[1];', ['swap']],
    ['ccx q[0], q[1], q[2];', ['ccx']],
    ['cswap q[0], q[1], q[2];', ['cswap']],
    ['u2(0.3, 0.4) q[0];', ['u']],
    ['u3(0.3, 0.4, 0.5) q[0];', ['u']],
    ['cu(0.1, 0.2, 0.3, 0.4) q[0], q[1];', ['p', 'u']],
    ['gphase(0.5);', []],
  ])('reads %s', (statement, gates) => {
    expect(gatesOf(`qubit[3] q;\n${statement}`)).toEqual(gates)
  })

  it('reads the controlled gates the catalog has no name for', () => {
    // `cy` and `ch` are in `stdgates.inc` and not in this catalog, and they do
    // not need to be: a one-qubit gate takes arbitrary controls (§3.1), so they
    // are `y` and `h` carrying one — which is also how the editor draws them.
    const circuit = circuitOf('qubit[2] q;\ncy q[0], q[1];\nch q[0], q[1];')
    expect(circuit.operations.map((operation) => operation.gate)).toEqual([
      'y',
      'h',
    ])
    expect(circuit.operations[0]?.controls).toEqual([{ qubit: 0, state: 1 }])
  })

  it('names a standard gate the catalog cannot hold, instead of calling it unknown', () => {
    const error = capture('qubit[2] q;\nrzz(0.5) q[0], q[1];')
    expect(error.code).toBe('unsupported')
    expect(error.construct).toBe('rzz')
    expect(error.message).toContain('ZZ rotation')
  })

  it('reads the Qiskit names the catalog does hold, as controls', () => {
    /*
     * None of these is in `stdgates.inc`, and every one of them is exactly a
     * catalog gate carrying controls — which is what a one-qubit gate accepts
     * arbitrarily many of (§3.1). Refusing them as "this catalog has no entry"
     * would be a false sentence, and refusing them as unknown would send a
     * reader looking for a typo they did not make.
     */
    const circuit = circuitOf(
      'qubit[5] q;\ncs q[0], q[1];\nccz q[0], q[1], q[2];\n' +
        'c3x q[0], q[1], q[2], q[3];\ncsx q[0], q[4];'
    )
    expect(circuit.operations.map((operation) => operation.gate)).toEqual([
      's',
      // The catalog's `cz` carries exactly one control; two of them is a plain
      // `z` with both in `controls`, which is also how the editor draws it.
      'z',
      'x',
      'sx',
    ])
    expect(circuit.operations[1]?.controls).toHaveLength(2)
    expect(circuit.operations[2]?.controls).toHaveLength(3)
  })

  it('reports an unknown gate as unknown', () => {
    const error = capture('qubit[1] q;\nfrobnicate q[0];')
    expect(error.code).toBe('semantic')
    expect(error.message).toContain('frobnicate')
  })

  it('reads a library gate even when the include is missing', () => {
    // Not legal OpenQASM, read by every toolchain. Refusing it would be a bug
    // report against this importer rather than strictness.
    expect(gatesOf('qubit[2] q;\nh q[0];\ncx q[0], q[1];')).toEqual(['h', 'cx'])
  })

  it('lets the file’s own definition win over the library', () => {
    // Which is how Qiskit's OpenQASM 2 output declares half of what it uses.
    const circuit = circuitOf(
      'OPENQASM 2.0;\ninclude "qelib1.inc";\ngate h a { x a; }\n' +
        'qreg q[1];\nh q[0];'
    )
    // The definition became a block called `h_` — `h` names the catalog
    // Hadamard, and a `customGates` entry under that name would be unreachable.
    expect(Object.keys(circuit.customGates ?? {})).toEqual(['h_'])
    expect(circuit.operations[0]?.gate).toBe('h_')
  })
})

/* ──────────────────────────── modifiers ──────────────────────────────── */

describe('OpenQASM 3 modifiers', () => {
  it('reads ctrl and negctrl in modifier order', () => {
    const circuit = circuitOf(
      'qubit[3] q;\nctrl @ negctrl @ x q[0], q[1], q[2];'
    )
    expect(circuit.operations[0]).toMatchObject({
      gate: 'x',
      targets: [2],
      controls: [
        { qubit: 0, state: 1 },
        { qubit: 1, state: 0 },
      ],
    })
  })

  it('reads a counted control', () => {
    const circuit = circuitOf('qubit[3] q;\nctrl(2) @ x q[0], q[1], q[2];')
    expect(circuit.operations[0]?.gate).toBe('ccx')
  })

  it('inverts what the catalog can invert', () => {
    expect(
      gatesOf('qubit[1] q;\ninv @ s q[0];\ninv @ t q[0];\ninv @ h q[0];')
    ).toEqual(['sdg', 'tdg', 'h'])
  })

  it('inverts a rotation by negating its angle', () => {
    const circuit = circuitOf('qubit[1] q;\ninv @ rx(0.5) q[0];')
    expect(circuit.operations[0]?.params).toEqual([-0.5])
  })

  it('inverts u by U(θ,φ,λ)† = U(−θ,−λ,−φ)', () => {
    const circuit = circuitOf('qubit[1] q;\ninv @ U(0.1, 0.2, 0.3) q[0];')
    expect(circuit.operations[0]?.params).toEqual([-0.1, -0.3, -0.2])
  })

  it('reverses a sequence when it inverts one', () => {
    const circuit = circuitOf(
      'qubit[2] q;\ngate g a, b { h a; cx a, b; }\ninv @ g q[0], q[1];'
    )
    expect(circuit.operations.map((operation) => operation.gate)).toEqual([
      'cx',
      'h',
    ])
  })

  it('refuses to invert a gate whose inverse the catalog lacks', () => {
    const error = capture('qubit[1] q;\ninv @ sx q[0];')
    expect(error.code).toBe('unsupported')
    expect(error.construct).toBe('inv @ sx')
  })

  it('repeats for a whole power and inverts for a negative one', () => {
    expect(gatesOf('qubit[1] q;\npow(3) @ x q[0];')).toEqual(['x', 'x', 'x'])
    expect(gatesOf('qubit[1] q;\npow(-2) @ s q[0];')).toEqual(['sdg', 'sdg'])
    expect(gatesOf('qubit[1] q;\npow(0) @ x q[0];')).toEqual([])
  })

  it('refuses a fractional power by name', () => {
    const error = capture('qubit[1] q;\npow(0.5) @ h q[0];')
    expect(error.code).toBe('unsupported')
    expect(error.construct).toBe('pow(0.5)')
  })

  it('refuses a controlled two-qubit gate the catalog has no shape for', () => {
    const error = capture(
      'qubit[4] q;\nctrl @ ctrl @ swap q[0], q[1], q[2], q[3];'
    )
    expect(error.code).toBe('unsupported')
    expect(error.construct).toBe('controlled swap')
  })

  it('refuses modifiers in an OpenQASM 2 file', () => {
    const error = capture('OPENQASM 2.0;\nqreg q[2];\nctrl @ x q[0], q[1];')
    expect(error.code).toBe('unsupported')
    expect(error.construct).toBe('ctrl @')
  })

  it('does not mistake a user gate called `inv` for a modifier', () => {
    // A modifier is only a modifier when an `@` follows it.
    expect(gatesOf('qubit[1] q;\ngate inv a { x a; }\ninv q[0];')).toEqual([
      'inv',
    ])
  })
})

/* ────────────────────────── gate definitions ─────────────────────────── */

describe('gate definitions', () => {
  it('becomes a block when it fits the contract', () => {
    const circuit = circuitOf(
      'qubit[2] q;\ngate bell a, b { h a; cx a, b; }\nbell q[0], q[1];'
    )
    expect(circuit.customGates?.bell?.qubits).toBe(2)
    expect(circuit.operations).toEqual([
      { id: 'op_1', gate: 'bell', targets: [0, 1], column: 0 },
    ])
  })

  it('keeps a definition’s own parameters as parameters', () => {
    const circuit = circuitOf(
      'qubit[2] q;\ngate rzz(theta) a, b { cx a, b; rz(theta) b; cx a, b; }\n' +
        'rzz(pi/4) q[0], q[1];'
    )
    expect(circuit.customGates?.rzz?.params).toEqual(['theta'])
    expect(circuit.customGates?.rzz?.operations[1]?.params).toEqual(['theta'])
    expect(circuit.operations[0]?.params).toEqual([Math.PI / 4])
  })

  it('inlines a definition whose body computes with its own parameter', () => {
    // `theta/2` has no shape in the contract, whose parameter is a name or a
    // literal. Nothing is approximated: at the call site the angle has a value.
    const circuit = circuitOf(
      'qubit[1] q;\ngate half(theta) a { rz(theta/2) a; }\nhalf(pi) q[0];'
    )
    expect(circuit.customGates).toBeUndefined()
    expect(circuit.operations[0]).toMatchObject({
      gate: 'rz',
      params: [Math.PI / 2],
    })
  })

  it('inlines a definition used under a modifier', () => {
    // The contract has no controlled custom gate (§3.1 decision 1), so a
    // controlled use becomes the controlled operations themselves.
    const circuit = circuitOf(
      'qubit[3] q;\ngate g a, b { x b; }\nctrl @ g q[0], q[1], q[2];'
    )
    // The modifier binds q[0]; `g` then receives q[1] and q[2] and puts an X on
    // the second of them. The control lands on that X, which is a `cx`.
    expect(circuit.operations[0]).toMatchObject({
      gate: 'cx',
      targets: [2],
      controls: [{ qubit: 0, state: 1 }],
    })
  })

  it('uses a block where it can and inlines where it cannot, in one file', () => {
    const circuit = circuitOf(
      'qubit[3] q;\ngate g a, b { cx a, b; }\n' +
        'g q[0], q[1];\nctrl @ g q[0], q[1], q[2];'
    )
    expect(circuit.operations[0]?.gate).toBe('g')
    expect(circuit.operations[1]?.gate).toBe('ccx')
  })

  it('reads a definition that calls another definition', () => {
    const circuit = circuitOf(
      'qubit[2] q;\ngate inner a { h a; }\ngate outer a, b { inner a; cx a, b; }\n' +
        'outer q[0], q[1];'
    )
    expect(circuit.customGates?.outer?.operations[0]?.gate).toBe('inner')
    expect(circuit.operations[0]?.gate).toBe('outer')
  })

  it('refuses a definition that measures', () => {
    const error = capture(
      'qubit[1] q;\nbit[1] c;\ngate g a { x a; }\n' +
        'gate bad a { measure a -> c; }\nbad q[0];'
    )
    expect(error.code).toBe('unsupported')
  })

  it('refuses a definition declared twice', () => {
    expect(
      capture('qubit[1] q;\ngate g a { x a; }\ngate g a { y a; }\ng q[0];').code
    ).toBe('semantic')
  })

  it('refuses a call with the wrong number of qubits', () => {
    const error = capture('qubit[2] q;\ngate g a { x a; }\ng q[0], q[1];')
    expect(error.code).toBe('semantic')
    expect(error.message).toContain('1 qubit(s)')
  })
})

/* ──────────────────────── structure and layout ───────────────────────── */

describe('structure', () => {
  it('packs operations into the earliest column they fit', () => {
    // A text file carries no columns; the reconstruction is the one the editor
    // itself produces, so an imported circuit looks like a drawn one.
    const circuit = circuitOf('qreg q[3];\nh q[0];\nh q[1];\ncx q[0], q[2];')
    expect(circuit.operations.map((operation) => operation.column)).toEqual([
      0, 0, 1,
    ])
  })

  it('lets a barrier hold its column across the wires it names', () => {
    const circuit = circuitOf('qreg q[2];\nh q[0];\nbarrier q;\nh q[1];')
    expect(circuit.operations.map((operation) => operation.column)).toEqual([
      0, 1, 2,
    ])
  })

  it('reads a bare barrier as the whole machine', () => {
    const circuit = circuitOf('qreg q[3];\nbarrier;')
    expect(circuit.operations[0]?.targets).toEqual([0, 1, 2])
  })

  it('reads reset', () => {
    expect(gatesOf('qreg q[2];\nreset q;')).toEqual(['reset', 'reset'])
  })

  it('ignores an include it knows and refuses one it does not', () => {
    expect(gatesOf('include "stdgates.inc";\nqubit[1] q;\nx q[0];')).toEqual([
      'x',
    ])
    // Nothing is fetched — this package has no file system by construction —
    // so an unknown include is a file whose gates cannot be resolved. It is not
    // refused outright: the gates in it either resolve or are named as unknown.
    expect(gatesOf('include "mine.inc";\nqubit[1] q;\nx q[0];')).toEqual(['x'])
  })
})
