---
title: "How to deploy AI models: from a notebook to an API"
description: "How to deploy AI models to production: choose a runtime, size memory, package weights, serve an OpenAI-compatible API, secure it and monitor it on your servers."
date: 2026-11-08
category: AI
keywords: deploy ai models, how to deploy ai models, self-host llm, model serving, deploy llm
---

A model that works in a notebook is a file on your laptop. To deploy AI models, you turn that file into a service: something with a stable URL, an API your app can call, limits on memory and concurrency, a way to update it without downtime, and a log you can read when it misbehaves. This guide walks through the decisions in order, from "should we host it at all" to monitoring it in production, with commands for a self-hosted setup you can run on your own servers.

## First decision: call an API or host the model

Hosting a model is not always the right call. Be honest about why you want to.

| Reason | Hosted API (OpenAI, Anthropic, Mistral, etc.) | Self-hosted model |
| --- | --- | --- |
| Time to first request | Minutes | Hours to days |
| Best model quality | Frontier models | Open-weight models, a step behind on hard tasks |
| Data leaves your servers | Yes | No |
| Cost shape | Per token, scales with use | Fixed per server, scales with hardware |
| Hardware to manage | None | Memory, GPUs, disks |
| Works offline or air-gapped | No | Yes |

Self-hosting wins when data must stay on your infrastructure, when volume is high and steady enough that a fixed server beats per-token billing, when you need a fine-tuned or niche model, or when you need to run offline. For a prototype with low traffic, an API is cheaper and better.

Many teams do both: a gateway such as LiteLLM in front, routing some requests to a hosted API and others to a local model, behind one OpenAI-compatible endpoint.

## Deployment vs. training

Training produces weights. Deployment, also called inference or serving, runs those weights to answer requests. They have different needs:

- **Training** is a batch job: hours or days on many GPUs, then it ends.
- **Serving** is a long-running service: it must start fast, answer within a latency budget, handle concurrent requests and stay up.

This guide is about serving. If you only use open-weight models as they are, you never train anything.

## Choose a serving runtime

The runtime loads the weights and exposes an API. Pick by hardware and traffic, not by popularity.

| Runtime | Runs on | Strength | Fits |
| --- | --- | --- | --- |
| Ollama | CPU, Apple Silicon, NVIDIA, AMD | One-command model pulls, simple API | Internal tools, small teams, CPU servers |
| llama.cpp server | CPU and most GPUs | Very efficient quantized inference | Edge devices, CPU-only hosts |
| vLLM | NVIDIA and AMD GPUs mainly | High throughput with continuous batching | Many concurrent users on GPUs |
| Hugging Face TGI | NVIDIA, AMD, others | Production features, HF ecosystem | Teams already on Hugging Face |
| NVIDIA Triton | NVIDIA GPUs, CPU | Many frameworks, ensembles | Mixed ML models, not only LLMs |

Ollama, llama.cpp and vLLM all expose an OpenAI-compatible API. That matters more than it seems: your app code talks to `/v1/chat/completions` and you can swap the runtime, or point at a hosted API, by changing one URL.

For classic ML models (classifiers, embeddings, vision), a small FastAPI or BentoML service around the model file is often all you need.

## Size the hardware before you deploy

The weights must fit in memory (GPU VRAM if you use a GPU, RAM otherwise), with room left for the context cache. A practical estimate:

```text
memory for weights ≈ parameters × bytes per parameter

7B  at FP16  (2 bytes)   ≈ 14 GB
7B  at 4-bit (≈0.5 byte) ≈ 4 to 5 GB
70B at 4-bit             ≈ 40 GB
```

Add 10 to 30% for the KV cache, which grows with context length and concurrent requests.

Rules of thumb:

- **Quantize.** 4-bit or 8-bit quantized models (GGUF, AWQ, GPTQ) lose little quality and cut memory by two to four times.
- **CPU is fine for small models and low traffic.** A 3B to 8B quantized model on a modern 8-core server answers an internal tool's questions at a usable speed. It will not serve hundreds of concurrent users.
- **GPUs are for throughput.** If many people hit the model at once, or you need fast responses from a large model, you need a GPU and a batching runtime like vLLM.

## Package the model the right way

Do not bake multi-gigabyte weights into your container image. Images that size are slow to push, slow to pull and wasteful to rebuild when only your code changed.

Instead:

1. Use the runtime's official image, pinned to a version or digest.
2. Keep weights in a **volume**, downloaded on first start or by a one-off job.
3. Pass the model name and settings as environment variables.

With Ollama on a plain Docker host:

```bash
# Run Ollama with weights in a named volume
docker run -d --name ollama \
  -v ollama:/root/.ollama \
  -p 127.0.0.1:11434:11434 \
  --memory 12g \
  ollama/ollama:0.5.7

# Pull a quantized model into the volume
docker exec ollama ollama pull llama3.1:8b

# Call the OpenAI-compatible endpoint
curl http://127.0.0.1:11434/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"llama3.1:8b","messages":[{"role":"user","content":"Say hello in Italian."}]}'
```

With vLLM on an NVIDIA GPU host (needs the NVIDIA Container Toolkit):

```bash
docker run -d --name vllm --gpus all \
  -v hf-cache:/root/.cache/huggingface \
  -e HF_TOKEN="$HF_TOKEN" \
  -p 127.0.0.1:8000:8000 \
  vllm/vllm-openai:v0.6.3 \
  --model mistralai/Mistral-7B-Instruct-v0.3 --max-model-len 8192
```

Note the `127.0.0.1` bindings: neither runtime has meaningful authentication of its own, so they should never listen on a public interface directly.

## Put a real service around it

A runtime listening on localhost is not yet a deployment. Production needs:

- **HTTPS and a hostname**, through a reverse proxy.
- **Access control.** An API key checked by a gateway, an IP allow list, a sign-in gateway, or a private network such as a VPN or tailnet. An open inference endpoint gets found and used by strangers.
- **Memory limits**, so a long prompt cannot take down the other services on the host.
- **A health check**, so traffic waits until the model has loaded. Loading a large model can take minutes.
- **Timeouts and streaming.** Generations take seconds. Stream tokens to the client and set proxy timeouts that allow for it.
- **Versioned rollouts.** Changing the model is a deploy like any other: pin the version, roll it out, keep the old one ready to roll back.

## Scale inference

Scaling a model is mostly about concurrency, not replicas.

- **Batch requests.** vLLM and TGI batch concurrent requests on one GPU automatically. One well-used GPU beats two idle ones.
- **Queue long jobs.** Summarizing a 200-page PDF should be a background job with a status, not a request that holds a connection for two minutes.
- **Cache.** Identical prompts (classification of the same text, repeated system prompts) can be cached at the gateway.
- **Add replicas last.** More copies means more memory for more copies of the weights. Do it when one instance is saturated, and remember that each replica needs its own weights on its own node.

## Monitor a deployed model

Watch the infrastructure and the model separately.

- **Infrastructure:** memory against the limit (the most common failure is an OOM kill on a long context), CPU or GPU utilization, request latency, error rate, and restarts.
- **Model behaviour:** response length, refusals, latency per token, and for ML models, input and prediction drift over time. Tools such as Evidently cover drift; for LLM apps, log prompts and outputs (with care for personal data) and review samples.

Set an alert on memory close to the limit and on restarts, and you will catch most serving problems before users report them.

## Deploying AI models on LogiStack

LogiStack is an open-source self-hosted PaaS on Docker Swarm. It does not run training jobs and its service settings cover CPU and memory limits, not GPUs. What it does well is the serving layer on CPU servers and everything around a model.

- **One-click templates.** The template catalog includes Ollama with Open WebUI, Open WebUI, LiteLLM, LibreChat, AnythingLLM, Flowise, Langflow and vector databases such as Qdrant, Weaviate and Chroma. The Ollama template keeps weights in a volume, gives the Ollama API no public domain, and only exposes the web UI. See [templates](/docs/deploy/templates/).
- **Limits and health checks.** Set CPU and memory per service and an HTTP, TCP or command health check, so a new version gets traffic only once the model answers. See [service settings](/docs/deploy/service-settings/).
- **HTTPS and access rules.** Every domain gets a certificate. Put an IP allow list, a password or a sign-in gateway in front of an endpoint at the proxy. See [access control](/docs/networking/access-control/).
- **Private endpoints.** Publish a model only on your Tailscale tailnet, so it never faces the internet.
- **Monitoring.** Memory against the limit, CPU, restarts and live logs for every service, with alerts when a threshold is crossed. See [metrics](/docs/operations/metrics/).

One honest constraint: [automatic scaling](/docs/deploy/autoscaling/) works only for services without volumes, and model weights usually live in a volume. Scale model services by hand, or keep the model on one node and scale the stateless app in front of it.

For GPU inference, a common split is: vLLM on a dedicated GPU host or a GPU cloud, and LogiStack running the app, the LiteLLM gateway, the vector database and the background workers that call it. Our guide to [AI app deployment platforms](/blog/ai-app-deployment-platforms/) compares the options for that GPU half.

## FAQ

### What is the easiest way to deploy an AI model?

For an open-weight LLM, run Ollama in Docker, pull a quantized model and call its OpenAI-compatible API. Put it behind a reverse proxy with HTTPS and access control before anyone outside your machine uses it. A PaaS template does all of this in one step.

### Can I deploy an LLM without a GPU?

Yes, for small quantized models and modest traffic. A 7B or 8B model at 4-bit needs about 5 GB of RAM and runs on a modern CPU at a speed suitable for internal tools. For many concurrent users or larger models, use a GPU.

### How much memory does a 7B model need?

About 14 GB at 16-bit precision and 4 to 5 GB at 4-bit quantization, plus 10 to 30% for the context cache. Set the container's memory limit above that figure so long prompts do not trigger an OOM kill.

### Should I put model weights in the Docker image?

No. Weights are gigabytes and change on a different schedule from your code. Keep them in a volume or a model cache, pin the runtime image, and pass the model name as configuration.

Ready to run a model on your own servers? [Install LogiStack](/#install), deploy the Ollama template, and you have a private chat UI with HTTPS, memory limits and alerts in a few minutes. Our post on the [AI sandbox](/blog/ai-sandbox/) covers how to let agents work against it safely.
