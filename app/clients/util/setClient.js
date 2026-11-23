const Blog = require("models/blog");

// Sets the blog's client, disconnecting the client it had first. Every route
// that connects a client goes through this, as the dashboard's Switch page
// does, so a blog never keeps a client it has left: that client would go on
// syncing into the blog's folder, and its records of the blog would outlive
// the connection (a deleted blog disconnects only its current client).
async function setClient(blog, name) {
  const clients = require("clients");
  const current = blog.client;

  if (current && current !== name && clients[current]) {
    await clients[current].disconnect(blog.id);
  }

  await Blog.set(blog.id, { client: name });
  blog.client = name;
}

module.exports = setClient;
