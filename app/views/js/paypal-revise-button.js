const paypalButtonContainer = document.getElementById(
  "paypal-button-container"
);

if (
  paypalButtonContainer &&
  window.paypal &&
  typeof window.paypal.Buttons === "function"
) {
  const subscriptionId = paypalButtonContainer.dataset.paypalSubscriptionId;
  const planId = paypalButtonContainer.dataset.paypalPlanId;
  const reviseQuantity = paypalButtonContainer.dataset.paypalReviseQuantity;
  const redirectUrl = paypalButtonContainer.dataset.paypalRedirectUrl;

  if (subscriptionId && planId && reviseQuantity && redirectUrl) {
    window.paypal
      .Buttons({
        createSubscription: function (_data, actions) {
          return actions.subscription.revise(subscriptionId, {
            plan_id: planId,
            quantity: reviseQuantity,
          });
        },
        onApprove: function () {
          const form = document.querySelector("form");
          if (form) {
            form.innerHTML = "<p>Loading...</p>";
          }

          window.location.href = redirectUrl;
        },
      })
      .render("#paypal-button-container");
  }
}
