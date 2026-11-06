// We need to be able to send CSS files through the
// template editor and they sometimes include base64 stuff.
const MAX_POST_REQUEST_SIZE = "5mb";

// body-parser 1, which Express 4 shipped: it leaves req.body as {} when a
// request has no form body, where Express 5's own urlencoded() leaves it
// undefined and the handlers read req.body.x
module.exports = require("body-parser").urlencoded({
  extended: false,
  limit: MAX_POST_REQUEST_SIZE,
});
