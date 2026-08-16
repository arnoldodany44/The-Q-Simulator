/**
 * Import — somebody else's circuit, opened here (§3.5, milestone M2.4).
 *
 * The reader lives in `@qsim/qasm` beside the writer, because a format has one
 * place where it is understood or it has two that disagree, and because that
 * package touches no browser and is therefore usable from the API too. What is
 * here is everything that needs one: the file the reader chose, the sentence
 * they see when it will not load, and the panel that offers both.
 */

export { ImportPanel } from './ImportPanel'
export type { ImportPanelProps } from './ImportPanel'

export {
  asImportFailure,
  importFailureKey,
  importFailureValues,
} from './failure'
export type { ImportFailure, ImportFailureCode } from './failure'

export { QASM_FILE_ACCEPT, readQasmFile, MAX_SOURCE_LENGTH } from './readSource'
export type { ReadResult } from './readSource'
