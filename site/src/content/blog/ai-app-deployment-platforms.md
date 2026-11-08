---
title: "AI app deployment platforms: where to ship your AI product"
description: "Compare AI app deployment platforms: frontend clouds, container PaaS, GPU inference hosts, hyperscalers and self-hosted PaaS, with what each handles well."
date: 2026-11-08
category: AI
keywords: ai app deployment platforms, deploy ai app, ai hosting platform, llm app hosting, self-hosted ai platform
---

An AI app is still a web app, with a few habits that break assumptions. Requests take 20 seconds instead of 200 milliseconds. Responses stream token by token. Half the work happens in background jobs that call a model, embed documents or run an agent loop. There is a vector database next to the regular one, a pile of provider API keys to protect, and a bill that can spike overnight. Choosing among AI app deployment platforms comes down to which of those habits each platform handles well. This guide sorts the options into five groups, compares them, and helps you pick by the shape of your app rather than by the logo.

## What an AI app needs from a platform

Score platforms against what your app actually does:

- **Long, streaming requests.** Server-sent events or WebSockets held open for tens of seconds, without the platform cutting them off.
- **Background workers and queues.** Ingestion, embedding, long generations and agent runs belong in workers, not in request handlers.
- **Stateful companions.** Postgres (often with pgvector), Redis, and sometimes a dedicated vector database such as Qdrant or Weaviate.
- **Secrets management.** Provider keys for OpenAI, Anthropic and others, scoped per environment and never printed in logs.
- **Model access.** Either outbound calls to hosted APIs, or GPUs to run your own models.
- **Cost control.** Predictable spend for compute, and a way to see which feature or customer drives model usage.
- **Previews.** Prompt changes are code changes: reviewers need to try them on a live URL before merge.
- **Agent friendliness.** More and more deploys are done by coding agents. An API or MCP server with scoped permissions matters.

## The five groups of AI app deployment platforms

| Group | Examples | Handles well | Watch out for |
| --- | --- | --- | --- |
| Frontend clouds | Vercel, Netlify | Next.js and frontends, edge delivery, previews, AI SDKs | Function duration limits, long-running workers need another home |
| Managed container PaaS | Render, Railway, Fly.io, Heroku | Web services, workers, managed Postgres and Redis, simple deploys | Usage-based bills that grow with traffic, limited or regional GPU options |
| GPU and inference platforms | Modal, Replicate, RunPod, Hugging Face Inference Endpoints | Running models on GPUs, scale to zero, pay per second | Not a home for your web app and databases |
| Hyperscaler ML platforms | AWS SageMaker and Bedrock, Google Vertex AI, Azure ML and AI Foundry | Enterprise controls, managed models, training and serving at scale | Complexity, many services to wire together, steep learning curve |
| Self-hosted PaaS | LogiStack, Coolify, Dokploy, CapRover | Full control, fixed server cost, data on your machines | You own the servers; no GPU scheduling in most of them |

Low-code builders such as Bubble or Retool also host AI features, but they are a different decision: you are choosing a development model, not just a place to deploy.

## Frontend clouds

Vercel and Netlify are the shortest path from a Next.js or Svelte repository to a global URL with previews on every pull request. Vercel's AI SDK makes streaming chat interfaces straightforward, and serverless functions handle model calls.

Where they fit: a chat or copilot UI that calls hosted model APIs, with light server logic.

Where they strain: anything long-running. Serverless functions have execution time limits that vary by plan, so document ingestion, multi-step agents and batch jobs usually move to a separate worker service on another platform. Databases come from partners or external providers.

## Managed container PaaS

Render, Railway, Fly.io and Heroku run containers: a web service, a worker, a cron job, a database, all in one place. Long requests and WebSockets work because the process is always on. This is the most natural home for a typical AI backend that calls hosted model APIs.

- **Render** and **Railway** give a Heroku-like experience with Docker support, managed Postgres and Redis, and preview environments.
- **Fly.io** runs containers as Firecracker micro-VMs close to users in many regions; it is good for latency-sensitive apps.
- **Heroku** remains simple and mature, with a large add-on marketplace.

Trade-offs: costs scale with usage and instance size, and GPU availability is limited or absent on most of them. Check each vendor's current pricing and GPU offering directly; both change often. We compare these in [Railway vs. Render](/blog/railway-vs-render/) and [Fly.io alternatives](/blog/fly-io-alternatives/).

## GPU and inference platforms

If you run your own models, you need GPUs, and most teams should rent them rather than buy them.

- **Modal** runs Python functions on GPUs with a decorator, scales to zero and bills per second of use.
- **Replicate** hosts models behind an API, including your own packaged with Cog.
- **RunPod** rents GPU pods and offers serverless GPU endpoints.
- **Hugging Face Inference Endpoints** deploy a model from the Hub onto dedicated hardware in a few clicks.

These are excellent at serving models and poor at hosting the rest of your app. The common pattern is a split: models on an inference platform, everything else on a general-purpose platform that calls them over HTTPS. Our guide on [how to deploy AI models](/blog/deploy-ai-models/) covers sizing and runtimes for either side of that split.

## Hyperscaler ML platforms

AWS, Google Cloud and Azure each offer a full ML platform: managed foundation models (Bedrock, Vertex AI, Azure AI Foundry), training and serving infrastructure (SageMaker, Vertex AI, Azure ML), pipelines, model registries and governance.

Choose them when your company already runs on that cloud, when you need enterprise compliance controls and private networking to managed models, or when you train models at scale. Avoid them for a small team shipping its first AI feature: the number of services to learn and wire together is the main cost.

## Self-hosted PaaS

A self-hosted PaaS gives you the developer experience of Render or Heroku on servers you rent from Hetzner, OVHcloud, DigitalOcean or anyone else. You pay a fixed monthly amount per server, and your data, prompts and logs stay on your machines. That matters for AI apps that process customer documents or personal data. See [self-hosted PaaS](/blog/self-hosted-paas/) for the general case.

The cost is responsibility: you run the servers, and you get no managed GPU scheduling from most of these tools. In practice, teams self-host the app, the databases and the workers, and either call hosted model APIs or run models on a separate GPU host.

### LogiStack for AI apps

LogiStack is an open-source (Apache 2.0) self-hosted PaaS on Docker Swarm. For AI apps specifically:

- **Everything around the model in one place.** Deploy the web app and workers from Git, add Postgres, Redis, MongoDB or libSQL in one click, and run object storage for uploaded documents. Long requests and WebSockets work because services are ordinary containers behind Caddy.
- **AI templates.** The [template catalog](/templates/) has an AI category: Open WebUI, Ollama with Open WebUI, LiteLLM as an OpenAI-compatible gateway, LibreChat, AnythingLLM, Flowise, Langflow, and vector databases such as Qdrant, Weaviate and Chroma.
- **Secrets per environment.** Variables at organization, project, environment or service level; secrets are write-only and encrypted at rest.
- **Preview environments.** Every pull request gets its own environment and URL, so you can review a prompt change live.
- **Built for agents.** An [MCP server](/docs/automation/mcp-server/) at `/mcp` mirrors the REST API, so Claude Code, Cursor or VS Code can create services, read logs and deploy with a scoped API key. Destructive tools refuse to run without explicit confirmation, and every call lands in the audit log. The docs are published as `llms.txt` and per-page Markdown for agents. See [AI coding agents](/docs/automation/ai-agents/).
- **No paid tier.** SSO, custom roles and the audit log are in the same free build.

![The LogiStack API keys page with the MCP server endpoint and a ready-made Claude Code command](/docs/screens/settings-api-keys.webp)

Honest limits: LogiStack does not schedule GPUs, it runs on Docker Swarm rather than Kubernetes, and it is a young project with a smaller community than Coolify or Dokploy. If you need managed GPUs, pair it with an inference platform. If your company is standardized on Kubernetes, a Kubernetes-native platform is a better fit.

## How to choose

Start from the shape of your app:

1. **A chat UI over hosted model APIs, frontend-heavy, small team.** A frontend cloud, plus a worker somewhere when you need background jobs.
2. **A backend with workers, RAG and a vector database, calling hosted APIs.** A managed container PaaS if you want zero operations; a self-hosted PaaS if you want fixed costs and data on your servers.
3. **Your own open-weight models at meaningful traffic.** A GPU inference platform for the models, plus one of the above for the app.
4. **Regulated enterprise on one cloud.** That cloud's ML platform, possibly with a PaaS for the app layer.
5. **Data must never leave your infrastructure.** Self-hosted PaaS for the app, and self-hosted models on your own GPU hardware or CPU-friendly quantized models.

Then run one real workload, including a 30-second streaming request and a background job, on your top two candidates before committing.

## FAQ

### What is the best platform to deploy an AI app?

It depends on the app. Frontend clouds suit chat UIs over hosted APIs, container PaaS suits backends with workers and databases, GPU platforms suit self-hosted models, and self-hosted PaaS suits teams that want fixed costs and their data on their own servers. Most production AI apps use two of these together.

### Do I need a GPU to deploy an AI app?

Not if your app calls hosted model APIs such as OpenAI or Anthropic, which most AI apps do. You need GPUs only to run your own models at meaningful speed and volume. Small quantized models can run on CPU servers for low-traffic internal tools.

### Can I self-host an AI app with RAG?

Yes. A typical stack is the app, a worker for ingestion, Postgres with pgvector or a vector database such as Qdrant, Redis for queues, and object storage for documents. All of these run as containers on a self-hosted PaaS, and the model can be a hosted API or a self-hosted runtime.

### How do AI coding agents deploy apps?

Through the platform's API or an MCP server. The agent gets a scoped, expiring key, calls tools such as "create service" or "deploy", and reads logs to debug failures. Keep destructive actions behind human approval and review the audit log.

If your AI app is a backend with workers, databases and a few model APIs, you can run all of it on one server you control. [Install LogiStack](/#install), connect your repository, and point your coding agent at the MCP server.
