---
title: "Container security scanning: find CVEs before attackers do"
description: "How container security scanning works, where to run it in your pipeline, how to read results without drowning, and how to keep running images scanned."
date: 2026-11-08
category: Security
keywords: container security scanning, container image scanning, docker image vulnerability scan, trivy, cve scanning
---

You deployed an image three months ago. It passed every check on the day it shipped. Since then, dozens of new CVEs have been published against packages it contains, and nothing told you. Container security scanning closes that gap: it lists what is inside an image, matches it against vulnerability databases, and tells you which packages to update. This guide explains how scanners work, where to run them, how to triage the output, and how to make scanning continuous instead of a one-time gate.

## What container security scanning finds

"Scanning" covers several different checks. Know which one you are running.

| Scan type | What it finds | Example |
| --- | --- | --- |
| Vulnerability scan | Packages with known CVEs | `openssl 3.0.13` affected by a published advisory |
| Dependency scan | CVEs in language packages inside the image | A vulnerable npm, pip, Go or Maven dependency |
| Misconfiguration scan | Risky settings in Dockerfiles and manifests | Running as root, no health check, `ADD` from a URL |
| Secret scan | Credentials left in layers | An AWS key in a copied config file |
| License scan | Dependencies with licenses you can't ship | A copyleft library in a proprietary product |

When people say container security scanning, they usually mean the first two. That is also where most of the actionable findings are.

## How an image scanner works

Under the hood, every image scanner does the same three steps.

1. **Inventory.** It unpacks the image layers and reads package databases: `/var/lib/dpkg/status` on Debian, `/lib/apk/db/installed` on Alpine, `package-lock.json`, `go.sum` or Python metadata for language dependencies. The result is a software bill of materials (SBOM).
2. **Match.** It compares each package and version against advisory sources: distribution security trackers, the GitHub Advisory Database, the NVD and others.
3. **Report.** For every match it prints the CVE ID, severity, installed version and, when one exists, the first fixed version.

Two consequences follow. A scanner can only report packages it recognizes, so a binary you copied in by hand is invisible to it. And results change over time without the image changing, because the advisory databases grow every day.

## Where to scan: build, registry or runtime

You can scan at three points. Each catches something the others miss.

| Where | Catches | Misses |
| --- | --- | --- |
| In CI, before push | Vulnerable images before they ship | CVEs published after the build |
| In the registry | Every image pushed, from any pipeline | Images that never reach that registry |
| Continuously, on running images | New CVEs in what is actually live | Nothing new until the next scan runs |

If you only do one, scan running images on a schedule. A CI gate is valuable, but production risk lives in what is deployed now, and much of it was deployed before today's advisories existed.

## Run your first scan with Trivy

Trivy is an open-source scanner from Aqua Security under the Apache 2.0 license. It handles OS packages and most language ecosystems in one binary.

```bash
# Scan an image and show only high and critical findings that have a fix
trivy image --severity HIGH,CRITICAL --ignore-unfixed nginx:1.27

# Machine-readable output for scripts
trivy image --format json --output report.json nginx:1.27

# Exit with code 1 when anything critical is found, for CI gates
trivy image --severity CRITICAL --exit-code 1 registry.example.com/acme/api:dep_8k2p1q
```

Grype from Anchore is a good alternative, and pairs with Syft for SBOMs:

```bash
syft registry.example.com/acme/api:dep_8k2p1q -o spdx-json > sbom.json
grype sbom:./sbom.json --fail-on high
```

Generating an SBOM once and scanning it later is cheap, and it lets you answer "are we affected?" for a new CVE without pulling every image again. For a wider comparison of scanners and runtime tools, see [the best container security tools](/blog/best-container-security-tools/).

## Add a scanning gate to CI

A gate in CI stops the worst images before they reach a server. Keep it strict enough to matter and loose enough that people don't disable it.

```yaml
# .github/workflows/scan.yml
name: scan
on: [push]
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Build
        run: docker build -t api:${{ github.sha }} .
      - name: Scan
        run: |
          docker save api:${{ github.sha }} -o image.tar
          docker run --rm -v "$PWD:/work" aquasec/trivy:0.58.1 image \
            --input /work/image.tar \
            --severity CRITICAL --ignore-unfixed --exit-code 1
```

Two settings make the gate livable:

- **`--ignore-unfixed`**: failing a build for a CVE with no available fix blocks your team without giving them anything to do.
- **Critical only, at first**: start by blocking critical findings. Tighten to high once the backlog is under control.

## Read the results without drowning

A first scan of an older image can list hundreds of findings. Most are not urgent. Triage in this order:

1. **Critical with a fix available.** Update the package or the base image now.
2. **High with a fix, in an internet-facing service.** Schedule it this week.
3. **Known exploited.** Anything on CISA's Known Exploited Vulnerabilities list jumps the queue, whatever its score.
4. **No fix yet.** Note it, watch it, and consider whether you can remove the package entirely.
5. **Low and medium.** Clear them with your regular base image rebuilds.

Severity alone is a blunt tool. A critical CVE in a library your code never loads is less urgent than a high one in your HTTP parser. Use the score to sort, then use your knowledge of the service to decide.

When you accept a finding, record why and set a date to look again. Trivy reads a `.trivyignore` file:

```text
# libfoo is only used by the CLI, not by the server process. Review in January.
CVE-2026-12345 exp:2027-01-31
```

## Fix findings at the source

Most findings disappear with one of three actions:

- **Bump the base image.** Many OS package CVEs are fixed by moving to the latest patch tag of your base, such as from `node:22.11-bookworm-slim` to the newest `node:22-bookworm-slim`, then rebuilding.
- **Update the dependency.** For language packages, update the lockfile to the version in "fixed in" and redeploy.
- **Remove what you don't use.** A smaller image has fewer findings. Multi-stage builds and slim bases often remove dozens at once. The [container security best practices](/blog/container-security-best-practices/) checklist covers these image habits.

For images you don't build, such as `postgres:17` or `redis:7`, the fix is to move to a newer tag of the same major version and redeploy.

## Continuous scanning in LogiStack

LogiStack, the open-source self-hosted PaaS, scans the image each service runs with Trivy. You don't add a pipeline step:

- **After each deployment**, a few seconds after it succeeds. A redeploy of an image scanned in the last 12 hours reuses that result.
- **Once a day**, for every image in use, so a CVE published after you deployed still shows up.
- **On demand**, with **Scan now** on the service's **Security** tab.

Results are stored per image digest, so services that run the same image share one result. Scans run in the background and never delay a deployment.

![The Security tab of a service: image digest, scan time, counts by severity and a findings table with package, installed version and fixed version](/docs/screens/service-security.webp)

Each service header shows a badge: **N critical**, **N high**, **Low risk** or **No known vulnerabilities**. The **Security** tab lists each finding with its package, installed version and **Fixed in** version, and a **Fixable** filter. When a scan finds a critical vulnerability the image didn't have before, LogiStack sends an `image.vulnerable` event you can route to Slack, email or any [notification channel](/docs/operations/alerts-and-notifications/). The same data is available over the API:

```bash
curl -s https://stack.example.com/api/services/svc_storefront_web/vulnerabilities \
  -H "Authorization: Bearer $LOGISTACK_KEY" | jq '.badge, .counts'
```

The limits are worth knowing. The scan covers OS packages and the language dependencies Trivy recognizes, not the running container's filesystem, configuration or secrets. Private images are scanned with your organization's default registry credentials, so images from another private registry can't be scanned. The worker needs internet access to download the vulnerability database. Full details are in the [vulnerability scanning docs](/docs/operations/vulnerability-scanning/).

## FAQ

### What is the difference between container scanning and image scanning?

Image scanning inspects the static image: its packages and layers. Container scanning sometimes also means watching running containers for drift or suspicious behavior, which is runtime security. Most tools called container scanners are image scanners, so check what a tool actually inspects.

### How long does a container image scan take?

Usually seconds to a minute. The first run downloads the vulnerability database, which takes longest; later runs fetch only updates. Large images with many language dependencies take longer than slim ones.

### Can I trust "No known vulnerabilities"?

It means no package the scanner recognized matches a published advisory today. It doesn't cover binaries copied in by hand, zero-days, or misconfiguration. Treat it as one signal among several, not a certificate.

### Should a failing scan block deployment?

Blocking on critical findings with a fix available is a reasonable default. Blocking on everything leads teams to disable the scanner. Pair a narrow CI gate with continuous scanning of what runs in production.

Scanning is cheap; ignoring the results is what costs you. If you want every running service scanned daily with no pipeline changes, [install LogiStack](/#install) on your server and check the **Security** tab after your first deploy.
