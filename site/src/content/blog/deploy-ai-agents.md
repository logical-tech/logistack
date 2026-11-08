---
title: "How to deploy AI agents: queues, timeouts and state"
description: "Deploy AI agents that run for minutes: split API and workers, pick a queue, set timeouts at every layer, checkpoint state and survive redeploys."
date: 2026-11-08
category: AI
keywords: deploy ai agents, ai agent deployment, long running ai agents, ai agent infrastructure, background jobs for llm, agent queue worker
---

Your agent works in a script. It plans, calls a search tool, reads three pages, calls the model twelve times and writes a report in four minutes. Then you put it behind an HTTP endpoint and things break: the proxy cuts the request at 60 seconds, a deploy kills a run halfway through, a retry sends the same email twice, and one stuck loop burns through your token budget overnight. To deploy AI agents that run for minutes, you need the boring parts of backend engineering: a queue, workers, timeouts at every layer and state that survives a restart. This guide covers each one, with code you can adapt.

## Why AI agents are harder to deploy than a web app

A normal request takes 50 milliseconds, does one thing and is safe to retry. An agent run is different on every axis:

- **Long.** Seconds to hours, mostly spent waiting on model and tool calls.
- **Variable.** The same input can take 3 steps or 30.
- **Expensive.** Every step costs tokens. A retry from scratch pays again.
- **Side effects.** Agents send emails, open tickets, write to databases. Repeating a step can repeat the effect.
- **Fragile dependencies.** Model APIs rate-limit, time out and return errors under load.

None of that fits inside one HTTP request. The fix is to stop trying.

## The architecture: API, queue, workers, state

Split the agent into parts with one job each.

| Part | Job | Scales by |
| --- | --- | --- |
| API | Accepts a task, stores it, enqueues it, returns a run id at once | Requests per second |
| Queue | Holds runs until a worker is free, retries failures | Rarely needs scaling |
| Workers | Run the agent loop, one or more runs each | Concurrent runs and rate limits |
| State store | Runs, steps, tool results, final output | Data size |
| Progress channel | Tells the user what is happening: polling, SSE or WebSocket | Connected users |

The API never waits for the agent. The user gets a run id in milliseconds and watches progress. Workers can restart, scale up or crash without losing the run, because the run lives in the queue and the state store, not in a process's memory.

## Pick a queue

You do not need a new piece of infrastructure for every agent. Pick by what you already run.

| Option | Backed by | Good fit | Watch out for |
| --- | --- | --- | --- |
| BullMQ (Node), RQ or Celery (Python) | Redis | Teams that already run Redis; fast, mature | Redis needs persistence turned on, or a restart loses queued jobs |
| pg-boss, Graphile Worker, Procrastinate | Postgres | One database for everything; transactional enqueue | Very high throughput needs tuning |
| Durable workflow engines: Temporal, Inngest, Hatchet, Restate | Their own server plus a database | Multi-step runs that must resume exactly where they stopped | One more system to learn and operate |
| Cloud queues (SQS, Pub/Sub) | The provider | Already on that cloud | Ties the agent to one cloud |

A Redis or Postgres queue plus your own checkpoints, as shown below, covers most agents. Reach for a durable workflow engine when runs have many steps with expensive side effects, last hours, or wait for human input in the middle. Those engines record each step's result and replay the function after a crash, so you write normal code and get resumability for free.

## A worker that survives real traffic

This BullMQ example shows the settings that matter. The API enqueues; the worker runs.

```ts title="api.ts"
import { Queue } from "bullmq";
import IORedis from "ioredis";

const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });
export const runs = new Queue("agent-runs", { connection });

export async function startRun(runId: string, task: string) {
  await runs.add(
    "run",
    { runId, task },
    {
      jobId: runId, // the same run id is never queued twice
      attempts: 3,
      backoff: { type: "exponential", delay: 10_000 },
      removeOnComplete: { age: 86_400 },
    },
  );
}
```

```ts title="worker.ts"
import { Worker } from "bullmq";
import IORedis from "ioredis";
import { runAgent } from "./agent";

const connection = new IORedis(process.env.REDIS_URL!, { maxRetriesPerRequest: null });

const worker = new Worker(
  "agent-runs",
  async (job) => runAgent(job.data.runId, job.data.task, (step) => job.updateProgress(step)),
  {
    connection,
    concurrency: Number(process.env.AGENT_CONCURRENCY ?? 4),
    lockDuration: 120_000, // a run may go two minutes between heartbeats
  },
);

// On deploy, stop taking new runs and let active ones finish.
process.on("SIGTERM", async () => {
  await worker.close();
  process.exit(0);
});
```

Three settings deserve a second look:

- **`concurrency`.** Agent runs spend most of their time waiting on the network, so one worker process can handle several. Set it from your model provider's rate limit, not your CPU count.
- **`jobId`.** If the API retries the enqueue, the queue drops the duplicate.
- **`lockDuration`.** If a worker dies, the lock expires and another worker picks the job up. Too short and a slow model call looks like a dead worker, so two workers run the same job.

## Timeouts at every layer

Every layer between the user and the model has a timeout. Set each one on purpose, and make inner ones shorter than outer ones, so the failure happens where your code can handle it.

| Layer | Typical value | Purpose |
| --- | --- | --- |
| API request | Under 5 seconds | Only enqueues. Never holds a run |
| Model call | 60 to 120 seconds | One completion. Retry with backoff on timeout or 429 |
| Tool call | 10 to 60 seconds per tool | A slow website or API cannot stall the run |
| Step limit | 20 to 50 steps | Stops loops that never converge |
| Run deadline | Minutes to hours, per task type | Hard ceiling, after which the run fails cleanly |
| Shutdown grace | Longer than a typical step | Lets a worker finish its step on deploy |

Add a token or cost budget per run next to the step limit. An agent that hits it stops and reports, instead of quietly spending money all night.

## Keep state outside the process

Write every step to the database as it finishes. That gives you three things: a progress view for the user, a debug trail when a run goes wrong, and resumability after a crash.

```sql
create table agent_steps (
  run_id     text not null,
  step       int  not null,
  kind       text not null,      -- "model", "tool", "final"
  input      jsonb,
  output     jsonb,
  created_at timestamptz default now(),
  primary key (run_id, step)
);
```

```ts title="agent.ts (sketch)"
export async function runAgent(runId: string, task: string, report: (s: number) => void) {
  const history = await loadSteps(runId); // resume from the last saved step
  for (let step = history.length; step < MAX_STEPS; step++) {
    const action = await callModel(task, history, { timeoutMs: 90_000 });
    if (action.type === "final") return saveStep(runId, step, "final", action);
    const result = await runTool(action, { idempotencyKey: `${runId}:${step}` });
    history.push(await saveStep(runId, step, "tool", { action, result }));
    report(step);
  }
  throw new Error(`Run ${runId} hit the step limit`);
}
```

The key is `idempotencyKey`. When a retry replays step 7, a tool that sends email or charges a card must recognise `run_42:7` and skip the second send. Many payment and email APIs accept an idempotency key; for your own tools, store the key with the result and check it first.

## Redeploys without killing runs

Deploying a new worker version means stopping old workers. Two things keep runs safe:

1. **Graceful shutdown.** On `SIGTERM`, stop taking new jobs and finish the active ones, as `worker.close()` does above. The platform must wait long enough before sending `SIGKILL`.
2. **Checkpoints for anything longer.** If a run lasts an hour, no grace period will cover it. The worker saves state after each step; the replacement worker resumes from the last one.

Version your prompts and tools with the code. A run that started on version 12 and resumes on version 13 should either cope or fail clearly; recording the version in the run row makes the second case easy to detect.

## Tell the user what is happening

Pick the simplest channel that works:

- **Polling** `GET /runs/:id` every few seconds. Works everywhere, through every proxy.
- **Server-sent events** for a live feed of steps. Plain HTTP, one direction, reconnects on its own.
- **WebSockets** when the user can also steer the run mid-flight.

Whatever you pick, serve it from the API, reading from the state store. Workers write; the API reads.

## Scheduled and event-driven agents

Not every agent starts with a user. Nightly report agents, inbox triage and data-sync agents start on a clock or an event. A cron job that enqueues a run is enough; the same workers execute it. Give scheduled runs their own queue name so a backlog of nightly work does not delay interactive users.

## Deploying AI agents on LogiStack

LogiStack is an open-source self-hosted PaaS on Docker Swarm. It does not run your agent loop for you; it runs the services around it.

- **Separate API and worker services** from the same repository. The API gets a domain; the worker gets none and is reachable by nothing. Both deploy on push. See [deploy from Git](/docs/deploy/from-git/).
- **Redis and Postgres in one click** as managed databases, with generated credentials, a volume and scheduled backups. Apps in the same environment reach them by service name. See [databases](/docs/deploy/databases/).
- **A drain timeout up to 3600 seconds.** Under **Settings › Healthcheck and drain**, set how long a replaced worker gets after `SIGTERM` to finish its runs. See [service settings](/docs/deploy/service-settings/).
- **Replicas and autoscaling for workers.** A worker with no volume is stateless, so you can raise replicas by hand or let autoscaling add copies on CPU load. Agent workers are usually network-bound, so check that CPU tracks your load before you rely on it.
- **Schedules** that run a script on a cron, in a fresh container or inside a running service, with a timeout from 1 to 1440 minutes and a run history. Use them to enqueue nightly runs. See [schedules](/docs/data/schedules/).
- **Templates** for the infrastructure: [Inngest](/templates/inngest/) as a durable workflow engine, n8n for low-code agent workflows, and [LiteLLM](/templates/litellm/) as a gateway that adds retries and budgets in front of model providers.
- **Memory limits and alerts** per service, so a worker that leaks memory over a long run gets restarted and you get notified.

One honest limit: LogiStack's service settings cover CPU and memory, not GPUs. If your agent calls a self-hosted model, our [vLLM vs Ollama comparison](/blog/vllm-vs-ollama/) covers where to run it.

## FAQ

### Can I run an AI agent in a serverless function?

Short agents, yes, if every run fits in the function's time limit. Long or variable runs hit that limit, and a cold start or timeout loses the run. Use a queue and long-running workers, or a durable workflow service, for anything that can take more than a minute.

### How do I stop an AI agent from running forever?

Set a step limit, a token or cost budget, and a hard deadline per run. When any of them trips, the worker saves the state, marks the run as failed with the reason, and stops. Alert on runs that hit limits often; it usually means a prompt or tool is broken.

### What happens to running agents when I deploy?

Without care, they die mid-step. Handle `SIGTERM` by finishing active work, give the platform a long enough drain period, and checkpoint each step so a new worker can resume runs that do not finish in time.

### Do I need Temporal to deploy AI agents?

No. A Redis or Postgres queue with per-step checkpoints and idempotency keys covers most agents. Durable workflow engines pay off when runs are long, have many side effects or pause for human approval.

### How many agent runs can one worker handle?

More than you might think, because runs mostly wait on network calls. Start with 4 to 10 concurrent runs per process, then tune against your model provider's rate limits and the worker's memory use.

Agents need ordinary infrastructure done well: a queue, workers, databases, timeouts and deploys that do not drop work. [Install LogiStack](/#install) on your own server and run all of it from one dashboard, with the parts you would otherwise assemble by hand.
