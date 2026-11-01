// Gives the specs in a describe() longer than jasmine's five seconds, which
// real git repositories, megabytes of data and a busy CI runner can need.
// Not a spec itself. Call it inside the describe().
module.exports = function timeout(ms) {
  let original;

  beforeAll(function () {
    original = jasmine.DEFAULT_TIMEOUT_INTERVAL;
    jasmine.DEFAULT_TIMEOUT_INTERVAL = ms;
  });

  afterAll(function () {
    jasmine.DEFAULT_TIMEOUT_INTERVAL = original;
  });
};
