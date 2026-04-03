import IORedis from 'ioredis';
import config from './config.js';
import { initStore } from './store.js';
import { initDispatcher } from './dispatcher.js';
import { startApi } from './api.js';
import { startAnt } from './ant.js';

const redis = new IORedis({
  host: config.redis.host,
  port: config.redis.port,
  maxRetriesPerRequest: null,
});

redis.on('connect', () => console.log('[redis] connected'));
redis.on('error', (err) => console.error('[redis] error:', err.message));

initStore(redis);

if (config.role === 'worker') {
  startAnt();
} else {
  initDispatcher(redis);
  startApi();
}
