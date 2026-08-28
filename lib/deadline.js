// Measured against the monotonic clock, as a deadline that counted wall clock
// time would be cut short or drawn out by a step in the system time.
const hrtime = require('bare-hrtime')

const MILLISECOND = 1000000n

module.exports = class Deadline {
  constructor(ms, onexpire) {
    // Anything that is not a wait of some length is no wait at all. A timer
    // takes `Infinity` and `NaN` to mean the next tick, which would turn either
    // one into a deadline that expires immediately rather than never.
    this._ms = Number.isFinite(ms) && ms > 0 ? Math.ceil(ms) : 0
    this._onexpire = onexpire

    // Counted in nanoseconds, as a deadline that only ever counted whole
    // milliseconds would lose the remainder of every wait it was suspended
    // part way through, and so never advance at all under a peer that suspends
    // it more than once a millisecond.
    this._total = BigInt(this._ms) * MILLISECOND
    this._remaining = this._total
    this._since = 0n
    this._timer = null
    this._armed = false
  }

  get armed() {
    return this._armed
  }

  arm() {
    this._armed = true
    this._remaining = this._total

    this._start()
  }

  disarm() {
    this._stop()

    this._armed = false
    this._remaining = this._total
  }

  suspend() {
    this._stop()
  }

  resume() {
    if (this._armed) this._start()
  }

  _start() {
    if (this._ms === 0 || this._timer !== null) return

    this._since = hrtime.bigint()

    // Rounded up, as a wait shorter than the clock the timer runs on must not
    // be treated as no wait at all.
    const ms = Number((this._remaining + MILLISECOND - 1n) / MILLISECOND)

    this._timer = setTimeout(this._onexpire, ms)
    this._timer.unref()
  }

  _stop() {
    if (this._timer === null) return

    clearTimeout(this._timer)
    this._timer = null

    const elapsed = hrtime.bigint() - this._since

    // Never all the way to zero, as that would be indistinguishable from a
    // deadline that has not started counting yet.
    this._remaining = elapsed >= this._remaining ? 1n : this._remaining - elapsed
  }
}
