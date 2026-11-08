---
title: "How to deploy an MCP server: build, host and secure it"
description: "Deploy an MCP server over Streamable HTTP: build a small TypeScript server, containerize it, add auth, host it with HTTPS and connect Claude or Cursor."
date: 2026-11-08
category: AI
keywords: deploy mcp server, host mcp server, remote mcp server, model context protocol server, self-host mcp server, streamable http mcp
---

Your MCP server works on your laptop. Claude Code starts it over stdio, the tools show up, and the agent can query your orders table. Then a teammate asks for it, or you want to use it from Claude Desktop on another machine, and the stdio setup stops scaling: everyone needs the code, the runtime and the database credentials on their own machine. To deploy an MCP server properly, you turn it into a small web service with one URL, one place for credentials and an access check in front. This guide builds a minimal remote server in TypeScript, packages it in Docker, secures it and puts it on your own server with HTTPS.

## When you need to deploy an MCP server at all

The Model Context Protocol has two standard transports. Pick the one that matches who uses the server.

| | stdio | Streamable HTTP |
| --- | --- | --- |
| Where it runs | A child process the client starts on the same machine | A web service, anywhere the client can reach |
| Who uses it | One person, one machine | A team, several clients, hosted agents |
| Credentials | On every user's machine | On the server only |
| Updates | Every user pulls and rebuilds | You deploy once |
| Auth | The OS user | Something you add: a token, OAuth or a private network |
| Good for | File system tools, local dev helpers | Internal APIs, databases, SaaS integrations |

Keep stdio for tools that act on the user's own machine, like a local file search. Anything that talks to a shared system, such as a database, an internal API or a ticketing tool, belongs on a server. The older HTTP+SSE transport is deprecated in the spec; build new servers on Streamable HTTP.

## Build a minimal remote MCP server

The official TypeScript SDK handles the protocol. You write the tools. This server exposes one read-only tool that looks up an order in Postgres.

```bash
mkdir orders-mcp && cd orders-mcp
npm init -y
npm install @modelcontextprotocol/sdk express zod pg
npm install -D typescript @types/express @types/node @types/pg
```

```ts title="src/server.ts"
import express from "express";
import pg from "pg";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

const db = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const TOKEN = process.env.MCP_TOKEN;
if (!TOKEN) throw new Error("MCP_TOKEN is required");

function buildServer() {
  const server = new McpServer({ name: "orders", version: "1.0.0" });

  server.registerTool(
    "get_order",
    {
      description: "Look up one order by its id. Returns status, total and line items.",
      inputSchema: { id: z.string().regex(/^ord_[a-z0-9]+$/) },
    },
    async ({ id }) => {
      const { rows } = await db.query(
        "select id, status, total_cents, items from orders where id = $1",
        [id],
      );
      const text = rows[0] ? JSON.stringify(rows[0]) : `No order ${id}`;
      return { content: [{ type: "text", text }] };
    },
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "1mb" }));

app.get("/healthz", (_req, res) => res.send("ok"));

app.use("/mcp", (req, res, next) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
});

// Stateless: a fresh server and transport per request, no session to keep.
app.post("/mcp", async (req, res) => {
  const server = buildServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

app.listen(Number(process.env.PORT ?? 3000));
```

Three choices in this file matter in production:

- **Tight input schemas.** The regex on `id` means a confused agent cannot send SQL fragments or a 10 MB string. The model reads the schema and the description, so write both for a reader.
- **Parameterized queries.** The agent supplies `id`, so treat it like any user input.
- **A health route outside `/mcp`.** The platform checks it without a token.

If you prefer Python, the official SDK's FastMCP class does the same with decorators and `mcp.run(transport="streamable-http")`. Everything below applies unchanged.

## Stateless or stateful

Streamable HTTP supports sessions: the server returns an `Mcp-Session-Id` header on initialize, and the client sends it on every later request. Sessions let a server push notifications or keep per-conversation state in memory.

They also make scaling harder. With two replicas, a request carrying session A can land on the replica that never saw session A. You then need sticky routing or a shared session store.

Most tool servers do not need any of that. Each tool call is a self-contained request: read the input, query something, return text. Run stateless, as above, and you can run any number of replicas behind a load balancer with no extra work. Move to sessions only when a tool needs server-initiated messages or long-lived state, and keep that state in Redis or Postgres rather than in process memory.

## Containerize it

```dockerfile title="Dockerfile"
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc --outDir dist

FROM node:22-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
```

The runtime stage carries only production dependencies and runs as the unprivileged `node` user. Secrets such as `DATABASE_URL` and `MCP_TOKEN` come from the environment at runtime and never enter the image. If you are new to multi-stage builds, our guide to [Dockerfile vs Docker Compose](/blog/dockerfile-vs-docker-compose/) covers the basics.

## Secure a remote MCP server

An MCP server is an API that an AI model drives. It deserves more care than a normal internal API, not less, because the caller can be talked into things by whatever text it reads.

### Authenticate every request

Pick the model that fits your audience:

- **A static bearer token** per user or per client, as in the example. Simple, and fine for an internal server used by a handful of people. Give each person their own token so you can revoke one without breaking everyone.
- **OAuth 2.1.** The MCP authorization spec describes the server as an OAuth resource server, with discovery so clients can send the user through a sign-in flow. Use it for a server that outside users connect to, or when you want sign-in through your identity provider.
- **A private network.** Publish the server only on a VPN or tailnet, so it never faces the internet. Combine it with a token; network position alone is weak identity.

Whatever you choose, the server should also check the `Origin` header on browser requests, and a server meant for local use should bind to `127.0.0.1`, not `0.0.0.0`. Both close DNS rebinding attacks the spec warns about.

### Limit what the server itself can do

The server's own credentials set the ceiling for any agent that uses it. A tool that only reads orders should connect with a database role that can only read orders:

```sql
create role mcp_orders login password 'change-me';
grant select on orders to mcp_orders;
```

Then a prompt injection that convinces the agent to "clean up old orders" fails at the database, not at the hope that the model behaves.

### Gate destructive tools

If a tool deletes, refunds or deploys, make the model ask a human first. A pattern that holds up: give the tool a required `confirm: boolean` argument, refuse the call when it is missing, and return a message telling the agent to get explicit approval. Enforcement lives in your code, not in the prompt.

### Log every call

Log the tool name, the arguments (redact secrets), the caller's token id and the outcome. When an agent does something odd, this is the only record of what it actually asked for.

## Deploy the MCP server with HTTPS

The steps are the same on any platform:

1. Push the repository to Git.
2. Build the image from the Dockerfile.
3. Set `DATABASE_URL` and `MCP_TOKEN` as secret environment variables.
4. Point a domain at the service, with a TLS certificate.
5. Add a health check on `/healthz` so traffic waits until the process is up.
6. Optionally restrict who can reach the domain at the proxy.

On LogiStack, an open-source self-hosted PaaS, that is one wizard. Create a service from your repository, choose the **Dockerfile** build type and set the container port to `3000`, as described in [deploy from Git](/docs/deploy/from-git/) and [build types](/docs/deploy/build-types/). Mark both variables as secrets on the service's **Environment** tab. Add a domain such as `mcp.example.com`, and Caddy gets the certificate. Under **Settings › Healthcheck and drain**, set an HTTP check on port `3000`, path `/healthz`. Each push to the branch then builds a new image and rolls it out once the check passes.

For a server only your team should reach, add an IP allow list on the domain ([access rules](/docs/networking/access-control/)), or skip the public domain and publish it on your Tailscale tailnet. If your agents run elsewhere, such as in CI or on hosted runners, keep the public domain and rely on per-client tokens.

## Test it before you hand it out

Check the protocol with plain `curl`. Streamable HTTP clients must accept both JSON and an event stream:

```bash
curl -s https://mcp.example.com/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"curl","version":"0"}}}'
```

A response with `serverInfo` and `capabilities` means routing, TLS and auth all work. For an interactive check, run the MCP Inspector, connect it to the URL with the header, list tools and call `get_order`:

```bash
npx @modelcontextprotocol/inspector
```

## Connect Claude Code, Cursor and others

Claude Code adds a remote server in one command:

```bash
claude mcp add --transport http orders https://mcp.example.com/mcp \
  --header "Authorization: Bearer $MCP_TOKEN"
```

Cursor and VS Code read a JSON file with the URL and headers. Keep the token in an environment variable or the client's secret prompt, never in a file you commit.

## A production checklist

- **Timeouts.** Agents wait for tools. Give slow tools their own timeout and return a clear error, rather than letting the proxy cut the connection.
- **Long jobs.** If a tool takes minutes, start a background job and return its id, with a second tool to check status. Our guide on [deploying AI agents](/blog/deploy-ai-agents/) covers queues and workers.
- **Output size.** Models have context limits. Paginate and cap results; return 50 rows and a cursor, not 50,000.
- **Pinned versions.** Pin the SDK and base image, and roll back by redeploying the previous image when an upgrade breaks a client.
- **Rate limits.** A looping agent can call one tool hundreds of times a minute. Limit per token.
- **Clear tool descriptions.** The model picks tools by name and description. Vague descriptions cause wrong calls.

## LogiStack has its own MCP server

You do not need to build one to let an agent run your infrastructure. LogiStack exposes an MCP server at `/mcp` on your dashboard's URL. Every REST operation is a tool, each call runs with the API key's role and scopes, every change lands in the audit log, and destructive tools refuse to run without `confirm: true`. It uses the same patterns this guide recommends: per-client keys, least privilege and a human gate on deletes. See the [MCP server docs](/docs/automation/mcp-server/), and our guide to [letting AI agents operate your infrastructure](/blog/ai-agents-infrastructure/) for the policies around it.

![The API keys page with the MCP server panel showing the endpoint and a ready-made Claude Code command](/docs/screens/settings-api-keys.webp)

## FAQ

### Can I host an MCP server for free?

Yes, if you already have a server. An MCP server is a small web process, often under 100 MB of memory, and runs next to your other apps. You pay only for the machine, the domain and your time.

### Should my MCP server use stdio or HTTP?

Use stdio when the tools act on the user's own machine and only that user needs them. Use Streamable HTTP when the server talks to shared systems, when several people or agents use it, or when credentials should stay off laptops.

### How do I authenticate a remote MCP server?

For internal use, a bearer token per client checked on every request is enough, ideally combined with an IP allow list or a private network. For servers used by outside users, implement OAuth 2.1 as the MCP authorization spec describes.

### Can I run several replicas of an MCP server?

Yes, if it is stateless: create a new transport per request and keep no session data in memory. Stateful servers with `Mcp-Session-Id` sessions need sticky routing or a shared session store.

### Does Claude Desktop support remote MCP servers?

Claude Desktop starts local servers from its configuration file. To reach a remote server, bridge it with a small local proxy such as `mcp-remote`, or add it as a connector where your plan supports that.

If you want somewhere to run your MCP servers with HTTPS, secrets, health checks and per-push deploys, [install LogiStack](/#install) on a server you own. Everything is in the open-source build, including the MCP server that lets your agents operate the platform itself.
