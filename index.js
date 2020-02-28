/**
 * Copyright 2020 Simo Ahava
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

'use strict';

// [START configuration]
const {google} = require('googleapis');
const {Storage} = require('@google-cloud/storage');
const config = require('./config.json');
const fs = require('fs');
const {promisify} = require('util');
const {IncomingWebhook} = require('@slack/webhook');
const prettyMs = require('pretty-ms');

const readFile = promisify(fs.readFile);
const webhooks = {};
// [END configuration]

// [START log]
/**
 * Helper function to log messages if verbose logging is enabled in config.
 *
 * @param {string} msg Message to log.
 */
const log = msg => {
  if (config.verboseLogging) console.log(msg);
};
// [END log]

// [START validateConfig]
/**
 * Checks if the config file has all the required components.
 *
 * @returns {object} Error message, if there was a problem with the config.
 */
const validateConfig = () => {
  let msg = '';
  if (!config.hasOwnProperty('gcs')) msg += 'config_missing_gcs;';
  if (config.gcs && !config.gcs.hasOwnProperty('bucketName')) msg += 'config_missing_gcs_bucketName;';
  if (config.gcs && !config.gcs.hasOwnProperty('fileName')) msg += 'config_missing_gcs_fileName;';
  if (!config.hasOwnProperty('slackOutput')) msg += 'config_missing_slackOutput;';
  if (config.slackOutput && config.slackOutput.length === 0) msg += 'config_missing_slackOutput_items;';
  if (config.slackOutput && config.slackOutput.filter(s => s['slackWebhookUrl'] && s['gtmContainers']).length !== config.slackOutput.length) msg += 'invalid_items_in_slackOutput;';
  return {
    error: msg !== '',
    errorMessage: msg
  };
};
// [END validateConfig]

// [START sendSlackMessage]
/**
 * Send message to slack using the incoming webhook URL
 *
 * @param {timestamp} lastChecked Timestamp when the version was last checked.
 * @param {object} data The container object from the GTM API response.
 * @param {string} webhookUrl URL to send the request to.
 */
const sendSlackMessage = async (lastChecked, data, webhookUrl) => {
  const now = new Date().getTime();
  const delta = now - lastChecked;
  return await webhooks[webhookUrl].send({
    attachments: [{
      fallback: `Container version ${data.containerVersionId} was recently published`,
      color: '#36a64f',
      pretext: 'A container version was recently published!',
      author_name: `${data.container.publicId}: ${data.container.name}`,
      title: `${data.containerVersionId}: ${data.name || '(no name)'}`,
      title_link: data.tagManagerUrl,
      text: `New published version found since last check (${prettyMs(delta)} ago).`,
      mrkdwn_in: ['text'],
      footer: 'by GTM Tools',
      ts: now / 1000
    }]
  });
};
// [END sendSlackMessage]

// [START addContainerToState]
/**
 * Update the state object with the accountId and containerId if not present.
 * @param gtmState
 * @param accountId
 * @param containerId
 * @returns {object} The updated state object.
 */
const addContainerToState = (gtmState, accountId, containerId) => {
  // Account ID missing, adding it to state
  if (!gtmState[accountId]) {
    gtmState[accountId] = {};
  }

  // Container ID missing, adding it to state
  gtmState[accountId][containerId] = gtmState[accountId][containerId] || {};
  return gtmState;
};
// [END addContainerToState]

// [START checkPublishedVersionIdAgainstState]
/**
 * Fetch live version from GTM API and check the version ID in the live version against the one in the state object.
 * @param {object} tagmanager The service object used with the GTM API
 * @param {string} webHookUrl Slack incoming webhook URL
 * @param {object} gtmState The state object
 * @param {string} accountId GTM account ID
 * @param {string} containerId GTM container ID
 */
const checkPublishedVersionIdAgainstState = async (tagmanager, webHookUrl, gtmState, accountId, containerId) => {
  // Fetch live version from API
  const res = await tagmanager.accounts.containers.versions.live({
    parent: `accounts/${accountId}/containers/${containerId}`
  });

  if (!gtmState[accountId][containerId]['containerVersionId']) {
    // Container hasn't been previously polled
    log(`${accountId}_${containerId}: Previous entry missing, setting the current version as the new entry.`);
  } else if (gtmState[accountId][containerId]['containerVersionId'] !== res.data.containerVersionId) {
    // Container version has changed between live version and the one in state
    log(`${accountId}_${containerId}: New version published since previous entry, notifying Slack.`);
    await sendSlackMessage(gtmState[accountId][containerId]['lastChecked'], res.data, webHookUrl);
  } else {
    // Container version has stayed the same
    log(`${accountId}_${containerId}: Published version same as previous entry, or new entry altogether.`);
  }
  // Update the latest version in the state object to the new, published version ID
  gtmState[accountId][containerId]['containerVersionId'] = res.data.containerVersionId;

  return gtmState;
};
// [END checkPublishedVersionIdAgainstState]

// [START getGtmInfo]
/**
 * Entry point for the Cloud Function. Triggered with a Pub/Sub Topic.
 */
exports.getGtmInfo = async () => {
  console.log('Validating config.json');
  const validated = validateConfig();
  if (validated.error) {
    console.error(`Invalid config.json: ${validated.errorMessage}`);
    return;
  }
  console.log('Validation successful.');

  const {bucketName, fileName} = config.gcs;
  const storage = new Storage();
  const destination = `/tmp/${fileName}`;
  let gtmState = {};

  console.log('Loading state from Cloud Storage.');
  try {
    await storage
      .bucket(bucketName)
      .file(fileName)
      .download({destination: `/tmp/${fileName}`});
    gtmState = JSON.parse(await readFile(destination));
    console.log('State file found and loaded successfully.');
  } catch(e) {
    console.log('State file not found, creating a new one.');
  }

  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/tagmanager.readonly']
  });
  const authClient = await auth.getClient();

  const tagmanager = google.tagmanager({
    version: 'v2',
    auth: authClient
  });

  for (const slack of config['slackOutput']) {
    const webHookUrl = slack['slackWebhookUrl'];
    log(`Starting operation for webhook URL ${webHookUrl}`);
    webhooks[webHookUrl] = new IncomingWebhook(webHookUrl);
    for (const gtmContainer of slack['gtmContainers']) {
      const [accountId, containerId] = gtmContainer.split('_');
      log(`${accountId}_${containerId}: Checking version state.`);

      // Make sure the container has an entry in the state object
      gtmState = addContainerToState(gtmState, accountId, containerId);

      // Live version ID check against stored ID
      gtmState = await checkPublishedVersionIdAgainstState(tagmanager, webHookUrl, gtmState, accountId, containerId);

      // Update the last checked time for the container in question to the current time
      gtmState[accountId][containerId]['lastChecked'] = new Date().getTime();
    }
  }
  console.log('Writing new state to Cloud Storage.');
  await storage
    .bucket(bucketName)
    .file(fileName)
    .save(JSON.stringify(gtmState, null, " "), {
      metadata: {contentType: 'application/json'}
    });
};
// [END getGtmInfo]
