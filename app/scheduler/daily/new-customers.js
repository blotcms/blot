const { promisify } = require("util");
const User = require("models/user");
const Blog = require("models/blog");

const getAllUserIds = promisify(User.getAllIds);
const getUserById = promisify(User.getById);
const getBlog = promisify(Blog.get);

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

async function main(callback) {
  try {
    const userIds = await getAllUserIds();
    const new_customers = [];
    const cutoff = Date.now() - ONE_DAY_MS;

    for (const userId of userIds) {
      try {
        const user = await getUserById(userId);

        if (!user) continue;

        const stripeCreatedMs = toMs(user.subscription?.created);
        const paypalStartMs = toMs(user.paypal?.start_time);

        const isNewStripe = Boolean(
          stripeCreatedMs && stripeCreatedMs >= cutoff
        );
        const isNewPaypal = Boolean(paypalStartMs && paypalStartMs >= cutoff);

        if (!isNewStripe && !isNewPaypal) continue;

        const sites = [];

        if (Array.isArray(user.blogs)) {
          for (const blogId of user.blogs) {
            try {
              const blog = await getBlog({ id: blogId });

              if (!blog || blog.isDisabled) continue;

              const extendedBlog = Blog.extend(blog);

              if (extendedBlog?.url) {
                sites.push({ url: extendedBlog.url });
              }
            } catch (err) {
              continue;
            }
          }
        }

        new_customers.push({
          email: user.email,
          sites,
        });
      } catch (err) {
        continue;
      }
    }

    callback(null, { new_customers });
  } catch (err) {
    callback(err);
  }
}

function toMs(timestamp) {
  if (!timestamp) return null;

  if (timestamp instanceof Date) return timestamp.getTime();

  if (typeof timestamp === "number") {
    if (!Number.isFinite(timestamp)) return null;

    return timestamp < 1e12 ? timestamp * 1000 : timestamp;
  }

  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);

    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

module.exports = main;
if (require.main === module) require("./cli")(main);
