var ensure = require("helper/ensure");
var promiseOnly = require("helper/promiseOnly");
var getByEmail = require("../getByEmail");
var { emailIsTooLong } = require("../auth-limits");

module.exports = promiseOnly(async function validateEmail(user, email) {
  ensure(user, "object").and(email, "string");

  // Normalize the email, case sensitivity confuses users
  email = email.trim().toLowerCase().replace(" ", "");

  if (!email) throw new Error("Please enter an email");

  if (emailIsTooLong(email)) throw new Error("Email address is too long");

  var emailRegex = /[^\s@]+@[^\s@]+\.[^\s@]+/;

  if (!emailRegex.test(email)) throw new Error("Please enter a valid email");

  var otheruser = await getByEmail(email);

  if (otheruser && otheruser.uid !== user.uid) {
    var err = new Error("This email is in use.");
    err.code = "EEXISTS";
    throw err;
  }

  // this email is free!
  return email;
});
