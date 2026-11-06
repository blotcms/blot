var chars = "abcdefghijklmnopqrstuvwxyz".split("");

function randomChars(len) {
  var res = "";

  while (res.length < len)
    res += chars[Math.floor(Math.random() * chars.length)];

  return res;
}

module.exports = randomChars;
