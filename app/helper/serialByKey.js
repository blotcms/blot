// Returns run(key, fn), which calls the async fn once every earlier call with
// the same key has settled, so calls that share a key run one at a time, in
// the order they were made. Calls with different keys don't wait for each
// other. Resolves or rejects as fn does; a rejection doesn't hold up the next
// call. The queue lives in this process only: it is not a lock between
// processes (helper/lock and sync/lock are).
//
// fn must not call run with its own key, directly or through anything it
// awaits: it would wait for itself forever.
module.exports = function serialByKey() {
  // key -> a promise which settles when the last call queued for it has
  const tails = new Map();

  return function run(key, fn) {
    const previous = tails.get(key) || Promise.resolve();
    const result = previous.then(() => fn());
    const tail = result.then(
      () => {},
      () => {}
    );

    tails.set(key, tail);

    // Forget the key once nothing is queued behind this call, so the map
    // only holds keys with work in progress
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });

    return result;
  };
};
