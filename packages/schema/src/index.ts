/**
 * @qsim/schema — the circuit JSON contract (specification §6).
 *
 * Every part of the system agrees on this shape: the editor produces it, the
 * engine consumes it, the API stores it in `CircuitVersion.data`, and the
 * QASM converters translate to and from it. It is validated with the same
 * Zod schemas on both sides of the wire.
 *
 * Populated in M0.1. This file currently pins only the schema version so
 * that the value has a single home from the very first commit.
 */

/**
 * Version of the circuit JSON contract.
 *
 * Bump only for breaking shape changes, and add a migration when you do —
 * saved circuits in the database carry this number and must keep loading.
 */
export const CIRCUIT_SCHEMA_VERSION = 1
