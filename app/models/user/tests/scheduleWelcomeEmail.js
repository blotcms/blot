describe("user", function () {
  global.test.user();

  var User = require("models/user");
  var client = require("models/client");
  var key = require("models/user/key");

  var email = require("helper/email");
  var scheduleWelcomeEmail = require("models/user/scheduleWelcomeEmail");
  var alarms = scheduleWelcomeEmail.alarm;
  var DELAY = scheduleWelcomeEmail.WELCOME_EMAIL_DELAY_MS;

  function setUser(uid, updates) {
    return new Promise(function (resolve, reject) {
      User.set(uid, updates, function (err) {
        err ? reject(err) : resolve();
      });
    });
  }

  function schedule(uid) {
    return new Promise(function (resolve, reject) {
      User.scheduleWelcomeEmail(uid, function (err) {
        err ? reject(err) : resolve();
      });
    });
  }

  function getUser(uid) {
    return new Promise(function (resolve, reject) {
      User.getById(uid, function (err, user) {
        err ? reject(err) : resolve(user);
      });
    });
  }

  function sentKey(uid) {
    return scheduleWelcomeEmail.sendingKey(uid);
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  beforeEach(function () {
    this.sends = [];
    spyOn(email, "WELCOME").and.callFake(
      function (uid, locals, callback) {
        this.sends.push(uid);
        setTimeout(callback, 10);
      }.bind(this)
    );
  });

  afterEach(async function () {
    await alarms.cancel(this.user.uid);
    await client.del(sentKey(this.user.uid));
  });

  it("sets an alarm for two hours after the user was created", async function () {
    var uid = this.user.uid;
    var created = Date.now() - 60 * 1000;

    await setUser(uid, { created: created, welcomeEmailSent: false });
    await schedule(uid);

    expect(await alarms.when(uid)).toBe(created + DELAY);
    expect(this.sends).toEqual([]);
  });

  it("cancels the alarm when the email was already sent", async function () {
    var uid = this.user.uid;

    await setUser(uid, { created: Date.now(), welcomeEmailSent: false });
    await schedule(uid);
    expect(await alarms.when(uid)).not.toBe(null);

    await setUser(uid, { welcomeEmailSent: true });
    await schedule(uid);

    expect(await alarms.when(uid)).toBe(null);
  });

  it("sends once when the handler runs twice at the same time; the loser throws", async function () {
    var uid = this.user.uid;

    await setUser(uid, { welcomeEmailSent: false });
    var results = await Promise.allSettled([
      scheduleWelcomeEmail.handler(uid),
      scheduleWelcomeEmail.handler(uid),
    ]);

    expect(this.sends).toEqual([uid]);
    expect(results.filter((r) => r.status === "rejected").length).toBe(1);
    expect((await getUser(uid)).welcomeEmailSent).toBe(true);
  });

  it("is blocked by a stale sending claim only until it expires", async function () {
    var uid = this.user.uid;

    await setUser(uid, { welcomeEmailSent: false });
    // A claim left by a process that died mid-send
    await client.set(sentKey(uid), "1", { PX: 150 });

    var failed = false;
    try {
      await scheduleWelcomeEmail.handler(uid);
    } catch (err) {
      failed = true;
    }
    expect(failed).toBe(true);
    expect(this.sends).toEqual([]);

    await sleep(250);
    await scheduleWelcomeEmail.handler(uid);

    expect(this.sends).toEqual([uid]);
    expect((await getUser(uid)).welcomeEmailSent).toBe(true);
  });

  describe("reconcile", function () {
    it("sets an alarm for a recent user without one", async function () {
      var uid = this.user.uid;

      await setUser(uid, { created: Date.now() - 1000, welcomeEmailSent: false });
      await alarms.cancel(uid);

      await scheduleWelcomeEmail.reconcile({ days: 7 });

      expect(await alarms.when(uid)).not.toBe(null);
    });

    it("sets nothing for a user who was already sent the email", async function () {
      var uid = this.user.uid;

      await setUser(uid, { created: Date.now() - 1000, welcomeEmailSent: true });
      await alarms.cancel(uid);

      await scheduleWelcomeEmail.reconcile({ days: 7 });

      expect(await alarms.when(uid)).toBe(null);
    });

    it("sets nothing for a user older than the window", async function () {
      var uid = this.user.uid;

      await setUser(uid, {
        created: Date.now() - 10 * 24 * 60 * 60 * 1000,
        welcomeEmailSent: false,
      });
      await alarms.cancel(uid);

      await scheduleWelcomeEmail.reconcile({ days: 7 });

      expect(await alarms.when(uid)).toBe(null);
    });
  });

  it("skips users who were already sent the email", async function () {
    var uid = this.user.uid;

    await setUser(uid, { welcomeEmailSent: true });
    await scheduleWelcomeEmail.handler(uid);

    expect(this.sends).toEqual([]);
  });

  it("skips users who no longer exist", async function () {
    await scheduleWelcomeEmail.handler("user_that_does_not_exist");

    expect(this.sends).toEqual([]);
  });

  it("clears its claim when the send fails so a retry sends", async function () {
    var uid = this.user.uid;
    var sends = this.sends;

    await setUser(uid, { welcomeEmailSent: false });

    email.WELCOME.and.callFake(function (uid, locals, callback) {
      callback(new Error("mail is down"));
    });

    var failed = false;
    try {
      await scheduleWelcomeEmail.handler(uid);
    } catch (err) {
      failed = true;
    }

    expect(failed).toBe(true);
    expect(await client.exists(sentKey(uid))).toBe(0);
    expect((await getUser(uid)).welcomeEmailSent).toBe(false);

    email.WELCOME.and.callFake(function (uid, locals, callback) {
      sends.push(uid);
      callback();
    });

    await scheduleWelcomeEmail.handler(uid);

    expect(sends).toEqual([uid]);
    expect((await getUser(uid)).welcomeEmailSent).toBe(true);
  });

  it("sends an overdue email when the alarm is polled", async function () {
    var uid = this.user.uid;

    await setUser(uid, {
      created: Date.now() - 3 * 60 * 60 * 1000,
      welcomeEmailSent: false,
    });
    await schedule(uid);
    await alarms.poll();

    expect(this.sends).toContain(uid);
    expect((await getUser(uid)).welcomeEmailSent).toBe(true);
    expect(await alarms.when(uid)).toBe(null);
  });

  it("defaults missing fields when loading legacy users", function (done) {
    var uid = this.user.uid;

    (async function () {
      try {
        var original = await client.get(key.user(uid));

        await client.set(
          key.user(uid),
          JSON.stringify({ uid: uid, email: "legacy@example.com" })
        );

        User.getById(uid, function (err, user) {
          if (err) return done.fail(err);

          expect(user.created).toBe(0);
          expect(user.welcomeEmailSent).toBe(true);

          (async function () {
            try {
              await client.set(key.user(uid), original);
              done();
            } catch (restoreErr) {
              done.fail(restoreErr);
            }
          })();
        });
      } catch (err) {
        done.fail(err);
      }
    })();
  });
});
