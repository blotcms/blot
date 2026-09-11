var client = require("models/client");
var key = require("../key");
var set = require("../set");
var getById = require("../getById");
var promisify = require("util").promisify;
var save = promisify(set);
var get = promisify(getById);

describe("atomic user updates", function () {
  var uid = "atomic-user-test";
  var otherUid = "atomic-other-user-test";
  var oldEmail = "atomic-old@example.com";
  var newEmail = "atomic-new@example.com";
  var otherEmail = "atomic-other@example.com";

  function user(id, email) {
    return {
      uid: id, email: email, blogs: [], isDisabled: false,
      lastSession: "", created: 0, welcomeEmailSent: true,
      passwordHash: "initial-password", subscription: {}, paypal: {},
    };
  }

  beforeEach(async function () {
    await client.set(key.user(uid), JSON.stringify(user(uid, oldEmail)));
    await client.set(key.email(oldEmail), uid);
    await client.set(key.user(otherUid), JSON.stringify(user(otherUid, otherEmail)));
    await client.set(key.email(otherEmail), otherUid);
  });

  afterEach(async function () {
    await client.del([
      key.user(uid), key.user(otherUid), key.email(oldEmail),
      key.email(newEmail), key.email(otherEmail),
      key.customer("atomic-old"), key.customer("atomic-new"),
      key.paypal("atomic-old"), key.paypal("atomic-new"),
    ]);
  });

  it("preserves password and subscription updates that read the same version", async function () {
    var original = client.get.bind(client);
    var reads = [];
    spyOn(client, "get").and.callFake(async function (name) {
      var value = await original(name);
      if (name !== key.user(uid) || reads.length >= 2) return value;
      return new Promise(function (resolve) {
        reads.push(function () { resolve(value); });
        if (reads.length === 2) reads.forEach(function (release) { release(); });
      });
    });

    await Promise.all([
      save(uid, { passwordHash: "new-password" }),
      save(uid, { subscription: { customer: "atomic-new" } }),
    ]);
    var saved = await get(uid);
    expect(saved.passwordHash).toEqual("new-password");
    expect(saved.subscription.customer).toEqual("atomic-new");
    expect(await client.get(key.customer("atomic-new"))).toEqual(uid);
  });

  it("rejects an email claimed after validation without writing the user", async function () {
    var original = client.eval.bind(client);
    var calls = [];
    spyOn(client, "eval").and.callFake(function (script, options) {
      return new Promise(function (resolve, reject) {
        calls.push(function () { original(script, options).then(resolve, reject); });
        if (calls.length === 2) calls.forEach(function (release) { release(); });
      });
    });
    var results = await Promise.all([
      save(uid, { email: newEmail }).then(() => null, err => err),
      save(otherUid, { email: newEmail }).then(() => null, err => err),
    ]);
    expect(results.filter(result => result === null).length).toEqual(1);
    expect(results.filter(result => result && result.code === "EEXISTS").length).toEqual(1);
    var owner = await client.get(key.email(newEmail));
    expect((await get(owner)).email).toEqual(newEmail);
    var loser = owner === uid ? otherUid : uid;
    var originalEmail = loser === uid ? oldEmail : otherEmail;
    expect((await get(loser)).email).toEqual(originalEmail);
    expect(await client.get(key.email(originalEmail))).toEqual(loser);
  });

  it("removes former subscription indexes and keeps the new ones", async function () {
    await save(uid, { subscription: { customer: "atomic-old" }, paypal: { id: "atomic-old" } });
    await save(uid, { subscription: { customer: "atomic-new" }, paypal: { id: "atomic-new" } });
    expect(await client.get(key.customer("atomic-old"))).toBeNull();
    expect(await client.get(key.paypal("atomic-old"))).toBeNull();
    expect(await client.get(key.customer("atomic-new"))).toEqual(uid);
    expect(await client.get(key.paypal("atomic-new"))).toEqual(uid);
    await save(uid, { subscription: {}, paypal: {} });
    expect(await client.get(key.customer("atomic-new"))).toBeNull();
    expect(await client.get(key.paypal("atomic-new"))).toBeNull();
  });

  it("does not remove a former index owned by another user", async function () {
    await client.set(key.email(oldEmail), otherUid);
    await save(uid, { email: newEmail });
    expect(await client.get(key.email(oldEmail))).toEqual(otherUid);
  });

  it("stops retrying under sustained contention", async function () {
    spyOn(client, "eval").and.returnValue(Promise.resolve(0));
    var error = await save(uid, { passwordHash: "changed" }).then(() => null, err => err);
    expect(error.code).toEqual("EAGAIN");
    expect(client.eval.calls.count()).toEqual(20);
    expect((await get(uid)).passwordHash).toEqual("initial-password");
  });

  it("does not recreate a user deleted before commit", async function () {
    var original = client.eval.bind(client);
    spyOn(client, "eval").and.callFake(async function (script, options) {
      await client.del(key.user(uid));
      return original(script, options);
    });
    var error = await save(uid, { passwordHash: "changed" }).then(() => null, err => err);
    expect(error.message).toEqual("No user");
    expect(await client.get(key.user(uid))).toBeNull();
  });
});
