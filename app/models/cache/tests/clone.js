const Entry = require("models/entry/instance");
const {
  cloneDeep,
  prepareCacheValue,
  emptyCopy,
} = require("models/cache/clone");

function fields(n) {
  return Object.fromEntries(Array.from({ length: n }, (_, i) => ["f" + i, i]));
}

describe("cache copies", function () {
  it("keeps an Entry an Entry, with the same keys and values", function () {
    const entry = new Entry({ ...fields(30), title: "T", tags: ["a"] });
    const copy = emptyCopy(entry, true);

    expect(copy instanceof Entry).toBe(true);
    expect(Object.keys(copy)).toEqual(Object.keys(entry));
    expect(copy.title).toBe("T");
    expect(copy).not.toBe(entry);
  });

  it("makes a plain object when entries aren't preserved", function () {
    const copy = emptyCopy(new Entry(fields(5)), false);

    expect(copy instanceof Entry).toBe(false);
    expect(Object.keys(copy)).toEqual(Object.keys(fields(5)));
  });

  it("leaves symbol keys out, as Object.keys does", function () {
    const value = { a: 1, [Symbol("s")]: 2 };
    const copy = emptyCopy(value, false);

    expect(Object.getOwnPropertySymbols(copy).length).toBe(0);
    expect(Object.keys(copy)).toEqual([]);
  });

  it("treats a __proto__ key as data, not a prototype", function () {
    const value = JSON.parse('{"__proto__": {"x": 1}, "a": 1}');
    const copy = emptyCopy(value, false);

    expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
    expect(Object.keys(copy)).toEqual(["__proto__", "a"]);
  });

  it("copies deeply through prepareCacheValue and cloneDeep with the same shape", function () {
    const list = [new Entry({ ...fields(30), nested: { deep: [1, 2] } })];
    const prepared = prepareCacheValue(list, { preserveEntryInstances: true });
    const hit = cloneDeep(prepared.payload, { preserveEntryInstances: true });

    for (const copy of [prepared.payload[0], hit[0]]) {
      expect(copy instanceof Entry).toBe(true);
      expect(Object.keys(copy)).toEqual(Object.keys(list[0]));
      expect(copy.nested).toEqual({ deep: [1, 2] });
      expect(copy.nested).not.toBe(list[0].nested);
    }
    expect(Object.isFrozen(prepared.payload[0])).toBe(true);
    expect(Object.isFrozen(hit[0])).toBe(false);
    hit[0].f0 = "changed";
    expect(prepared.payload[0].f0).toBe(0);
  });
});

describe("Entry", function () {
  it("builds from init with the same own keys, and stays an Entry", function () {
    const init = JSON.parse(JSON.stringify(fields(30)));
    const entry = new Entry(init);

    expect(entry instanceof Entry).toBe(true);
    expect(Object.keys(entry)).toEqual(Object.keys(init));
    expect(entry).not.toBe(init);
  });

  it("is empty without init", function () {
    const entry = new Entry();

    expect(entry instanceof Entry).toBe(true);
    expect(Object.keys(entry)).toEqual([]);
  });
});
