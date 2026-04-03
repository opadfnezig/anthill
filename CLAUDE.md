# Anthill — Centralized Scraping Service

## What This Is

Anthill is a centralized web scraping service with a REST API. External apps (hwscan, future services) send URLs + options, Anthill fetches the pages and returns raw HTML/content. **Anthill does NOT parse** — parsing is owned by client apps so they can debug parsing issues on their side.

Named after the metaphor: the system is the anthill, workers are ants.

## Architecture

```
Client apps (hwscan, others)
    │
    │  POST /scrape { url, engine, headers, proxy, ... }
    │  GET  /result/:id
    ▼
┌─────────────────────────────────┐
│         API (Express)           │
│  - validates requests           │
│  - dispatches to per-host queue │
│  - serves results from Redis    │
└──────────────┬──────────────────┘
               │
    ┌──────────┴──────────┐
    │   Dispatcher        │
    │   routes jobs to    │
    │   per-host BullMQ   │
    │   queues            │
    └──────────┬──────────┘
               │
    ┌──────────┴──────────────────────────┐
    │  Per-Host Redis Queues (BullMQ)     │
    │  anthill:host:example.com           │
    │  anthill:host:bazos.cz              │
    │  anthill:host:olx.ua               │
    │  (created lazily on first request)  │
    └──┬──────┬──────┬──────┬─────────────┘
       │      │      │      │
    ┌──┴──────┴──────┴──────┴──┐
    │     Ant Workers           │
    │  - pull model             │
    │  - per-host rate limiting │
    │  - per-host concurrency   │
    │  - dynamic: auto-attach   │
    │    to new host queues     │
    │    via Redis pub/sub      │
    └──────────┬───────────────┘
               │
    ┌──────────┴──────────────┐
    │   Fetcher Engines       │
    │  - axios (default HTTP) │
    │  - fetch (undici, alt   │
    │    TLS fingerprint)     │
    │  - puppeteer (browser,  │
    │    stealth plugin,      │
    │    screenshots, PDFs)   │
    └──────────┬──────────────┘
               │
    ┌──────────┴──────────────┐
    │   Redis                  │
    │  - job queues (BullMQ)   │
    │  - results with TTL      │
    │  - host registry         │
    │  - AOF persistence       │
    └──────────────────────────┘
```

## Key Design Decisions

### Per-host queues (from scrape v2 architecture)
Each hostname gets its own BullMQ queue. Rate limiting, backoff, concurrency — all per-host. One host returning 429s doesn't block other hosts. Backpressure stays local.

### Pull model
Ant workers dynamically attach to host queues. When a new host queue is created (first request for that hostname), workers are notified via Redis pub/sub and auto-attach. Each worker has its own concurrency and rate limit per host.

### Three fetcher engines
- **axios** (default): Standard HTTP client. Supports SOCKS5/HTTP proxies. Good for static HTML, JSON APIs.
- **fetch** (undici): Node 20 built-in fetch. Different TLS fingerprint than axios. Bypasses WAFs that fingerprint TLS (e.g. CloudFront on OLX). Does NOT support SOCKS5 proxies.
- **puppeteer**: puppeteer-extra with stealth plugin. Full browser rendering. Supports screenshots, PDFs, custom actions (click, type, scroll, wait), cookies. Browser pool keyed by proxy config.

### No parsing
Anthill returns raw responses (HTML, JSON, binary, screenshots, PDFs). Client apps own parsing. This lets clients debug parsing issues without touching the scraper.

### Minimal state
Redis only. Results stored with configurable TTL (default 1 hour). Redis configured with AOF persistence for disk backup. No database.

## Project Structure

```
anthill/
├── src/
│   ├── index.js           # Entry point — starts API or worker based on ROLE env
│   ├── config.js          # All config from env vars
│   ├── api.js             # Express server: /scrape, /scrape/batch, /result/:id, /health
│   ├── ant.js             # Worker process — dynamic per-host BullMQ workers
│   ├── dispatcher.js      # Per-host queue creation, registry, pub/sub notification
│   ├── store.js           # Redis result store (set/get with TTL)
│   ├── proxy.js           # SOCKS5/HTTP proxy rotation, agent creation
│   ├── user-agents.js     # UA string rotation (desktop + mobile)
│   └── fetchers/
│       ├── http.js        # axios + undici fetchers
│       └── browser.js     # puppeteer-extra + stealth, browser pool, actions
├── data/
│   └── proxies.json       # Proxy list: [{ protocol, host, port, user, pass }]
├── package.json
├── Dockerfile             # Node 20 slim + Chromium for puppeteer
├── docker-compose.yaml    # redis + api + worker (2 replicas)
└── CLAUDE.md              # This file
```

## API Contract

### POST /scrape
Submit a single scrape job. Returns immediately with job ID.

```json
// Request
{
  "url": "https://example.com/page",       // required
  "engine": "axios",                        // "axios" | "fetch" | "puppeteer" (default: "axios")
  "method": "GET",                          // HTTP method (default: "GET")
  "headers": { "Cookie": "session=abc" },   // custom headers (optional)
  "body": "...",                            // request body for POST/PUT (optional)
  "proxy": true,                            // true = use next from pool, or { protocol, host, port, user, pass }, or "socks5://..." string
  "timeout": 30000,                         // ms (default: 30000)
  "retries": 2,                             // auto-retry count (default: 0)
  "chromeHeaders": true,                    // include sec-ch-ua/Sec-Fetch-* headers (default: false)
  "responseType": "text",                   // "text" | "binary" (base64) (default: "text")
  "priority": 0,                            // lower = higher priority (default: 0)

  // puppeteer-only options (ignored for axios/fetch):
  "waitFor": "#content",                    // CSS selector to wait for after navigation
  "waitTimeout": 10000,                     // wait timeout ms (default: 10000)
  "screenshot": true,                       // capture screenshot (base64)
  "pdf": true,                              // capture PDF (base64)
  "fullPage": true,                         // full page screenshot (default: true)
  "viewport": { "width": 1920, "height": 1080 },
  "userAgent": "...",                        // override UA for puppeteer
  "cookies": [{ "name": "x", "value": "y", "domain": ".example.com" }],
  "actions": [                              // sequential browser actions
    { "type": "click", "selector": "#btn" },
    { "type": "type", "selector": "#input", "text": "hello", "delay": 50 },
    { "type": "wait", "ms": 2000 },
    { "type": "waitForSelector", "selector": ".loaded", "timeout": 5000 },
    { "type": "waitForNavigation", "timeout": 10000 },
    { "type": "scroll", "direction": "down" },
    { "type": "evaluate", "script": "document.querySelector('#x').remove()" },
    { "type": "select", "selector": "#dropdown", "value": "opt2" },
    { "type": "screenshot", "fullPage": false }
  ]
}

// Response
{ "id": "V1StGXR8_Z5jdHi6B-myT", "hostname": "example.com", "status": "queued" }
```

### POST /scrape/batch
Submit multiple jobs at once.

```json
// Request
{ "jobs": [{ "url": "..." }, { "url": "...", "engine": "puppeteer" }] }

// Response
{ "ids": ["abc123", "def456"], "status": "queued" }
```

### GET /result/:id
Poll for job result.

```json
// Pending
{ "id": "abc123", "status": "queued" }
{ "id": "abc123", "status": "active" }

// Completed
{
  "id": "abc123",
  "status": "completed",
  "data": {
    "url": "https://example.com/page",      // final URL after redirects
    "statusCode": 200,
    "headers": { "content-type": "text/html; charset=utf-8", "..." : "..." },
    "body": "<html>...</html>",              // raw response body
    "contentType": "text/html; charset=utf-8",
    "timing": { "duration": 342 },
    "screenshot": "base64...",               // if requested (puppeteer)
    "pdf": "base64...",                      // if requested (puppeteer)
    "cookies": [{ "name": "...", "..." }]    // if puppeteer
  }
}

// Failed
{ "id": "abc123", "status": "failed", "error": "timeout of 30000ms exceeded" }

// Expired (TTL passed)
404 { "error": "not found or expired" }
```

### GET /health
```json
{
  "status": "ok",
  "uptime": 3600.5,
  "queues": {
    "bazos.cz": { "waiting": 5, "active": 2, "completed": 100, "failed": 1 },
    "olx.ua": { "waiting": 0, "active": 0, "completed": 50, "failed": 0 }
  }
}
```

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `ROLE` | `api` | `api` or `worker` |
| `PORT` | `3000` | API listen port |
| `REDIS_HOST` | `localhost` | Redis hostname |
| `REDIS_PORT` | `6379` | Redis port |
| `RESULT_TTL` | `3600` | Result TTL in seconds (1 hour) |
| `CONCURRENCY_PER_HOST` | `5` | Max concurrent jobs per host per worker |
| `MAX_RATE_PER_HOST` | `10` | Max jobs per rate window per host |
| `RATE_DURATION` | `1000` | Rate window in ms |
| `DEFAULT_TIMEOUT` | `30000` | Default request timeout ms |
| `PROXIES_PATH` | `./data/proxies.json` | Path to proxy list |
| `PUPPETEER_HEADLESS` | `true` | Puppeteer headless mode |
| `PUPPETEER_EXECUTABLE_PATH` | (auto) | Chrome/Chromium binary path |

## Running

```bash
# Development (docker-compose)
docker compose up --build

# Scale workers
docker compose up --build --scale worker=4

# Test it
curl -X POST http://localhost:3000/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com"}'

# Poll result
curl http://localhost:3000/result/<id>

# Puppeteer example
curl -X POST http://localhost:3000/scrape \
  -H 'Content-Type: application/json' \
  -d '{"url": "https://example.com", "engine": "puppeteer", "screenshot": true}'
```

## Proxy Configuration

Create `data/proxies.json`:
```json
[
  { "protocol": "socks5", "host": "proxy1.example.com", "port": 19010, "user": "user", "pass": "pass" },
  { "protocol": "socks5", "host": "proxy2.example.com", "port": 19010, "user": "user", "pass": "pass" }
]
```

Pass `"proxy": true` in scrape request to use rotation from pool. Or pass explicit proxy config per request.

## Fetcher Engine Selection Guide

| Scenario | Engine | Why |
|---|---|---|
| Static HTML, JSON APIs | `axios` | Fast, supports proxies, default |
| WAF blocks axios TLS fingerprint | `fetch` | Different TLS signature (undici) |
| JS-rendered pages | `puppeteer` | Full browser execution |
| Cloudflare/bot detection | `puppeteer` | Stealth plugin evades detection |
| Need screenshots/PDFs | `puppeteer` | Only engine that supports this |
| Need SOCKS5 proxy + page fetch | `axios` | `fetch` engine has no SOCKS5 support |

## Bypass Techniques Available

From hwscan patterns, carried over:
- **SOCKS5 proxy rotation**: residential proxies, round-robin
- **User-Agent rotation**: desktop + mobile UAs
- **Chrome-like headers**: `sec-ch-ua`, `Sec-Fetch-*` headers via `chromeHeaders: true`
- **TLS fingerprint switching**: `fetch` engine uses undici (different from axios)
- **Puppeteer stealth**: `puppeteer-extra-plugin-stealth` evades headless detection
- **Mobile UA bypass**: for Cloudflare sites that are lenient on mobile (like Aukro)
- **Custom headers passthrough**: any headers from client are forwarded
- **Cookie injection**: set cookies before navigation (puppeteer)
- **Browser actions**: click, type, scroll, wait — for interactive pages

## Connected Systems

- **hwscan** (`/home/user/Downloads/coinflux/hwscan/`): Hardware marketplace aggregator. 7 scraper microservices currently fetching their own pages. Will migrate to use Anthill as centralized fetcher.
- **scrape v1** (`/home/user/Downloads/coinflux/scrape/`): Original crawler with Bull queues + MongoDB. Anthill inherits the v2 architecture (per-host queues, pull model) but drops PG, write buffer, backlog, and crawling mode.
- Future apps will connect to Anthill as clients.

## Redis Key Layout

| Key Pattern | Type | TTL | Description |
|---|---|---|---|
| `anthill:result:{jobId}` | string (JSON) | RESULT_TTL | Job result/status |
| `anthill:hosts` | set | none | Registry of all known hostnames |
| `anthill:new-host` | pub/sub channel | — | Notifies workers of new host queues |
| `bull:anthill:host:{hostname}:*` | various | BullMQ managed | BullMQ internal queue data |
