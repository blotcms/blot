describe("user writes without a callback", function () {
  var client = require("models/client");
  var key = require("../key");
  var User = require("../index");

  async function expectRejection(promise, message) {
    var error;
    try {
      await promise;
    } catch (err) {
      error = err;
    }
    expect(error && error.message).toBe(message);
  }

  describe("create", function () {
    var email = "promise-create@example.com";
    var created;

    afterEach(async function () {
      await client.del(key.email(email));
      if (created) {
        await client.del(key.user(created.uid));
        await client.sRem(key.uids, created.uid);
      }
      created = null;
    });

    it("returns the user", async function () {
      created = await User.create(email, "hash", {}, {});

      expect(created.email).toBe(email);
      expect(await client.get(key.email(email))).toBe(created.uid);
      expect((await User.getById(created.uid)).email).toBe(email);
    });

    it("rejects an invalid email", async function () {
      await expectRejection(
        User.create("not an email", "hash", {}, {}),
        "Please enter a valid email"
      );
    });
  });

  describe("set, disable, enable and remove", function () {
    global.test.user();

    it("returns promises", async function () {
      var uid = this.user.uid;

      expect(await User.set(uid, { lastSession: "abc" })).toEqual([
        "lastSession",
      ]);

      await User.disable(await User.getById(uid), { lastSession: "def" });
      var disabled = await User.getById(uid);
      expect(disabled.isDisabled).toBe(true);
      expect(disabled.lastSession).toBe("def");

      await User.enable(disabled);
      expect((await User.getById(uid)).isDisabled).toBe(false);

      await expectRejection(User.set("user_nonexistent", {}), "No user");

      // The shared user is removed after each spec, so remove another one
      var other = await User.create("promise-remove@example.com", "h", {}, {});
      await User.remove(other.uid);
      expect(await User.getById(other.uid)).toBe(null);
      expect(await client.get(key.email("promise-remove@example.com"))).toBe(
        null
      );
      await expectRejection(User.remove(other.uid), "No user");
    });
  });
});
