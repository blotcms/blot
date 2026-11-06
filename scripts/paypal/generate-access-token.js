var request = require("request");
var config = require("config");

async function main() {
  var data = await new Promise(function (resolve, reject) {
    request.post(
      {
        uri: "https://api.sandbox.paypal.com/v1/oauth2/token",
        headers: {
          Accept: "application/json",
          "Accept-Language": "en_US",
        },
        auth: {
          user: config.paypal.client_id,
          pass: config.paypal.secret,
        },
        body: "grant_type=client_credentials",
      },
      function (err, res, data) {
        if (err) return reject(err);
        resolve(data);
      }
    );
  });

  return JSON.parse(data).access_token;
}

module.exports = main;

if (require.main === module)
  main().then(
    function (token) {
      console.log(token);
    },
    function (err) {
      console.error(err);
      process.exit(1);
    }
  );
