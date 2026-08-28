// Measured against the monotonic clock, as a deadline that counted wall clock
// time would be cut short or drawn out by a step in the system time.
const hrtime = require('bare-hrtime')

const MILLISECOND = 1000000n

module.exports = class Deadline {
  constructor(ms, onexpire) {
    this._ms = ms
    this._onexpire = onexpire

    this._remaining = ms
    this._since = 0n
    this._timer = null
    this._armed = false
  }

  get armed() {
    return this._armed
  }

  arm() {
    this._armed = true
    this._remaining = this._ms

    this._start()
  }

  disarm() {
    this._stop()

    this._armed = false
    this._remaining = this._ms
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
    this._timer = setTimeout(this._onexpire, this._remaining)
    this._timer.unref()
  }

  _stop() {
    if (this._timer === null) return

    clearTimeout(this._timer)
    this._timer = null

    const elapsed = Number((hrtime.bigint() - this._since) / MILLISECOND)

    // Never all the way to zero, as that would be indistinguishable from a
    // deadline that has not started counting yet.
    this._remaining = elapsed >= this._remaining ? 1 : this._remaining - elapsed
  }
}
