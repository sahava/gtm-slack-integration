# gtm-slack-integration
This is a **node.js** project designed to be run with [Google Cloud Functions](https://cloud.google.com/functions).

## How it works
Once the app is running as a Cloud Function, each time the function is invoked, it will go through all the Google Tag Manager **containers** listed in the `config.json` file, and query Google Tag Manager's API for what the most recent published version is.

If this version differs from the one in state (stored in a Google Cloud Storage file), a Slack message is pushed notifying about this.

## What you'll need
Here are the things you need to have in order for the setup to work:

- Google Cloud Platform project with **billing enabled**.
- **Cloud Functions API** and **Tag Manager API** enabled in the project.
- A **service account** (you can use the default SA created by the Cloud Functions API) added as a **READ** user to each Google Tag Manager container you want to audit for changes to the published version.
- A [Slack app](https://api.slack.com/apps) per Slack workspace you want to publish messages to.
- An [Incoming Webhook](https://api.slack.com/messaging/webhooks) per GTM account/container, which forwards the message sent by the app to a given channel (or direct message) in the workspace.

It's also recommended to install the [`gcloud`](https://cloud.google.com/pubsub/docs/quickstart-cli) command-line tool.

## How to set it up
The instructions for setting up the integration are detailed in [this blog post](https://www.simoahava.com/analytics/create-slack-notification-system-google-tag-manager-changes/)..
