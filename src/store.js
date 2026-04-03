import config from './config.js';

let redis;

export function initStore(connection) {
  redis = connection;
}

export async function storeResult(jobId, result) {
  await redis.set(
    `anthill:result:${jobId}`,
    JSON.stringify(result),
    'EX',
    config.result.ttl,
  );
}

export async function getResult(jobId) {
  const raw = await redis.get(`anthill:result:${jobId}`);
  return raw ? JSON.parse(raw) : null;
}

export async function setStatus(jobId, status) {
  const key = `anthill:result:${jobId}`;
  const ttl = await redis.ttl(key);
  const raw = await redis.get(key);
  if (!raw) return;
  const data = JSON.parse(raw);
  data.status = status;
  await redis.set(key, JSON.stringify(data), 'EX', ttl > 0 ? ttl : config.result.ttl);
}
