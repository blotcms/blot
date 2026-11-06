var request = require("request");

function main(product_id, callback) {
  require("../generate-access-token")(function (err, token) {
    request.post(
      {
        uri: "https://api.sandbox.paypal.com/v1/billing/plans",
        headers: {
          "Content-Type": "application/json",
          "Accept-Language": "en_US",
          Authorization: "Bearer " + token,
        },
        body: JSON.stringify({
          product_id: product_id,
          name: "Blog",
          description: "Annual subscription to host a blog",
          quantity_supported: true,
          billing_cycles: [
            {
              frequency: {
                interval_unit: "YEAR",
                interval_count: 1,
              },
              tenure_type: "REGULAR",
              sequence: 1,
              total_cycles: 0,
              pricing_scheme: {
                fixed_price: {
                  value: "44",
                  currency_code: "USD",
                },
              },
            },
          ],
          payment_preferences: {
            auto_bill_outstanding: true,
            payment_failure_threshold: 3,
          },
        }),
      },
      function (err, res, data) {
        if (err) return callback(err);
        callback(null, JSON.parse(data));
      }
    );
  });
}

module.exports = main;

if (require.main === module)
  main(process.argv[2], function (err, res) {
    if (err) throw err;
    console.log(res);
  });
