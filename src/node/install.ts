/**
 * Copyright 2020 Google Inc. All rights reserved.
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

import https, { RequestOptions } from 'https';
import ProgressBar from 'progress';
import URL from 'url';
import puppeteer from '../node.js';
import { PUPPETEER_REVISIONS } from '../revisions.js';
import { PuppeteerNode } from './Puppeteer.js';
import createHttpsProxyAgent, {
  HttpsProxyAgentOptions,
} from 'https-proxy-agent';
import { getProxyForUrl } from 'proxy-from-env';

const supportedProducts = {
  chrome: 'Chromium',
  firefox: 'Firefox Nightly',
} as const;

function getProduct(input: string): 'chrome' | 'firefox' {
  if (input !== 'chrome' && input !== 'firefox') {
    throw new Error(`Unsupported product ${input}`);
  }
  return input;
}

export async function downloadBrowser(): Promise<void> {
  const downloadHost =
    process.env['PUPPETEER_DOWNLOAD_HOST'] ||
    process.env['npm_config_puppeteer_download_host'] ||
    process.env['npm_package_config_puppeteer_download_host'];
  const product = getProduct(
    process.env['PUPPETEER_PRODUCT'] ||
      process.env['npm_config_puppeteer_product'] ||
      process.env['npm_package_config_puppeteer_product'] ||
      'chrome'
  );
  const downloadPath =
    process.env['PUPPETEER_DOWNLOAD_PATH'] ||
    process.env['npm_config_puppeteer_download_path'] ||
    process.env['npm_package_config_puppeteer_download_path'];
  const browserFetcher = (puppeteer as PuppeteerNode).createBrowserFetcher({
    product,
    host: downloadHost,
    path: downloadPath,
  });
  const revision = await getRevision();
  await fetchBinary(revision);

  async function getRevision(): Promise<string> {
    if (product === 'chrome') {
      return (
        process.env['PUPPETEER_CHROMIUM_REVISION'] ||
        process.env['npm_config_puppeteer_chromium_revision'] ||
        PUPPETEER_REVISIONS.chromium
      );
    } else if (product === 'firefox') {
      (puppeteer as PuppeteerNode)._preferredRevision =
        PUPPETEER_REVISIONS.firefox;
      return getFirefoxNightlyVersion().catch((error) => {
        console.error(error);
        process.exit(1);
      });
    } else {
      throw new Error(`Unsupported product ${product}`);
    }
  }

  function fetchBinary(revision: string) {
    const revisionInfo = browserFetcher.revisionInfo(revision);

    // Do nothing if the revision is already downloaded.
    if (revisionInfo.local) {
      logPolitely(
        `${supportedProducts[product]} is already in ${revisionInfo.folderPath}; skipping download.`
      );
      return;
    }

    // Override current environment proxy settings with npm configuration, if any.
    const NPM_HTTPS_PROXY =
      process.env['npm_config_https_proxy'] || process.env['npm_config_proxy'];
    const NPM_HTTP_PROXY =
      process.env['npm_config_http_proxy'] || process.env['npm_config_proxy'];
    const NPM_NO_PROXY = process.env['npm_config_no_proxy'];

    if (NPM_HTTPS_PROXY) process.env['HTTPS_PROXY'] = NPM_HTTPS_PROXY;
    if (NPM_HTTP_PROXY) process.env['HTTP_PROXY'] = NPM_HTTP_PROXY;
    if (NPM_NO_PROXY) process.env['NO_PROXY'] = NPM_NO_PROXY;

    function onSuccess(localRevisions: string[]): void {
      logPolitely(
        `${supportedProducts[product]} (${revisionInfo.revision}) downloaded to ${revisionInfo.folderPath}`
      );
      localRevisions = localRevisions.filter(
        (revision) => revision !== revisionInfo.revision
      );
      const cleanupOldVersions = localRevisions.map((revision) =>
        browserFetcher.remove(revision)
      );
      Promise.all([...cleanupOldVersions]);
    }

    function onError(error: Error) {
      console.error(
        `ERROR: Failed to set up ${supportedProducts[product]} r${revision}! Set "PUPPETEER_SKIP_DOWNLOAD" env variable to skip download.`
      );
      console.error(error);
      process.exit(1);
    }

    let progressBar: ProgressBar | null = null;
    let lastDownloadedBytes = 0;
    function onProgress(downloadedBytes: number, totalBytes: number) {
      if (!progressBar) {
        progressBar = new ProgressBar(
          `Downloading ${
            supportedProducts[product]
          } r${revision} - ${toMegabytes(totalBytes)} [:bar] :percent :etas `,
          {
            complete: '=',
            incomplete: ' ',
            width: 20,
            total: totalBytes,
          }
        );
      }
      const delta = downloadedBytes - lastDownloadedBytes;
      lastDownloadedBytes = downloadedBytes;
      progressBar.tick(delta);
    }

    return browserFetcher
      .download(revisionInfo.revision, onProgress)
      .then(() => browserFetcher.localRevisions())
      .then(onSuccess)
      .catch(onError);
  }

  function toMegabytes(bytes: number) {
    const mb = bytes / 1024 / 1024;
    return `${Math.round(mb * 10) / 10} Mb`;
  }

  async function getFirefoxNightlyVersion(): Promise<string> {
    const firefoxVersionsUrl =
      'https://product-details.mozilla.org/1.0/firefox_versions.json';

    const proxyURL = getProxyForUrl(firefoxVersionsUrl);

    const requestOptions: RequestOptions = {};

    if (proxyURL) {
      const parsedProxyURL = URL.parse(proxyURL);

      const proxyOptions = {
        ...parsedProxyURL,
        secureProxy: parsedProxyURL.protocol === 'https:',
      } as HttpsProxyAgentOptions;

      requestOptions.agent = createHttpsProxyAgent(proxyOptions);
      requestOptions.rejectUnauthorized = false;
    }

    const promise = new Promise<string>((resolve, reject) => {
      let data = '';
      logPolitely(
        `Requesting latest Firefox Nightly version from ${firefoxVersionsUrl}`
      );
      https
        .get(firefoxVersionsUrl, requestOptions, (r) => {
          if (r.statusCode && r.statusCode >= 400)
            return reject(new Error(`Got status code ${r.statusCode}`));
          r.on('data', (chunk) => {
            data += chunk;
          });
          r.on('end', () => {
            try {
              const versions = JSON.parse(data);
              return resolve(versions.FIREFOX_NIGHTLY);
            } catch {
              return reject(new Error('Firefox version not found'));
            }
          });
        })
        .on('error', reject);
    });
    return promise;
  }
}

export function logPolitely(toBeLogged: unknown): void {
  const logLevel = process.env['npm_config_loglevel'] || '';
  const logLevelDisplay = ['silent', 'error', 'warn'].indexOf(logLevel) > -1;

  // eslint-disable-next-line no-console
  if (!logLevelDisplay) console.log(toBeLogged);
}
