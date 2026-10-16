module.exports = {
  uids: "uids",

  user: function (uid) {
    return "user:" + uid + ":info";
  },

  accessToken: function (token) {
    return "token:" + token;
  },

  email: function (email) {
    return "email:" + email;
  },

  customer: function (customer) {
    return "customer:" + customer;
  },

  paypal: function (subscriptionId) {
    return "paypal:" + subscriptionId;
  },

  paypalCancelEmail: function (uid, subscriptionId) {
    return "user:" + uid + ":paypal_cancel_email:" + subscriptionId;
  }
};
