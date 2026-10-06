module.exports = function (req, res, next) {
  // we failed to extract the updates from the request body
  if (!req.updates || !req.updates.plugins || !req.updates.plugins.analytics)
    return next();

  // the user does not want to enable analytics
  if (!req.updates.plugins.analytics.enabled) return next();

  const { options } = req.updates.plugins.analytics;
  const { provider, trackingID } = options;

  // we want to detect if the tracking ID for the analytics service
  // has been submitted, and if so, we want to validate the ID
  // if the user has incorrectly pasted in their embed code, we want to
  // automatically extract the tracking ID from the embed code
  // for example, clicky's embed code looks like:
  // <a title="Google Analytics Alternative" href="http://clicky.com/100788619"><img alt="Google Analytics Alternative" src="//static.getclicky.com/media/links/badge.gif" border="0" /></a>
  // <script src="//static.getclicky.com/js" type="text/javascript"></script>
  // <script type="text/javascript">try{ clicky.init(100788619); }catch(e){}</script>
  // we want to extract the tracking ID from the clicky.init() call, which in this case is 100788619

  //  options: { provider: { Cloudflare: 'selected' }, trackingID: '2222211311' }

  if (
    provider.Clicky === "selected" &&
    trackingID.match(/clicky.init\((.*)\);/)
  ) {
    const fixedTrackingID = trackingID.match(/clicky.init\((.*)\);/)[1];

    // validate the tracking ID
    // https://clicky.com/help/customization#tracking_code
    if (!fixedTrackingID.match(/^\d{9}$/g)) {
      return next(
        new Error("The tracking ID you entered is invalid. Please try again.")
      );
    }

    // overwrite the tracking ID with the fixed version
    req.updates.plugins.analytics.options.trackingID = fixedTrackingID;
  }

  next();
};
