/**
 * A profile picture: the one the identity provider issued, or one drawn from
 * the user id — milestone M1.9.
 *
 * ── Both branches are decoration ──────────────────────────────────────────
 *
 * The identity is the name and the handle beside this, which are text. So the
 * generated one is `aria-hidden` and the provider's carries `alt=""`: a
 * screen reader announcing "profile picture of ada" before the word "ada" is
 * a duplicate, and announcing "a green pattern" is noise. WCAG 1.1.1 is
 * satisfied by an empty `alt` on an image that adds nothing — that is what an
 * empty `alt` is *for*, and it is not the same as omitting the attribute,
 * which makes a screen reader read the file name instead.
 *
 * ── The provider's image is loaded carefully ──────────────────────────────
 *
 * It is a third-party URL and it is rendered in a page a stranger may open, so
 * it is `referrerPolicy="no-referrer"` — otherwise every view of a profile
 * tells the picture's host which profile was being looked at — and
 * `loading="lazy"` because on a listing it is fifty requests to somebody
 * else's server. `decoding="async"` keeps a slow decode off the main thread.
 *
 * The URL itself was restricted to http and https in `apps/api`'s `verify.ts`
 * before it ever reached a column, which is why this component can render it
 * without asking questions: the dangerous values never got stored.
 */

import { identiconFor, IDENTICON_GRID } from './identicon.js'

export interface AvatarProps {
  /** `User.id` — what the generated picture is derived from. */
  readonly identity: string
  /** The provider's picture, or `null` for the generated one. */
  readonly avatarUrl: string | null
  /** Rendered size in pixels. The grid scales with it. */
  readonly size?: number
  readonly className?: string
}

export function Avatar({
  identity,
  avatarUrl,
  size = 48,
  className,
}: AvatarProps) {
  const classes = ['avatar', className].filter(Boolean).join(' ')

  if (avatarUrl !== null) {
    return (
      <img
        className={classes}
        src={avatarUrl}
        // Deliberately empty rather than absent — see the header.
        alt=""
        width={size}
        height={size}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
      />
    )
  }

  const { cells, colour } = identiconFor(identity)

  return (
    <svg
      className={classes}
      width={size}
      height={size}
      viewBox={`0 0 ${String(IDENTICON_GRID)} ${String(IDENTICON_GRID)}`}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        width={IDENTICON_GRID}
        height={IDENTICON_GRID}
        // The panel colour, so the unfilled cells are the surface rather than
        // a hole punched in it.
        fill="var(--bg-elevated)"
      />
      {cells.map((filled, index) =>
        filled ? (
          <rect
            key={index}
            x={index % IDENTICON_GRID}
            y={Math.floor(index / IDENTICON_GRID)}
            width={1}
            height={1}
            fill={colour}
          />
        ) : null
      )}
    </svg>
  )
}
