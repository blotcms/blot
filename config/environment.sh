# Copy this file to /etc/blot/environment.sh and fill it in

# Flags
export NODE_ENV=production
export BLOT_CACHE=true
export BLOT_MAINTENANCE=false
export BLOT_DEBUG=false

# Server configuration
export BLOT_HOST=
export BLOT_IP=
export BLOT_DIRECTORY=
export NODE_PATH=$(cd $BLOT_DIRECTORY/app; pwd)  # same as BLOT_DIRECTORY/app, but must be absolute
export BLOT_CACHE_DIRECTORY=

# Remove these eventually
export BLOT_PROTOCOL=https

# Redis configuration
export BLOT_REDIS_HOST=127.0.0.1

# Entry reads come from the per-entry Redis hash by default. Set this to
# "false" to force reads back onto the legacy JSON string key (migration
# rollback). Remove once the string keys have been purged.
# export BLOT_REDIS_READ_ENTRIES_FROM_HASH=false

# Name of linux user who runs the blot server
export BLOT_USER=

# Use latest stable version which passes tests
export BLOT_NODE_VERSION=22.14.0

# result of which pandoc
export BLOT_PANDOC_PATH=

# Scripts and variables used by Upstart
export BLOT_START=$BLOT_DIRECTORY/scripts/production/start_blot.sh
export BLOT_MAIN=$BLOT_DIRECTORY/app
export BLOT_LOG=$BLOT_DIRECTORY/logs/app.log

# Admin information
export BLOT_ADMIN_UID=
export BLOT_ADMIN_EMAIL=

# Required by node-zopfli library to work on AWS
# TODO: remove the need for this!
export LD_LIBRARY_PATH=/usr/local/lib64

# For taking screenshots
export PUPPETEER_PRODUCT=
export PUPPETEER_EXECUTABLE_PATH=

#############################################
#               S E C R E T S               #
#############################################

# Set this to a stable, randomly generated secret in production, for example:
#   openssl rand -hex 32
# If omitted, Blot warns and generates a secure process-local fallback; because
# that fallback changes at each restart, all existing dashboard sessions expire.
export BLOT_SESSION_SECRET=
export BLOT_BACKUP_SECRET=
export BLOT_WEBHOOKS_SECRET=

# Stripe for payment processing
export BLOT_STRIPE_KEY=
export BLOT_STRIPE_SECRET=

# Paypal for payment processing
export BLOT_PAYPAL_CLIENT_ID=
export BLOT_PAYPAL_SECRET=
export BLOT_PAYPAL_MONTHLY_4=
export BLOT_PAYPAL_YEARLY_44=
export BLOT_PAYPAL_MONTHLY_5=
export BLOT_PAYPAL_YEARLY_55=

# Dropbox for folder syncing
export BLOT_DROPBOX_APP_KEY=
export BLOT_DROPBOX_APP_SECRET=
export BLOT_DROPBOX_FULL_KEY=
export BLOT_DROPBOX_FULL_SECRET=

# Dropbox credentials for testing purposes
export BLOT_DROPBOX_TEST_ACCOUNT_ID=
export BLOT_DROPBOX_TEST_ACCOUNT_APP_TOKEN=
export BLOT_DROPBOX_TEST_ACCOUNT_FULL_TOKEN=

# Youtube for fetching video player codes
export BLOT_YOUTUBE_SECRET=

# AWS for uploading images to Blot's CDN
export BLOT_AWS_KEY=
export BLOT_AWS_SECRET=

# AWS for controlling route 53 for wildcard SSL certficate
export AWS_ACCESS_KEY_ID=
export AWS_SECRET_ACCESS_KEY=

# Mailgun for sending emails to customers
export BLOT_MAILGUN_KEY=

# Google Drive client for folder syncing
export BLOT_GOOGLEDRIVE_ID=
export BLOT_GOOGLEDRIVE_SECRET=
