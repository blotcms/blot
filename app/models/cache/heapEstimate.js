// A V8-shaped estimate of what the render caches hold, beside the size their
// caps use (prepareCacheValue in ./clone), to account for node-a's heap
// (#2795): there the heap has tracked about 1.75 times the caches' summed
// calculatedSize. It only reports; nothing here changes what a cache holds.
//
// Measuring walks a value's whole graph, so it never runs on the request
// path: the stats job calls measureSome() once a minute, and it measures each
// cached value once (remembered in a WeakMap), in slices of SLICE_MS with the
// event loop free in between, up to BUDGET_MS of work a call; a value too big
// for one call carries on in the next. Values not yet measured are
// extrapolated from the measured ones' ratio to their size.
//
// What the walk counts: a string a 16-byte header plus one byte per
// character, or two once it holds a character above U+00FF (V8 then stores
// the whole string as UTF-16), which twoByteBytes adds up; an object its
// header, in-object slack and property array; an array its header and
// element store; a number that isn't a small integer a 16-byte box. Keys cost
// nothing (V8 shares them through the object's map). wideObjects counts
// objects with DICTIONARY_KEYS keys or more: built a key at a time, as
// prepareCacheValue's copies are, V8 may keep them in dictionary mode at
// ~1.6 KB each rather than ~300 bytes, which JavaScript can't see. Nor can it
// see a string sliced from a larger one, which keeps the larger one alive.

const STRING_HEADER = 16;
const OBJECT_BYTES = 56;
const ARRAY_BYTES = 48;
const SLOT_BYTES = 8;
const HEAP_NUMBER_BYTES = 16;
const DICTIONARY_KEYS = 20;
const TWO_BYTE = /[Ā-￿]/;
const NODES_PER_CHECK = 500;
const SLICE_MS = 2;
const BUDGET_MS = 100;

const tracked = new Set();
const measured = new WeakMap();
let running = false;

function track(cache) {
  tracked.add(cache);
}

// Walks one value, yielding every NODES_PER_CHECK nodes so the caller can
// stop at the end of a slice and carry on later. Shared objects count once.
function* walk(root) {
  const seen = new Set();
  const stack = [root];
  let heap = 0;
  let twoByteBytes = 0;
  let wideObjects = 0;
  let nodes = 0;

  while (stack.length) {
    const value = stack.pop();
    if (typeof value === "string") {
      const twoByte = TWO_BYTE.test(value);
      const chars = Math.ceil((value.length * (twoByte ? 2 : 1)) / 8) * 8;
      heap += STRING_HEADER + chars;
      if (twoByte) twoByteBytes += chars;
    } else if (typeof value === "number") {
      if (!(Number.isInteger(value) && Math.abs(value) < 2 ** 31))
        heap += HEAP_NUMBER_BYTES;
    } else if (value && typeof value === "object" && !seen.has(value)) {
      seen.add(value);
      const keys = Object.keys(value);
      heap += Array.isArray(value) ? ARRAY_BYTES : OBJECT_BYTES;
      heap += keys.length * SLOT_BYTES;
      if (!Array.isArray(value) && keys.length >= DICTIONARY_KEYS)
        wideObjects++;
      for (const key of keys) stack.push(value[key]);
    }
    if (++nodes % NODES_PER_CHECK === 0) yield;
  }

  return { heap, twoByteBytes, wideObjects };
}

// Render caches hold { payload, size } envelopes (./clone). Mustache's
// template cache holds bare token arrays: each one counts as one unit of
// size, so unmeasured ones are extrapolated per value instead of per byte.
function measurable(value) {
  return value !== null && typeof value === "object";
}

function payloadOf(value) {
  return typeof value.size === "number" && "payload" in value
    ? value.payload
    : value;
}

function sizeOf(value) {
  return typeof value.size === "number" && "payload" in value ? value.size : 1;
}

const nextTick = () => new Promise((resolve) => setImmediate(resolve));

// A walk cut short by the budget, resumed by the next call.
let pending = null;

// Measures values not yet measured, in slices, until the budget is spent;
// a value too big for one call's budget carries on in the next. One call at
// a time; a value evicted mid-walk is simply dropped.
async function measureSome({ budgetMs = BUDGET_MS } = {}) {
  if (running) return;
  running = true;
  try {
    let spent = 0;
    const queue = function* () {
      if (pending) yield pending;
      for (const cache of tracked)
        for (const value of [...cache.values()])
          if (measurable(value) && !measured.has(value))
            yield { value, walker: walk(payloadOf(value)) };
    };
    for (const job of queue()) {
      if (job !== pending && measured.has(job.value)) continue;
      pending = null;
      for (;;) {
        if (spent >= budgetMs) {
          pending = job;
          return;
        }
        const startedAt = performance.now();
        let step;
        do step = job.walker.next();
        while (!step.done && performance.now() - startedAt < SLICE_MS);
        spent += performance.now() - startedAt;
        if (step.done) {
          measured.set(job.value, step.value);
          break;
        }
        await nextTick();
      }
    }
  } finally {
    running = false;
  }
}

// The estimate for one cache now: measured values as measured, the rest
// scaled from the measured ones' heap per byte of size.
function estimate(cache) {
  let heap = 0;
  let twoByteBytes = 0;
  let wideObjects = 0;
  let measuredSize = 0;
  let unmeasuredSize = 0;
  for (const value of cache.values()) {
    if (!measurable(value)) continue;
    const m = measured.get(value);
    if (!m) {
      unmeasuredSize += sizeOf(value);
      continue;
    }
    heap += m.heap;
    twoByteBytes += m.twoByteBytes;
    wideObjects += m.wideObjects;
    measuredSize += sizeOf(value);
  }
  const ratio = measuredSize ? heap / measuredSize : 0;
  const total = measuredSize + unmeasuredSize;
  return {
    heapBytes: Math.round(heap + unmeasuredSize * ratio),
    twoByteBytes: Math.round(
      twoByteBytes * (measuredSize ? total / measuredSize : 0)
    ),
    wideObjects: Math.round(
      wideObjects * (measuredSize ? total / measuredSize : 0)
    ),
    measuredShare: total ? measuredSize / total : 1,
  };
}

module.exports = { track, measureSome, estimate, walk };
