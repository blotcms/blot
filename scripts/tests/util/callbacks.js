// Callback-style loops for specs whose bodies are nested callbacks (around
// sync's (err, folder, finish) callback, for instance), where async/await has
// nothing to unwrap. Each calls back once, with the first error or null.
// Tasks and iteratees take a node-style callback.

function callTask(fn, ...args) {
  return new Promise(function (resolve, reject) {
    fn(...args, function (err, result) {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

function finish(promise, callback) {
  promise.then(function (results) {
    callback(null, results);
  }, callback);
}

// Runs the tasks one after another and stops at the first error. The results
// are what each task passed to its callback.
function series(tasks, callback) {
  finish(
    (async function () {
      const results = [];
      for (const task of tasks) results.push(await callTask(task));
      return results;
    })(),
    callback
  );
}

// Runs iteratee(item, next) over items one after another
function eachSeries(items, iteratee, callback) {
  finish(
    (async function () {
      for (const item of items) await callTask(iteratee, item);
    })(),
    function (err) {
      callback(err || null);
    }
  );
}

// Runs iteratee(item, next) over all the items at once
function each(items, iteratee, callback) {
  finish(
    Promise.all(items.map((item) => callTask(iteratee, item))),
    function (err) {
      callback(err || null);
    }
  );
}

module.exports = { series, eachSeries, each };
