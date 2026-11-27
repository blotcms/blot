const email = require("helper/email");
const clfdate = require("helper/clfdate");

// Emails the maintainer that a blog removal, or the reduction of its owner's
// subscription, did not finish. Never rejects: it runs where the failure is
// already being handled.
module.exports = async function alertBlogRemoval(summary, details) {
  console.error(clfdate(), "ERROR Blog removal:", summary, details);

  try {
    await email.BLOG_REMOVAL_ALERT(null, { summary, details });
  } catch (err) {
    console.error(clfdate(), "Error sending the blog removal alert", err);
  }
};
