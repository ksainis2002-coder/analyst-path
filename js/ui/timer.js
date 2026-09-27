/* =========================================================================
   ui/timer.js: the countdown for the mock test (spec §8: "wrap any task set
   in timer.js; record completion time")
   -------------------------------------------------------------------------
   The clock is anchored to a start TIMESTAMP, not to a counter, so it keeps
   running through a reload, a sleeping laptop or a closed tab, exactly like
   the real test's clock. There is no pause.

   PURE (Node-testable):
     countdown({ durationSec, startedAt, now }) → { elapsed, remaining, expired, warning, final }
     formatClock(seconds) → "44:05" (or "1:02:03")
     crossed(prevRemaining, remaining) → the announcement thresholds just passed
   DOM:
     createTimer(host, { durationSec, startedAt, now, onExpire, onTick, label })
       → { remaining(), elapsed(), expired(), stop(), destroy(), el }
     A visible clock (role="timer"), plus a polite live region that speaks
     only at 10, 5 and 1 minutes left, so screen readers aren't flooded
     every second. onExpire fires exactly once.
   ========================================================================= */

export const WARN_AT = 5 * 60;      // clay from here: time to wrap up
export const FINAL_AT = 60;         // last minute
export const ANNOUNCE_AT = Object.freeze([10 * 60, 5 * 60, 60]);

/** Where the clock stands. All times in ms except durationSec; results in whole seconds. */
export function countdown({ durationSec, startedAt, now }) {
  const elapsed = Math.max(0, Math.floor((now - startedAt) / 1000));
  const remaining = Math.max(0, durationSec - elapsed);
  return { elapsed: Math.min(elapsed, durationSec), remaining, expired: remaining === 0, warning: remaining > 0 && remaining <= WARN_AT, final: remaining > 0 && remaining <= FINAL_AT };
}

export function formatClock(seconds) {
  const t = Math.max(0, Math.ceil(seconds)), h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

/** Thresholds crossed going from prev → now (e.g. 601 → 599 crosses 600). */
export function crossed(prev, now) { return ANNOUNCE_AT.filter(t => prev > t && now <= t); }

const words = s => (s >= 60 ? `${s / 60} minute${s === 60 ? "" : "s"}` : `${s} seconds`);

export function createTimer(host, opts = {}) {
  const { durationSec, startedAt, onExpire, onTick, label = "Time left" } = opts;
  const now = opts.now || (() => Date.now());
  host.innerHTML = `
    <div class="timer" data-timer>
      <span class="timer__label">${label}</span>
      <span class="timer__clock mono" role="timer" aria-label="${label}" data-clock></span>
      <span class="visually-hidden" aria-live="polite" data-announce></span>
    </div>`;
  const el = host.querySelector("[data-timer]"), clock = host.querySelector("[data-clock]"), say = host.querySelector("[data-announce]");
  let prev = countdown({ durationSec, startedAt, now: now() }).remaining, fired = false, id = null;

  function tick() {
    const c = countdown({ durationSec, startedAt, now: now() });
    clock.textContent = formatClock(c.remaining);
    el.classList.toggle("is-warning", c.warning);
    el.classList.toggle("is-final", c.final);
    el.classList.toggle("is-expired", c.expired);
    const hit = crossed(prev, c.remaining);
    if (hit.length) say.textContent = `${words(hit.at(-1))} left.`;
    prev = c.remaining;
    onTick?.(c);
    if (c.expired && !fired) { fired = true; say.textContent = "Time's up."; stop(); onExpire?.(c); }
  }
  function stop() { if (id !== null) { clearInterval(id); id = null; } }
  tick();
  if (!fired) id = setInterval(tick, 250); // 4×/s so the display never skips a second visibly

  return {
    el,
    remaining: () => countdown({ durationSec, startedAt, now: now() }).remaining,
    elapsed: () => countdown({ durationSec, startedAt, now: now() }).elapsed,
    expired: () => countdown({ durationSec, startedAt, now: now() }).expired,
    tick, stop,
    destroy() { stop(); host.innerHTML = ""; },
  };
}
