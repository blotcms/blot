var request = require("request");

function main(callback) {
  require("../generate-access-token")(function(err, token) {
    request(
      {
        uri: "https://api.sandbox.paypal.com/v1/billing/plans",
        headers: {
          "Content-Type": "application/json",
          "Accept-Language": "en_US",
          Authorization: "Bearer " + token
        }
      },
      function(err, res, data) {
        if (err) return callback(err);
        callback(null, JSON.parse(data));
      }
    );
  });
}

module.exports = main;

if (require.main === module)
  main(function(err, res) {
    if (err) throw err;
    console.log(res);
  });
