/**
 * §3.7's comparison view — ideal, modelled, real.
 *
 * The barrel exists for the route and for tests. Nothing outside this feature
 * imports the leaf modules, with one deliberate exception: `paths.ts` is
 * reached directly by `App.tsx`, because the entry chunk must not acquire the
 * histogram, the schema expander and React Query for the sake of one string
 * (M0.9b).
 */

export { DeviceProvenance } from './DeviceProvenance.js'
export type { DeviceProvenanceProps } from './DeviceProvenance.js'

export { ExecutedProgram } from './ExecutedProgram.js'
export type { ExecutedProgramProps } from './ExecutedProgram.js'

export { HardwareComparisonPanel } from './HardwareComparisonPanel.js'
export type { HardwareComparisonPanelProps } from './HardwareComparisonPanel.js'

export { HardwareResultView } from './HardwareResultView.js'
export type { HardwareResultViewProps } from './HardwareResultView.js'

export {
  alignMeasurements,
  basisIndexOf,
  distributionFromCounts,
} from './alignment.js'
export type { AlignmentRefusal, CountsAlignment } from './alignment.js'

export { buildHardwareComparison, overlaysOf } from './comparison.js'
export type {
  HardwareComparison,
  HardwareRow,
  PairReading,
} from './comparison.js'

export { formatDuration, formatQpuSeconds } from './duration.js'

export { idealCircuitOf } from './ideal.js'
export type { IdealCircuit, IdealRefusal } from './ideal.js'

export { GATE_COSTS, compareProgram, costOfGate } from './program.js'
export type {
  GateCost,
  GateTally,
  ProgramComparison,
  ProgramSide,
} from './program.js'

export { provenanceOf } from './provenance.js'
export type { JobProvenance, ProvenanceSource } from './provenance.js'

export { HARDWARE_RUN_ROUTE_PATH, hardwareRunPath } from './paths.js'

export { HardwareCredentialsSection } from './HardwareCredentialsSection.js'

export { SubmitToHardwarePanel } from './SubmitToHardwarePanel.js'
export type { SubmitToHardwarePanelProps } from './SubmitToHardwarePanel.js'
