---
title: "Self-hosted S3 storage: run object storage on your own servers"
description: "Run self-hosted S3 storage with MinIO, Garage, SeaweedFS or RustFS: when it pays off, how to choose an engine, and how to keep data durable and private."
date: 2026-11-08
category: Self-hosting
keywords: self-hosted s3 storage, s3 compatible storage, minio alternative, garage s3, seaweedfs, rustfs, self-hosted object storage
---

Your app stores user uploads, product images and exports, and every one of them goes to a cloud bucket. The storage bill is small. The egress bill, the data-location questions from customers, and the dependency on one more provider are not. Self-hosted S3 storage puts an S3-compatible server on hardware you control, so your apps keep the same SDK and API while the files stay on your machines. This guide covers when that trade is worth it, how the main engines differ, and how to run one without losing data.

## When self-hosted S3 storage makes sense

Object storage at a large cloud provider is very hard to beat on durability. Your data is spread across many disks and several facilities, and the provider's engineers replace failed drives before you hear about them. A single server with one disk is a different thing. Be clear about what you gain and what you take on.

Self-hosting is a good fit when:

- **Egress dominates the bill.** Media-heavy apps, downloads and data pipelines that read the same objects over and over pay for every gigabyte that leaves a cloud bucket.
- **The app and its files live together.** If the app runs on your server, local object storage means low latency and no traffic over the public internet.
- **Data location matters.** Contracts or regulation require data to stay in a specific country or on hardware you own.
- **Development and staging.** A local S3 server gives every environment its own buckets for free.
- **Backup targets inside your own network,** as one copy among several.

It's a poor fit when the files are irreplaceable and you have one server with no second copy, or when nobody on the team wants to own disks, capacity and upgrades. In that case, a managed bucket at Cloudflare R2, Backblaze B2, Hetzner or AWS is the better call. A mix works too: self-hosted storage for hot data, replicated to a cloud bucket for durability.

## What S3-compatible actually means

"S3-compatible" means the server speaks enough of the Amazon S3 API that standard SDKs and tools work against it. The core is well covered everywhere: buckets, `PutObject`, `GetObject`, `ListObjectsV2`, multipart uploads, Signature V4 and presigned URLs. Differences show up in the advanced features:

- **Versioning** of objects, so overwrites and deletes can be undone.
- **Object lock** for write-once, read-many retention.
- **Lifecycle rules** that expire or move objects automatically.
- **Bucket policies and IAM** with fine-grained conditions.
- **Event notifications** on upload or delete.

Check the features you actually use against the engine's documentation. One more detail matters in practice: most self-hosted engines expect **path-style addressing** (`https://s3.example.com/bucket/key`) rather than a bucket subdomain. Set `forcePathStyle: true` in the AWS SDK, or the equivalent in your client.

## Self-hosted S3 engines compared

| Engine | Language | License | Strengths | Watch out for |
| --- | --- | --- | --- | --- |
| MinIO | Go | AGPLv3 | The most complete S3 API, versioning, policies, erasure coding | Community edition changed significantly in 2025 |
| RustFS | Rust | Apache 2.0 | MinIO-compatible API, web console, permissive license | Young project, smaller track record |
| Garage | Rust | AGPLv3 | Very low memory, built for several small nodes across sites | Smaller S3 feature set, check what you need |
| SeaweedFS | Go | Apache 2.0 | Many small files, versioning and policies, also a filer and FUSE mount | More components to understand |
| Ceph RGW | C++ | LGPL | Massive scale, block and file storage in the same cluster | Needs several nodes and real Ceph expertise |

### MinIO

MinIO was the default answer for years. It has the broadest S3 coverage and a long production record. In 2025 the company moved most administration features out of the community web console and stopped publishing free prebuilt binaries and images for new releases, steering users to its commercial product. Check the current state of the community edition before you standardize on it, and be aware of the AGPL obligations if you modify and distribute it.

### RustFS

RustFS is a newer engine that targets MinIO's API and console experience under the Apache 2.0 license. It's attractive for teams that want a MinIO-like setup without the AGPL. It's also young: test the features you rely on and watch its release notes closely.

### Garage

Garage comes from a collective that runs infrastructure on small, geographically spread machines. It replicates data across nodes and zones, uses very little memory, and keeps operations simple. It deliberately implements a smaller part of the S3 API, so confirm support for features such as versioning or lifecycle rules before you depend on them.

### SeaweedFS

SeaweedFS is designed for billions of small files. It stores them efficiently, offers an S3 gateway, versioning and IAM-style keys, and can also expose the same data as a filesystem. It has more moving parts (master, volume servers, filer), which pays off at scale and adds learning on day one.

### Ceph

Ceph's RADOS Gateway is what large organizations use for petabytes. It's the wrong tool for one or two servers: the minimum sensible cluster is several nodes, and running it well is a specialty.

## Using self-hosted S3 from your app

Once the server runs, clients talk to it exactly like AWS S3, with a custom endpoint. With the AWS CLI:

```bash
export AWS_ACCESS_KEY_ID=app-key-id
export AWS_SECRET_ACCESS_KEY=app-secret
export AWS_DEFAULT_REGION=us-east-1
S3=https://s3.example.com

aws s3 mb s3://product-images --endpoint-url "$S3"
aws s3 cp ./sku-1042.webp s3://product-images/products/ --endpoint-url "$S3"
aws s3 ls s3://product-images/products/ --endpoint-url "$S3"

# A download link valid for one hour, without making the bucket public
aws s3 presign s3://product-images/products/sku-1042.webp \
  --expires-in 3600 --endpoint-url "$S3"
```

In Python with boto3:

```python
import os
import boto3
from botocore.config import Config

s3 = boto3.client(
    "s3",
    endpoint_url=os.environ["S3_ENDPOINT"],
    region_name=os.environ.get("S3_REGION", "us-east-1"),
    config=Config(s3={"addressing_style": "path"}),
)

s3.upload_file("report.pdf", "exports", "2026/11/report.pdf")
```

Keep the endpoint in an environment variable so the same code runs against a local engine in development and any other S3 store elsewhere.

## Durability: don't lose the files

A self-hosted bucket is only as durable as the disks under it. Plan for failure from the start.

- **Redundancy on the node.** Use RAID or the engine's erasure coding, so one failed disk loses nothing.
- **Redundancy across nodes.** Garage, SeaweedFS, MinIO and Ceph can replicate across servers. A second node in another location protects against losing a whole machine.
- **A copy somewhere else.** Sync important buckets to another provider on a schedule. rclone handles this between any two S3 endpoints:

```bash
rclone sync selfhosted:product-images r2:product-images-replica \
  --checksum --transfers 16
```

- **Versioning** where the engine supports it, so an app bug that overwrites files can be reversed.
- **Monitor free space.** Object stores fill up quietly, and a full disk fails every upload at once.

If the bucket holds your database backups, the copy-elsewhere rule is not optional. Backups on the same server as the database don't survive losing that server. Our [database backup](/blog/database-backup/) guide explains why.

## Security checklist

- **Buckets private by default.** Share single files with presigned URLs that expire, not with public buckets.
- **One access key per app,** scoped to the buckets it needs and to read-only when it only reads. Revoke a key without touching the others.
- **Root credentials only for administration.** Never in an app's environment.
- **TLS on any public endpoint.** Put the S3 API behind a reverse proxy with a valid certificate. See [what is Caddy](/blog/what-is-caddy/) for one that handles certificates for you.
- **Keep the web console private** or behind authentication. It's an admin panel for all your files.

## Self-hosted S3 storage on LogiStack

[LogiStack](/features/) runs object storage as a service in your project, next to the apps that use it. From **New service** › **Object storage**, you pick MinIO, RustFS, Garage or SeaweedFS and a name. LogiStack generates the root credentials, keeps them encrypted, and asks whether the S3 endpoint and, for MinIO and RustFS, the web console should get a public domain. Apps in the same environment always reach the internal endpoint, and buckets start private either way.

![The Storage tab of a MinIO service: buckets on the left, folders and files of product-images on the right](/docs/screens/service-storage.webp)

Each storage service gets a **Storage** tab with:

- **A bucket browser:** create buckets, upload by drag and drop, create folders, preview images and text, rename, download and bulk delete. Per-bucket **Versioning** and **Public read** settings, where the engine supports them.
- **Share links** for one object that expire after 1 hour, 1 day or 7 days, without making the bucket public.
- **Scoped access keys:** pick the buckets and **Read only** or **Read and write**, copy the variables into the app, and revoke in one click.
- **Connection settings:** internal and public endpoints, region, addressing style, and an environment-variable block ready to paste.
- **Use as backup destination:** turn a bucket into an S3 destination for database and volume backups in one step.

The **Storage** page in the sidebar lists every object storage service in the organization with its engine, project and status. The full walkthrough is in the [object storage docs](/docs/data/object-storage/), and backup destinations are covered in [S3 destinations](/docs/data/s3-destinations/).

One honest note: LogiStack gives you the S3 server and the tools around it, with the data on the service's volume. It doesn't build a replicated multi-site cluster for you. For files you can't lose, keep an off-site copy at a second provider, as the docs recommend.

## FAQ

### Is self-hosted S3 storage cheaper than AWS S3?

Often, when egress is a large part of your bill or you already pay for servers with spare disk. Raw storage at cloud providers is cheap, but data transfer out and request charges add up for media-heavy apps. Count the cost of redundancy and your own time before you decide.

### What is the best MinIO alternative?

It depends on what you need. RustFS is the closest in API and console under a permissive license, Garage is the lightest for small multi-site clusters, and SeaweedFS handles very many small files well. For a single node in a small team, any of them works; test your app's S3 calls against the one you pick.

### Can I use self-hosted S3 for backups?

Yes, as one copy. It's fast to write to and keeps data in your network. Keep a second copy at another provider or location, because a backup on the same server as the data doesn't survive losing that server.

### Do existing S3 SDKs work with self-hosted engines?

Yes. Set the endpoint URL, the region (often `us-east-1`) and path-style addressing. Uploads, downloads, listing, multipart uploads and presigned URLs work on all the engines in this guide; check advanced features like object lock per engine.

Self-hosted S3 storage is a good trade when you know where the files live and how they get a second copy. If you want the server, the bucket browser, scoped keys and backups wired together, [install LogiStack](/#install) and add an object storage service to your first project.
