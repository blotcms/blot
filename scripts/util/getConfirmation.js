const readline = require("readline");

module.exports = function getConfirmation(message) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    rl.question(`${message} (y/n): `, (answer) => {
      rl.close();
      const confirmation = answer.toLowerCase().trim() === "y";

      resolve(confirmation);
    });
  });
};
