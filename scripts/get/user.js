var User = require("models/user");
var fromBlog = require("./blog");
var { promisify } = require("util");

// A failed lookup has always counted as "no match" here, so its error is
// dropped rather than failing the whole lookup
async function ignoreErrors(lookup) {
  try {
    return await lookup();
  } catch (err) {
    return undefined;
  }
}

async function find(identifier) {
  var userFromBlog = await ignoreErrors(() => promisify(fromBlog)(identifier));
  var userFromID = await ignoreErrors(() => User.getById(identifier));
  var userFromCustomerID = await ignoreErrors(() =>
    User.getByCustomerId(identifier)
  );
  var userFromEmail = await ignoreErrors(() => User.getByEmail(identifier));

  if (!userFromBlog && !userFromID && !userFromCustomerID && !userFromEmail)
    throw new Error("No user");

  var user = userFromBlog || userFromID || userFromCustomerID || userFromEmail;

  var url = await promisify(require("../blog/access"))(user.email);

  return { user, url };
}

// Takes a URL or handle and fetches the blog and user
module.exports = function get(identifier, callback) {
  find(identifier).then(
    function (found) {
      callback(null, found.user, found.url);
    },
    function (err) {
      callback(err);
    }
  );
};
