// Runs one task per blog at a time, in the order they arrive. Each task is
// passed a function to call when it has finished. This covers one process,
// which is enough for the concurrency it exists for: a rebuild building
// several of a blog's entries at once.
var queues = new Map();

function next(blogID) {
  var queue = queues.get(blogID);
  var finished = false;

  queue[0](function () {
    if (finished) return;
    finished = true;

    queue.shift();

    if (queue.length) next(blogID);
    else queues.delete(blogID);
  });
}

module.exports = function serial(blogID, task) {
  var queue = queues.get(blogID);

  if (queue) return queue.push(task);

  queues.set(blogID, [task]);
  next(blogID);
};
