# Backend patch: `/internal/ai/health` (needed for the AI's `/ready`)

The AI's `GET /ready` calls `GET <BACKEND_BASE_URL>/internal/ai/health` with
`Authorization: Bearer <BACKEND_SERVICE_TOKEN>` and accepts **only** this exact body:

```json
{"status":"ready","database":"up","contract":"conversation-tools-v1"}
```

The Backend does not have this route yet, so `/ready` answers 503 forever. Railway's
healthcheck in this package therefore uses `/health/live` (process liveness) and
nothing blocks a deploy; `/ready` is for you to check that the AI can reach the Backend.

Suggested addition to `src/ai/ai.controller.ts` (reuse the existing token check; the
service token comparison must be constant-time like `AiSecurity.authenticate`):

```ts
@Get('internal/ai/health')
@AuthScope('public')
async health(@Headers('authorization') authorization?: string) {
  this.ai.assertServiceToken(authorization);           // 401 if Bearer BACKEND_SERVICE_TOKEN does not match
  await this.prisma.$queryRaw`SELECT 1`;               // 503 if the database is down
  return { status: 'ready', database: 'up', contract: 'conversation-tools-v1' };
}
```
