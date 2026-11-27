// Returns run(task): starts task() once fewer than `limit` earlier tasks are
// still running, and resolves or rejects with what task() does. Tasks start
// in the order they were queued.
module.exports = function createLimiter(limit) {
  let running = 0;
  const waiting = [];

  const next = () => {
    while (running < limit && waiting.length) {
      const { task, resolve, reject } = waiting.shift();
      running += 1;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          next();
        });
    }
  };

  return (task) =>
    new Promise((resolve, reject) => {
      waiting.push({ task, resolve, reject });
      next();
    });
};
