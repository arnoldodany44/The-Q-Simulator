import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { useUnsavedWork } from './useUnsavedWork'

/**
 * When the browser's own "leave this page?" dialog is armed, and — the part
 * that matters — when it is not.
 *
 * The documented decision is that the address bar is the draft: `?c=` carries
 * the document through a reload, so warning about a loss that does not happen
 * would train the reader to dismiss the one warning that means something. What
 * is asserted here is that discipline, from both sides.
 */

afterEach(cleanup)

function Probe({
  carried,
  hasWork,
}: {
  readonly carried: boolean
  readonly hasWork: boolean
}) {
  useUnsavedWork({ carried, hasWork })
  return null
}

/** Whether a `beforeunload` listener would stop the page from unloading. */
function wouldWarn(): boolean {
  const event = new Event('beforeunload', { cancelable: true })
  window.dispatchEvent(event)
  return event.defaultPrevented
}

describe('the leave-the-page warning', () => {
  it('stays silent while the address bar is carrying the document', () => {
    render(<Probe carried hasWork />)

    // A reload brings the edit back out of `?c=`, so there is nothing to warn
    // about — and a dialog here would be a false alarm on every single edit.
    expect(wouldWarn()).toBe(false)
  })

  it('stays silent when there is no work to lose', () => {
    render(<Probe carried={false} hasWork={false} />)

    expect(wouldWarn()).toBe(false)
  })

  it('fires for a circuit too large for the address bar', () => {
    /*
     * `exceedsUrlBudget` leaves no parameter at all rather than a stale one, so
     * for this document — and only this one — closing the tab really does lose
     * the edit.
     */
    render(<Probe carried={false} hasWork />)

    expect(wouldWarn()).toBe(true)
  })

  it('stops warning once the work is carried again', () => {
    const view = render(<Probe carried={false} hasWork />)
    expect(wouldWarn()).toBe(true)

    view.rerender(<Probe carried hasWork />)

    expect(wouldWarn()).toBe(false)
  })

  it('leaves no listener behind when the editor unmounts', () => {
    const view = render(<Probe carried={false} hasWork />)
    view.unmount()

    // Otherwise navigating away from the editor would keep prompting on every
    // page of the app, for a document that is no longer open.
    expect(wouldWarn()).toBe(false)
  })
})
