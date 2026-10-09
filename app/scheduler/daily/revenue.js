const User = require("models/user");
const extend = require("models/user/extend");
const async = require("async");
const prettyPrice = require("helper/prettyPrice");
const prettyNumber = require("helper/prettyNumber");

function main (callback) {
  var annual_recurring_revenue = 0;
  var annual_billed_revenue = 0;
  var paypal_annual_recurring_revenue = 0;
  var total_active_blogs = 0;
  var total_active_blogs_paypal = 0;
  var total_customers = 0;
  var total_customers_paypal = 0;

  User.getAllIds(function (err, uids) {
    async.map(uids, User.getById, function (err, users) {
      users.forEach(function (user) {
        if (!user) return;
        user = extend(user);

        if (user.isDisabled) return;

        if (!user.isSubscribed) return;

        total_customers++;
        total_active_blogs += user.pretty.amount;

        if (user.isMonthly === false) {
          annual_recurring_revenue += user.totalFee;
          annual_billed_revenue += user.totalFee;
        } else {
          annual_recurring_revenue += user.totalFee * 12;
        }

        if (user.paypal.status) {
          total_customers_paypal++;
          total_active_blogs_paypal += user.pretty.amount;
          paypal_annual_recurring_revenue += user.isMonthly
            ? user.totalFee * 12
            : user.totalFee;
        }
      });

      callback(null, {
        total_customers_paypal,
        total_active_blogs_paypal,
        paypal_percentage:
          (
            (paypal_annual_recurring_revenue / annual_recurring_revenue) *
            100
          ).toFixed(1) + "%",
        annual_percentage:
          (
            (annual_billed_revenue / annual_recurring_revenue) *
            100
          ).toFixed(1) + "%",
        annual_recurring_revenue: prettyPrice(
          Math.floor(annual_recurring_revenue / 100) * 100
        ),
        monthly_recurring_revenue: prettyPrice(
          Math.floor(Math.floor(annual_recurring_revenue / 12) / 100) * 100
        ),
        total_customers,
        total_active_blogs: prettyNumber(total_active_blogs)
      });
    });
  });
}

module.exports = main;
if (require.main === module) require("./cli")(main);
