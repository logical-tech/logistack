---
title: "Docker volumes explained: named volumes, bind mounts, tmpfs"
description: "Docker volumes explained: when to use named volumes, bind mounts or tmpfs, how to back up and restore a volume, and the mistakes that lose data."
date: 2026-11-08
category: Docker
keywords: docker volumes, docker named volume, docker bind mount, docker volume backup, docker tmpfs
---

You redeployed a container and the uploads folder came back empty. Or you ran `docker compose down -v` to "reset something" and the database went with it. Data loss in Docker almost always comes down to one question: where did the files live? **Docker volumes** are the answer Docker gives, and this guide covers the three storage types, how to choose between them, and how to back up and restore a volume without guesswork.

## Why containers need volumes

A container's filesystem is the image's read-only layers plus one writable layer. That writable layer belongs to the container. Remove the container and the layer goes with it. Every redeploy creates a new container, so anything written there is gone. (If that model is new, read [Docker image vs container](/blog/docker-image-vs-container/).)

The writable layer is also slow for heavy writes, because of copy-on-write. Databases on it perform badly and lose everything on the next deploy.

A volume mounts storage from outside the container at a path inside it. The container can be replaced. The storage stays.

## The three types of Docker storage

| Type | Where the data lives | Managed by | Survives container removal | Typical use |
|---|---|---|---|---|
| Named volume | `/var/lib/docker/volumes/<name>/_data` | Docker | Yes | Databases, uploads, app state |
| Bind mount | Any host path you choose | You | Yes | Dev source code, host config files |
| tmpfs mount | Host memory | Docker | No, gone on stop | Scratch files, secrets you never want on disk |

There is also the anonymous volume: a named volume with a random ID instead of a name. Images create them when they declare `VOLUME` in the Dockerfile and you do not mount anything there. They are easy to lose track of.

## Named volumes

Named volumes are the default choice for data that matters. Docker creates and owns the directory, sets it up with the right permissions on first use, and copies the image's existing files at that path into a new, empty volume.

```bash
docker volume create pgdata

docker run -d --name db \
  -e POSTGRES_PASSWORD=change-me \
  --mount type=volume,source=pgdata,target=/var/lib/postgresql/data \
  postgres:16.4
```

The shorter `-v pgdata:/var/lib/postgresql/data` does the same. The `--mount` syntax is more verbose but fails loudly on mistakes, while `-v` silently creates a volume or directory if you mistype a name.

In Compose:

```yaml
services:
  db:
    image: postgres:16.4
    volumes:
      - pgdata:/var/lib/postgresql/data

volumes:
  pgdata: {}
```

Inspect and list them:

```bash
docker volume ls
docker volume inspect pgdata
docker system df -v        # size of each volume
```

## Bind mounts

A bind mount maps a host path straight into the container:

```bash
docker run -d --name web \
  --mount type=bind,source="$(pwd)"/site,target=/usr/share/nginx/html,readonly \
  nginx:1.27
```

Use them when the host owns the files:

- **Local development.** Mount your source folder so changes appear without a rebuild.
- **Host configuration.** Mount a single config file read-only.
- **Host integration.** Some tools need host paths, such as the Docker socket for a monitoring agent. Treat that as a privileged mount, because access to the socket is effectively root on the host.

Bind mounts have sharp edges in production:

- They depend on the exact directory layout of one server.
- File ownership is whatever the host says. A container running as UID 1000 cannot write to a root-owned folder.
- An empty host folder hides whatever the image had at that path, unlike a new named volume, which is filled from the image.

## tmpfs mounts

A tmpfs mount lives in memory and disappears when the container stops:

```bash
docker run -d --mount type=tmpfs,target=/tmp,tmpfs-size=64m my-app:1.4.2
```

Use it for scratch data you never need again, or with a read-only root filesystem (`--read-only`) when the app still needs somewhere to write temporary files.

## Named volume or bind mount: how to choose

- Does Docker need to manage the lifecycle, including on a fresh server? **Named volume.**
- Does a human edit the files on the host? **Bind mount.**
- Is it a database's data directory? **Named volume**, always.
- Should the data never touch disk? **tmpfs.**

## How to back up a Docker volume

A volume is storage, not a backup. If the disk fails or someone runs `down -v`, the data is gone. Two approaches cover nearly every case.

### Back up the files

Start a throwaway container that mounts the volume and writes an archive to a bind-mounted folder:

```bash
docker run --rm \
  -v pgdata:/data:ro \
  -v "$(pwd)":/backup \
  alpine:3.20 \
  tar czf /backup/pgdata-$(date +%F).tar.gz -C /data .
```

Stop or pause the writing container first, or the archive can capture a half-written state.

### Back up the database with its own tool

For databases, a logical dump is safer than copying files from a running server:

```bash
docker exec db pg_dump -U postgres -Fc postgres > pg-$(date +%F).dump
```

`pg_dump`, `mysqldump` and `mongodump` produce a consistent snapshot while the database keeps running. Our [database backup](/blog/database-backup/) guide covers schedules, encryption and retention.

### Restore a volume

```bash
docker volume create pgdata-restored
docker run --rm \
  -v pgdata-restored:/data \
  -v "$(pwd)":/backup:ro \
  alpine:3.20 \
  sh -c 'tar xzf /backup/pgdata-2026-11-08.tar.gz -C /data'
```

Then start the database on `pgdata-restored`. Test restores on a schedule. An untested backup is a hope.

## Cleaning up volumes safely

Volumes are never removed automatically when you remove a container, unless you ask:

```bash
docker rm -v my-container     # also removes its anonymous volumes
docker volume prune           # removes unused anonymous volumes
docker volume prune -a        # also removes unused named volumes
docker compose down -v        # removes the project's named volumes
```

Since Docker Engine 23, `docker volume prune` without `-a` leaves named volumes alone. Older guides that say otherwise describe the previous behaviour. Read twice before running `-a` or `down -v` on a server.

## Volumes on more than one server

Named volumes use the `local` driver by default, which means the data lives on one machine. In a cluster such as Docker Swarm, a service with a local volume must run on the node that holds the data. Options for sharing storage across nodes include NFS, volume plugins for cloud block storage, or moving the data out of the filesystem entirely into a database or S3-compatible storage. Each adds latency and a failure mode, so many teams pin stateful services to one node and replicate at the application level instead. The trade-offs come up again in [Docker networking](/blog/docker-networking/) and [Docker Swarm](/blog/docker-swarm/).

## Common mistakes

- **Running a database without a volume.** The first redeploy wipes it.
- **Two database containers on one volume.** Two processes writing the same data directory corrupt it.
- **`down -v` as a reset button.** It deletes named volumes, including the database.
- **Bind-mounting an empty folder over an app's data path.** The app sees an empty directory and may initialise a new, blank state.
- **Assuming the volume is backed up because the server has snapshots.** A disk snapshot taken mid-write can hold a database that will not start.

## How LogiStack handles volumes

LogiStack, the open-source PaaS we build on Docker Swarm, keeps service data on named volumes. Databases store their data directory on one, and a service's [Files tab](/docs/data/volumes-and-files/) lets you browse a volume, upload files or a whole folder, and download them without SSH. Deleting a service keeps its named volumes until you remove them.

Backups are a policy on the service: database dumps for every engine it runs, or archives of any volume, on a cron schedule, encrypted before they leave the server and sent to S3-compatible storage. A scheduled restore check restores the latest backup into a throwaway container and reports whether it worked. See [backups](/docs/data/backups/).

Two limits to know. Volumes are local to a node, so a service with a volume is pinned to the node that holds its data. And in [compose stacks](/docs/deploy/compose-stacks/), host path bind mounts and a volume shared by two services are refused; a relative bind such as `./data` becomes a named volume. Bind mounts are still available on a service under its host access settings, but they bypass LogiStack's volume backups.

## FAQ

### Where are Docker volumes stored?

On Linux, named volumes live under `/var/lib/docker/volumes/<name>/_data` with the default `local` driver. On Docker Desktop for macOS and Windows, they live inside the Linux VM that Docker Desktop runs, not on your host filesystem.

### Do Docker volumes persist after a container is removed?

Yes. Named volumes stay until you remove them with `docker volume rm`, `docker volume prune -a` or `docker compose down -v`. Anonymous volumes also stay unless you remove the container with `docker rm -v`.

### Can two containers share a volume?

Yes, mount the same named volume in both. It works well for read-mostly data or a producer and a consumer of files. It does not work for two instances of a database, which need exclusive access to their data directory.

### Are bind mounts slower than volumes?

On Linux, both run at native disk speed. On Docker Desktop for macOS and Windows, bind mounts cross the boundary between the host and the VM and can be noticeably slower for many small files, so named volumes are faster there.

### How big can a Docker volume get?

With the `local` driver, a volume can grow until the host filesystem holding `/var/lib/docker` is full. Docker does not cap it by default. Monitor disk usage on the server.

If you want volumes with scheduled, encrypted backups and restore checks without writing the cron jobs yourself, [install LogiStack](/#install) on a server and add a backup policy to your first database.
