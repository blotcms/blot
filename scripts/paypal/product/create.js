var request = require("request");

async function main() {
  var token;
  try {
    token = await require("../generate-access-token")();
  } catch (err) {
    // The callback version ignored this error and sent the request anyway,
    // with "Bearer undefined" as the token. Kept as it was.
  }

  await new Promise(function (resolve, reject) {
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
        if (err) return reject(err);
        console.log(data);
        resolve();
      }
    );
  });
}

module.exports = main;

if (require.main === module)
  main().catch(function (err) {
    console.error(err);
    process.exit(1);
  });
