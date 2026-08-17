import { cleanup, render } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { CommentBody } from './CommentBody'

/**
 * §11 in one file: a comment is written by one user and rendered to others.
 *
 * The assertions are about the *format* rather than about a filter, because there
 * is no filter. The allow-list has two productions in it — a newline and a span
 * between backticks — and everything else is a character. So the way to prove a
 * comment cannot inject anything is to prove that markup arrives as text and that
 * nothing on this path ever hands a string to the DOM as HTML.
 *
 * The last test greps the source. That is deliberate and not paranoia: a
 * `dangerouslySetInnerHTML` added here later would pass every behavioural test in
 * this file — they only assert what the *current* renderer does with markup — and
 * would be a stored-XSS hole on the one surface in the product where a stranger's
 * text is shown to somebody else.
 */

afterEach(cleanup)

describe('a comment body is text', () => {
  it('renders markup as characters rather than as elements', () => {
    const body = '<script>alert(1)</script> and <img src=x onerror=alert(2)>'
    const view = render(<CommentBody body={body} />)

    expect(view.container.querySelector('script')).toBeNull()
    expect(view.container.querySelector('img')).toBeNull()
    // Visible, so nothing was silently stripped either: a reader sees what was
    // written, which is the honest outcome for text nobody promised was markup.
    expect(view.container.textContent).toContain('<script>alert(1)</script>')
    expect(view.container.textContent).toContain('onerror=alert(2)')
  })

  it('marks a span between backticks as notation', () => {
    const view = render(<CommentBody body="The `H` on `q0` is redundant." />)

    const marked = [...view.container.querySelectorAll('[translate="no"]')].map(
      (node) => node.textContent
    )
    expect(marked).toEqual(['H', 'q0'])
    // The backticks themselves are consumed: they are the convention, not text.
    expect(view.container.textContent).toBe('The H on q0 is redundant.')
  })

  it('leaves an unpaired backtick as a character', () => {
    // The forgiving reading, argued in `lib/prose.ts`: the strict one lets one
    // stray backtick swallow the rest of a paragraph into a code span.
    const view = render(<CommentBody body="a ` b" />)
    expect(view.container.querySelector('[translate="no"]')).toBeNull()
    expect(view.container.textContent).toBe('a ` b')
  })

  it('turns newlines into paragraphs and collapses empty runs', () => {
    const view = render(<CommentBody body={'First.\n\n\n\nSecond.'} />)
    const paragraphs = [
      ...view.container.querySelectorAll('.comment-body__paragraph'),
    ].map((node) => node.textContent)
    expect(paragraphs).toEqual(['First.', 'Second.'])
  })

  it('renders nothing for a body that is only whitespace', () => {
    // Not reachable through the contract, which trims and demands one character.
    // Asserted anyway: the renderer must not produce an empty paragraph that
    // pushes the thread apart for a body that says nothing.
    const view = render(<CommentBody body={'   \n  '} />)
    expect(
      view.container.querySelectorAll('.comment-body__paragraph')
    ).toHaveLength(0)
  })

  it('has no path to innerHTML anywhere in its source', () => {
    const source = readFileSync(
      join(import.meta.dirname, 'CommentBody.tsx'),
      'utf8'
    )
    /*
     * Matched as *usage* rather than as a substring, because the file's header
     * names both to explain why neither is there. An attribute is followed by
     * `=`, and an assignment to `innerHTML` is too — a mention inside a comment
     * is not.
     */
    expect(source).not.toMatch(/dangerouslySetInnerHTML\s*=/)
    expect(source).not.toMatch(/innerHTML\s*=/)
  })
})
