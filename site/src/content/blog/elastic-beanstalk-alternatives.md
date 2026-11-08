---
title: "Elastic Beanstalk alternatives: on AWS and beyond"
description: "Compare AWS Elastic Beanstalk alternatives: ECS Express Mode, ECS on Fargate, managed PaaS and self-hosted platforms on EC2, with the trade-offs."
date: 2026-11-08
category: Comparisons
keywords: elastic beanstalk alternatives, aws elastic beanstalk alternative, beanstalk vs ecs, ecs express mode, self-hosted paas on ec2
---

AWS Elastic Beanstalk was one of the first PaaS products on a major cloud, and it still runs a lot of production traffic. You upload an application bundle, and Beanstalk provisions EC2 instances, a load balancer, an Auto Scaling group and health monitoring. Teams look for Elastic Beanstalk alternatives when the abstraction starts to leak: slow deploys, platform version upgrades, `.ebextensions` that nobody wants to touch, and a console that hides a CloudFormation stack you still have to understand when something breaks. This guide covers alternatives inside AWS, managed platforms outside it, and self-hosted options on your own instances.

## What Elastic Beanstalk does today

Beanstalk has changed, so check the current model before comparing. According to AWS's docs, as of November 2026:

- **Two modes.** Standard mode runs apps directly on EC2 and supports Windows. Cluster mode runs apps on Amazon EKS, with faster deploys and autoscaling and better use of resources across environments.
- **Platforms.** Go, Java, .NET, Node.js, PHP, Python and Ruby, plus Docker for anything else.
- **Environment types.** Web server environments behind a load balancer, and worker environments that read from a queue.
- **Tools.** The console, AWS CLI, the EB CLI, an official GitHub Action, CloudFormation and Terraform.
- **Pricing.** There is no charge for Beanstalk itself. You pay for the EC2, load balancer, storage and other resources it creates.

That last point is Beanstalk's quiet strength: it's a free orchestration layer over services you would pay for anyway.

## Why teams move off Beanstalk

- **Deploy speed.** Rolling deploys on Standard mode replace instances or restart app servers, which takes minutes.
- **Platform upgrades.** Each platform branch reaches end of life, and moving to a new Amazon Linux base can mean rewriting config hooks.
- **Configuration sprawl.** Settings live in the console, saved configurations, `.ebextensions` and platform hooks. Reviewing a change is hard.
- **The leaky abstraction.** When an environment gets stuck, you debug the CloudFormation stack, the Auto Scaling group and the instance logs anyway.
- **One app per environment.** Small services each want their own environment and load balancer, and the cost adds up.

## Elastic Beanstalk alternatives at a glance

| Option | Where it runs | Unit of deploy | Config | Good fit |
| --- | --- | --- | --- | --- |
| ECS on Fargate | AWS, serverless containers | Task definition | JSON, CDK, Terraform | Teams that want containers without hosts |
| ECS Express Mode | AWS, on Fargate | Container image | One API call, then ECS | Simple web services on AWS |
| Beanstalk Cluster mode | AWS, on EKS | Image or source | Beanstalk config | Staying on Beanstalk with faster deploys |
| EKS | AWS, Kubernetes | Kubernetes manifests | YAML, Helm | Platform teams already on Kubernetes |
| Render, Railway, Heroku | Vendor clouds | Service | YAML or dashboard | Teams leaving AWS for simplicity |
| LogiStack on EC2 | Your instances | Service or Compose stack | Dashboard, YAML manifests | Many small services, fixed cost, a dashboard |
| Kamal on EC2 | Your instances | Container | `deploy.yml` | Few apps, deploy config in the repo |

## Alternatives inside AWS

Most Beanstalk users stay on AWS, because their data, IAM model and network already live there.

### Amazon ECS on Fargate

ECS is AWS's own container orchestrator, and Fargate removes the hosts. You define a task (image, CPU, memory, variables, secrets from Secrets Manager), then a service that keeps a number of tasks running behind a load balancer. Deploys are rolling or blue-green through CodeDeploy.

It is the default destination for Beanstalk Docker users. The cost is assembly: you wire the load balancer, target groups, log groups, IAM roles and CI yourself, usually with CDK or Terraform.

### Amazon ECS Express Mode

ECS Express Mode is AWS's newest answer to "just run my container". With one API call you pass an image and two IAM roles, and ECS creates a Fargate service, an Application Load Balancer, autoscaling and networking in your account. There is no extra charge beyond those resources. Unlike Beanstalk's language platforms, it needs a container image, so you build one in CI first.

You may have read about AWS App Runner for this job. AWS closed App Runner to new customers on April 30, 2026, plans no new features for it, and points users to ECS Express Mode instead.

### Beanstalk Cluster mode

If your complaint is deploy speed and resource use, try Cluster mode before you leave. It runs environments on a shared EKS cluster that AWS operates, so several small apps no longer need their own instances. You keep the Beanstalk console and CLI.

### Amazon EKS

EKS is right if you have, or want, a platform team and Kubernetes skills. It is not a simpler Beanstalk. See [Kubernetes alternatives](/blog/kubernetes-alternatives/) if you are unsure whether you need it.

## Managed platforms outside AWS

Render, Railway, Fly.io and Heroku give you a dashboard, Git deploys and managed Postgres without any AWS concepts. Moving there makes sense when the AWS account exists only to host the app. It makes less sense when the app reads from S3, uses SQS or sits behind a VPC with other systems. Egress and latency between clouds add up. [Heroku alternatives](/blog/heroku-alternatives/) and [Render alternatives](/blog/render-alternatives/) compare that group.

## Self-hosted PaaS on EC2

A middle path: keep AWS for the network, IAM and data services, and run a self-hosted PaaS on a few EC2 instances. You trade per-environment overhead for a fixed set of instances that host many services.

### LogiStack

LogiStack is an open-source PaaS under Apache 2.0, built on Docker Swarm with Caddy for automatic HTTPS. It installs on Ubuntu 22.04 or later or Debian 12 or later, amd64 or arm64, so Graviton instances work.

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

How Beanstalk concepts map:

| Elastic Beanstalk | LogiStack |
| --- | --- |
| Application and environments | A project with environments such as production and staging |
| Platform (Node.js, Python...) | Railpack detects the language, or use your Dockerfile ([build types](/docs/deploy/build-types/)) |
| Application version | A deployment with an immutable image tag; roll back to any earlier one |
| Rolling deploy | The new container passes its health check before the old one stops |
| Worker environment | A service with no domain and its own start command |
| `cron.yaml` | [Scheduled jobs](/docs/data/schedules/) with run history |
| Auto Scaling group | CPU-based autoscaling of replicas across Swarm nodes |
| Load balancer and ACM | Caddy with Let's Encrypt, or Route 53 for DNS-01 and wildcard certificates |
| Saved configurations | [Project manifests](/docs/automation/project-manifests/) in YAML, applied from CI |

LogiStack has a Route 53 DNS integration, so it can create records for new domains and issue wildcard certificates over DNS-01. Backups of databases and volumes go to S3 with a key you control, and a scheduled job restores the latest one to check it works. You can also keep RDS: set the connection string as a variable and skip the platform database.

The honest trade-offs: you patch the instances and own their uptime, and Swarm does not add or remove EC2 instances for you, so you size the cluster. LogiStack is a young project with a much smaller community than AWS's. If your organization requires everything to be an AWS-managed service, ECS on Fargate or ECS Express Mode is the better answer.

### Kamal

Kamal deploys containers to EC2 instances over SSH, with zero-downtime switches through `kamal-proxy`. No control plane, everything in `config/deploy.yml`. See [Kamal alternatives](/blog/kamal-alternatives/) for a fair comparison with a dashboard platform.

## How to choose

- **Stay on AWS with no hosts:** ECS on Fargate, or ECS Express Mode for simple web services.
- **Stay on Beanstalk but faster:** try Cluster mode first.
- **Many small services, cost matters, want a dashboard:** a self-hosted PaaS on a few EC2 instances.
- **Leave AWS entirely:** Render or Railway, if the app does not depend on other AWS services.

## Moving off Beanstalk

1. **Export environment properties.** `eb printenv` lists the variables of the current environment.
2. **Containerize.** If you use a language platform, write a Dockerfile or try Railpack. Look in `.ebextensions` and `.platform/hooks` for packages and commands the build needs.
3. **Map processes.** Your `Procfile` lines become services. A worker environment becomes a service that reads from the same SQS queue.
4. **Keep the database.** RDS stays where it is; allow the new instances in its security group.
5. **Shift traffic.** Lower the DNS TTL, point the record at the new platform, watch errors, then terminate the environment with `eb terminate`.

## FAQ

### Is Elastic Beanstalk deprecated?

No. AWS still develops it and added Cluster mode on EKS. Individual platform branches do retire on a schedule, so keep your environment on a supported one.

### What replaced Elastic Beanstalk?

Nothing officially replaced it. On AWS, most container workloads that would once have gone to Beanstalk now go to ECS on Fargate. For simple web services, AWS now recommends ECS Express Mode, since App Runner closed to new customers in April 2026.

### Is Elastic Beanstalk free?

Beanstalk itself has no charge. You pay for the EC2 instances, load balancers, storage and data transfer it creates.

### Can I run a self-hosted PaaS on AWS?

Yes. LogiStack, Coolify, Dokploy and Dokku run on standard EC2 instances. You keep AWS networking, IAM and data services, and run many services on a fixed set of instances.

If you want Beanstalk's convenience for many small services, on a few instances you control and with a dashboard your team can use, try LogiStack. The [first deploy guide](/docs/getting-started/first-deploy/) takes you from a new instance to a running app.
