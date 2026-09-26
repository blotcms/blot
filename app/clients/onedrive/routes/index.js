// The dashboard routes are mounted to
// a specific blog on a user's dashboard
// and are authenticated, with session access.
const dashboard = require("./dashboard");

// The site routes are exposed to the internet
// and are used for things like OAUTH callbacks
// and webhook endpoints.
const site = require("./site");

// We export them conventionally like so:
module.exports = { dashboard, site };
