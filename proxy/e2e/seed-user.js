// Runs inside the Blot app container (which sets NODE_PATH so "models/user"
// resolves). Usage: node seed-user.js <email> <password>
const User = require("models/user");

const email = process.argv[2];
const password = process.argv[3];

if (!email || !password) {
  console.error("usage: node seed-user.js <email> <password>");
  process.exit(1);
}

(async () => {
  const hash = await User.hashPassword(password);
  const user = await User.create(email, hash, {}, {});
  console.log("seeded user", user.uid, email);
  process.exit(0);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
