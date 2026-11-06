var request = require("request");

function main(callback) {
  require("../generate-access-token")(function (err, token) {
    request.post(
      {
        uri: "https://api.sandbox.paypal.com/v1/catalogs/products",
        headers: {
          "Content-Type": "application/json",
          "Accept-Language": "en_US",
          Authorization: "Bearer " + token,

          // Optional and if passed, helps identify idempotent requests
          "PayPal-Request-Id": "BLOT-PRODUCT-" + Date.now(),
        },
        body: JSON.stringify({
          name: "Blot",
          description: "A blogging platform with no interface",
          type: "SERVICE",
          category: "SOFTWARE",
          image_url: "https://example.com/streaming.jpg",
          home_url: "https://blot.im",
        }),
      },
      function (err, res, data) {
        if (err) return callback(err);
        console.log(data);
      }
    );
  });
}

module.exports = main;

if (require.main === module)
  main(function (err, token) {
    if (err) throw err;
    console.log(token);
  });
