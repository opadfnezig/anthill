import { SocksProxyAgent } from 'socks-proxy-agent';
import { HttpsProxyAgent } from 'https-proxy-agent';
import { readFileSync, existsSync } from 'fs';
import config from './config.js';

let proxies = [];
let idx = 0;

export function loadProxies() {
  if (existsSync(config.proxiesPath)) {
    proxies = JSON.parse(readFileSync(config.proxiesPath, 'utf-8'));
    console.log(`[proxy] loaded ${proxies.length} proxies`);
  }
}

export function getProxyCount() {
  return proxies.length;
}

export function getProxyByIndex(i) {
  if (!proxies.length) return null;
  return proxies[i % proxies.length];
}

export function getNextProxy() {
  if (!proxies.length) return null;
  const p = proxies[idx % proxies.length];
  idx++;
  return p;
}

export function createAgent(proxy) {
  if (!proxy) return null;

  // connection string: "socks5://user:pass@host:port"
  if (typeof proxy === 'string') {
    return proxy.startsWith('socks')
      ? new SocksProxyAgent(proxy)
      : new HttpsProxyAgent(proxy);
  }

  const { protocol = 'socks5', host, port, user, pass } = proxy;
  const auth = user ? `${user}:${pass}@` : '';
  const connStr = `${protocol}://${auth}${host}:${port}`;

  return protocol.startsWith('socks')
    ? new SocksProxyAgent(connStr)
    : new HttpsProxyAgent(connStr);
}

export function getNextAgent() {
  return createAgent(getNextProxy());
}

/**
 * Get next proxy config suitable for the given engine.
 * - axios: SOCKS5 (port from proxy.port, protocol socks5)
 * - puppeteer: HTTP (port from proxy.http_port or proxy.port, protocol http)
 * - fetch: null (no proxy support in undici)
 */
export function getNextProxyForEngine(engine) {
  if (engine === 'fetch') return null; // undici can't proxy
  const p = getNextProxy();
  if (!p) return null;

  if (engine === 'puppeteer') {
    // Puppeteer needs HTTP proxy, not SOCKS5
    // proxies.json may have http_port alongside socks5 port
    const httpPort = p.http_port || p.port;
    return { protocol: 'http', host: p.host, port: httpPort, user: p.user, pass: p.pass };
  }

  // axios — use as-is (socks5)
  return p;
}
