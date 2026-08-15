/**
 * The keyboard map, on screen.
 *
 * A shortcut nobody can find is a shortcut nobody has. §10 asks for an
 * editor that works without a pointer, and that is only true if the key that
 * does the work is discoverable from inside the editor rather than from the
 * source of `useKeyboardGrid.ts` — which is where the same map is written
 * down for whoever maintains it. The two must be changed together.
 *
 * Key *names* are translated, unlike gate symbols. A French keyboard is
 * legended `Échap` and `Suppr`; telling a French user to press `Esc` is
 * naming a key their hardware does not have. The letters in a combination
 * are notation and stay as they are: `Ctrl` + `Z` is `Z` everywhere.
 */

import { useTranslation } from 'react-i18next'

import { Notation } from '../../components/Notation'

/** A key in a combination: a translated name, or a literal legend. */
type KeyToken = { readonly name: string } | { readonly legend: string }

interface Shortcut {
  /** Alternative combinations that do the same thing. */
  readonly combos: readonly (readonly KeyToken[])[]
  readonly description: string
}

export function ShortcutsPanel() {
  const { t } = useTranslation('editor')

  const name = (key: string): KeyToken => ({
    name: t(`shortcuts.keys.${key}`),
  })
  const legend = (value: string): KeyToken => ({ legend: value })

  const shortcuts: readonly Shortcut[] = [
    { combos: [[name('arrows')]], description: t('shortcuts.move') },
    {
      combos: [[name('home')], [name('end')]],
      description: t('shortcuts.rowEnds'),
    },
    { combos: [[name('gate')]], description: t('shortcuts.arm') },
    { combos: [[name('enter')]], description: t('shortcuts.place') },
    { combos: [[name('space')]], description: t('shortcuts.pickUp') },
    { combos: [[name('escape')]], description: t('shortcuts.cancel') },
    { combos: [[name('delete')]], description: t('shortcuts.remove') },
    {
      combos: [[name('ctrl'), legend('Z')]],
      description: t('shortcuts.undo'),
    },
    {
      combos: [
        [name('ctrl'), name('shift'), legend('Z')],
        [name('ctrl'), legend('Y')],
      ],
      description: t('shortcuts.redo'),
    },
    {
      combos: [[name('ctrl'), legend('C')]],
      description: t('shortcuts.copy'),
    },
    {
      combos: [[name('ctrl'), legend('V')]],
      description: t('shortcuts.paste'),
    },
    /*
     * The timeline's keys (M0.8). They are listed with the rest because this
     * panel is where a keyboard user looks, and they name the bar explicitly
     * because they are the only entries here that are *not* live on the grid:
     * Space on a cell picks a gate up, and Space on the timeline plays it. Two
     * meanings for one key is safe only while each says where it applies.
     */
    {
      combos: [[name('arrows')], [name('home')], [name('end')]],
      description: t('shortcuts.timelineStep'),
    },
    { combos: [[name('space')]], description: t('shortcuts.timelinePlay') },
  ]

  return (
    <details className="shortcuts">
      <summary className="shortcuts__summary">{t('shortcuts.title')}</summary>
      <p className="shortcuts__note">{t('shortcuts.note')}</p>
      <dl className="shortcuts__list">
        {shortcuts.map((shortcut) => (
          <div className="shortcuts__entry" key={shortcut.description}>
            <dt className="shortcuts__combos">
              {shortcut.combos.map((combo, index) => (
                <span className="shortcuts__combo" key={index}>
                  {combo.map((token, position) => (
                    <kbd className="shortcuts__key" key={position}>
                      {'legend' in token ? (
                        <Notation value={token.legend} />
                      ) : (
                        token.name
                      )}
                    </kbd>
                  ))}
                </span>
              ))}
            </dt>
            <dd className="shortcuts__description">{shortcut.description}</dd>
          </div>
        ))}
      </dl>
    </details>
  )
}
