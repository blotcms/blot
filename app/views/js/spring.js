// A critically damped spring that settles in about `seconds`, on rAF. The
// value keeps its velocity when retargeted, so a movement never jolts. Used
// by the video thumbnail (home-video.js) and the questions (home-faq.js).
module.exports = function springValue(value, onUpdate) {
  let velocity = 0;
  let frame = null;
  onUpdate(value);

  return {
    get value() {
      return value;
    },
    set(next) {
      cancelAnimationFrame(frame);
      value = next;
      velocity = 0;
      onUpdate(value);
    },
    to(target, seconds, done) {
      const omega = (2 * Math.PI) / (1.2 * seconds);
      let last = performance.now();
      cancelAnimationFrame(frame);
      const tick = (now) => {
        // Small steps keep the integration stable after a dropped frame
        const dt = Math.min(0.064, (now - last) / 1000);
        last = now;
        const force = -omega * omega * (value - target) - 2 * omega * velocity;
        velocity += force * dt;
        value += velocity * dt;
        if (Math.abs(value - target) < 0.1 && Math.abs(velocity) < 1) {
          value = target;
          velocity = 0;
          onUpdate(value);
          if (done) done();
          return;
        }
        onUpdate(value);
        frame = requestAnimationFrame(tick);
      };
      frame = requestAnimationFrame(tick);
    },
    stop() {
      cancelAnimationFrame(frame);
    },
  };
};
