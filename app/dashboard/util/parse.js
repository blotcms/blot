// We need to be able to send CSS files through the
// template editor and they sometimes include base64 stuff.
const MAX_POST_REQUEST_SIZE = "5mb";

// helper/bodyParser keeps req.body as {} when a request has no form body
// (body-parser 2 leaves it undefined) and the handlers read req.body.x
module.exports = require("helper/bodyParser").urlencoded({
  extended: false,
  limit: MAX_POST_REQUEST_SIZE,
});
