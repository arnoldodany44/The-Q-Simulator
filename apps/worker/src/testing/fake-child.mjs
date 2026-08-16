/**
 * A stand-in for `simulate.child.js`, used by `pool.test.ts`.
 *
 * ── Why it is plain JavaScript ────────────────────────────────────────────
 *
 * Because the pool forks it, and a forked process is started by Node with no
 * Vitest transform in front of it. A `.ts` fixture would resolve fine in the
 * test file and fail the moment it was actually executed — which is to say, in
 * every test that matters.
 *
 * ── Why the pool is tested against a fake child at all ────────────────────
 *
 * The pool's job has nothing to do with quantum mechanics: it is dispatch,
 * timeouts, kills and replacement. Testing it against the real child would make
 * every assertion depend on how long a simulation happens to take on the
 * machine running the suite, and would make "kill a job that will not stop"
 * require a circuit chosen to be slow. Here the behaviour is asked for
 * directly, through the run id, and the real simulation is tested as the plain
 * function it is in `simulate.test.ts`.
 *
 * The directive is the run id's prefix:
 *
 *   ok:<ms>        answer after roughly <ms> of real time, asynchronously
 *   spin:<ms>      answer after <ms> of *synchronous* busy-looping
 *   hang           never answer, in a synchronous loop that no timer, no
 *                  AbortController and no SIGTERM can break into. This is the
 *                  case the whole child-process design exists for.
 *   fail:<code>    report a failure with that code
 *   crash          exit without a word, like an OOM kill
 *   progress:<n>   emit <n> progress messages, then answer
 */

process.on('message', (command) => {
  if (command === null || typeof command !== 'object') return
  if (command.type !== 'run') return

  const directive = String(command.payload?.runId ?? '')
  const [kind, argument] = directive.split(':')

  const done = () => {
    process.send?.({
      type: 'done',
      result: {
        resultVersion: 1,
        mode: command.payload.mode,
        qubits: 1,
        shots: null,
        seed: 0,
        noiseProfileId: null,
        outcomes: [{ state: '0', probability: 1, count: null }],
        hiddenOutcomes: 0,
        hiddenWeight: 0,
        purity: null,
        durationMs: 0,
      },
    })
  }

  if (kind === 'hang') {
    // Deliberately a synchronous spin and not a `setInterval`. The point of the
    // test that uses this is that the parent's SIGKILL lands on a process that
    // is *inside* a loop, which is exactly where a cooperative cancellation
    // mechanism would be powerless.
    for (;;) {
      Math.sqrt(Math.random())
    }
  }

  if (kind === 'crash') {
    process.exit(1)
  }

  if (kind === 'fail') {
    process.send?.({
      type: 'failed',
      code: argument ?? 'ENGINE_FAILED',
      detail: 'the fake child was asked to fail',
    })
    return
  }

  if (kind === 'spin') {
    const until = Date.now() + Number(argument ?? 0)
    while (Date.now() < until) {
      /* synchronous, so the child's own event loop is blocked too */
    }
    done()
    return
  }

  if (kind === 'progress') {
    const total = Number(argument ?? 1)
    for (let step = 1; step <= total; step++) {
      process.send?.({
        type: 'progress',
        progress: { phase: 'simulating', completed: step, total },
      })
    }
    done()
    return
  }

  setTimeout(done, Number(argument ?? 0))
})

process.send?.({ type: 'ready' })
