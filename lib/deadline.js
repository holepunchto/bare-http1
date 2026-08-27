module.exports = class Deadline {
  constructor(ms, onexpire) {
    this._ms = ms
    this._onexpire = onexpire

    this._remaining = ms
    this._since = 0
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

    this._since = Date.now()
    this._timer = setTimeout(this._onexpire, this._remaining)
    this._timer.unref()
  }

  _stop() {
    if (this._timer === null) return

    clearTimeout(this._timer)
    this._timer = null

    const elapsed = Date.now() - this._since

    // Never all the way to zero, as that would be indistinguishable from a
    // deadline that has not started counting yet.
    this._remaining = elapsed >= this._remaining ? 1 : this._remaining - elapsed
  }
}
