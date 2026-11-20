// Returns run(size, task): starts task() once fewer than maxConcurrent
// earlier tasks are running and the sizes of those running leave room for
// this one under maxBytes, and resolves or rejects with what task() does.
// A task larger than maxBytes runs once nothing else is running, so it
// still runs, alone. Tasks start in the order they were queued: a large one
// waiting for room holds back the small ones queued after it.
module.exports = function createDownloadLimiter({ maxConcurrent, maxBytes }) {
  let running = 0;
  let bytes = 0;
  const waiting = [];

  const fits = (size) =>
    running < maxConcurrent && (running === 0 || bytes + size <= maxBytes);

  const next = () => {
    while (waiting.length && fits(waiting[0].size)) {
      const { size, task, resolve, reject } = waiting.shift();
      running += 1;
      bytes += size;
      Promise.resolve()
        .then(task)
        .then(resolve, reject)
        .finally(() => {
          running -= 1;
          bytes -= size;
          next();
        });
    }
  };

  return (size, task) =>
    new Promise((resolve, reject) => {
      waiting.push({ size: size || 0, task, resolve, reject });
      next();
    });
};
