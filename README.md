# WhatsApp Broadcasting Backend

Headless microservice for Meta WhatsApp Cloud API broadcasting.
Built with Node.js, Express, BullMQ, and ioredis. Deployed on Render.

---

## Quick Start — Local Development

### 1. Clone and install dependencies

```bash
git clone <your-repo-url>
cd wa-broadcast-backend

# Install all production + dev dependencies
npm install
```

### 2. Set up environment variables

```bash
cp .env.example .env
# Open .env and fill in all values
```

### 3. Start Redis locally (Docker)

```bash
docker run -d -p 6379:6379 --name wa-redis redis:7-alpine
```

### 4. Run the API server

```bash
npm run dev
# → Server starts on http://localhost:3000
# → Health check: http://localhost:3000/health
```

### 5. Run the workers (separate terminal windows)

```bash
# Terminal 2 — Broadcast worker (sends messages to Meta API)
npm run worker

# Terminal 3 — Webhook worker (processes inbound callbacks)
node src/workers/webhookWorker.js
```

---

## Folder Structure

```
wa-broadcast-backend/
├── src/
│   ├── server.js                    ← Express app entry point
│   ├── config/
│   │   ├── redis.js                 ← ioredis connections (queue, worker, client)
│   │   └── logger.js                ← Winston structured logging
│   ├── queues/
│   │   └── queues.js                ← BullMQ queue definitions (broadcast, webhook, optout)
│   ├── workers/
│   │   ├── broadcastWorker.js       ← Outbound message sender
│   │   └── webhookWorker.js         ← Inbound status/message processor
│   ├── routes/
│   │   ├── webhookRoutes.js         ← GET+POST /webhook/whatsapp
│   │   └── campaignRoutes.js        ← /api/campaigns, /api/templates, /api/health
│   ├── middleware/
│   │   └── auth.js                  ← JWT verification + Meta HMAC validation
│   ├── services/
│   │   └── metaApiService.js        ← Meta Cloud API wrapper (axios)
│   └── utils/                       ← (extend with helpers: phone formatters, etc.)
├── .env.example
├── .gitignore
├── render.yaml                      ← Render IaC — 3 services + Redis
├── package.json
└── README.md
```

---

## API Endpoints

### Webhook (Meta → Your Server)

| Method | Path                   | Auth | Description                          |
|--------|------------------------|------|--------------------------------------|
| GET    | /webhook/whatsapp      | None | Meta verification handshake (once)   |
| POST   | /webhook/whatsapp      | HMAC | Inbound status updates + messages    |

### API (WordPress → Your Server)

| Method | Path                         | Auth | Description                      |
|--------|------------------------------|------|----------------------------------|
| GET    | /health                      | None | Render health check              |
| POST   | /api/campaigns               | JWT  | Create + enqueue broadcast       |
| GET    | /api/campaigns/:id/stats     | JWT  | Live delivery stats              |
| DELETE | /api/campaigns/:id           | JWT  | Cancel pending campaign          |
| GET    | /api/templates/sync          | JWT  | Sync approved templates from Meta|
| GET    | /api/health/queue            | JWT  | Queue depth + phone quality      |

---

## Deployment on Render

### Option A — render.yaml (recommended)

1. Push this repo to GitHub
2. In Render dashboard → "New Blueprint" → connect your repo
3. Render reads `render.yaml` and creates all 3 services + Redis automatically
4. Set secret environment variables manually in the Render dashboard:
   - `META_ACCESS_TOKEN`
   - `META_PHONE_NUMBER_ID`
   - `META_WABA_ID`
   - `META_WEBHOOK_VERIFY_TOKEN`
   - `META_APP_SECRET`
   - `WP_JWT_SECRET`
   - `WP_SITE_URL`

### Option B — Manual setup

1. Create a **Redis Key Value** instance → note the connection string
2. Create a **Web Service** → start command: `npm start`
3. Create a **Background Worker** → start command: `node src/workers/broadcastWorker.js`
4. Create a **Background Worker** → start command: `node src/workers/webhookWorker.js`
5. Set `REDIS_URL` on all services to the Redis connection string

---

## Meta Webhook Setup (one-time)

1. Your Render web service URL will be: `https://wa-broadcast-api.onrender.com`
2. In Meta Business Suite → WhatsApp → Configuration → Webhooks:
   - **Callback URL**: `https://wa-broadcast-api.onrender.com/webhook/whatsapp`
   - **Verify Token**: the value of your `META_WEBHOOK_VERIFY_TOKEN`
3. Subscribe to events: `messages`, `message_deliveries`, `message_reads`
4. Click Verify — Meta calls your GET endpoint and you should see "Verified ✓"

---

## Rate Limiting Architecture

```
Meta API limit: 80 messages/second per phone number

Our implementation:
  ├── Inter-message delay: 12ms between each send (≈83 msg/sec gross)
  ├── BullMQ limiter: max 80 jobs/second across all workers
  ├── Batch size: 50 contacts/job
  └── On HTTP 429: exponential backoff (1s → 2s → 4s → 8s → 16s → DLQ)
```

---

## Key Dependencies

| Package          | Version | Purpose                                      |
|------------------|---------|----------------------------------------------|
| express          | ^4.x    | HTTP server framework                        |
| bullmq           | ^5.x    | Redis-backed job queue with priorities       |
| ioredis          | ^5.x    | Redis client (required by BullMQ)            |
| axios            | ^1.x    | Meta API HTTP client                         |
| helmet           | ^7.x    | Secure HTTP headers                          |
| cors             | ^2.x    | Cross-Origin request control                 |
| express-rate-limit | ^7.x  | IP-based rate limiting                       |
| morgan           | ^1.x    | HTTP request logging                         |
| winston          | ^3.x    | Structured application logging               |
| uuid             | ^9.x    | Unique job IDs                               |
| dotenv           | ^16.x   | Environment variable loading                 |
| nodemon          | ^3.x    | Dev: auto-restart on file change             |
