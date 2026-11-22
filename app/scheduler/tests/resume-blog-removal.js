describe("scheduler resume-blog-removal", function () {
  const resume = require("../resume-blog-removal");
  const Blog = require("models/blog");
  const client = require("models/client");
  const discover = require("models/discover");
  const redisSearch = require("helper/redisSearch");

  const MINUTE = 60 * 1000;

  global.test.user();

  beforeEach(async function () {
    this.blog = await Blog.create(this.user.uid, { handle: "resumeblog" });
    spyOn(console, "log");
    spyOn(console, "error");

    // The kill: removal stops after the owner's list is updated
    this.kill = spyOn(discover, "removeBlog").and.callFake(() =>
      Promise.reject(new Error("killed"))
    );
    await expectAsync(Blog.remove(this.blog.id)).toBeRejected();
    this.kill.and.callThrough();
  });

  // An interrupted removal keeps the handle claimed, so finish it or the
  // next spec can't create its blog
  afterEach(async function () {
    this.kill.and.callThrough();
    await Blog.remove(this.blog.id).catch(() => {});
    await client.zRem(Blog.key.removing, this.blog.id);
    await client.hDel(Blog.key.removalAttempts, this.blog.id);
  });

  it("finishes a removal a kill interrupted, once it is overdue", async function () {
    const result = await resume({ now: Date.now() + 11 * MINUTE });

    expect(result.resumed).toEqual([this.blog.id]);
    expect(await Blog.get({ id: this.blog.id })).toBeUndefined();
    expect(await client.zScore(Blog.key.removing, this.blog.id)).toBeNull();
    expect(await redisSearch(this.blog.id)).toEqual([]);
  });

  it("leaves a removal alone while it may still be running", async function () {
    const result = await resume({ now: Date.now() + MINUTE });

    expect(result).toEqual({ resumed: [], failed: [], gaveUp: [], billed: [] });
    expect(await Blog.get({ id: this.blog.id })).toBeDefined();
  });

  it("waits longer after each failed attempt and gives up after too many", async function () {
    this.kill.and.callFake(() => Promise.reject(new Error("still failing")));

    let now = Date.now() + 11 * MINUTE;
    let result = await resume({ now });

    expect(result.failed).toEqual([this.blog.id]);

    // Not due again straight away
    expect(await resume({ now: now + MINUTE })).toEqual({
      resumed: [],
      failed: [],
      gaveUp: [],
      billed: [],
    });

    await client.hSet(
      Blog.key.removalAttempts,
      this.blog.id,
      String(resume.MAX_ATTEMPTS)
    );

    now += 2 * 24 * 60 * MINUTE;
    this.kill.calls.reset();
    result = await resume({ now });

    expect(result.gaveUp).toEqual([this.blog.id]);
    expect(this.kill).not.toHaveBeenCalled();
    expect(
      await client.zScore(Blog.key.removing, this.blog.id)
    ).toBeGreaterThan(now);
  });

  describe("the owner's subscription", function () {
    const User = require("models/user");
    const email = require("helper/email");
    const removalBilling = require("models/blog/removalBilling");
    const decreaseSubscription = require("helper/decreaseSubscription");
    const stripe = decreaseSubscription.stripe;

    const subscription = (overrides = {}) => ({
      id: "sub_test",
      customer: "cus_test",
      status: "active",
      quantity: 2,
      plan: { amount: 500, interval: "month" },
      ...overrides,
    });

    beforeEach(async function () {
      // The owner has one site left and pays for two
      await Blog.create(this.user.uid, { handle: "resumeblogtwo" });
      await User.set(this.user.uid, { subscription: subscription() });
      await removalBilling.record(this.blog.id, this.user.uid);

      this.original = stripe.customers.updateSubscription;
      this.update = jasmine
        .createSpy("updateSubscription")
        .and.callFake(async (customer, id, change) =>
          subscription({ quantity: change.quantity })
        );
      stripe.customers.updateSubscription = this.update;
      spyOn(email, "SUBSCRIPTION_DECREASE").and.returnValue(Promise.resolve());
      this.alert = spyOn(email, "BLOG_REMOVAL_ALERT").and.returnValue(
        Promise.resolve()
      );
      this.later = { now: Date.now() + 11 * MINUTE };
    });

    afterEach(async function () {
      stripe.customers.updateSubscription = this.original;
      await removalBilling.clear(this.blog.id);
      await client.del("notify:blog-removal:billing:" + this.blog.id);
    });

    it("is reduced to the number of sites once an interrupted delete is finished", async function () {
      const result = await resume(this.later);

      expect(result.billed).toEqual([this.blog.id]);
      expect(this.update).toHaveBeenCalledTimes(1);
      expect(this.update).toHaveBeenCalledWith("cus_test", "sub_test", {
        quantity: 1,
        prorate: false,
      });
      expect((await User.getById(this.user.uid)).subscription.quantity).toBe(1);
      expect(await removalBilling.pending()).toEqual([]);
      expect(this.alert).not.toHaveBeenCalled();
    });

    it("is not reduced twice", async function () {
      await decreaseSubscription(this.user.uid);
      await decreaseSubscription(this.user.uid);
      await resume(this.later);

      expect(this.update).toHaveBeenCalledTimes(1);
      expect(await removalBilling.pending()).toEqual([]);
    });

    it("waits while the delete route may still be running", async function () {
      expect((await resume({ now: Date.now() + MINUTE })).billed).toEqual([]);
      expect(this.update).not.toHaveBeenCalled();
      expect((await removalBilling.pending()).length).toBe(1);
    });

    it("is not reduced for a cancelled subscription or a deleted account", async function () {
      await User.set(this.user.uid, {
        subscription: subscription({ status: "canceled" }),
      });
      await resume(this.later);

      expect(this.update).not.toHaveBeenCalled();
      expect(await removalBilling.pending()).toEqual([]);

      await removalBilling.record(this.blog.id, "user_gone");
      await resume(this.later);

      expect(this.update).not.toHaveBeenCalled();
      expect(await removalBilling.pending()).toEqual([]);
    });

    it("is not tried for an account that is being deleted", async function () {
      await removalBilling.clearForUser(this.user.uid);
      await resume(this.later);

      expect(this.update).not.toHaveBeenCalled();
    });

    it("emails the maintainer, once, when the reduction fails, and tries again", async function () {
      this.update.and.callFake(() =>
        Promise.reject(new Error("Stripe is down"))
      );

      const first = await resume(this.later);
      await resume({ now: this.later.now + 20 * MINUTE });

      expect(first.billed).toEqual([]);
      expect(this.alert).toHaveBeenCalledTimes(1);
      expect(this.alert.calls.argsFor(0)[1].summary).toContain(this.user.uid);
      expect(this.update).toHaveBeenCalledTimes(2);
      expect((await removalBilling.pending()).length).toBe(1);

      this.update.and.callFake(async (customer, id, change) =>
        subscription({ quantity: change.quantity })
      );
      expect((await resume(this.later)).billed).toEqual([this.blog.id]);
    });

    it("emails the maintainer when it gives up on a blog", async function () {
      await client.hSet(
        Blog.key.removalAttempts,
        this.blog.id,
        String(resume.MAX_ATTEMPTS)
      );
      await client.zAdd(Blog.key.removing, {
        score: 1,
        value: this.blog.id,
      });

      const result = await resume(this.later);
      await client.del("notify:blog-removal:" + this.blog.id);

      expect(result.gaveUp).toEqual([this.blog.id]);
      expect(this.alert).toHaveBeenCalledTimes(1);
    });
  });
});
