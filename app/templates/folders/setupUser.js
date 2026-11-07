const config = require("config");
const User = require("models/user");
const FOLDER_ACCOUNT_EMAIL = config.admin.email || "example@example.com";
const format = require("url").format;

module.exports = async function setupUser() {
  let user = await User.getByEmail(FOLDER_ACCOUNT_EMAIL);

  if (!user) {
    user = await User.create(
      FOLDER_ACCOUNT_EMAIL,
      config.session.secret || "",
      {},
      {}
    );
  }

  // A log-in link for local development only. In production this account is
  // the admin's, and the link would land in the logs.
  if (config.environment !== "development") return { user };

  const token = await User.generateAccessToken({ uid: user.uid });

  const url = format({
    protocol: "https",
    host: config.host,
    pathname: "/log-in",
    query: { token },
  });

  return { user, url };
};
