// TEMPORARY (#2559): remove once phase 3 is finished and the open long-lived
// branches have merged. A callback passed to a promise-only function would hang.
module.exports = function promiseOnly(fn) {
  const name = fn.name || "anonymous";

  return function (...args) {
    if (typeof args[args.length - 1] === "function") {
      throw new TypeError(
        name + " no longer takes a callback; await it instead (#2559)"
      );
    }

    return fn.apply(this, args);
  };
};
