// Copied from the pattern library's assets/motion/dismiss.js with its imports removed: the modules are inlined into script.js.

// Drag a zoomed photo down to dismiss it, as in iOS Photos. The photo follows the pointer on
// both axes and shrinks around the point that was grabbed; its scale and the backdrop's opacity
// depend only on the downward pull. On release, a pull projected past `distance` of the height
// dismisses; anything less springs back. Works on a zoom from zoom.js, placed at its full state.
//
// const dismiss = createDismiss(zoom, {
//   height: () => innerHeight,
//   distance: 0.15,                     // of the height, measured on the projected release
//   onBackdrop(opacity),                // the backdrop's opacity for the current pull
//   from() => state,                    // the state to shrink into, e.g. fullState(rect)
//   onDismiss(),                        // zoom.progress now runs 1 → 0 at the release speed:
//                                       // call zoom.animate(0, presets.zoomClose, …)
//   onReturn(),                         // the photo has sprung back to rest
// });
// dismiss.start({ x, y });  dismiss.move(dx, dy);  dismiss.end(velocity) → true if dismissing
// Also { active, stop() }.
export function createDismiss(zoom, {
  height = () => innerHeight,
  distance = 0.15,
  scale = presets.dismissScale,
  opacity = presets.dismissOpacity,
  spring = presets.dismissReturn,
  onBackdrop = () => {},
  from,
  onDismiss = () => {},
  onReturn = () => {},
} = {}) {
  const render = () => {
    const { base } = zoom;
    const k = pull(scale, y.value, height());
    zoom.to = fullState({
      x: base.x + grab.x + x.value - grab.x * k,
      y: base.y + grab.y + y.value - grab.y * k,
      w: base.w * k,
      h: base.h * k,
    });
    zoom.progress.set(1);
    onBackdrop(pull(opacity, y.value, height()));
  };
  const x = createValue({ precision: 0.25, onUpdate: render });
  const y = createValue({ precision: 0.25, onUpdate: render });
  let grab = { x: 0, y: 0 };
  let active = false;

  const dismiss = {
    get active() {
      return active || x.running || y.running;
    },
    stop() {
      x.stop();
      y.stop();
    },
    // A drag began at viewport point `press`.
    start(press) {
      dismiss.stop();
      active = true;
      zoom.progress.stop();
      x.value = y.value = 0;
      grab = { x: press.x - zoom.base.x, y: press.y - zoom.base.y };
    },
    move(dx, dy) {
      x.value = dx;
      y.value = dy;
      render();
    },
    // Let go at `velocity` px/s. Returns true when dismissing.
    end(velocity) {
      active = false;
      if (y.value + project(velocity.y, FAST_DECELERATION) > height() * distance) {
        zoom.from = from();
        zoom.progress.velocity = velocity.y / (zoom.to.content.y - zoom.from.content.y || 1);
        onDismiss();
        return true;
      }
      let moving = 2;
      const settled = () => {
        if (--moving === 0) onReturn();
      };
      x.velocity = velocity.x;
      y.velocity = velocity.y;
      x.to(0, spring, settled);
      y.to(0, spring, settled);
      return false;
    },
  };
  return dismiss;
}
