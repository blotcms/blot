var type = require("./type");
var ensure = require("./ensure");

/*

Maps Object -> Array. For example:

{
  a: {1: 'uno'},
  b: {2: 'dos'},
  c: {3: 'tres'}
}

becomes:

[
  {id: 'a', 1: 'uno'},
  {id: 'b', 2: 'dos'},
  {id: 'c', 3: 'tres'}
]

*/

module.exports = function arrayify(obj, manipulate) {
  // This is useful for mustache templates
  // manipulate should be a simple function

  var list = [];
  var count = 0;

  for (var i in obj) {
    try {
      ensure(obj.name, "undefined");
    } catch (e) {
      if (obj.name !== i) {
        throw "Attempting to arrayIfy object failed because it already has the name property set";
      }
    }

    if (type(obj[i], "string") || type(obj[i], "number")) {
      var name = i;
      obj[i] = { content: obj[i], name: name, index: ++count };
    } else {
      obj[i] = obj[i] || {};
      obj[i].name = obj[i].name || i;
    }

    var foo = true;

    if (manipulate) foo = manipulate(obj[i], list.length);

    if (foo !== false) list.push(obj[i]);
  }

  return list;
};
