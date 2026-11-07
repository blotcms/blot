var User = require("models/user");
var fromBlog = require("./blog");

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
  var userFromBlog = await ignoreErrors(
    async () => (await fromBlog(identifier)).user
  );
  var userFromID = await ignoreErrors(() => User.getById(identifier));
  var userFromCustomerID = await ignoreErrors(() =>
    User.getByCustomerId(identifier)
  );
  var userFromEmail = await ignoreErrors(() => User.getByEmail(identifier));

  if (!userFromBlog && !userFromID && !userFromCustomerID && !userFromEmail)
    throw new Error("No user");

  var user = userFromBlog || userFromID || userFromCustomerID || userFromEmail;

  var url = await require("../blog/access")(user.email);

  return { user, url };
}

// Takes a URL, handle, user ID, customer ID or email and resolves { user, url },
// where url is a one-time dashboard log-in link. Throws if there is no such user.
module.exports = find;
