var MODEL = {
  uid: "string",
  email: "string",
  blogs: "array",
  isDisabled: "boolean",
  lastSession: "string",
  created: "number",
  welcomeEmailSent: "boolean",
  passwordHash: "string",
  subscription: "object",
  paypal: "object",
  paymentMethods: "array",
  // When paymentMethods was last read from Stripe (0: never)
  paymentMethodsSyncedAt: "number",
};

module.exports = MODEL;
