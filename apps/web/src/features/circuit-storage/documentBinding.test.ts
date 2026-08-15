import { emptyCircuit } from '@qsim/schema'
import { describe, expect, it } from 'vitest'

import { createDocumentBinding } from './documentBinding'

/**
 * The binding is four fields and two actions, and it earns a suite for one
 * reason: it is what survives the route swap between `/new` and `/c/:slug`,
 * and everything that depends on that survival fails silently when it does not.
 */

const base = {
  circuitId: 'cir_1',
  slug: 'V1StGXR8Z5jdHi6BmyT8a',
  versionNum: 1,
  circuit: emptyCircuit(2),
}

describe('the document binding', () => {
  it('starts unbound, which is what an unsaved document is', () => {
    expect(createDocumentBinding().getState().base).toBeNull()
  })

  it('remembers the version a document descends from', () => {
    const binding = createDocumentBinding()
    binding.getState().bind(base)

    expect(binding.getState().base).toEqual(base)
  })

  it('lets a save move the base forward without losing the identity', () => {
    const binding = createDocumentBinding()
    binding.getState().bind(base)
    const current = binding.getState().base!

    binding.getState().bind({
      ...current,
      versionNum: 2,
      circuit: emptyCircuit(4),
    })

    expect(binding.getState().base?.circuitId).toBe('cir_1')
    expect(binding.getState().base?.versionNum).toBe(2)
  })

  it('releases without churning the state when there was nothing bound', () => {
    // Identity is preserved on a no-op release, so a component subscribed to
    // `base` does not re-render every time an unbound route re-runs its effect.
    const binding = createDocumentBinding()
    const before = binding.getState()
    binding.getState().release()

    expect(binding.getState()).toBe(before)
  })

  it('forgets a bound circuit when asked', () => {
    const binding = createDocumentBinding()
    binding.getState().bind(base)
    binding.getState().release()

    expect(binding.getState().base).toBeNull()
  })

  it('gives each instance its own state', () => {
    // The app shares one; a test that had to reach around a singleton would
    // leak a binding from one case into the next.
    const first = createDocumentBinding()
    const second = createDocumentBinding()
    first.getState().bind(base)

    expect(second.getState().base).toBeNull()
  })
})
