var request = require("request");
var config = require("config");

function main(callback) {
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
      if (err) return callback(err);
      try {
        data = JSON.parse(data).access_token;
      } catch (e) {
        return callback(e);
      }
      callback(null, data);
    }
  );
}

module.exports = main;

if (require.main === module)
  main(function (err, token) {
    if (err) throw err;
    console.log(token);
  });
