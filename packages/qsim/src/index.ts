/**
 * @qsim/core — quantum circuit simulation engine.
 *
 * Constraints that define this package (specification §12.3):
 *   - zero runtime dependencies
 *   - no DOM, no React, no Node APIs
 *
 * It must produce byte-identical results in a browser Web Worker and in a
 * Node process, because the client simulates for live feedback while the
 * server simulates authoritatively to validate challenges. Any divergence
 * between the two would let a user see "solved" locally and "failed"
 * remotely, with almost nothing to debug.
 *
 * The "no Node APIs" half of that rule is enforced at the type level: this
 * package's tsconfig sets `"types": []`, so `process`, `Buffer` and friends
 * are not even in scope.
 */

export {
  bitOf,
  clearBit,
  flipBit,
  formatKet,
  setBit,
  stateSize,
} from './conventions.js'
