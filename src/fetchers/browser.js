import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { getRandomUA } from '../user-agents.js';
import config from '../config.js';

puppeteer.use(StealthPlugin());

// Browser pool keyed by proxy string (or 'default')
const browsers = new Map();

async function getBrowser(proxyStr) {
  const key = proxyStr || 'default';
  if (browsers.has(key) && browsers.get(key).connected) {
    return browsers.get(key);
  }

  const args = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--disable-features=IsolateOrigins,site-per-process',
  ];

  if (proxyStr) {
    args.push(`--proxy-server=${proxyStr}`);
  }

  const browser = await puppeteer.launch({
    headless: config.puppeteer.headless ? 'new' : false,
    executablePath: config.puppeteer.executablePath,
    args,
  });

  browsers.set(key, browser);
  return browser;
}

function buildProxyStr(proxy) {
  if (!proxy) return null;
  if (typeof proxy === 'string') return proxy;
  const { protocol = 'socks5', host, port } = proxy;
  return `${protocol}://${host}:${port}`;
}

export async function fetchBrowser(url, opts = {}) {
  const {
    headers = {},
    proxy,
    timeout = config.defaultTimeout,
    waitFor,
    waitTimeout = 10000,
    screenshot = false,
    pdf = false,
    fullPage = true,
    viewport = { width: 1920, height: 1080 },
    actions = [],
    cookies = [],
    userAgent,
  } = opts;

  const proxyStr = buildProxyStr(proxy);
  const browser = await getBrowser(proxyStr);
  const page = await browser.newPage();
  const start = Date.now();

  try {
    await page.setViewport(viewport);
    await page.setUserAgent(userAgent || headers['User-Agent'] || getRandomUA());

    // Extra HTTP headers (strip User-Agent since it's set separately)
    const { 'User-Agent': _, ...extraHeaders } = headers;
    if (Object.keys(extraHeaders).length) {
      await page.setExtraHTTPHeaders(extraHeaders);
    }

    // Proxy auth
    if (proxy && typeof proxy === 'object' && proxy.user) {
      await page.authenticate({ username: proxy.user, password: proxy.pass });
    }

    // Cookies
    if (cookies.length) {
      await page.setCookie(...cookies);
    }

    // Navigate
    const response = await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout,
    });

    // Wait for selector
    if (waitFor) {
      await page.waitForSelector(waitFor, { timeout: waitTimeout });
    }

    // Execute actions sequence
    for (const action of actions) {
      await executeAction(page, action);
    }

    // Collect result
    const body = await page.content();
    const result = {
      url: page.url(),
      statusCode: response?.status() || 0,
      headers: response?.headers() || {},
      body,
      contentType: response?.headers()['content-type'] || 'text/html',
      cookies: await page.cookies(),
      timing: { duration: Date.now() - start },
    };

    if (screenshot) {
      result.screenshot = await page.screenshot({
        encoding: 'base64',
        fullPage,
      });
    }

    if (pdf) {
      const pdfBuf = await page.pdf();
      result.pdf = pdfBuf.toString('base64');
    }

    return result;
  } finally {
    await page.close();
  }
}

async function executeAction(page, action) {
  switch (action.type) {
    case 'click':
      await page.click(action.selector);
      break;
    case 'type':
      await page.type(action.selector, action.text, { delay: action.delay || 0 });
      break;
    case 'wait':
      await new Promise(r => setTimeout(r, action.ms || 1000));
      break;
    case 'waitForSelector':
      await page.waitForSelector(action.selector, { timeout: action.timeout || 10000 });
      break;
    case 'waitForNavigation':
      await page.waitForNavigation({ timeout: action.timeout || 10000 });
      break;
    case 'scroll':
      await page.evaluate((dir) => {
        window.scrollBy(0, dir === 'up' ? -window.innerHeight : window.innerHeight);
      }, action.direction || 'down');
      break;
    case 'evaluate':
      await page.evaluate(action.script);
      break;
    case 'select':
      await page.select(action.selector, action.value);
      break;
    case 'screenshot':
      // mid-flow screenshot, stored in action result
      action.result = await page.screenshot({ encoding: 'base64', fullPage: action.fullPage });
      break;
  }
}

export async function closeBrowsers() {
  for (const [key, browser] of browsers) {
    try { await browser.close(); } catch {}
    browsers.delete(key);
  }
}
