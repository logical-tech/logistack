# Security policy

## Report a vulnerability privately

Do not open a public issue for a security problem. Use one of these channels:

- GitHub private vulnerability reporting: open the **Security** tab of `logical-tech/logistack` and click **Report a vulnerability**.
- Email `info@logicaltech.it` with `[security]` in the subject.

Include the LogiStack version (`/etc/logistack/version` on the server), the steps to reproduce, and what an attacker gains. A proof of concept helps. We confirm that we received the report, and we agree a disclosure date with you before anything is published.

## Supported versions

Only the latest stable release gets security fixes. Betas and nightlies are fixed by the next build on their channel, not patched. Upgrade before you report, if you can.

## How we handle a report

1. We confirm that we received it within three working days.
2. We reproduce it and agree a severity with you, using the threat model below.
3. We fix it in a private fork through a GitHub security advisory, and credit you unless you prefer otherwise.
4. We publish the release with the fix, then the advisory with a CVE, on the date we agreed.

The design rules that keep most bugs of this class out are described in the [security model](https://stack.logicaltech.it/docs/reference/security-model/).

## In scope

- The API server (`apps/server`), including REST, WebSocket, MCP, and webhook routes.
- The worker (`apps/worker`): builds, deployments, backups, schedules, and the reconciler.
- The node agent (`apps/agent`) and its connection to the server.
- The dashboard (`apps/web`).
- The installer and uninstaller (`install/`) and the published images.
- How LogiStack configures Caddy, Docker, BuildKit, and the generated secrets.

The threat model in `.oss-scanner/threat_model.md` lists the trust boundaries and how we rate severity.

## Out of scope

- Actions that need the `admin` or `owner` role. These roles control the Docker socket and are root on every node by design. A report is in scope only when it lets an admin escape that boundary, for example to reach another LogiStack instance or a cloud account the server cannot otherwise reach.
- Problems in the applications you deploy on LogiStack, and in their images.
- Bugs in Docker, Caddy, BuildKit, Postgres, or Redis. Report those upstream. Tell us if LogiStack uses them in an unsafe way.
- Attacks that need root on the host or physical access.
- Ports that Docker publishes past UFW or firewalld. `docs/INSTALL.md` documents this Docker behaviour.
- Denial of service by volume, missing rate limits without a concrete impact, and reports from automated scanners with no proof of impact.
- The shared Let's Encrypt rate limit on sslip.io and nip.io hostnames.
