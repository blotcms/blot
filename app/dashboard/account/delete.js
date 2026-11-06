var Express = require("express");
var Delete = new Express.Router();
var User = require("models/user");
var Email = require("helper/email");
var checkPassword = require("./util/checkPassword");
var logout = require("./util/logout");
var async = require("async");

var Blog = require("models/blog");
var config = require("config");
var prettyPrice = require("helper/prettyPrice");

var Stripe = require("stripe");

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

let stripeClient = null;

function getStripeClient() {
  if (!stripeClient) {
    stripeClient = Stripe(config.stripe.secret);
  }

  return stripeClient;
}

Delete.route("/")

  .get(function (req, res) {
    res.render("dashboard/account/delete", {
      title: "Delete your account",
      breadcrumb: "Delete",
    });
  })

  .post(
    checkPassword,
    issueDeletionRefund,
    deleteSubscription,
    deleteBlogs,
    deleteUser,
    emailUser,
    logout,
    function (req, res) {
      res.redirect("/sites/deleted");
    }
  );

function emailUser(req, res, next) {
  if (req.refund?.issued) {
    return Email.DELETED_FIRST_PERIOD(
      "",
      Object.assign({}, req.user, { refund: req.refund }),
      next
    );
  }

  Email.DELETED("", req.user, next);
}
function deleteBlogs(req, res, next) {
  async.each(
    req.user.blogs || [],
    function (blogID, cb) {
      Blog.remove(blogID, function (err) {
        if (
          err &&
          (err.message === "No blog" || err.message === "Invalid blog id")
        ) {
          console.warn("Blog cleanup anomaly; continuing account deletion", {
            uid: req.user && req.user.uid,
            blogID,
            reason: err.message,
          });
          return cb();
        }

        cb(err);
      });
    },
    next
  );
}

function deleteUser(req, res, next) {
  User.remove(req.user.uid, next);
}

async function deleteSubscription(req, res, next) {
  try {
    await ensureIssueDeletionRefund(req);

    if (req.user.paypal?.id) {
      const cancellablePaypalStatuses = ["ACTIVE", "SUSPENDED"];
      const paypalStatus = String(req.user.paypal?.status || "").toUpperCase();

      if (cancellablePaypalStatuses.includes(paypalStatus)) {
        const response = await fetch(
          `${config.paypal.api_base}/v1/billing/subscriptions/${req.user.paypal.id}/cancel`,
          {
            method: "POST",
            headers: {
              Authorization: buildPaypalAuthHeader(),
              "Content-Type": "application/json",
            },
            body: JSON.stringify({
              reason: "Customer deleted account",
            }),
          }
        );

        if (response.status !== 204) {
          throw await paypalError(response, "PayPal API error");
        }

        console.log("PayPal subscription canceled");
      } else {
        console.log(
          `Skipping PayPal cancellation: subscription is already non-cancellable (status: ${paypalStatus || "MISSING"})`
        );
      }
    } else if (req.user.subscription?.customer) {
      const client = getStripeClient();

      if (!client?.customers?.del) {
        throw new Error("Stripe client unavailable");
      }

      let deleted;

      try {
        deleted = await client.customers.del(req.user.subscription.customer);
      } catch (error) {
        if (isStripeCustomerMissingError(error)) {
          console.warn(
            "Stripe customer already missing; continuing account deletion",
            {
              customer: req.user.subscription.customer,
              code: error.code,
              type: error.type,
              statusCode: error.statusCode,
            }
          );
          deleted = { deleted: true };
        } else {
          throw error;
        }
      }

      if (!deleted || deleted.deleted !== true) {
        throw new Error("Stripe customer not deleted");
      }

      console.log("Stripe customer deleted");
    }

    if (typeof next === "function") {
      next();
    }
  } catch (error) {
    console.error("Error in deleting subscription:", error);
    if (typeof next === "function") {
      next(error);
    } else {
      throw error;
    }
  }
}

async function issueDeletionRefund(req, res, next) {
  try {
    await ensureIssueDeletionRefund(req);
  } catch (error) {
    console.error("Error issuing deletion refund:", error);
    recordRefundError(req, undefined, error);
  }

  if (typeof next === "function") {
    next();
  }
}

async function ensureIssueDeletionRefund(req) {
  if (!req?.user) return;

  if (req.issueDeletionRefundHandled) return;

  req.issueDeletionRefundHandled = true;

  try {
    const now = Date.now();

    const stripeCreatedMs = toMs(req.user.subscription?.created);
    const paypalStartMs = toMs(req.user.paypal?.start_time);

    const stripeEligible = Boolean(
      req.user.subscription?.customer &&
      stripeCreatedMs &&
      now - stripeCreatedMs <= THIRTY_DAYS_MS
    );

    const paypalEligible = Boolean(
      req.user.paypal?.id &&
      paypalStartMs &&
      now - paypalStartMs <= THIRTY_DAYS_MS
    );

    if (!stripeEligible && !paypalEligible) return;

    if (stripeEligible) {
      try {
        const issued = await issueStripeRefund(req, now);
        if (issued) return;
      } catch (error) {
        console.error("Stripe refund failed:", error);
        recordRefundError(req, "stripe", error);
      }
    }

    if (paypalEligible) {
      try {
        await issuePaypalRefund(req, now, paypalStartMs);
      } catch (error) {
        console.error("PayPal refund failed:", error);
        recordRefundError(req, "paypal", error);
      }
    }
  } catch (error) {
    console.error("Unexpected refund error:", error);
    recordRefundError(req, undefined, error);
  }
}

async function issueStripeRefund(req, now) {
  const client = getStripeClient();

  if (!client?.invoices?.list || !client?.refunds?.create) {
    throw new Error("Stripe client unavailable");
  }

  const invoicesResponse = await client.invoices.list({
    customer: req.user.subscription.customer,
    limit: 100,
  });

  const eligibleInvoices = (invoicesResponse?.data || [])
    .filter((invoice) => invoice && invoice.paid && invoice.charge)
    .map((invoice) => ({ invoice, createdMs: toMs(invoice.created) }))
    .filter(
      ({ createdMs }) =>
        typeof createdMs === "number" && now - createdMs <= THIRTY_DAYS_MS
    );

  if (!eligibleInvoices.length) return false;

  const { invoice: targetInvoice, createdMs: invoiceCreatedMs } =
    eligibleInvoices.reduce((latest, current) => {
      if (!latest) return current;

      return current.createdMs >= latest.createdMs ? current : latest;
    }, null);

  if (!invoiceCreatedMs) return false;

  const refund = await client.refunds.create({
    charge: targetInvoice.charge,
    reason: "requested_by_customer",
  });

  if (!refund) return false;

  const currency = refund.currency ? refund.currency.toUpperCase() : undefined;
  const amount = refund.amount;

  req.refund = {
    issued: true,
    provider: "stripe",
    providerPretty: "Stripe",
    id: refund.id,
    invoice: targetInvoice.id,
    charge: targetInvoice.charge,
    amount,
    currency,
    amountPretty: formatAmount(amount, currency),
  };

  return true;
}

async function issuePaypalRefund(req, now, startMs) {
  if (!config.paypal?.client_id || !config.paypal?.secret) {
    throw new Error("PayPal credentials unavailable");
  }

  const authHeader = buildPaypalAuthHeader();
  const startTime = new Date(startMs).toISOString();
  const endTime = new Date(now).toISOString();
  const transactionsUrl =
    `${config.paypal.api_base}/v1/billing/subscriptions/${req.user.paypal.id}/transactions` +
    `?start_time=${encodeURIComponent(startTime)}&end_time=${encodeURIComponent(endTime)}`;

  const transactionsResponse = await fetch(transactionsUrl, {
    headers: { Authorization: authHeader },
  });

  if (!transactionsResponse.ok) {
    throw await paypalError(transactionsResponse, "PayPal API error");
  }

  const transactions = await transactionsResponse.json();
  const capture = selectMostRecentCapture(transactions?.transactions || []);

  if (!capture) return false;

  const captureId =
    capture.capture_id ||
    capture.id ||
    capture.transaction_id ||
    capture.resource_id;

  if (!captureId) return false;

  const refundResponse = await fetch(
    `${config.paypal.api_base}/v2/payments/captures/${captureId}/refund`,
    {
      method: "POST",
      headers: {
        Authorization: authHeader,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({}),
    }
  );

  if (!refundResponse.ok) {
    throw await paypalError(refundResponse, "PayPal refund error");
  }

  const refund = await refundResponse.json();

  const amountInfo =
    refund.amount ||
    refund.seller_payable_breakdown?.gross_amount ||
    refund.seller_payable_breakdown?.net_amount ||
    capture.amount_with_breakdown?.gross_amount ||
    capture.amount;

  const rawCurrency =
    amountInfo?.currency_code ||
    amountInfo?.currency ||
    req.user.paypal?.currency;
  const currency = rawCurrency ? rawCurrency.toUpperCase() : undefined;
  const amountValue =
    amountInfo?.value ??
    amountInfo?.total ??
    amountInfo?.amount ??
    amountInfo?.gross;

  const amountCents = toCents(amountValue);

  req.refund = {
    issued: true,
    provider: "paypal",
    providerPretty: "PayPal",
    id: refund.id,
    capture: captureId,
    amount: amountCents ?? amountValue,
    currency,
    amountPretty:
      formatAmount(amountCents, currency) ||
      (amountValue && currency ? `${amountValue} ${currency}` : undefined),
  };

  return true;
}

function selectMostRecentCapture(transactions) {
  return transactions
    .filter((transaction) => {
      if (!transaction) return false;

      const status = transaction.status || transaction.transaction_status;
      return typeof status === "string" && status.toUpperCase() === "COMPLETED";
    })
    .reduce((latest, transaction) => {
      const transactionTime = toMs(
        transaction.time || transaction.transaction_time
      );
      const latestTime = toMs(latest?.time || latest?.transaction_time) || 0;

      if (!latest) return transaction;

      return (transactionTime || 0) >= latestTime ? transaction : latest;
    }, null);
}

function formatAmount(amount, currency) {
  const upperCurrency = currency ? currency.toUpperCase() : currency;

  if (typeof amount === "number" && Number.isFinite(amount)) {
    if (!upperCurrency || upperCurrency === "USD") {
      return prettyPrice(amount);
    }

    const value = (amount / 100).toFixed(2);
    return `${value} ${upperCurrency}`.trim();
  }

  if (typeof amount === "string" && amount !== "") {
    const numeric = Number(amount);

    if (Number.isFinite(numeric)) {
      return formatAmount(Math.round(numeric * 100), upperCurrency);
    }

    return upperCurrency ? `${amount} ${upperCurrency}` : amount;
  }

  return undefined;
}

function toMs(timestamp) {
  if (!timestamp) return null;

  if (timestamp instanceof Date) return timestamp.getTime();

  if (typeof timestamp === "number") {
    if (!Number.isFinite(timestamp)) return null;

    return timestamp < 1e12 ? timestamp * 1000 : timestamp;
  }

  if (typeof timestamp === "string") {
    const parsed = Date.parse(timestamp);

    return Number.isNaN(parsed) ? null : parsed;
  }

  return null;
}

function toCents(value) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value * 100);
  }

  if (typeof value === "string" && value !== "") {
    const numeric = Number(value);

    return Number.isFinite(numeric) ? Math.round(numeric * 100) : null;
  }

  return null;
}

function buildPaypalAuthHeader() {
  return `Basic ${Buffer.from(
    `${config.paypal.client_id}:${config.paypal.secret}`
  ).toString("base64")}`;
}

async function paypalError(response, prefix, bodyOverride, textOverride) {
  let message = `${prefix}: ${response.status}`;
  let body = bodyOverride;
  let text = textOverride;

  if (!body) {
    try {
      body = await response.json();
    } catch (_) {}
  }

  if (!text && body) {
    try {
      text = JSON.stringify(body);
    } catch (_) {}
  }

  if (!text) {
    try {
      text = await response.text();
    } catch (_) {}
  }

  if (body?.message) {
    message = `${prefix}: ${body.message}`;
  } else if (body?.name || body?.details) {
    message = `${prefix}: ${body.name || ""} ${
      Array.isArray(body?.details)
        ? body.details
            .map((detail) => detail.issue || detail.description)
            .filter(Boolean)
            .join(", ")
        : ""
    }`.trim();
  } else if (text) {
    message = `${prefix}: ${text}`;
  }

  const error = new Error(message);

  if (body?.name && !error.code) {
    error.code = body.name;
  }

  if (Array.isArray(body?.details) && !error.details) {
    error.details = body.details;
  }

  return error;
}

function getProviderPretty(provider) {
  if (provider === "stripe") return "Stripe";
  if (provider === "paypal") return "PayPal";
  return provider;
}

function recordRefundError(req, provider, error, extra) {
  if (!req) return;

  if (req.refund?.issued) return;

  const message = normalizeErrorMessage(error);
  const base = req.refund && !req.refund.issued ? req.refund : {};
  const updates = Object.assign({ issued: false, skipped: true }, extra || {});

  if (message && updates.error === undefined) {
    updates.error = message;
  }

  if (provider && !updates.provider) {
    updates.provider = provider;
  }

  if (provider && !updates.providerPretty) {
    updates.providerPretty = getProviderPretty(provider);
  }

  req.refund = Object.assign({}, base, updates);
}

function normalizeErrorMessage(error) {
  if (!error) return undefined;
  if (typeof error === "string") return error;
  if (error && typeof error.message === "string") return error.message;
  try {
    return JSON.stringify(error);
  } catch (_) {
    return String(error);
  }
}

function isStripeCustomerMissingError(error) {
  if (!error) return false;

  return (
    error.type === "StripeInvalidRequestError" &&
    error.code === "resource_missing" &&
    (error.statusCode === undefined || error.statusCode === 404)
  );
}

// We expose these methods for our scripts
// Hopefully this does not clobber anything in
// the exposed Express application?

if (Delete.exports !== undefined)
  throw new Error(
    "Delete.exports is defined (typeof=" +
      typeof Delete.exports +
      ") Would clobber Delete.exports"
  );

Delete.exports = {
  blogs: deleteBlogs,
  user: deleteUser,
  subscription: deleteSubscription,
  refund: issueDeletionRefund,
  email: emailUser,
  ensureRefund: ensureIssueDeletionRefund,
};

Delete._setStripeClient = function (client) {
  stripeClient = client;
};

Delete._resetStripeClient = function () {
  stripeClient = null;
};

module.exports = Delete;
