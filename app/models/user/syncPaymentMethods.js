var config = require("config");
var createStripe = require("stripe");
var set = require("./set");

var stripeClient;

function getStripeClient() {
  if (stripeClient) return stripeClient;

  if (!config.stripe || !config.stripe.secret) return null;

  stripeClient = createStripe(config.stripe.secret);

  // Pin an API version that supports the PaymentMethods resource and
  // customer.invoice_settings.default_payment_method, regardless of
  // whichever version is configured as the account default on Stripe.
  if (stripeClient.setApiVersion) stripeClient.setApiVersion("2020-08-27");

  return stripeClient;
}

// Legacy Card objects use title-cased brand names ("Visa", "American
// Express"); modern PaymentMethod objects use lowercase slugs ("visa",
// "amex"). Normalize to the latter so the view/CSS only need to know one
// vocabulary.
var LEGACY_BRANDS = {
  Visa: "visa",
  MasterCard: "mastercard",
  Mastercard: "mastercard",
  "American Express": "amex",
  Discover: "discover",
  "Diners Club": "diners",
  JCB: "jcb",
  UnionPay: "unionpay",
};

function normalizeBrand(brand) {
  return LEGACY_BRANDS[brand] || (brand || "").toLowerCase();
}

function buildPaymentMethod(pm, defaultId) {
  return {
    id: pm.id,
    brand: pm.card.brand,
    last4: pm.card.last4,
    exp_month: pm.card.exp_month,
    exp_year: pm.card.exp_year,
    isDefault: pm.id === defaultId,
  };
}

// Generic "follow has_more with starting_after" pager shared by both the
// modern PaymentMethods list and the legacy Cards list - both are paginated
// the same way, so a customer with more than one page of either would
// otherwise silently lose access to everything past the first page.
async function listAll(list) {
  var all = [];
  var startingAfter;

  while (true) {
    var page = await list(startingAfter);

    var data = page.data || [];
    all = all.concat(data);

    if (page.has_more && data.length) {
      startingAfter = data[data.length - 1].id;
      continue;
    }

    return all;
  }
}

function listAllPaymentMethods(stripe, customerId) {
  return listAll(function (startingAfter) {
    var params = { customer: customerId, type: "card", limit: 100 };
    if (startingAfter) params.starting_after = startingAfter;
    return stripe.paymentMethods.list(params);
  });
}

// Cards added before this feature existed were stored as legacy Card
// objects (attached via customer.sources) rather than modern PaymentMethods.
// Stripe's Payment Methods API is backwards-compatible with those Cards: the
// same object appears in paymentMethods.list with the same card_ id, just
// object: "payment_method" instead of object: "card". We still fetch
// listCards for any card Stripe does not surface that way.
async function fetchLegacyCards(stripe, customerId, defaultSourceId) {
  var cards;

  try {
    cards = await listAll(function (startingAfter) {
      var params = { limit: 100 };
      if (startingAfter) params.starting_after = startingAfter;
      return stripe.customers.listCards(customerId, params);
    });
  } catch (err) {
    if (err && err.code === "resource_missing") return [];
    throw err;
  }

  return cards.map(function (card) {
    return {
      id: card.id,
      brand: normalizeBrand(card.brand),
      last4: card.last4,
      exp_month: card.exp_month,
      exp_year: card.exp_year,
      isDefault: card.id === defaultSourceId,
      isLegacy: true,
    };
  });
}

// A subscription can pin its own default_payment_method or (for accounts
// still on the legacy update-payment-method flow) its own default_source,
// either of which takes priority over the customer-level defaults when
// Stripe decides what to charge for that subscription. We need the live
// subscription (not our cached copy, which may be stale) to know that.
async function fetchSubscriptionDefault(stripe, customerId, subscriptionId) {
  if (!subscriptionId) return null;

  var subscription;

  try {
    subscription = await stripe.customers.retrieveSubscription(
      customerId,
      subscriptionId
    );
  } catch (err) {
    // A missing subscription (cancelled/replaced since we last cached it)
    // genuinely has no subscription-level override left - safe to fall
    // back to the customer-level default. Any other error (network, auth,
    // rate limit) must not be treated the same way: silently falling back
    // could misidentify which card Stripe will actually charge and let it
    // be removed instead of whatever the real override was.
    if (err && err.code === "resource_missing") return null;
    throw err;
  }

  return (
    (subscription &&
      (subscription.default_payment_method || subscription.default_source)) ||
    null
  );
}

// Fetches the Stripe customer's payment methods and caches a display-ready
// summary (brand, last 4 digits, expiry, which one is the default) on the
// user record. Stripe remains the source of truth for the payment-methods
// page itself; this cache lets other parts of the app (e.g. billing emails)
// show card details without an extra live API call.
async function syncPaymentMethods(user) {
  if (!user || !user.subscription || !user.subscription.customer) return [];

  var stripe = getStripeClient();

  if (!stripe) throw new Error("Stripe secret is not configured");

  var customerId = user.subscription.customer;

  var customer = await stripe.customers.retrieve(customerId);

  var subscriptionDefaultId = await fetchSubscriptionDefault(
    stripe,
    customerId,
    user.subscription.id
  );

  // Stripe's real precedence for what a subscription actually
  // charges: its own default_payment_method, then its own
  // default_source, then the customer's invoice_settings default,
  // then the customer's default_source. subscriptionDefaultId above
  // already folds the first two together; this folds in the rest.
  // The result is a single id we can match against either a modern
  // PaymentMethod or a legacy Card, whichever it turns out to be.
  var defaultId =
    subscriptionDefaultId ||
    (customer.invoice_settings &&
      customer.invoice_settings.default_payment_method) ||
    customer.default_source ||
    null;

  var methods = await listAllPaymentMethods(stripe, customerId);

  var paymentMethods = methods
    .filter(function (pm) {
      return pm.card;
    })
    .map(function (pm) {
      return buildPaymentMethod(pm, defaultId);
    });

  var legacyCards = await fetchLegacyCards(stripe, customerId, defaultId);

  // Same card_ id from both APIs is one card, not two. Keep the
  // legacy row so isLegacy stays accurate for remove/default.
  var seen = {};
  legacyCards.forEach(function (card) {
    seen[card.id] = true;
  });
  paymentMethods = legacyCards.concat(
    paymentMethods.filter(function (pm) {
      return !seen[pm.id];
    })
  );

  await set(user.uid, { paymentMethods: paymentMethods });

  return paymentMethods;
}

module.exports = syncPaymentMethods;

module.exports.getClient = getStripeClient;

module.exports._setStripeClient = function (client) {
  stripeClient = client;
};

module.exports._resetStripeClient = function () {
  stripeClient = null;
};
