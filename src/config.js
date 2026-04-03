export default {
  role: process.env.ROLE || 'api',
  port: parseInt(process.env.PORT || '3000'),

  redis: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
    maxRetriesPerRequest: null, // required by BullMQ
  },

  worker: {
    concurrencyPerHost: parseInt(process.env.CONCURRENCY_PER_HOST || '5'),
    maxRatePerHost: parseInt(process.env.MAX_RATE_PER_HOST || '10'),
    rateDuration: parseInt(process.env.RATE_DURATION || '1000'),
  },

  result: {
    ttl: parseInt(process.env.RESULT_TTL || '3600'),
  },

  puppeteer: {
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    headless: process.env.PUPPETEER_HEADLESS !== 'false',
  },

  proxiesPath: process.env.PROXIES_PATH || './data/proxies.json',
  defaultTimeout: parseInt(process.env.DEFAULT_TIMEOUT || '30000'),
};
