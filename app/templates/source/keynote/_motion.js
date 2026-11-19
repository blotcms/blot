// Copied from the pattern library's assets/motion/motion.js with its imports removed: the modules are inlined into script.js.
// Motion primitives measured from iOS 26 Photos (see /resources/animation/). The fades are in style.css.

export const presets = {
  zoomOpen: { omega: 24.85, zeta: 0.973 },
  zoomClose: { omega: 28.27, zeta: 0.973 },
  page: { omega: 13.27, zeta: 1 },
  dismissReturn: { omega: 21.07, zeta: 0.947 },
  // Scale and backdrop opacity against the downward pull, for pull().
  dismissScale: { k: 0.3076, L: 0.3057, p: 1.792 },
  dismissOpacity: { k: 0.9955, L: 0.2884, p: 2.338 },
};

// Per-millisecond deceleration rates: UIScrollView's normal and fast. Not measured.
export const DECELERATION = 0.998;
export const FAST_DECELERATION = 0.99;
// UIScrollView's rubber-band constant. Not measured.
export const RUBBER_BAND = 0.55;

export const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
export const lerp = (a, b, p) => a + (b - a) * p;
export const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// A damped spring (mass 1, stiffness ω², damping 2ζω) from (x0, v0) toward target after t seconds.
// Returns [position, velocity].
export function spring(x0, v0, target, { omega, zeta }, t) {
  const a = x0 - target;
  const decay = Math.exp(-zeta * omega * t);
  if (zeta === 1) {
    const b = v0 + omega * a;
    return [target + (a + b * t) * decay, (v0 - omega * b * t) * decay];
  }
  if (zeta > 1) {
    const r = omega * Math.sqrt(zeta * zeta - 1);
    const r1 = -zeta * omega + r;
    const r2 = -zeta * omega - r;
    const c2 = (v0 - r1 * a) / (r2 - r1);
    const c1 = a - c2;
    const e1 = Math.exp(r1 * t);
    const e2 = Math.exp(r2 * t);
    return [target + c1 * e1 + c2 * e2, c1 * r1 * e1 + c2 * r2 * e2];
  }
  const wd = omega * Math.sqrt(1 - zeta * zeta);
  const b = (v0 + zeta * omega * a) / wd;
  const cos = Math.cos(wd * t);
  const sin = Math.sin(wd * t);
  return [
    target + decay * (a * cos + b * sin),
    decay * ((b * wd - zeta * omega * a) * cos - (a * wd + zeta * omega * b) * sin),
  ];
}

// Run a spring on requestAnimationFrame until it is within `precision` of the target.
// `now` lets a page run animations on its own clock. Returns a stop function.
export function runSpring({ from, velocity = 0, to, params, precision = 0.01, now = () => performance.now(), onUpdate, onDone }) {
  const start = now();
  let id;
  const tick = () => {
    let [x, v] = spring(from, velocity, to, params, Math.max(0, now() - start) / 1000);
    const settled = Math.abs(x - to) < precision && Math.abs(v) < precision * 20;
    if (settled) [x, v] = [to, 0];
    onUpdate(x, v);
    if (settled) onDone?.();
    else id = requestAnimationFrame(tick);
  };
  id = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(id);
}

// A value that animates on springs. Starting a new animation keeps the current velocity, so
// retargeting mid-flight never jolts. With reduced motion, animations jump to their target.
export function createValue({ value = 0, precision = 0.01, now, onUpdate = () => {} } = {}) {
  let stop = null;
  const state = {
    value,
    velocity: 0,
    precision,
    get running() {
      return Boolean(stop);
    },
    stop() {
      stop?.();
      stop = null;
    },
    set(next, velocity = 0) {
      state.stop();
      state.value = next;
      state.velocity = velocity;
      onUpdate(next, velocity);
    },
    // Spring to `target`.
    to(target, params, done) {
      state.stop();
      if (reduceMotion.matches) {
        state.set(target);
        done?.();
        return;
      }
      stop = runSpring({
        from: state.value, velocity: state.velocity, to: target, params, precision: state.precision, now,
        onUpdate(x, v) {
          state.value = x;
          state.velocity = v;
          onUpdate(x, v);
        },
        onDone() {
          stop = null;
          done?.();
        },
      });
    },
    // Decelerate exponentially, at the rate that comes to rest exactly on `target`, then hand
    // the last `within` of the distance to a spring instead of the long tail. Slow releases, short
    // distances (under `min`) and releases away from the target go straight to the spring.
    coast(target, params, { within = 0.25, min = 0.5, done } = {}) {
      const distance = target - state.value;
      const v0 = state.velocity;
      if (reduceMotion.matches || Math.abs(v0) < 1 || Math.sign(distance) !== Math.sign(v0) || Math.abs(distance) < min) {
        state.to(target, params, done);
        return;
      }
      state.stop();
      const rate = v0 / distance;
      const origin = state.value;
      const clock = now ?? (() => performance.now());
      const start = clock();
      let id;
      const tick = () => {
        const remaining = distance * Math.exp(-rate * Math.max(0, clock() - start) / 1000);
        state.value = origin + distance - remaining;
        state.velocity = rate * remaining;
        onUpdate(state.value, state.velocity);
        if (Math.abs(remaining) < within) {
          stop = null;
          state.to(target, params, done);
        } else id = requestAnimationFrame(tick);
      };
      id = requestAnimationFrame(tick);
      stop = () => cancelAnimationFrame(id);
    },
  };
  return state;
}

// How far a flick at `velocity` (units per second) travels while decelerating at `rate` per ms.
export const project = (velocity, rate = DECELERATION) => (velocity / 1000) * (rate / (1 - rate));

// Stretch for a pull of `over` past an edge, in a space of size `dimension`: less the further it goes.
export const rubberBand = (over, dimension, c = RUBBER_BAND) => (over * dimension * c) / (dimension + c * over);

// The raw position that band() draws at `value`, so a drag can pick up a stretched value.
export function unband(value, min, max, dimension, c = RUBBER_BAND) {
  const raw = (r) => (r * dimension) / (c * (dimension - Math.min(r, 0.99 * dimension)));
  if (value < min) return min - raw(min - value);
  if (value > max) return max + raw(value - max);
  return value;
}

// Clamp `value` to [min, max] with rubber-banded overshoot.
export function band(value, min, max, dimension, c = RUBBER_BAND) {
  if (value < min) return min - rubberBand(min - value, dimension, c);
  if (value > max) return max + rubberBand(value - max, dimension, c);
  return value;
}

// Scale or opacity against a pull of d, in a space of size `height`: 1 − k(1 − e^−(d / Lh)^p).
export const pull = ({ k, L, p }, d, height = innerHeight) => (d > 0 && height > 0 ? 1 - k * (1 - Math.exp(-((d / (L * height)) ** p))) : 1);

// A wheel event's movement in pixels; lines count 16 px and pages `page` px.
export function wheelDelta(event, page = innerHeight) {
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? page : 1;
  return { x: event.deltaX * unit, y: event.deltaY * unit };
}

// Release velocity from pointer samples: only the last `window` ms count, so holding still
// before letting go means no flick. Velocities are in pixels per second.
export function velocityTracker(window = 100) {
  let samples = [];
  return {
    reset() {
      samples = [];
    },
    add(event) {
      samples.push({ t: event.timeStamp, x: event.clientX, y: event.clientY });
      samples = samples.filter((sample) => event.timeStamp - sample.t < window);
    },
    velocity(timeStamp = samples.at(-1)?.t ?? 0) {
      const recent = samples.filter((sample) => timeStamp - sample.t < window);
      const first = recent[0];
      const last = recent.at(-1);
      if (!first || first === last) return { x: 0, y: 0 };
      const elapsed = Math.max(1, last.t - first.t) / 1000;
      return { x: (last.x - first.x) / elapsed, y: (last.y - first.y) / elapsed };
    },
  };
}
