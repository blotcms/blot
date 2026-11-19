// Copied from the pattern library's assets/motion/drag.js with its imports removed: the modules are inlined into script.js.

// Pointer drags with a start threshold, an axis decided on the first movement, pointer capture,
// release velocity, and no click after a drag.
//
// drag(element, {
//   threshold: 8,                       // pixels before a press becomes a drag
//   // Horizontal drags only: a press that moves mostly vertically is released as a tap.
//   canStart(event) => boolean,         // checked on pointerdown
//   onPress(event) => caught,           // return true when the press caught something moving: the
//                                       // click that follows a press without a drag is swallowed
//   onStart({ axis, event }), onMove({ dx, dy, axis, event }),
//   onEnd({ dx, dy, axis, velocity: { x, y }, cancelled, event }),  // velocity in px/s
//   onRelease({ event, cancelled, caught }),  // a press that ended without becoming a drag (a tap,
//                                       // or a drag along an axis the helper refused); before click
// })
// Returns { active }: true from pointerdown until release.
export function drag(element, { threshold = 8, canStart = () => true, onPress, onStart, onMove, onEnd, onRelease } = {}) {
  const tracker = velocityTracker();
  let state = null;
  let suppressClick = false;

  const chooseAxis = (dx, dy) => (Math.abs(dx) >= Math.abs(dy) ? "x" : null);

  function down(event) {
    if (state || event.button !== 0 || !canStart(event)) return;
    // Stop mouse drags from starting a native image drag or a text selection.
    if (event.pointerType === "mouse") event.preventDefault();
    state = { id: event.pointerId, x: event.clientX, y: event.clientY, axis: null, caught: false };
    suppressClick = false;
    tracker.reset();
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
    state.caught = onPress?.(event) === true;
  }

  function move(event) {
    if (event.pointerId !== state?.id) return;
    const dx = event.clientX - state.x;
    const dy = event.clientY - state.y;
    if (!state.axis) {
      if (Math.hypot(dx, dy) < threshold) return;
      state.axis = chooseAxis(dx, dy);
      if (!state.axis) {
        const { caught } = state;
        finish();
        onRelease?.({ event, cancelled: false, caught });
        return;
      }
      try {
        element.setPointerCapture(event.pointerId);
      } catch {
        // The pointer may already be gone; the drag still works without capture.
      }
      onStart?.({ axis: state.axis, event });
    }
    tracker.add(event);
    onMove?.({ dx, dy, axis: state.axis, event });
  }

  function up(event) {
    if (event.pointerId !== state?.id) return;
    const { axis: chosen, x, y, caught } = state;
    finish();
    if (chosen || caught) {
      suppressClick = true;
      setTimeout(() => (suppressClick = false));
    }
    if (!chosen) {
      onRelease?.({ event, cancelled: event.type === "pointercancel", caught });
      return;
    }
    const cancelled = event.type === "pointercancel";
    const velocity = cancelled ? { x: 0, y: 0 } : tracker.velocity(event.timeStamp);
    onEnd?.({ dx: event.clientX - x, dy: event.clientY - y, axis: chosen, velocity, cancelled, event });
  }

  function finish() {
    state = null;
    removeEventListener("pointermove", move);
    removeEventListener("pointerup", up);
    removeEventListener("pointercancel", up);
  }

  function click(event) {
    if (!suppressClick) return;
    suppressClick = false;
    event.preventDefault();
    event.stopImmediatePropagation();
  }

  const dragstart = (event) => event.preventDefault();
  element.addEventListener("pointerdown", down);
  element.addEventListener("click", click, true);
  element.addEventListener("dragstart", dragstart);

  return {
    get active() {
      return Boolean(state);
    },
  };
}
