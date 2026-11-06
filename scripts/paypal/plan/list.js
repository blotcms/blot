var request = require("request");

async function main() {
  var token;
  try {
    token = await require("../generate-access-token")();
  } catch (err) {
    // The callback version ignored this error and sent the request anyway,
    // with "Bearer undefined" as the token. Kept as it was.
  }

  var data = await new Promise(function (resolve, reject) {
    request(
      {
        uri: "https://api.sandbox.paypal.com/v1/billing/plans",
        headers: {
          "Content-Type": "application/json",
          "Accept-Language": "en_US",
          Authorization: "Bearer " + token,
        },
      },
      function (err, res, data) {
        if (err) return reject(err);
        resolve(data);
      }
    );
  });

  return JSON.parse(data);
}

module.exports = main;

if (require.main === module)
  main().then(
    function (res) {
      console.log(res);
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );
