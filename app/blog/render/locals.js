const render = require("./main");
const type = require("helper/type");
const TAG = "{{";
const ensure = require("helper/ensure");

// Recursively render all the locals in
// the view. This is to ensure that variables
// inside stuff like entry.html
// are replaced with the values they should.
module.exports = function renderLocals(req, res) {
  ensure(res, "object")
    .and(res.locals, "object")
    .and(res.locals.partials, "object");

  const locals = res.locals;
  const partials = res.locals.partials;

  try {
    handle(res.locals);
  } catch (e) {
    return;
  }

  function handle(obj) {
    for (const i in obj) {
      // We want to skip partials now
      // Otherwise shit would break.
      // Technically we only need to check
      // this on the first level.
      if (i === "partials") continue;

      const local = obj[i];

      // Go deeper!
      if (type(local, "object") || type(local, "array")) {
        handle(obj[i]);
        continue;
      }

      if (type(local, "string") && local.indexOf(TAG) > -1) {
        // this needs to inherit context so entry can access
        // other tags etc...
        // Render this string local since it contains a tag

        // bits of the entry might not work, that's OK!

        try {
          obj[i] = render(local, locals, partials);
        } catch (e) {
          obj[i] = local;
        }
      }
    }
  }
};
