import axios from 'axios';
import { getRandomUA } from '../user-agents.js';
import { createAgent, getNextProxy } from '../proxy.js';
import config from '../config.js';

// Chrome-like headers for sites with WAF (CloudFront, Cloudflare)
const CHROME_HEADERS = {
  'sec-ch-ua': '"Chromium";v="120", "Google Chrome";v="120", "Not:A-Brand";v="99"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"Windows"',
  'Sec-Fetch-Dest': 'document',
  'Sec-Fetch-Mode': 'navigate',
  'Sec-Fetch-Site': 'none',
  'Sec-Fetch-User': '?1',
  'Upgrade-Insecure-Requests': '1',
};

/**
 * Fetch via axios. Default engine — works for static HTML, JSON APIs.
 * Supports SOCKS5/HTTP proxies.
 */
export async function fetchWithAxios(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    proxy,
    timeout = config.defaultTimeout,
    responseType = 'text',
    maxRedirects = 5,
    chromeHeaders = false,
  } = opts;

  const agent = resolveAgent(proxy);

  const reqConfig = {
    method,
    url,
    headers: {
      'User-Agent': getRandomUA(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      ...(chromeHeaders ? CHROME_HEADERS : {}),
      ...headers,
    },
    timeout,
    maxRedirects,
    responseType: responseType === 'binary' ? 'arraybuffer' : 'text',
    validateStatus: () => true,
  };

  if (agent) {
    reqConfig.httpsAgent = agent;
    reqConfig.httpAgent = agent;
  }

  if (body) reqConfig.data = body;

  const start = Date.now();
  const res = await axios(reqConfig);

  let resBody = res.data;
  if (responseType === 'binary') {
    resBody = Buffer.from(res.data).toString('base64');
  }

  return {
    url: res.request?.res?.responseUrl || url,
    statusCode: res.status,
    headers: res.headers,
    body: resBody,
    contentType: res.headers['content-type'] || '',
    timing: { duration: Date.now() - start },
  };
}

/**
 * Fetch via Node built-in fetch (undici). Different TLS fingerprint than axios.
 * Useful for bypassing WAFs that fingerprint TLS (e.g. CloudFront on OLX).
 * Does NOT support SOCKS5 proxies — use axios or puppeteer for that.
 */
export async function fetchWithUndici(url, opts = {}) {
  const {
    method = 'GET',
    headers = {},
    body,
    timeout = config.defaultTimeout,
    chromeHeaders = false,
  } = opts;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  const start = Date.now();
  try {
    const res = await globalThis.fetch(url, {
      method,
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        ...(chromeHeaders ? CHROME_HEADERS : {}),
        ...headers,
      },
      body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
      signal: controller.signal,
      redirect: 'follow',
    });

    const resBody = await res.text();
    const resHeaders = Object.fromEntries(res.headers.entries());

    return {
      url: res.url,
      statusCode: res.status,
      headers: resHeaders,
      body: resBody,
      contentType: resHeaders['content-type'] || '',
      timing: { duration: Date.now() - start },
    };
  } finally {
    clearTimeout(timer);
  }
}

function resolveAgent(proxyOpt) {
  if (proxyOpt === true) return createAgent(getNextProxy());
  if (proxyOpt && typeof proxyOpt === 'object') return createAgent(proxyOpt);
  if (typeof proxyOpt === 'string') return createAgent(proxyOpt);
  return null;
}
