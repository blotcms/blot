// Copied from the pattern library's assets/motion/pager.js with its imports removed (the modules
// are inlined into script.js), and trimmed to what the viewer uses: no looping.

// A paging position: an item index, fractional while moving. It follows a drag, stretches past
// either end, and on release springs to the item a flick would reach, at most `maxFlick` items
// from where the drag began. Retargeting keeps the current speed. The pager owns no elements;
// draw it from `onPosition`, and feed it a drag (see drag.js):
//
// const pager = createPager({ count, pitch: () => width + gap, onPosition: render });
// drag(element, {
//   onPress: () => pager.grab(),
//   onMove: ({ dx }) => pager.move(dx),
//   onEnd: ({ velocity }) => pager.release(velocity.x),
//   onRelease: () => pager.settle(),
// });
//
// createPager({
//   count,                   // number of items
//   pitch() => px,           // distance between items
//   spring: presets.page,
//   maxFlick: 1,             // items a release may move from where the drag began
//   onPosition(position),    // every change
// })
//
// Reading: position (raw), target (the item it is heading to, or resting on).
// Moving: goTo(i), step(±n) (from the target, so quick steps add up), set(position), stop().
// Dragging: grab(), move(dx), release(vx) → target, settle().
export function createPager({ count, pitch, spring = presets.page, maxFlick = 1, onPosition = () => {} }) {
  const last = count - 1;
  const value = createValue({ onUpdate: (position) => onPosition(position) });
  // The item the pager is heading to or resting on.
  let goal = 0;
  let origin = 0;
  let start = 0;

  function aim(raw, velocity) {
    goal = clamp(raw, 0, last);
    if (velocity !== undefined) value.velocity = velocity;
    value.precision = 0.25 / pitch();
    value.to(goal, spring);
  }

  const pager = {
    get position() {
      return value.value;
    },
    get target() {
      return goal;
    },
    // Spring to item `index`, keeping the current speed.
    goTo(index) {
      aim(clamp(index, 0, last));
    },
    // Move `delta` items on from the target, so quick presses add up.
    step(delta) {
      aim(Math.round(goal) + delta);
    },
    // Jump to a position at rest.
    set(position) {
      goal = Math.round(position);
      value.set(position);
    },
    stop() {
      value.stop();
    },
    // A press: stop where it is, picking up a stretched position as the raw one it came from.
    grab() {
      value.stop();
      start = unband(value.value, 0, last, 1);
      origin = Math.round(start);
    },
    // Follow a drag `dx` pixels from the press.
    move(dx) {
      value.velocity = 0;
      value.set(band(start - dx / pitch(), 0, last, 1));
    },
    // Let go at `vx` px/s: spring to where the flick would come to rest. Returns the target item.
    release(vx) {
      const velocity = -vx / pitch();
      const landing = Math.round(value.value + project(velocity));
      aim(clamp(landing, origin - maxFlick, origin + maxFlick), velocity);
      return pager.target;
    },
    // A press that didn't become a drag: carry on to the nearest item.
    settle() {
      aim(Math.round(value.value));
    },
  };
  return pager;
}
