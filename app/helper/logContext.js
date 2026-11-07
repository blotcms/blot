const { AsyncLocalStorage } = require("async_hooks");

// What a log line is about: the request (req), blog and sync it runs on behalf
// of. helper/oneLineConsole adds these to each production console line, so
// a grep of app.log for a blog or request finds lines whose code never named it.
//
//   run({ req: id }, fn)   fn and everything it starts, with these fields added
//                          to any the caller had
//   set({ blog: id })      adds fields to the current context (a no-op outside
//                          one), e.g. once a request has loaded its blog
//   fields()               the current fields, in KEYS order

const KEYS = ["req", "blog", "sync"];

const storage = new AsyncLocalStorage();

function run(fields, fn) {
  return storage.run({ ...storage.getStore(), ...fields }, fn);
}

function set(fields) {
  const store = storage.getStore();
  if (store) Object.assign(store, fields);
}

function fields() {
  const store = storage.getStore();
  if (!store) return [];
  return KEYS.filter((key) => store[key]).map((key) => [key, store[key]]);
}

module.exports = { run, set, fields };
