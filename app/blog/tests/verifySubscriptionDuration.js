const { promisify } = require("util");
const User = require("models/user");

const setUser = promisify(User.set);

describe("verify-subscription-duration", function () {
  require("./util/setup")();

  it("returns the subscription duration in ms for a paying user", async function () {
    const startedAt = Date.now() - 1000 * 60 * 60 * 24 * 30; // 30 days ago

    await setUser(this.user.uid, {
      subscription: { customer: "cus_123", created: startedAt / 1000 },
    });

    const res = await this.get("/verify/subscription-duration");
    const body = await res.json();

    expect(res.status).toEqual(200);
    expect(body.duration).toBeGreaterThan(0);
    // Roughly 30 days, allowing generous slack for test runtime.
    expect(body.duration).toBeGreaterThan(1000 * 60 * 60 * 24 * 29);
  });

  it("returns 404 when the blog's owner has no subscription", async function () {
    const res = await this.get("/verify/subscription-duration");

    expect(res.status).toEqual(404);
  });

  it("returns 404 when the blog has no owner", async function () {
    // Simulate an orphaned blog by pointing owner at a uid that doesn't exist.
    await this.blog.update({ owner: "does-not-exist" });

    const res = await this.get("/verify/subscription-duration");

    expect(res.status).toEqual(404);
  });
});
