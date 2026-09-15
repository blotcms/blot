// A card counts as "expiring soon" inside this many months of its
// expiry date (but hasn't expired yet).
var EXPIRING_SOON_MONTHS = 2;

// Mutates each payment method in place, adding isExpired/isExpiringSoon
// flags derived from its exp_month/exp_year. Shared by app/models/user/extend
// (so subscription.html can show a warning badge) and the payment-methods
// page itself (which reads a freshly-synced list, not the extended user).
module.exports = function markExpiry(paymentMethods) {
  if (!paymentMethods || !paymentMethods.length) return paymentMethods;

  var now = new Date();
  var currentYear = now.getFullYear();
  var currentMonth = now.getMonth() + 1;

  paymentMethods.forEach(function (paymentMethod) {
    var monthsUntilExpiry =
      (paymentMethod.exp_year - currentYear) * 12 +
      (paymentMethod.exp_month - currentMonth);

    paymentMethod.isExpired = monthsUntilExpiry < 0;
    paymentMethod.isExpiringSoon =
      !paymentMethod.isExpired && monthsUntilExpiry < EXPIRING_SOON_MONTHS;
  });

  return paymentMethods;
};
