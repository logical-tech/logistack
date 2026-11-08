---
title: "Self-host Open WebUI: a private ChatGPT for your team"
description: "Self-host Open WebUI as a private ChatGPT for your team: deploy it alone or with Ollama, connect hosted APIs and keep chats on your servers."
date: 2026-11-08
category: AI
keywords: self-host open webui, open webui docker, private chatgpt, ollama web ui, self-hosted chatgpt alternative
---

Half your team pastes code and customer emails into ChatGPT, the other half wants to and has been told not to. A shared ChatGPT Team plan solves the policy question but not the data question, and it is billed per seat. If you self-host Open WebUI, you give everyone a familiar chat interface on a domain you own, with chats stored on your server and models you choose: local ones through Ollama, hosted ones through any OpenAI-compatible API, or both. This guide shows how to set it up for a team.

## What Open WebUI is

Open WebUI is a web interface for large language models. It does not run models itself. It talks to backends:

- **Ollama**, for open-weight models on your own hardware.
- **Any OpenAI-compatible API**: OpenAI, Mistral, Groq, OpenRouter, a vLLM server, or a gateway such as LiteLLM that fronts several providers.

On top of that it adds what a team needs: user accounts with roles, per-model access control, chat history, shared prompts, document upload with retrieval (RAG), web search, image generation hooks, and an admin panel. It runs as a single Python container and stores its data in a volume.

A note on licensing: Open WebUI started under BSD-3 and moved to its own license in 2025, which keeps the BSD terms but adds a branding clause for larger deployments. If you plan to rebrand it for many users, read the license first.

## Choose your model backend first

Where the model runs decides your cost, speed and privacy. The published guide on [how to deploy AI models](/blog/deploy-ai-models/) covers runtimes, memory sizing and GPUs in depth; here is the short version for a chat UI:

| Setup | Where prompts go | Hardware | Good for |
| --- | --- | --- | --- |
| Open WebUI + hosted API | The API provider | Any small server | Best answer quality, quick start |
| Open WebUI + Ollama on CPU | Nowhere, stays on your server | 8 to 16 GB RAM for 7B to 8B models | Private, low-volume internal use |
| Open WebUI + GPU inference elsewhere | Your GPU host | A separate GPU server | Private and fast for many users |
| Open WebUI + LiteLLM gateway | Per model, your choice | Small server for the UI | Mixing local and hosted models with budgets |

Many teams start with a hosted API for quality and add a local model for sensitive work.

## Two LogiStack templates

LogiStack has two templates for this, and they differ in one important way.

| Template | Services | Public | Use it when |
| --- | --- | --- | --- |
| [Open WebUI](/templates/open-webui/) | `open-webui` | The UI on port 8080 | You use hosted APIs or an inference server you already run |
| [Ollama with Open WebUI](/templates/ollama-with-open-webui/) | `ollama-api` + `open-webui` | Only the UI | You want local models on the same server |

In the Ollama template, the `ollama-api` service has no public domain. Open WebUI reaches it on the internal network through `OLLAMA_BASE_URL`, set to the service's internal hostname on port 11434. Ollama's API has no authentication of its own, so keeping it private is the right default. Model weights live in the `ollama` volume, so they survive redeploys. Open WebUI's data lives in the `open-webui` volume at `/app/backend/data`.

Both images are pinned by digest, so a redeploy never pulls a surprise version.

## Deploy Open WebUI

Install LogiStack on your server if you have not:

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

Size the server for the backend. For Open WebUI with hosted APIs, 2 GB of RAM is enough. With Ollama on the same machine, add the model's memory: a 4-bit 8B model needs roughly 5 GB on top.

1. Create a DNS record such as `chat.example.com` pointing at the server.
2. In a project, select **New service** › **Templates** and search `open webui`.
3. Pick **Open WebUI** or **Ollama with Open WebUI**.
4. Enter `chat.example.com` as the public URL.
5. Review and **Deploy**.

When the services are healthy, open the URL. The [templates guide](/docs/deploy/templates/) has screenshots of every step.

### Claim the admin account immediately

The first account to sign up becomes the admin. Create yours right after the deploy. Then, in **Admin Panel** › **Settings** › **General**:

- Set the **default user role** to **pending**, so new sign-ups wait for your approval.
- Or turn sign-up off entirely and add users yourself.

You can also set this from the environment with `ENABLE_SIGNUP=false` and `DEFAULT_USER_ROLE=pending` on the `open-webui` service.

## Pull a model into Ollama

If you used the Ollama template, the model list is empty at first. Open the `ollama-api` service, select **Terminal**, and pull a model:

```bash
ollama pull llama3.1:8b
ollama list
```

The weights land in the `ollama` volume. Refresh Open WebUI and the model appears in the picker. Admins can also pull models from **Admin Panel** › **Settings** › **Models**.

Keep a few things in mind:

- **Memory limits.** Set a memory limit on `ollama-api` in its service settings, with headroom above the model size. The most common failure is an out-of-memory kill on a long conversation.
- **Disk.** Each model takes several gigabytes. Check the node's disk before pulling a large one.
- **No GPU settings.** LogiStack's service settings cover CPU and memory, not GPUs. For GPU inference, run the model server on a GPU host and point Open WebUI at it as an OpenAI-compatible connection.

## Connect hosted models

Add OpenAI-compatible connections under **Admin Panel** › **Settings** › **Connections**, or with environment variables on the `open-webui` service:

```text
OPENAI_API_BASE_URL=https://api.openai.com/v1
OPENAI_API_KEY=sk-...
```

Mark the key as a secret when you add it on the **Environment** tab, so it is stored encrypted and never shown in logs. The change waits as a pending diff until you deploy.

To use several providers with per-team budgets and one audit trail, deploy the LiteLLM template next to Open WebUI and add LiteLLM as the single OpenAI-compatible connection.

## Control who uses which model

In a team, not everyone should use the expensive model, and some models should only see some data.

- **Groups.** Create groups under **Admin Panel** › **Users** › **Groups**, for example `engineering` and `support`.
- **Model visibility.** In **Workspace** › **Models**, set each model to private and grant it to specific groups.
- **Custom models.** Wrap a base model with a system prompt and attached knowledge, for example a support assistant that answers from your help-center docs, and share it with one group.

For extra protection, put the whole domain behind your company sign-in with forward auth, or an IP allowlist for office networks. LogiStack's [access control](/docs/networking/access-control/) adds either at the proxy, before a request reaches Open WebUI.

## Documents and RAG

Users can attach files to a chat, or admins can build knowledge collections that models search. By default, Open WebUI embeds documents with a small local model and stores vectors in an embedded database inside its data volume. That works for a few hundred documents.

For larger collections, point Open WebUI at an external vector database such as Qdrant or Chroma through its `VECTOR_DB` settings, and choose a stronger embedding model. Embedding with a hosted API is faster on a CPU-only server but sends document text to that provider, so decide per collection.

## Back up chats and settings

Everything Open WebUI knows sits in the `open-webui` volume: users, chats, settings, uploaded documents and vectors. Its default database is SQLite.

- Create a backup policy on the `open-webui` service for that volume and turn on **Stop open-webui while archiving**, so SQLite is copied in a consistent state. Schedule it at night.
- You do not need to back up the `ollama` volume. Model weights can be pulled again; back it up only if bandwidth is scarce.

The [backups guide](/docs/data/backups/) covers destinations, encryption and retention.

## FAQ

### Is Open WebUI free?

Yes, you can self-host it for free. Its license keeps BSD-style terms with an added branding clause for larger deployments. Your costs are the server and any hosted API you connect.

### Do I need a GPU to run Open WebUI?

No. Open WebUI itself is a light web app. Only local models need serious hardware: small quantized models run on CPU for internal use, and a GPU helps for larger models or many users.

### Can Open WebUI use ChatGPT models?

It can use OpenAI's API models with an API key, billed per token. That is separate from a ChatGPT subscription, which does not include API access.

### Is my data private with self-hosted Open WebUI?

Chats, users and documents stay on your server. Prompts sent to a hosted model go to that provider. Use local models through Ollama for data that must not leave your infrastructure.

### What are the alternatives to Open WebUI?

LibreChat is strong at multi-provider chat with agents, and AnythingLLM focuses on document workspaces. Both have LogiStack templates, so you can try them side by side.

A private ChatGPT is one of the most useful things a small team can self-host. [Install LogiStack](/#install), deploy Open WebUI, and give your team a chat UI on your own domain with HTTPS, access rules and backups. Then read our guide on the [AI sandbox](/blog/ai-sandbox/) for letting agents work against it safely.
