import { Queue } from 'bullmq';
import { nanoid } from 'nanoid';
import config from './config.js';
import { storeResult } from './store.js';

const queues = new Map();
let redis;

export function initDispatcher(connection) {
  redis = connection;
}

function getHostname(url) {
  return new URL(url).hostname;
}

async function getOrCreateQueue(hostname) {
  if (queues.has(hostname)) return queues.get(hostname);

  const queue = new Queue(`anthill/host/${hostname}`, {
    connection: { host: config.redis.host, port: config.redis.port },
    defaultJobOptions: {
      removeOnComplete: { count: 100 },
      removeOnFail: { count: 100 },
    },
  });

  queues.set(hostname, queue);

  // Register host + notify workers
  await redis.sadd('anthill:hosts', hostname);
  await redis.publish('anthill:new-host', hostname);

  return queue;
}

export async function dispatch(jobData) {
  const jobId = nanoid();
  const hostname = getHostname(jobData.url);
  const queue = await getOrCreateQueue(hostname);

  await queue.add('scrape', { ...jobData, jobId }, {
    jobId,
    priority: jobData.priority || 0,
    attempts: (jobData.retries || 0) + 1,
    backoff: { type: 'exponential', delay: 1000 },
  });

  // Initial status
  await storeResult(jobId, { status: 'queued' });

  return { id: jobId, hostname };
}

export async function dispatchBatch(jobs) {
  return Promise.all(jobs.map(job => dispatch(job)));
}

export async function getQueueStats() {
  const stats = {};
  for (const [hostname, queue] of queues) {
    const [waiting, active, completed, failed] = await Promise.all([
      queue.getWaitingCount(),
      queue.getActiveCount(),
      queue.getCompletedCount(),
      queue.getFailedCount(),
    ]);
    stats[hostname] = { waiting, active, completed, failed };
  }
  return stats;
}

export async function getActiveHosts() {
  return redis.smembers('anthill:hosts');
}
