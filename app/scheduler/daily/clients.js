const { promisify } = require("util");
const User = require("models/user");
const extend = require("models/user/extend");
const Blog = require("models/blog");

const getAllUserIds = promisify(User.getAllIds);
const getUserById = promisify(User.getById);
const getBlog = promisify(Blog.get);

const NO_CLIENT_LABEL = "No client";

// Turns a list of { clients: Set<string> } (one entry per current user, each
// holding the distinct clients used across their non-disabled blogs) into a
// sorted array of { client, users, percentage }. Kept pure so it can be
// tested without touching Redis.
function buildRows(usersClients, totalUsers) {
  const counts = {};

  usersClients.forEach(function (clients) {
    clients.forEach(function (client) {
      counts[client] = (counts[client] || 0) + 1;
    });
  });

  const rows = Object.keys(counts).map(function (client) {
    const users = counts[client];

    return {
      client,
      users,
      percentage: (totalUsers ? (users / totalUsers) * 100 : 0).toFixed(1) + "%"
    };
  });

  rows.sort(function (a, b) {
    return b.users - a.users;
  });

  return rows;
}

async function main(callback) {
  try {
    const userIds = await getAllUserIds();
    const usersClients = [];

    for (const userId of userIds) {
      try {
        let user = await getUserById(userId);

        if (!user) continue;

        user = extend(user);

        if (user.isDisabled) continue;

        if (!user.isSubscribed) continue;

        const clients = new Set();

        if (Array.isArray(user.blogs)) {
          for (const blogId of user.blogs) {
            try {
              const blog = await getBlog({ id: blogId });

              if (!blog || blog.isDisabled) continue;

              clients.add(blog.client || NO_CLIENT_LABEL);
            } catch (err) {
              continue;
            }
          }
        }

        usersClients.push(clients);
      } catch (err) {
        continue;
      }
    }

    callback(null, {
      users_by_client: buildRows(usersClients, usersClients.length)
    });
  } catch (err) {
    callback(err);
  }
}

module.exports = main;
module.exports.buildRows = buildRows;

if (require.main === module) require("./cli")(main);
