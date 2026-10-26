const { promisify } = require("util");
const config = require("config");
const User = require("models/user");
const getUserByEmail = promisify(User.getByEmail);
const createUser = promisify(User.create);
const generateAccessToken = promisify(User.generateAccessToken);
const FOLDER_ACCOUNT_EMAIL = config.admin.email || "example@example.com";
const format = require("url").format;

module.exports = async function setupUser() {
  let user = await getUserByEmail(FOLDER_ACCOUNT_EMAIL);

  if (!user) {
    user = await createUser(
      FOLDER_ACCOUNT_EMAIL,
      config.session.secret || "",
      {},
      {}
    );
  }

  const token = await generateAccessToken({ uid: user.uid });

  const url = format({
    protocol: "https",
    host: config.host,
    pathname: "/log-in",
    query: { token },
  });

  return { user, url };
};
