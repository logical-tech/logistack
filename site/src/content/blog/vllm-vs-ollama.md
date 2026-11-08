---
title: "vLLM vs Ollama: which LLM server to self-host"
description: "vLLM vs Ollama compared: architecture, hardware, concurrency, model formats, API and operations, with commands and a clear rule for which to self-host."
date: 2026-11-08
category: AI
keywords: vllm vs ollama, ollama vs vllm, self-hosted llm server, llm inference server, vllm or ollama for production, ollama concurrency
---

You want to run an open-weight model on your own hardware, and two names keep coming up. Ollama gets a model answering in one command on a laptop or a CPU server. vLLM is what people mention when they talk about serving many users from a GPU. The vLLM vs Ollama question is less about which is better and more about which problem you have: a few people using a model, or many requests at once on dedicated GPUs. This comparison explains how each one works, where each one wins, and how to run either in production.

If you are still deciding whether to host a model at all, start with our guide to [deploying AI models](/blog/deploy-ai-models/), which covers sizing memory and the wider list of runtimes. This post goes deep on these two.

## vLLM vs Ollama at a glance

| | Ollama | vLLM |
| --- | --- | --- |
| Built for | Easy local and small-team use | High-throughput serving |
| Engine | llama.cpp-based, plus its own model runner | Own engine with PagedAttention and continuous batching |
| Hardware | CPU, Apple Silicon, NVIDIA, AMD | NVIDIA GPUs first; AMD, TPU and others supported with more setup; CPU possible but not its strength |
| Model format | GGUF, mostly 4-bit to 8-bit quantized | Hugging Face weights (FP16/BF16), plus AWQ, GPTQ, FP8 and other quantizations |
| Getting a model | `ollama pull llama3.1:8b` | Point at a Hugging Face repo id; weights download on start |
| API | Native API plus an OpenAI-compatible `/v1` | OpenAI-compatible server |
| Many models | Loads and unloads models on demand | One model per server process |
| Concurrency | A few parallel requests per model, configurable | Dozens to hundreds of concurrent sequences on one GPU |
| Built-in auth | None | A single static API key flag |
| License | MIT | Apache 2.0 |

## How they differ under the hood

### Ollama: convenience first

Ollama wraps an inference engine derived from llama.cpp in a server that manages models for you. You pull a model by name, Ollama stores it, loads it into memory on the first request and unloads it after a period of inactivity. It picks GPU or CPU on its own, and it can split a model between them when VRAM is short.

The format is GGUF, usually quantized to 4 or 5 bits. That is why a 7B or 8B model fits in about 5 GB and runs on a laptop or a plain CPU server. The trade-off is throughput: Ollama processes a small number of requests in parallel per model, and requests beyond that wait in a queue.

### vLLM: throughput first

vLLM is a serving engine built to keep a GPU busy. Two ideas drive it:

- **PagedAttention** stores the key-value cache in fixed-size blocks, like virtual memory pages, so little VRAM is wasted and more sequences fit at once.
- **Continuous batching** adds new requests to the running batch at every generation step, instead of waiting for a batch to finish.

Together they let one GPU serve many concurrent users with steady latency. vLLM also supports tensor parallelism across several GPUs, prefix caching for shared system prompts, structured output and speculative decoding.

The cost is setup: vLLM expects a supported GPU, reserves most of its memory up front, serves one model per process, and takes a while to start on large models.

## Hardware: the first filter

Your hardware often decides for you.

- **No GPU, or a Mac.** Ollama. Quantized models on CPU are usable for internal tools at modest speed. On Apple Silicon, Ollama uses Metal when it runs natively; inside Docker on macOS it cannot reach the GPU.
- **One consumer GPU, a few users.** Either works. Ollama is simpler, and its quantized models let a larger model fit in limited VRAM.
- **Datacenter GPUs, many users or an API product.** vLLM. This is the case it was built for.
- **Several GPUs for one large model.** vLLM, with tensor parallelism across them.

## Concurrency: where the gap shows

With one user, the two feel similar. With twenty, they do not.

Ollama handles parallelism with a few settings:

```bash
docker run -d --name ollama \
  -v ollama:/root/.ollama \
  -p 127.0.0.1:11434:11434 \
  -e OLLAMA_NUM_PARALLEL=4 \
  -e OLLAMA_MAX_LOADED_MODELS=2 \
  -e OLLAMA_KEEP_ALIVE=30m \
  ollama/ollama:0.12.6
```

`OLLAMA_NUM_PARALLEL` sets how many requests one model serves at once. Each parallel slot multiplies the memory needed for context, so raising it on a small machine can push the model off the GPU or out of RAM. `OLLAMA_KEEP_ALIVE` keeps a model loaded between requests, which avoids a reload delay on the next call.

vLLM batches automatically. You tell it how much GPU memory to use and how long contexts may be, and it fits as many sequences as it can:

```bash
docker run -d --name vllm --gpus all \
  --ipc=host \
  -v hf-cache:/root/.cache/huggingface \
  -e HF_TOKEN="$HF_TOKEN" \
  -p 127.0.0.1:8000:8000 \
  vllm/vllm-openai:v0.11.0 \
  --model Qwen/Qwen2.5-7B-Instruct \
  --max-model-len 16384 \
  --gpu-memory-utilization 0.90 \
  --api-key "$VLLM_API_KEY"
```

Lowering `--max-model-len` leaves room for more concurrent sequences. `--gpu-memory-utilization` is the share of VRAM vLLM claims at startup; leave headroom if anything else uses the GPU.

Measure on your own hardware and prompts before you commit. A quick load test against either server's `/v1/chat/completions` with your real prompt sizes tells you more than any published benchmark.

## Models and formats

- **Ollama** has a curated library of popular models in GGUF, and imports other GGUF files or Hugging Face GGUF repositories. New architectures appear once the engine supports them.
- **vLLM** loads most popular Hugging Face transformer architectures directly, often on release day. It runs full-precision weights and several GPU-oriented quantizations. GGUF support exists but is not its main path.

If you fine-tune your own models, vLLM fits the usual Hugging Face workflow and can serve LoRA adapters on top of a base model. Ollama can import fine-tuned weights after conversion to GGUF.

## API and app compatibility

Both expose an OpenAI-compatible endpoint, so your application code can stay the same:

```bash
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Authorization: Bearer $VLLM_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"Qwen/Qwen2.5-7B-Instruct","messages":[{"role":"user","content":"Summarise vLLM in one sentence."}]}'
```

Swap the base URL to `http://127.0.0.1:11434/v1` and the model to an Ollama name, and the same client works against Ollama. Ollama also has its own native API, which tools such as Open WebUI use for model management.

This compatibility is the best argument for not over-thinking the choice: start with one, put a gateway such as LiteLLM in front, and switch the backend later without touching your app.

## Operations in production

| Concern | Ollama | vLLM |
| --- | --- | --- |
| Startup | Fast; model loads on first request | Slower; loads weights and profiles memory before serving |
| Health check | `ollama list`, or `GET /` | `GET /health` |
| Metrics | Basic; mostly logs | Prometheus metrics at `/metrics` |
| Auth | None; put it behind a proxy or private network | One static key with `--api-key`; use a gateway for per-user keys |
| Multiple models | One server, many models | One container per model |
| Storage | Models in `/root/.ollama` | Hugging Face cache volume |

In both cases, keep the server off the public internet. Bind it to localhost or a private network, and put a gateway or reverse proxy with real authentication in front for anything shared.

## When to choose which

Choose **Ollama** when:

- You run on CPUs, a Mac or one modest GPU.
- A handful of people use the model, or a background job calls it occasionally.
- You want to try several models and switch between them without redeploying.
- Simplicity matters more than throughput.

Choose **vLLM** when:

- You have dedicated NVIDIA GPUs, or AMD with a supported setup.
- Many users or an API product send concurrent requests.
- You need stable latency under load, multi-GPU serving or Prometheus metrics.
- You serve one model, or a few, at full or GPU-friendly precision.

Plenty of teams use both: Ollama on developer machines and internal tools, vLLM on the GPU box that serves the product. Other options exist too: the llama.cpp server for lean CPU and edge deployments, and SGLang or Hugging Face TGI for GPU serving with different strengths.

## Running either one with LogiStack

LogiStack is an open-source self-hosted PaaS on Docker Swarm. Its service settings cover CPU and memory limits, not GPUs, which shapes how each runtime fits.

- **Ollama on a CPU server.** The [Ollama with Open WebUI](/templates/ollama-with-open-webui/) template deploys both services, keeps models in a volume, gives the Ollama API no public domain and exposes only the chat UI. Set a memory limit above the model's needs so a long prompt cannot take down neighbours. See [templates](/docs/deploy/templates/) and [service settings](/docs/deploy/service-settings/).
- **vLLM on a GPU host.** Run vLLM on a dedicated GPU machine or a GPU cloud, and keep the app, the [LiteLLM](/templates/litellm/) gateway, the vector database and the workers on LogiStack. Connect the two privately, for example over your tailnet with LogiStack's [Tailscale integration](/docs/networking/tailscale/).
- **A chat UI for either.** [Open WebUI](/templates/open-webui/) talks to Ollama natively and to vLLM through its OpenAI-compatible endpoint.

## FAQ

### Is vLLM faster than Ollama?

For many concurrent requests on a GPU, vLLM usually delivers much higher total throughput because of continuous batching and its memory management. For one user at a time on the same GPU, the difference is smaller, and Ollama's quantized models may respond just as quickly. Test with your own prompts.

### Can vLLM run without a GPU?

vLLM has a CPU backend, but it is not where vLLM shines and it needs more setup than Ollama. For CPU-only servers, Ollama or the llama.cpp server is the practical choice.

### Can Ollama handle multiple users?

Yes, for small teams. Raise `OLLAMA_NUM_PARALLEL` to serve several requests per model at once, and watch memory, since each parallel slot needs its own context cache. Beyond a few dozen active users, a batching server such as vLLM scales better.

### Do vLLM and Ollama use the same models?

They use the same open-weight models in different formats. Ollama runs GGUF files, usually quantized. vLLM runs Hugging Face weights in full or GPU-oriented quantized precision. The model name is the same; the file you download is not.

### Which is better for production?

It depends on production. An internal assistant for 15 people runs well on Ollama. A customer-facing API with steady concurrent traffic belongs on vLLM with GPUs. Either needs authentication, memory limits, health checks and monitoring around it.

Whichever server you pick, the app, gateway and data around it need a home too. [Install LogiStack](/#install), deploy the Ollama template or wire it to your GPU box, and read our guide to a [self-hosted RAG stack](/blog/rag-stack-self-hosted/) for what to build on top.
