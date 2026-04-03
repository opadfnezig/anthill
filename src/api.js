import express from 'express';
import config from './config.js';
import { dispatch, dispatchBatch, getQueueStats } from './dispatcher.js';
import { getResult } from './store.js';

const app = express();
app.use(express.json({ limit: '10mb' }));

// Submit a scrape job
app.post('/scrape', async (req, res) => {
  try {
    const { url } = req.body;
    if (!url) return res.status(400).json({ error: 'url is required' });

    try { new URL(url); } catch {
      return res.status(400).json({ error: 'invalid url' });
    }

    const { id, hostname } = await dispatch(req.body);
    res.json({ id, hostname, status: 'queued' });
  } catch (err) {
    console.error('[api] /scrape error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Submit batch of scrape jobs
app.post('/scrape/batch', async (req, res) => {
  try {
    const { jobs } = req.body;
    if (!Array.isArray(jobs) || !jobs.length) {
      return res.status(400).json({ error: 'jobs array is required' });
    }

    for (const job of jobs) {
      if (!job.url) return res.status(400).json({ error: 'each job must have a url' });
    }

    const results = await dispatchBatch(jobs);
    res.json({
      ids: results.map(r => r.id),
      status: 'queued',
    });
  } catch (err) {
    console.error('[api] /scrape/batch error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Poll for result
app.get('/result/:id', async (req, res) => {
  try {
    const result = await getResult(req.params.id);
    if (!result) {
      return res.status(404).json({ error: 'not found or expired' });
    }
    res.json({ id: req.params.id, ...result });
  } catch (err) {
    console.error('[api] /result error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/health', async (req, res) => {
  try {
    const queues = await getQueueStats();
    res.json({
      status: 'ok',
      uptime: process.uptime(),
      queues,
    });
  } catch (err) {
    res.json({
      status: 'degraded',
      uptime: process.uptime(),
      error: err.message,
    });
  }
});

export function startApi() {
  app.listen(config.port, () => {
    console.log(`[api] anthill listening on :${config.port}`);
  });
}
