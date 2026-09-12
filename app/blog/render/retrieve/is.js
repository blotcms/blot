/*

This is a cheap hack to add even more logic to the supposedly
logic-less template system mustache. Basically it allows me
to compare the string value of a particular variable within
my template on Blot. For example, let's say my templat has
the following locals declared:

{
  "layout": "grid"
}

I can use this lamba to accomplish the following in my template:

{{#is.layout.grid}}
  ... then render the grid layout
{{/is.layout.grid}}

The lamba loops over the top-level variables, checks if they
are strings and if so, then creates a child object that looks
like this: { grid: true }.

I chose "is" instead of "if" to avoid future conflicts if we
move to handlebars, say.

*/
const asRetriever = require("../../lib/asRetriever");

module.exports = asRetriever(function (req, res) {
  const is = {};

  for (const local in req.template.locals) {
    if (typeof req.template.locals[local] === "string") {
      is[local] = {};
      is[local][req.template.locals[local]] = true;
    }
  }

  return is;
});
