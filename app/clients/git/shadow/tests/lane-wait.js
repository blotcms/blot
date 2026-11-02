// Shadow mode's figures are compared with EBS's, so the time its git spends
// waiting for a place in the git limiter's background lane is logged as
// waitMs and left out of storeMs, receiveMs and commitMs (counting.js).
describe("git store shadow mode: waits for the git limiter", function () {
  var setup = require("./setup");
  var shadow = require("clients/git/shadow");
  var limiter = require("clients/git/limiter");
  var counting = require("clients/git/shadow/counting");
  var { createMemoryStore } = require("clients/git/store");

  var HOLD = 3000;

  function sleep(ms) {
    return new Promise(function (resolve) {
      setTimeout(resolve, ms);
    });
  }

  // Holds the background lane for ms, outside any place the caller holds
  function holdLane(ms) {
    return limiter.outside(function () {
      return limiter.run("background", function () {
        return sleep(ms);
      });
    });
  }

  describe("the lane clock", function () {
    var caps;

    beforeEach(function () {
      caps = limiter.stats();
      limiter.reset({ background: 1 });
    });

    afterEach(function () {
      limiter.reset({ background: caps.background.max });
    });

    it("records a wait as waitMs and leaves it out of ms and a stopwatch", async function () {
      var held = holdLane(1000);

      var measured = await counting.measure(async function () {
        var elapsed = counting.stopwatch();
        // Two commands waiting at once count once
        var ran = await Promise.all([shadow.gate(() => sleep(50)), shadow.gate(() => sleep(50))]);
        expect(ran.length).toBe(2);
        return elapsed();
      });

      await held;

      expect(measured.counts.waitMs).toBeGreaterThanOrEqual(900);
      expect(measured.counts.waitMs).toBeLessThan(1500);
      expect(measured.result).toBeLessThan(500);
      expect(measured.ms).toBeLessThan(500);
    });
  });

  describe("a mirrored push", function () {
    var caps;
    var trap = null;

    // A memory store which calls trap(key) for each key read
    setup({
      objectStore: function (blogID) {
        var store = (this.stores[blogID] = this.stores[blogID] || createMemoryStore());
        var watched = Object.assign({}, store, { id: store.id });

        ["head", "read", "get", "stream"].forEach(function (name) {
          watched[name] = function (key) {
            if (trap) trap(key);
            return store[name].apply(store, arguments);
          };
        });

        return watched;
      },
    });

    beforeEach(function () {
      caps = limiter.stats();
      trap = null;
    });

    afterEach(function () {
      trap = null;
      limiter.reset({ background: caps.background.max });
    });

    it("logs the time receive waited for the lane as waitMs, not in receiveMs or storeMs", async function () {
      await this.local.writeAndPush("/a.txt", "A");
      await setup.expectMirrored(this);

      // A cold cache, so receive has to read the store's packs
      require("config").git_store.cache_directory = this.tmp + "/git-store-cache-cold";
      shadow._reset();

      limiter.reset({ background: 1 });

      // The first read of a pack is receive's, once it has the whole pack and
      // before its first git command: the lane is taken then, for HOLD ms, so
      // receive's git waits that long inside receiveMs's window
      var held = null;
      trap = function (key) {
        if (!held && /packs\//.test(key)) held = holdLane(HOLD);
      };

      await this.local.writeAndPush("/b.txt", "B");
      await shadow.idle(this.blog.id);

      expect(held).not.toBe(null);
      await held;

      var line = this.shadowLines("push").pop();
      expect(line).toContain("outcome=ok");

      var field = function (name) {
        return Number(new RegExp(" " + name + "=(\\d+)").exec(line)[1]);
      };

      expect(field("waitMs")).toBeGreaterThanOrEqual(HOLD - 1000);
      expect(field("receiveMs")).toBeLessThan(field("waitMs"));
      expect(field("storeMs")).toBeLessThan(field("waitMs"));
    });
  });
});
