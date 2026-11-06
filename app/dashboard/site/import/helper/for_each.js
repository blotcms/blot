var TYPES = {
    undefined: "undefined",
    number: "number",
    boolean: "boolean",
    string: "string",
    "[object Function]": "function",
    "[object RegExp]": "regexp",
    "[object Array]": "array",
    "[object Date]": "date",
    "[object Error]": "error",
  },
  TOSTRING = Object.prototype.toString;

function type(o, is) {
  if (is !== undefined) return type(o) === is;

  return TYPES[typeof o] || TYPES[TOSTRING.call(o)] || (o ? "object" : "null");
}

function callOnce(f) {
  var called = false;
  return function foo() {
    var args = arguments;
    if (!called) {
      f.apply(this, args);
    }
    called = true;
  };
}

var _ = require("lodash");
var pairs = _.toPairs;

// Perform some basic sanity checks
// and determine how to handle the items
function series(items, doThis, callback) {
  callback = callback || doNothing;

  if (!type(doThis, "function")) throw badDoThis(doThis);

  if (!type(callback, "function")) throw badCallback(callback);

  // Clone the items list in case
  // its modified during processing
  if (type(items, "array")) return seriesItem(items.slice(0), doThis, callback);

  // Pairs returns a new array anyway
  // so we don't have to worry about
  // side effects using slice(0)
  if (type(items, "object")) return seriesPair(pairs(items), doThis, callback);

  throw badItems(items);
}

// We let the supervisor handle type checking...
function seriesItem(list, doThis, callback) {
  if (list.length === 0) return callback();

  var item = list.shift();
  var nextItem = seriesItem.bind(this, list, doThis, callback);

  doThis(
    item,
    callOnce(function (err) {
      if (err) {
        // should handle this err
      }

      setImmediate(nextItem);
    })
  );
}

function seriesPair(list, doThis, callback) {
  if (list.length === 0) return callback();

  var item = list.shift();
  var nextItem = seriesPair.bind(this, list, doThis, callback);

  doThis(
    item[0],
    item[1],
    callOnce(function (err) {
      if (err) {
        // should handle this err
      }

      setImmediate(nextItem);
    })
  );
}

function parallel(items, doThis, callback) {
  callback = callback || doNothing;

  if (!type(doThis, "function")) throw badDoThis(doThis);

  if (!type(callback, "function")) throw badCallback(callback);

  // Clone the items list in case
  // its modified during processing
  if (type(items, "array"))
    return parallelItem(items.slice(0), doThis, callback);

  // Pairs returns a new array anyway
  // so we don't have to worry about
  // side effects using slice(0)
  if (type(items, "object"))
    return parallelPair(pairs(items), doThis, callback);

  throw badItems(items);
}

function parallelItem(list, doThis, callback) {
  var total = list.length;
  var completed = 0;

  if (total === 0) return callback();

  function done() {
    if (++completed === total) return callback();
  }

  for (var i = 0; i < total; i++) {
    doThis(list[i], callOnce(done), i);
  }
}

function parallelPair(list, doThis, callback) {
  var total = list.length;
  var completed = 0;

  if (total === 0) return callback();

  function done() {
    if (++completed === total) return callback();
  }

  for (var i = 0; i < total; i++) {
    doThis(list[i][0], list[i][1], callOnce(done), i);
  }
}

function multi(max) {
  return function (array, doThis, done) {
    // Do nothing after
    if (done === undefined)
      done = function () {
        return true;
      };

    done = callOnce(done);

    var remaining = array.length;
    var total = array.length;

    // List is empty, finish early!
    if (!remaining) return done();

    // Number of functions active
    var active = 0;

    // Position in array that we've done so far
    var counter = 0;

    // Call the first X functions
    while (active < max) {
      run();
      active++;
    }

    function run() {
      var i = counter;

      // No more to do
      if (i >= total) return;

      counter++;

      setTimeout(function () {
        // call once people!
        doThis(array[i], callOnce(onComplete));
      }, 0);
    }

    function onComplete() {
      if (!--remaining) {
        return done();
      }
      run();
    }
  };
}

function doNothing() {}

function badDoThis(doThis) {
  return new TypeError(
    "ForEach must be invoked a function. Do this is:" + doThis
  );
}

function badCallback(callback) {
  return new TypeError(
    "ForEach must be passed a callback which is a function. callback is:" +
      callback
  );
}

function badItems(items) {
  return new TypeError(
    "ForEach must be passed a list of object. It was " + items
  );
}

var forEach = series;

forEach.parallel = parallel;
forEach.multi = multi;

/////// Tests....

var assert = require("assert");

function longList(len) {
  var list = [];
  while (list.length < len) {
    list.push(list.length + 1);
  }
  return list;
}

function massiveParallelList(cb) {
  var list = longList(100000);

  console.log("Processing massive list in parallel...");

  forEach.parallel(
    list,
    function (number, next) {
      list[number - 1] = number * 10;
      next();
      next();
    },
    function () {
      console.log("All done!");
      console.log("Checking valid process...");
      assert.deepEqual(
        list,
        longList(100000).map(function (n) {
          return n * 10;
        })
      );
      cb();
    }
  );
}

function massiveSeriesList(cb) {
  var list = longList(100000);

  console.log("Processing massive list in series...");

  forEach(
    list,
    function (number, next) {
      list[number - 1] = number * 2;
      next();
      next();
    },
    function () {
      console.log("All done!");
      console.log("Checking valid process...");
      assert.deepEqual(
        list,
        longList(100000).map(function (n) {
          return n * 2;
        })
      );
      cb();
    }
  );
}

function delayedSeriesList(cb) {
  console.log("Processing delayed list in series...");

  var list = ["a", "b", "c", "d", "e"];

  forEach(
    list,
    function (num, next) {
      console.log(num + " is processing...");
      setTimeout(function () {
        console.log(num + " is completed...");
        next();
        next();
      }, 120);
    },
    function () {
      console.log("All done!");
      cb();
    }
  );
}

function delayedParallelList(cb) {
  console.log("Processing delayed list in parallel...");

  var list = ["a", "b", "c", "d", "e"];

  forEach.parallel(
    list,
    function (letter, next) {
      console.log(letter + " is processing...");
      setTimeout(function () {
        console.log(letter + " is completed...");
        next();
        next();
      }, 120);
    },
    function () {
      console.log("All done!");
      cb();
    }
  );
}

function multiList(cb) {
  console.log("Processing list in multi mode...");

  var list = ["a", "b", "c", "d", "e"];

  forEach.multi(2)(
    list,
    function (letter, next) {
      console.log(letter + " is processing...");
      setTimeout(function () {
        console.log(letter + " is completed...");
        next();
        next();
      }, 120);
    },
    function () {
      console.log("All done!");
      cb();
    }
  );
}

// eslint-disable-next-line no-unused-vars -- manual benchmark, see the commented-out runner below
function listTests(cb) {
  console.log("");
  massiveParallelList(function () {
    console.log("");
    massiveSeriesList(function () {
      console.log("");
      delayedSeriesList(function () {
        console.log("");
        delayedParallelList(function () {
          console.log("");
          multiList(function () {
            console.log("List tests complete!");
            cb();
          });
        });
      });
    });
  });
}

///// Object tests....

function seriesMassiveObject(cb) {
  var obj = bigObj(1000);
  var _obj = _.cloneDeep(obj);

  console.log("Processing massive object in series...");

  forEach(
    obj,
    function (key, value, next) {
      // console.log(key, value.length);

      value = false;
      key = false;

      next();
    },
    function () {
      console.log("All done!");
      assert.deepEqual(obj, _obj);
      cb();
    }
  );
}

function bigObj(len) {
  var obj = {};
  while (len) {
    obj[len + ""] = longList(len);
    len--;
  }
  return obj;
}

function parallelMassiveObject(cb) {
  var obj = bigObj(1000);
  var _obj = _.cloneDeep(obj);

  console.log("Processing massive object in parallel...");

  forEach.parallel(
    obj,
    function (key, value, next) {
      // console.log(key, value.length);

      value = false;
      key = false;

      next();
    },
    function () {
      console.log("All done!");
      assert.deepEqual(obj, _obj);
      cb();
    }
  );
}

function delayedSeriesObject(cb) {
  console.log("Processing delayed object in series...");

  var obj = { a: "1", b: "2", c: "3", d: "4", e: "5" };

  forEach(
    obj,
    function (letter, number, next) {
      console.log(letter + " " + number + " is processing...");
      setTimeout(function () {
        console.log(letter + " " + number + " is completed");
        next();
        next();
      }, 120);
    },
    function () {
      console.log("All done!");
      cb();
    }
  );
}

function delayedParallelObject(cb) {
  console.log("Processing delayed object in parallel...");

  var obj = { a: "1", b: "2", c: "3", d: "4", e: "5" };

  forEach.parallel(
    obj,
    function (letter, number, next) {
      console.log(letter + " " + number + " is processing...");
      setTimeout(function () {
        console.log(letter + " " + number + " is completed");
        next();
        next();
      }, 120);
    },
    function () {
      console.log("All done!");
      cb();
    }
  );
}

function multiObject(cb) {
  console.log("Processing object in multi mode...");

  var obj = { a: "1", b: "2", c: "3", d: "4", e: "5" };

  forEach.multi(2)(
    obj,
    function (letter, number, next) {
      console.log(letter + " " + number + " is processing...");
      setTimeout(function () {
        console.log(letter + " " + number + " is completed");
        next();
        next();
      }, 120);
    },
    function () {
      console.log("All done!");
      cb();
    }
  );
}

// eslint-disable-next-line no-unused-vars -- manual benchmark, see the commented-out runner below
function objectTests(cb) {
  console.log("");
  seriesMassiveObject(function () {
    console.log("");
    parallelMassiveObject(function () {
      console.log("");
      delayedSeriesObject(function () {
        console.log("");
        delayedParallelObject(function () {
          console.log("");
          multiObject(function () {
            console.log("Object tests complete!");
            cb();
          });
        });
      });
    });
  });
}

// listTests(function(){

//   objectTests(function(){

//     console.log('All tests complete!');

//   });
// });

// (function tests () {

//   var assert = require('assert');

//   var init = [{foo: 'bar'},{foo: 'baz'},{foo: 'bat'}];
//   var wasDoneCalled = false;
//   var totalCalled = 0;

//   forEach(init, function(obj, next){

//     obj.foo = 'woo';
//     totalCalled++;

//     next();

//   }, function () {
//     wasDoneCalled = true;
//     check(init);
//     console.log('First test passed!');
//   });

//   var called = 0;

//   forEach(init, function(obj, next){
//     called++;
//     next();
//     next();
//   });

//   forEach.parallel([1,2,3,4,5], function(number, next){

//     var delay = Math.floor(Math.random()*1000);

//     console.log(number + ' waits for a delay of ' + delay);

//     setTimeout(function() {
//       console.log(number);
//       next();
//     }, delay);

//   }, function(){
//     console.log('----> this is only done all the nexts are called...');
//   });

//   function check() {

//     assert.deepEqual(totalCalled, init.length);
//     assert.deepEqual(wasDoneCalled, true);

//     for (var i in init)
//       assert.deepEqual(init[i], {foo: 'woo'});
//   }

// }());

// var foo = [{foo: 'bar'},{foo: 'baz'},{foo: 'bat'}];

// forEach(foo, function(number, next){

//   console.log('Inside this! ' + number.foo);

//   return setTimeout(next, 100);

// }, function () {

//   console.log('All done!');
//   objectTest();
// });

// function objectTest () {

//   forEach({bar: 1, bam: 2, bat: 3}, function(key, value, next){

//     console.log('Key is ' + key);
//     console.log('Value is ' + value);

//     return setTimeout(next, 100);

//   }, function () {

//     console.log('Object test of this done!');
//   });
// }

module.exports = forEach;
