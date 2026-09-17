const MAX_EMAIL_LENGTH = 254;

// bcrypt only uses the first 72 bytes of a password. Reject longer passwords
// instead of silently hashing a value that is different from what the user
// entered.
const MAX_PASSWORD_LENGTH = 72;

function emailIsTooLong(email) {
  return (
    typeof email === "string" &&
    Buffer.byteLength(email, "utf8") > MAX_EMAIL_LENGTH
  );
}

function passwordIsTooLong(password) {
  return (
    typeof password === "string" &&
    Buffer.byteLength(password, "utf8") > MAX_PASSWORD_LENGTH
  );
}

module.exports = {
  MAX_EMAIL_LENGTH,
  MAX_PASSWORD_LENGTH,
  emailIsTooLong,
  passwordIsTooLong,
};
