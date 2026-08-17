/**
 * INDEPENDENT VERIFICATION — the comment content path (lens: anchor-survival).
 *
 * §3.4 (M5.4 decision 5) and §11: a comment body is user content rendered to
 * other users. The claim is that the markup is an ALLOW-list with two
 * productions (a newline, and a span between backticks) rather than a sanitiser
 * over a rich format, and that the bounds are enforced by the contract on both
 * sides of the wire.
 *
 * Everything here goes through the real renderer and the real schema.
 */

import {
  CommentBodySchema,
  MAX_COMMENT_LENGTH,
  PostCommentBody,
} from '@qsim/contract'
import { render } from '@testing-library/react'
import { describe, expect, it } from 'vitest'

import { CommentBody } from '../../features/comments/CommentBody'

/** Renders a body and hands back the container for structural questions. */
function renderBody(body: string): HTMLElement {
  const { container } = render(<CommentBody body={body} />)
  return container
}

describe('a comment body is text, and the markup is an allow-list', () => {
  it.each([
    ['<script>alert(1)</script>'],
    ['<img src=x onerror="alert(1)">'],
    ['<a href="javascript:alert(1)">click</a>'],
    ['<iframe src="https://example.invalid"></iframe>'],
    ['<svg><style>@import "https://example.invalid"</style></svg>'],
    ['[click](javascript:alert(1))'],
    ['![x](https://example.invalid/x.png)'],
    ['<div onmouseover=alert(1)>hover</div>'],
  ])('renders %s as characters and creates no element for it', (payload) => {
    const container = renderBody(payload)

    // The only elements on this path are the wrapper, the paragraph, and
    // `Notation` for a backticked span. Nothing the payload asked for.
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('a')).toBeNull()
    expect(container.querySelector('iframe')).toBeNull()
    expect(container.querySelector('svg')).toBeNull()
    expect(container.querySelector('style')).toBeNull()
    expect(container.querySelector('div[onmouseover]')).toBeNull()
    // And the reader sees the words, which is the whole point of not filtering.
    expect(container.textContent).toContain(payload.trim().slice(0, 12))
  })

  it('an attribute-shaped payload never becomes an attribute', () => {
    const container = renderBody('" onload="alert(1)" data-x="')
    for (const element of container.querySelectorAll('*')) {
      expect(element.getAttribute('onload')).toBeNull()
      expect(element.getAttribute('data-x')).toBeNull()
    }
  })

  it('the two productions are the only ones: a break and a backtick span', () => {
    const container = renderBody('first `H` line\nsecond **not bold** line')

    expect(container.querySelectorAll('p')).toHaveLength(2)
    // `Notation` is the sanctioned route for invariant text, and it is the only
    // markup the format has.
    const notation = container.querySelectorAll('[translate="no"]')
    expect(notation).toHaveLength(1)
    expect(notation[0]?.textContent).toBe('H')
    // Asterisks stay asterisks: there is no markdown here to allow or deny.
    expect(container.textContent).toContain('**not bold**')
    expect(container.querySelector('strong')).toBeNull()
    expect(container.querySelector('em')).toBeNull()
  })

  it('no dangerouslySetInnerHTML anywhere on the render path', async () => {
    // Read rather than reasoned about: the property is what would turn any of
    // the payloads above into markup, and it must not appear.
    const files = await Promise.all(
      [
        '../../features/comments/CommentBody.tsx',
        '../../features/comments/AnchorLabel.tsx',
        '../../features/comments/CommentThreadView.tsx',
        '../../features/comments/CommentsPanel.tsx',
        '../../features/comments/CommentMarkers.tsx',
        '../../lib/prose.ts',
      ].map(async (path) => {
        const { readFile } = await import('node:fs/promises')
        const { fileURLToPath } = await import('node:url')
        return readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
      })
    )
    for (const source of files) {
      // The prop, not the word: these files argue about the property in prose,
      // and a prose mention is the opposite of a use.
      expect(source).not.toMatch(/dangerouslySetInnerHTML\s*[={:]/)
    }
  })
})

describe('the bounds the contract enforces on both sides of the wire', () => {
  it('refuses a body over MAX_COMMENT_LENGTH', () => {
    expect(
      CommentBodySchema.safeParse('a'.repeat(MAX_COMMENT_LENGTH)).success
    ).toBe(true)
    expect(
      CommentBodySchema.safeParse('a'.repeat(MAX_COMMENT_LENGTH + 1)).success
    ).toBe(false)
  })

  it('refuses an empty or whitespace-only body', () => {
    expect(CommentBodySchema.safeParse('').success).toBe(false)
    expect(CommentBodySchema.safeParse('   \n  ').success).toBe(false)
  })

  it('refuses a NUL and a lone surrogate, and allows a newline', () => {
    expect(CommentBodySchema.safeParse('one\ntwo').success).toBe(true)
    expect(CommentBodySchema.safeParse('one\u0000two').success).toBe(false)
    expect(CommentBodySchema.safeParse('one\uD800two').success).toBe(false)
  })

  it('refuses a reply that carries its own anchor', () => {
    expect(
      PostCommentBody.safeParse({
        body: 'hello',
        parentId: 'abc',
        anchorOpId: 'op_9',
      }).success
    ).toBe(false)
    expect(
      PostCommentBody.safeParse({ body: 'hello', parentId: 'abc' }).success
    ).toBe(true)
  })

  it('bounds the anchor at the contract’s 64 characters', () => {
    expect(
      PostCommentBody.safeParse({ body: 'x', anchorOpId: 'a'.repeat(64) })
        .success
    ).toBe(true)
    expect(
      PostCommentBody.safeParse({ body: 'x', anchorOpId: 'a'.repeat(65) })
        .success
    ).toBe(false)
  })
})
