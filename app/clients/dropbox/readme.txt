Dropbox client
--------------

This client synchronizes a folder in a Dropbox folder with a folder on Blot's server. It does this using Dropbox's webhook api and subsequent calls to filesListFolder, which accepts a cursor indicating the state of the folder at the last fetch. 

The webhooks are now tunnelled through webhooks.blot.im using the server in clients/webhooks.js

Dependencies
------------

    "dropbox": "^2.5.7",
    "dropbox-stream"
    
Move this into this module when I start using git submodules or npm submodules properly.


Complications
-------------

This client is fairly complicated. The complications mostly self imposed and partly due to the design Dropbox. Some of these complications are caused by the distinction between full and partial Dropbox access for Blot.

* Partial permission (known as an App folder)
  -------------------------------------------

  This method has obvious benefits and subtle limitations. The limitations are as follows: 
    1. Dropbox prevents users from sharing app folders as of May 2018.
    2. Dropbox also does not let you choose where the folder is located (it must be in /Apps).

* Allowing customers to use the entire app folder for their first blog
  ----------------------------------------------------------------

  Given that we will allow folks to use Dropbox's app folder feature, we need to work out how to let customers manage one or multiple blogs from a single app folder. The obvious solution, used by a lot of Blot's competitors, is to create a subfolder for the blog. But when the customer has one blog, I don't like the idea of the Blot directory containing a single subdirectory. So for their first blog, the folder looks like. Then when the customer creates a second blog in the app folder, restructure the folder like so:

Features
--------

- This client needs to properly acquire and release a lock on the blog's folder when modifying the client. 
- This client aqcuires then release the sync lock when it disconnects...
- App folder permissions
  - Can recover from the customer deleting then restoring a folder inside the app folder
- Full folder permissions
  - Can recover from customer moving blog folder
  - Can recover from customer removing then restoring blog folder

Authentication routes
---------------------

If the blog does have an existing Dropbox account

  If the app and account have not changed, then save the new token and email address and sync.

  If the account has changed offer customer a choice to migrate files from existing account or reset folder state to empty and sync

If the blog does not have an existing Dropbox acccount connected to it

  - If using an app folder

      if there is already a blog in the account,
        then tell the user that blot will move all the existing files into a sub directory, offer them a choice of name for the existing folder
        and a choice of name for the new folder

      if this is the first blog attached to this account
      then set the root as '/'

  - if using the full folder, then offer them the choice of folder for their blog


4. Authentication to a different client (e.g. from full to app folder)







Issues
------

What about the problem of downloading large files from Dropbox? Or slow writes?


Notes
-----

5/22/18 - I recently started to simplify some of the code for this client. For example, I have removed the option to switch to a different Dropbox account: this should now be done by disconnecting and reconnecting. I have also removed the interstitial page to disconnect from Dropbox. Perhaps I should work out how to include an undo button?

Errors from Dropbox
-------------------

// The purpose of this module is to
// take an error which occurs during the
// sync process, notify the customer and me
// if appropriate, then determine whether
// it is worth attempting the sync again.

// Refer to error codes in docs here:
// https://www.dropbox.com/developers/core/docs

// Ensure that any error that makes it here
// is actually an instance of an error.
var ensure = require("helper/ensure");
var email = require("helper/email");

module.exports = function(uid, log, options) {
  ensure(uid, "string")
    .and(log, "function")
    .and(options, "object");

  return function handler(error) {
    error = error || {};

    var code = error.status,
      tryAgain = false;

    // Network error, new sync after a bit
    if (code === 0 || code === 500 || code === 504) {
      email.NETWORK_ERROR(uid);
      log("Network error accessing Dropbox API: " + code);
      tryAgain = true;
    }

    // Hitting rate limits, try again after delay
    // specified in error.Retry-After ?
    if (code === 429 || code === 503) {
      email.RATE_LIMIT(uid);
      log("Rate limit error accessing Dropbox API: " + code);
      tryAgain = true;
    }

    // User is over their dropbox storage quota
    if (code === 507) {
      email.NO_SPACE(uid);
      log("No space in Dropbox folder: " + code);
    }

    // Blot is sending bad requests
    if (code === 400 || code === 403) {
      email.BAD_REQUEST(uid);
      log("Bad request to Dropbox API: " + code);
    }

    // The user's dropbox access token has
    // expired or been revoked. This can be
    // fixed if the user visits /auth
    if (code === 401) {
      email.REVOKED(uid);
      log("Dropbox access token is invalid: " + code);
    }

    // Flag the error if Blot
    // should try and sync again
    error.tryAgain = tryAgain;
    return error;
  };
};


{ error: '',
  response:
   Body {
     url: 'https://api.dropboxapi.com/2/files/list_folder/continue',
     status: 500,
     statusText: 'Internal Server Error',
     headers: Headers { _headers: [Object] },
     ok: false,
     body:
      PassThrough {
        _readableState: [Object],
        readable: false,
        domain: null,
        _events: [Object],
        _eventsCount: 4,
        _maxListeners: undefined,
        _writableState: [Object],
        writable: false,
        allowHalfOpen: true,
        _transformState: [Object] },
     bodyUsed: true,
     size: 0,
     timeout: 0,
     _raw: [],
     _abort: false,
     _bytes: 0 },
  status: 500 }
