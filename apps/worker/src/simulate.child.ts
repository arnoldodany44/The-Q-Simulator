/**
 * The process a simulation actually runs in — what `pool.ts` forks.
 *
 * Three lines on purpose: everything it does is in `child-main.ts`, which is
 * testable without a fork. Built to `dist/simulate.child.js` beside
 * `dist/worker.js`, which is where the pool looks for it (`build.js`).
 */

import process from 'node:process'
import { childMain } from './child-main.js'

childMain(process)
