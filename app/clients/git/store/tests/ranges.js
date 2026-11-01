const { readRanges, plan } = require("../ranges");
const createMemoryStore = require("../objectStore/memory");

describe("git store ranged reads", function () {
  describe("plan", function () {
    it("merges ranges which are close together", function () {
      const reads = plan([{ offset: 0, length: 10 }, { offset: 15, length: 10 }], { maxGap: 10 });
      expect(reads.length).toBe(1);
      expect([reads[0].offset, reads[0].end]).toEqual([0, 25]);
    });

    it("keeps ranges which are far apart separate", function () {
      const reads = plan([{ offset: 0, length: 10 }, { offset: 100, length: 10 }], { maxGap: 10 });
      expect(reads.length).toBe(2);
    });

    it("merges overlapping and nested ranges, in any order", function () {
      const reads = plan(
        [{ offset: 50, length: 5 }, { offset: 0, length: 100 }, { offset: 20, length: 10 }],
        { maxGap: 0 }
      );
      expect(reads.length).toBe(1);
      expect([reads[0].offset, reads[0].end]).toEqual([0, 100]);
    });

    it("does not make a read longer than maxRead", function () {
      const ranges = [];
      for (let i = 0; i < 10; i++) ranges.push({ offset: i * 100, length: 100 });
      const reads = plan(ranges, { maxGap: 0, maxRead: 300 });
      expect(reads.map((r) => r.end - r.offset)).toEqual([300, 300, 300, 100]);
    });

    it("leaves out empty ranges", function () {
      expect(plan([{ offset: 5, length: 0 }])).toEqual([]);
    });
  });

  describe("readRanges", function () {
    let store;

    beforeEach(async function () {
      store = createMemoryStore();
      await store.put("k", Buffer.from("abcdefghijklmnopqrstuvwxyz"));
    });

    it("returns each range in the order asked", async function () {
      const got = await readRanges(store, "k", [
        { offset: 20, length: 3 },
        { offset: 0, length: 2 },
        { offset: 10, length: 1 },
      ]);
      expect(got.map(String)).toEqual(["uvw", "ab", "k"]);
    });

    it("reads nearby ranges in one round trip", async function () {
      await readRanges(store, "k", [{ offset: 0, length: 2 }, { offset: 4, length: 2 }, { offset: 8, length: 2 }]);
      expect(store.stats.reads).toBe(1);
    });

    it("reads distant ranges separately", async function () {
      await readRanges(store, "k", [{ offset: 0, length: 2 }, { offset: 20, length: 2 }], { maxGap: 5 });
      expect(store.stats.reads).toBe(2);
    });

    it("returns short or empty buffers past the end of the object", async function () {
      const got = await readRanges(store, "k", [{ offset: 24, length: 10 }, { offset: 100, length: 2 }, { offset: 3, length: 0 }], { maxGap: 0 });
      expect(got.map(String)).toEqual(["yz", "", ""]);
    });

    it("runs reads in parallel, up to the limit", async function () {
      let active = 0;
      let peak = 0;
      const slow = {
        read: async (key, offset, length) => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 10));
          active--;
          return store.read(key, offset, length);
        },
      };

      const ranges = [];
      for (let i = 0; i < 12; i++) ranges.push({ offset: i * 2, length: 1 });
      const got = await readRanges(slow, "k", ranges, { maxGap: 0, concurrency: 3 });

      expect(peak).toBe(3);
      expect(got.map(String).join("")).toBe("acegikmoqsuw");
    });

    it("fails if a read fails", async function () {
      let error;
      await readRanges(store, "missing", [{ offset: 0, length: 1 }]).catch((err) => (error = err));
      expect(error).toBeDefined();
    });
  });
});
