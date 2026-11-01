const { applyDelta, resultSize } = require("../delta");
const { CorruptError, TooLargeError } = require("../errors");

// A delta from its parts: the sizes, then instructions
const copy = (offset, length) => {
  const bytes = [];
  let op = 0x80;
  [offset & 0xff, (offset >> 8) & 0xff].forEach((b, i) => {
    if (b) {
      op |= 1 << i;
      bytes.push(b);
    }
  });
  [length & 0xff, (length >> 8) & 0xff].forEach((b, i) => {
    if (b) {
      op |= 0x10 << i;
      bytes.push(b);
    }
  });
  return [op, ...bytes];
};
const insert = (text) => [text.length, ...Buffer.from(text)];
const delta = (baseSize, size, ...instructions) => Buffer.from([baseSize, size, ...instructions.flat()]);

describe("git store delta", function () {
  const base = Buffer.from("0123456789");

  it("applies copies and inserts", function () {
    const d = delta(10, 9, copy(2, 3), insert("XY"), copy(8, 2), insert("!z"));
    expect(applyDelta(base, d).toString()).toBe("234XY89!z");
  });

  it("copies the whole base", function () {
    expect(applyDelta(base, delta(10, 10, copy(0, 10))).toString()).toBe("0123456789");
  });

  it("reads the size of what a delta produces", function () {
    expect(resultSize(delta(10, 9))).toBe(9);
    expect(resultSize(Buffer.from([0x80, 0x01, 0x85, 0x02]))).toBe(0x105);
  });

  it("copies a length of zero as 64 KiB", function () {
    const big = Buffer.alloc(0x10000, "a");
    const d = Buffer.from([0x80, 0x80, 0x04, 0x80, 0x80, 0x04, 0x80]);
    expect(applyDelta(big, d).equals(big)).toBe(true);
  });

  const bad = {
    "a different base size": () => applyDelta(base, delta(11, 3, copy(0, 3))),
    "a copy outside the base": () => applyDelta(base, delta(10, 5, copy(8, 5))),
    "a copy past the result": () => applyDelta(base, delta(10, 2, copy(0, 5))),
    "an insert past the end": () => applyDelta(base, Buffer.from([10, 5, 5, 65])),
    "a reserved instruction": () => applyDelta(base, Buffer.from([10, 1, 0])),
    "a result of the wrong size": () => applyDelta(base, delta(10, 9, copy(0, 3))),
    "a truncated header": () => applyDelta(base, Buffer.from([10])),
    "a truncated copy": () => applyDelta(base, Buffer.from([10, 3, 0x81])),
    "an endless size": () => applyDelta(base, Buffer.alloc(20, 0xff)),
  };

  for (const [name, run] of Object.entries(bad)) {
    it("rejects " + name, function () {
      expect(run).toThrowError(CorruptError);
    });
  }

  it("refuses a result bigger than the limit before making it", function () {
    expect(() => applyDelta(base, delta(10, 10, copy(0, 10)), 9)).toThrowError(TooLargeError);
    expect(() => applyDelta(base, Buffer.from([10, 0xff, 0xff, 0xff, 0x7f]), 1000)).toThrowError(TooLargeError);
  });
});
