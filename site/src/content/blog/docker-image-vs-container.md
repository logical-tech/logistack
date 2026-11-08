---
title: "Docker image vs container: what is the difference?"
description: "Docker image vs container explained: layers, tags, digests, the writable layer and lifecycle, with commands you can run to see the difference yourself."
date: 2026-11-08
category: Docker
keywords: docker image vs container, docker image, docker container, image layers, container lifecycle
---

You changed a config file inside a running container, restarted it, and the change survived. Then you redeployed and it was gone. Or you deleted a container to free disk space and `docker system df` barely moved. Both surprises come from the same place: mixing up the Docker image and the container. The **Docker image vs container** distinction is the first thing to get right, because every later decision (where data lives, how you roll back, why a deploy is reproducible) rests on it.

The short version: an image is a read-only template. A container is a running (or stopped) instance of that template with a thin writable layer on top. The rest of this article shows what that means on disk and in practice.

## The one-sentence answer

An image is a packaged filesystem plus metadata that never changes once built. A container is a process that Docker starts from that image, with its own writable layer, network namespace and lifecycle.

A useful analogy for developers: the image is the compiled binary, the container is the process running it. You can start many processes from one binary, and killing a process does not delete the binary.

## What a Docker image actually is

An image is a stack of read-only layers and a JSON config. Each layer is a tarball of filesystem changes. The config records the default command, environment variables, exposed ports, the working directory and the user.

Each instruction in a Dockerfile that changes files produces a layer:

```dockerfile
FROM node:22-alpine          # base layers from the node image
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile   # one layer with node_modules
COPY . .                     # one layer with your source
CMD ["node", "server.js"]    # metadata only, no layer
```

You can inspect the result:

```bash
docker image history my-app:1.4.2
docker image inspect my-app:1.4.2 --format '{{json .Config}}'
```

### Layers are shared

Two images built from `node:22-alpine` store the base layers once. That is why pulling a second Node app is fast and why `docker images` can report sizes that add up to more than your disk holds. The size column counts shared layers in every image that uses them.

### Tags versus digests

A tag such as `my-app:latest` or `my-app:1.4.2` is a movable pointer. Anyone with push access can point it at a different image tomorrow. A digest such as `my-app@sha256:3f1c...` is the hash of the image manifest, and it can never point at different content.

```bash
docker image ls --digests my-app
docker pull my-app@sha256:<digest>
```

For production, this matters. If two servers pull `my-app:latest` an hour apart, they can run different code. Pin a version tag you never reuse, or a digest.

## What a Docker container actually is

When you run `docker run my-app:1.4.2`, Docker:

1. Takes the image's read-only layers.
2. Adds an empty writable layer on top (copy-on-write).
3. Creates namespaces (process, network, mount, hostname) and cgroups for CPU and memory limits.
4. Starts the image's command as PID 1 inside that sandbox.

Everything the process writes outside a mounted volume lands in the writable layer. You can see exactly what changed:

```bash
docker run -d --name demo nginx:1.27
docker exec demo sh -c 'echo hello > /usr/share/nginx/html/test.txt'
docker diff demo
```

`docker diff` lists added (`A`), changed (`C`) and deleted (`D`) paths relative to the image. The image itself is untouched.

### Container lifecycle

A container moves through states: `created`, `running`, `paused`, `exited` and finally removed. Stopping a container does not delete its writable layer. That is why your edited config "survived" a restart: you restarted the same container. A redeploy creates a new container from the image, with a fresh, empty writable layer, and your edit was gone.

```bash
docker ps -a                 # running and stopped containers
docker container prune       # remove stopped containers and their writable layers
```

## Docker image vs container: side by side

| | Image | Container |
|---|---|---|
| What it is | Read-only layers plus config | A process sandbox built on an image |
| Mutable | No, a rebuild makes a new image | Yes, through its writable layer |
| Created by | `docker build`, `docker pull` | `docker run`, `docker create` |
| Identified by | Tag, image ID, digest | Container ID and name |
| Lives in | Local image store or a registry | The Docker host that runs it |
| Shared | Layers shared across images and hosts | Writable layer belongs to one container |
| Disappears when | You remove it and no container uses it | You remove the container |
| Listed with | `docker image ls` | `docker ps -a` |

## How many containers can one image run?

As many as the host has resources for. Each gets its own writable layer and its own network identity, while all of them read the same image layers from disk. This is how scaling works: ten replicas of a web service are ten containers from one image, not ten copies of the image.

```bash
for i in 1 2 3; do docker run -d --name web-$i nginx:1.27; done
docker ps --filter name=web-
```

## Where should data live?

Not in the writable layer. It is tied to one container, slow for heavy writes because of copy-on-write, and lost on every redeploy. Put anything that must survive in a volume:

```bash
docker volume create pgdata
docker run -d --name db -e POSTGRES_PASSWORD=change-me \
  -v pgdata:/var/lib/postgresql/data postgres:16.4
```

Now you can delete the container, start a new one from a newer image, and the data is still there. The full picture of named volumes, bind mounts and tmpfs is in our guide to [Docker volumes](/blog/docker-volumes/).

## Can you turn a container back into an image?

Yes, with `docker commit`, which snapshots the writable layer as a new image layer. Avoid it for anything you deploy. A committed image has no Dockerfile behind it, so nobody can tell how it was made or rebuild it after a security patch. Change the Dockerfile and rebuild instead. If you need to compare how Dockerfiles and compose files split the work, read [Dockerfile vs Docker Compose](/blog/dockerfile-vs-docker-compose/).

## Why the distinction matters in production

Once you treat images as immutable artifacts and containers as disposable, several good practices follow:

- **Rollbacks become cheap.** Rolling back means starting containers from the previous image. Nothing needs to be rebuilt, as long as the old image still exists in a registry.
- **Debugging stays honest.** If someone fixes a bug by hand inside a container, the next deploy erases the fix. Make the fix in the source and the image.
- **Security scans are meaningful.** You scan an image once and know what every container started from it contains, minus the writable layer.
- **Disk cleanup is predictable.** Old images and stopped containers are separate piles; prune each on purpose.

### How LogiStack applies this

LogiStack, the open-source PaaS we build, follows this model strictly. Every Git build produces an image tagged with its deployment ID, in the form `<registry>/<org>/<service>:<deploymentId>`, never `:latest`. A [rollback](/docs/deploy/deployments/) updates the service to the image of an earlier deployment without rebuilding. Services that run a prebuilt image keep the reference you give them, so the docs recommend pinning a version tag such as `ghcr.io/acme/api:1.4.2`. The [architecture reference](/docs/reference/architecture/) explains the full flow from build to registry to Swarm service.

LogiStack also scans the image each service runs against public vulnerability databases, after every deploy and once a day, which only works because the image is a fixed thing. See [vulnerability scanning](/docs/operations/vulnerability-scanning/).

## Common mistakes

- **Running `:latest` in production.** Two nodes can pull different images under the same tag. Pin versions.
- **Storing uploads or databases in the container.** Use a named volume.
- **Editing files with `docker exec` and calling it done.** Fine for a quick test, wrong as a fix.
- **Rebuilding to roll back.** A rebuild can pull newer base layers and produce a different image. Redeploy the old image instead.
- **Deleting images that running containers need.** Docker refuses to remove an image in use by a container, but deleting it from your registry can break the next node that tries to pull it.

## FAQ

### Is a Docker container a virtual machine?

No. A container shares the host's kernel and isolates a process with namespaces and cgroups. A virtual machine runs its own kernel on emulated hardware. Containers start in milliseconds and use far less memory, at the cost of weaker isolation than a VM.

### Does deleting a container delete the image?

No. Removing a container deletes only its writable layer and metadata. The image stays in the local store until you remove it with `docker image rm` or a prune.

### Why is my image so large?

Usually because build tools, caches or source files end up in the final layers. Use a multi-stage Dockerfile so only the runtime artifacts are copied into the last stage, start from a slim base image, and add a `.dockerignore` file.

### Can two containers share data?

Yes, by mounting the same volume. Both see the same files. Be careful with apps that expect exclusive access, such as databases: two database processes on one data directory will corrupt it.

### Is an image the same as a Dockerfile?

No. A Dockerfile is the recipe, the image is the result of running `docker build` on it. The same Dockerfile can produce different images over time if base images or dependencies change, which is why tags matter.

If you want images treated as immutable artifacts without wiring the registry, tags and rollbacks by hand, [install LogiStack](/#install) on a server and connect a repository. Each push becomes a new, pinned image, and every earlier one stays one click away.
