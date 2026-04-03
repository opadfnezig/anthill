import { Worker } from 'bullmq';
import IORedis from 'ioredis';
import config from './config.js';
import { storeResult, setStatus } from './store.js';
import { fetchWithAxios, fetchWithUndici } from './fetchers/http.js';
import { fetchBrowser, closeBrowsers } from './fetchers/browser.js';
import { loadProxies } from './proxy.js';

const workers = new Map();
let redis;
let sub;

async function processJob(job) {
  const { jobId, url, engine = 'axios', ...opts } = job.data;

  await setStatus(jobId, 'active');

  let result;
  switch (engine) {
    case 'puppeteer':
      result = await fetchBrowser(url, opts);
      break;
    case 'fetch':
      result = await fetchWithUndici(url, opts);
      break;
    case 'axios':
    default:
      result = await fetchWithAxios(url, opts);
      break;
  }

  await storeResult(jobId, { status: 'completed', data: result });
  return { jobId, statusCode: result.statusCode };
}

function attachHost(hostname) {
  if (workers.has(hostname)) return;

  const worker = new Worker(
    `anthill:host:${hostname}`,
    processJob,
    {
      connection: { host: config.redis.host, port: config.redis.port },
      concurrency: config.worker.concurrencyPerHost,
      limiter: {
        max: config.worker.maxRatePerHost,
        duration: config.worker.rateDuration,
      },
    },
  );

  worker.on('failed', async (job, err) => {
    if (!job) return;
    const { jobId } = job.data;
    // Only store error if all attempts exhausted
    if (job.attemptsMade >= (job.opts?.attempts || 1)) {
      await storeResult(jobId, { status: 'failed', error: err.message });
    }
  });

  worker.on('error', (err) => {
    console.error(`[ant] worker error on ${hostname}:`, err.message);
  });

  workers.set(hostname, worker);
  console.log(`[ant] attached to host: ${hostname}`);
}

async function discoverQueues() {
  const hosts = await redis.smembers('anthill:hosts');
  for (const host of hosts) {
    attachHost(host);
  }
  console.log(`[ant] discovered ${hosts.length} existing host queues`);
}

async function listenForNewQueues() {
  sub = redis.duplicate();
  await sub.subscribe('anthill:new-host');
  sub.on('message', (_channel, hostname) => {
    attachHost(hostname);
  });
  console.log('[ant] listening for new host queues');
}

export async function startAnt() {
  redis = new IORedis({
    host: config.redis.host,
    port: config.redis.port,
    maxRetriesPerRequest: null,
  });

  loadProxies();
  await discoverQueues();
  await listenForNewQueues();

  console.log(`[ant] ready — concurrency=${config.worker.concurrencyPerHost}/host, rate=${config.worker.maxRatePerHost}/${config.worker.rateDuration}ms`);

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[ant] shutting down...');
    for (const [hostname, worker] of workers) {
      await worker.close();
    }
    await closeBrowsers();
    if (sub) await sub.quit();
    await redis.quit();
    process.exit(0);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
