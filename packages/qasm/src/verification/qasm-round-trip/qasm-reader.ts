/**
 * A second, independent reader for the OpenQASM subset this project emits and
 * for hand-written fixtures — written to the published language definition and
 * sharing nothing with `import/`.
 *
 * It exists for one question: does `q[k]` mean the same qubit on both sides of
 * the file? An importer and an exporter that mirror each other agree perfectly
 * with themselves, so the only way to see the mirror is to read the same text
 * with a reader that was never told what this repo decided. That is this file,
 * and `reference.ts` is the simulator it feeds.
 *
 * It is deliberately incomplete: no `pow`, no `inv`, no register broadcast, no
 * `cu`. Every fixture that uses it is written inside that subset.
 */

import type { Ctrl, RefOp } from './reference.js'

interface Def {
  readonly name: string
  readonly params: string[]
  readonly qubits: string[]
  readonly body: string[]
}

export interface RefProgram {
  readonly qubits: number
  readonly clbits: number
  readonly ops: RefOp[]
}

/** stdgates names → kernel plus how many leading operands are controls. */
const LIBRARY: Record<
  string,
  { kernel: string; controls: number; params: number }
> = {
  id: { kernel: 'i', controls: 0, params: 0 },
  x: { kernel: 'x', controls: 0, params: 0 },
  y: { kernel: 'y', controls: 0, params: 0 },
  z: { kernel: 'z', controls: 0, params: 0 },
  h: { kernel: 'h', controls: 0, params: 0 },
  s: { kernel: 's', controls: 0, params: 0 },
  sdg: { kernel: 'sdg', controls: 0, params: 0 },
  t: { kernel: 't', controls: 0, params: 0 },
  tdg: { kernel: 'tdg', controls: 0, params: 0 },
  sx: { kernel: 'sx', controls: 0, params: 0 },
  rx: { kernel: 'rx', controls: 0, params: 1 },
  ry: { kernel: 'ry', controls: 0, params: 1 },
  rz: { kernel: 'rz', controls: 0, params: 1 },
  p: { kernel: 'p', controls: 0, params: 1 },
  phase: { kernel: 'p', controls: 0, params: 1 },
  U: { kernel: 'u', controls: 0, params: 3 },
  u1: { kernel: 'p', controls: 0, params: 1 },
  cx: { kernel: 'x', controls: 1, params: 0 },
  CX: { kernel: 'x', controls: 1, params: 0 },
  cy: { kernel: 'y', controls: 1, params: 0 },
  cz: { kernel: 'z', controls: 1, params: 0 },
  ch: { kernel: 'h', controls: 1, params: 0 },
  cp: { kernel: 'p', controls: 1, params: 1 },
  cphase: { kernel: 'p', controls: 1, params: 1 },
  crx: { kernel: 'rx', controls: 1, params: 1 },
  cry: { kernel: 'ry', controls: 1, params: 1 },
  crz: { kernel: 'rz', controls: 1, params: 1 },
  cs: { kernel: 's', controls: 1, params: 0 },
  csdg: { kernel: 'sdg', controls: 1, params: 0 },
  csx: { kernel: 'sx', controls: 1, params: 0 },
  swap: { kernel: 'swap', controls: 0, params: 0 },
  iswap: { kernel: 'iswap', controls: 0, params: 0 },
  cswap: { kernel: 'swap', controls: 1, params: 0 },
  ccx: { kernel: 'x', controls: 2, params: 0 },
  ccz: { kernel: 'z', controls: 2, params: 0 },
}

/** Strips comments and splits into statements and brace-delimited blocks. */
function scrub(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
}

/** Evaluates an angle expression: numbers, `pi`, `+ - * /`, parentheses. */
export function evalAngle(text: string, scope: Map<string, number>): number {
  const tokens = text.match(
    /[A-Za-z_][A-Za-z0-9_]*|\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+|\*\*|[()+\-*/]/g
  )
  if (tokens === null) throw new Error(`cannot read angle "${text}"`)
  let at = 0
  const peek = (): string | undefined => tokens[at]
  const eat = (value: string): boolean => {
    if (tokens[at] === value) {
      at += 1
      return true
    }
    return false
  }
  const primary = (): number => {
    if (eat('(')) {
      const inner = additive()
      if (!eat(')')) throw new Error('unbalanced parenthesis')
      return inner
    }
    if (eat('-')) return -primary()
    if (eat('+')) return primary()
    const token = tokens[at]
    if (token === undefined) throw new Error('angle ended early')
    at += 1
    if (/^[A-Za-z_]/.test(token)) {
      if (token === 'pi' || token === 'π') return Math.PI
      if (token === 'tau' || token === 'τ') return 2 * Math.PI
      if (token === 'euler') return Math.E
      const bound = scope.get(token)
      if (bound === undefined) throw new Error(`unknown name "${token}"`)
      return bound
    }
    return Number(token)
  }
  const multiplicative = (): number => {
    let left = primary()
    for (;;) {
      if (eat('*')) left *= primary()
      else if (eat('/')) left /= primary()
      else return left
    }
  }
  const additive = (): number => {
    let left = multiplicative()
    for (;;) {
      if (eat('+')) left += multiplicative()
      else if (eat('-')) left -= multiplicative()
      else return left
    }
  }
  const value = additive()
  if (peek() !== undefined) throw new Error(`trailing text in angle "${text}"`)
  return value
}

/**
 * Reads a program. `column` is the statement's own index, which gives the file
 * its plain sequential meaning — the meaning any other toolchain gives it.
 */
export function readQasm(source: string): RefProgram {
  const text = scrub(source)
  const qubitRegs: { name: string; base: number; size: number }[] = []
  const clbitRegs: { name: string; base: number; size: number }[] = []
  let qubits = 0
  let clbits = 0
  const defs = new Map<string, Def>()
  const ops: RefOp[] = []
  let column = 0

  // Split into top-level statements, keeping braced bodies together.
  const chunks = splitStatements(text)

  const resolveQ = (operand: string): number[] =>
    resolveOperand(operand, qubitRegs)
  const resolveC = (operand: string): number[] =>
    resolveOperand(operand, clbitRegs)

  const emitCall = (
    statement: string,
    wires: Map<string, number> | null,
    scope: Map<string, number>,
    condition: RefOp['condition'],
    depth: number
  ): void => {
    if (depth > 20) throw new Error('too deep')
    const parsed = parseCall(statement)
    const controls: Ctrl[] = []
    const operandLists = parsed.operands.map((operand) =>
      wires === null ? resolveQ(operand) : [lookupWire(operand, wires)]
    )
    const flat = operandLists.map((list) => {
      if (list.length !== 1) {
        throw new Error(
          `this reader does not do register broadcast: ${statement}`
        )
      }
      return list[0] as number
    })
    let taken = 0
    for (const modifier of parsed.modifiers) {
      controls.push({
        qubit: flat[taken] as number,
        state: modifier === 'ctrl' ? 1 : 0,
      })
      taken += 1
    }
    const rest = flat.slice(taken)
    const args = parsed.args.map((arg) => evalAngle(arg, scope))

    const definition = defs.get(parsed.name)
    if (definition !== undefined) {
      const inner = new Map<string, number>()
      definition.params.forEach((name, index) => {
        inner.set(name, args[index] as number)
      })
      const innerWires = new Map<string, number>()
      definition.qubits.forEach((name, index) => {
        innerWires.set(name, rest[index] as number)
      })
      for (const inner_ of definition.body) {
        emitCallOrBarrier(
          inner_,
          innerWires,
          inner,
          condition,
          depth + 1,
          controls
        )
      }
      return
    }

    const entry = LIBRARY[parsed.name]
    if (entry === undefined) throw new Error(`unknown gate "${parsed.name}"`)
    const own: Ctrl[] = rest
      .slice(0, entry.controls)
      .map((qubit) => ({ qubit, state: 1 as const }))
    ops.push({
      kind: 'gate',
      gate: entry.kernel,
      targets: rest.slice(entry.controls),
      controls: [...controls, ...own],
      params: args,
      column: column++,
      ...(condition === undefined ? {} : { condition }),
    })
  }

  const emitCallOrBarrier = (
    statement: string,
    wires: Map<string, number> | null,
    scope: Map<string, number>,
    condition: RefOp['condition'],
    depth: number,
    outerControls: readonly Ctrl[] = []
  ): void => {
    const trimmed = statement.trim()
    if (trimmed === '') return
    if (trimmed.startsWith('barrier')) {
      ops.push({
        kind: 'barrier',
        targets: [],
        controls: [],
        params: [],
        column: column++,
      })
      return
    }
    if (outerControls.length > 0) {
      // Controls on a user gate distribute over its body.
      const before = ops.length
      emitCall(trimmed, wires, scope, condition, depth)
      for (let index = before; index < ops.length; index++) {
        const op = ops[index] as RefOp
        ops[index] = { ...op, controls: [...outerControls, ...op.controls] }
      }
      return
    }
    emitCall(trimmed, wires, scope, condition, depth)
  }

  const runStatement = (chunk: string, condition: RefOp['condition']): void => {
    const statement = chunk.trim()
    if (statement === '') return
    if (/^OPENQASM\b/.test(statement)) return
    if (/^include\b/.test(statement)) return

    let match =
      /^(qubit|bit)\s*(?:\[\s*(\d+)\s*\])?\s*([A-Za-z_][A-Za-z0-9_]*)$/.exec(
        statement
      )
    if (match !== null) {
      const size = match[2] === undefined ? 1 : Number(match[2])
      if (match[1] === 'qubit') {
        qubitRegs.push({ name: match[3] as string, base: qubits, size })
        qubits += size
      } else {
        clbitRegs.push({ name: match[3] as string, base: clbits, size })
        clbits += size
      }
      return
    }
    match = /^(qreg|creg)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*(\d+)\s*\]$/.exec(
      statement
    )
    if (match !== null) {
      const size = Number(match[3])
      if (match[1] === 'qreg') {
        qubitRegs.push({ name: match[2] as string, base: qubits, size })
        qubits += size
      } else {
        clbitRegs.push({ name: match[2] as string, base: clbits, size })
        clbits += size
      }
      return
    }

    match =
      /^gate\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:\(([^)]*)\))?\s*([^{]*)\{([\s\S]*)\}$/.exec(
        statement
      )
    if (match !== null) {
      defs.set(match[1] as string, {
        name: match[1] as string,
        params: (match[2] ?? '')
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== ''),
        qubits: (match[3] ?? '')
          .split(',')
          .map((part) => part.trim())
          .filter((part) => part !== ''),
        body: splitStatements(match[4] as string),
      })
      return
    }

    if (/^if\b/.test(statement)) {
      const head = /^if\s*\(([^)]*)\)\s*([\s\S]*)$/.exec(statement)
      if (head === null) throw new Error(`unreadable if: ${statement}`)
      const test =
        /^([A-Za-z_][A-Za-z0-9_]*)(?:\[\s*(\d+)\s*\])?\s*==\s*(\S+)$/.exec(
          (head[1] as string).trim()
        )
      if (test === null)
        throw new Error(`unreadable condition: ${head[1] ?? ''}`)
      const register = clbitRegs.find((entry) => entry.name === test[1])
      if (register === undefined) throw new Error('unknown classical register')
      const bit = test[2] === undefined ? 0 : Number(test[2])
      const raw = test[3] as string
      const equals = raw === 'true' ? 1 : raw === 'false' ? 0 : Number(raw)
      if (equals !== 0 && equals !== 1) throw new Error('multi-bit condition')

      // `{ … } else { … }` or a single statement, with an optional else.
      const rest = (head[2] as string).trim()
      const [thenText, elseText] = splitElse(rest)
      /*
       * A sequential reader evaluates the test ONCE, here, and runs exactly one
       * branch. Reproduced by executing the branches in the order the file
       * gives them while remembering that only one of them may fire — which is
       * why the else body is emitted under the *complementary* condition on a
       * snapshot bit rather than on the live one. Modelled by giving the else
       * body the same condition value the if body tested, read at the same
       * moment: the reference executor evaluates a condition against the
       * register as it entered the statement's column, and each statement here
       * gets its own column, so a rewrite inside the then-branch would be
       * visible. To keep the file's own meaning, the else branch is therefore
       * pinned to the column the `if` itself occupied.
       */
      const testColumn = column
      for (const one of splitStatements(thenText)) {
        runStatement(one, { clbit: register.base + bit, equals })
      }
      if (elseText !== null) {
        const after = column
        column = testColumn
        for (const one of splitStatements(elseText)) {
          runStatement(one, {
            clbit: register.base + bit,
            equals: equals === 1 ? 0 : 1,
          })
        }
        column = Math.max(after, column)
      }
      return
    }

    if (/^barrier\b/.test(statement)) {
      ops.push({
        kind: 'barrier',
        targets: [],
        controls: [],
        params: [],
        column: column++,
      })
      return
    }
    if (/^reset\b/.test(statement)) {
      for (const qubit of resolveQ(statement.replace(/^reset\s*/, ''))) {
        ops.push({
          kind: 'reset',
          targets: [qubit],
          controls: [],
          params: [],
          column: column++,
          ...(condition === undefined ? {} : { condition }),
        })
      }
      return
    }
    match =
      /^([A-Za-z_][A-Za-z0-9_]*\s*(?:\[\s*\d+\s*\])?)\s*=\s*measure\s+(.+)$/.exec(
        statement
      )
    if (match !== null) {
      pushMeasure(match[2] as string, match[1] as string)
      return
    }
    match = /^measure\s+(.+?)\s*->\s*(.+)$/.exec(statement)
    if (match !== null) {
      pushMeasure(match[1] as string, match[2] as string)
      return
    }

    emitCallOrBarrier(statement, null, new Map(), condition, 0)

    function pushMeasure(source: string, target: string): void {
      const qs = resolveQ(source)
      const cs = resolveC(target)
      if (qs.length !== cs.length) throw new Error('measurement width mismatch')
      for (let index = 0; index < qs.length; index++) {
        ops.push({
          kind: 'measure',
          targets: [qs[index] as number],
          controls: [],
          params: [],
          clbit: cs[index],
          column: column++,
          ...(condition === undefined ? {} : { condition }),
        })
      }
    }
  }

  for (const chunk of chunks) runStatement(chunk, undefined)
  return { qubits, clbits, ops }
}

function lookupWire(operand: string, wires: Map<string, number>): number {
  const found = wires.get(operand.trim())
  if (found === undefined) throw new Error(`unknown wire "${operand}"`)
  return found
}

function resolveOperand(
  operand: string,
  registers: readonly { name: string; base: number; size: number }[]
): number[] {
  const text = operand.trim()
  const match = /^([A-Za-z_][A-Za-z0-9_]*)(?:\[\s*(\d+)\s*\])?$/.exec(text)
  if (match === null) throw new Error(`unreadable operand "${operand}"`)
  const register = registers.find((entry) => entry.name === match[1])
  if (register === undefined)
    throw new Error(`unknown register "${match[1] ?? ''}"`)
  if (match[2] === undefined) {
    return Array.from({ length: register.size }, (_, i) => register.base + i)
  }
  return [register.base + Number(match[2])]
}

interface ParsedCall {
  readonly modifiers: ('ctrl' | 'negctrl')[]
  readonly name: string
  readonly args: string[]
  readonly operands: string[]
}

function parseCall(statement: string): ParsedCall {
  let rest = statement.trim()
  const modifiers: ('ctrl' | 'negctrl')[] = []
  for (;;) {
    const match = /^(ctrl|negctrl)\s*@\s*/.exec(rest)
    if (match === null) break
    modifiers.push(match[1] as 'ctrl' | 'negctrl')
    rest = rest.slice(match[0].length)
  }
  const head = /^([A-Za-z_][A-Za-z0-9_]*)\s*/.exec(rest)
  if (head === null) throw new Error(`unreadable statement "${statement}"`)
  const name = head[1] as string
  rest = rest.slice(head[0].length)
  const args: string[] = []
  if (rest.startsWith('(')) {
    let depth = 0
    let index = 0
    for (; index < rest.length; index++) {
      if (rest[index] === '(') depth += 1
      else if (rest[index] === ')') {
        depth -= 1
        if (depth === 0) break
      }
    }
    args.push(
      ...splitTop(rest.slice(1, index)).filter((part) => part.trim() !== '')
    )
    rest = rest.slice(index + 1)
  }
  const operands = splitTop(rest).filter((part) => part.trim() !== '')
  return { modifiers, name, args, operands }
}

/** Splits on commas that are not inside parentheses or brackets. */
function splitTop(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const character of text) {
    if (character === '(' || character === '[') depth += 1
    if (character === ')' || character === ']') depth -= 1
    if (character === ',' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += character
  }
  out.push(current)
  return out.map((part) => part.trim())
}

/** Splits text into statements, keeping `{ … }` bodies attached to their head. */
function splitStatements(text: string): string[] {
  const out: string[] = []
  let current = ''
  let depth = 0
  for (let index = 0; index < text.length; index++) {
    const character = text[index] as string
    if (character === '{') depth += 1
    if (character === '}') {
      depth -= 1
      current += character
      // `} else {` keeps the whole conditional in one statement.
      if (depth === 0 && !/^\s*else\b/.test(text.slice(index + 1))) {
        out.push(current.trim())
        current = ''
      }
      continue
    }
    if (character === ';' && depth === 0) {
      out.push(current.trim())
      current = ''
      continue
    }
    current += character
  }
  if (current.trim() !== '') out.push(current.trim())
  return out.filter((part) => part !== '')
}

/** Separates the `then` body of a conditional from its `else` body. */
function splitElse(rest: string): [string, string | null] {
  if (!rest.startsWith('{')) {
    const at = /\belse\b/.exec(rest)
    if (at === null) return [rest, null]
    return [rest.slice(0, at.index), rest.slice(at.index + 4)]
  }
  let depth = 0
  for (let index = 0; index < rest.length; index++) {
    if (rest[index] === '{') depth += 1
    else if (rest[index] === '}') {
      depth -= 1
      if (depth === 0) {
        const head = rest.slice(1, index)
        const tail = rest.slice(index + 1).trim()
        if (!tail.startsWith('else')) return [head, null]
        const body = tail.slice(4).trim()
        return [head, body.startsWith('{') ? body.slice(1, -1) : body]
      }
    }
  }
  return [rest, null]
}
