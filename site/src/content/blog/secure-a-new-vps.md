---
title: "How to secure a new VPS: a 30-minute hardening checklist"
description: "Secure a new VPS in about 30 minutes: SSH keys, a sudo user, automatic security updates, a firewall, fail2ban and the Docker caveat most guides skip."
date: 2026-11-08
category: Security
keywords: secure a new vps, vps hardening, linux server security, ssh hardening, fail2ban ubuntu
---

A fresh VPS gets its first SSH login attempts from strangers within minutes of booting. Bots scan entire cloud IP ranges all day, trying `root` with common passwords, probing for open databases and old admin panels. None of this is personal, and most of it is easy to shut out. This checklist shows how to secure a new VPS running Ubuntu or Debian in about half an hour: SSH keys only, a non-root user, automatic security updates, a firewall, fail2ban, and the Docker firewall caveat that catches out people who did everything else right.

Every command below is for Ubuntu 22.04 or later and Debian 12 or later. Run them as root on first login, or with `sudo` once you have a user.

## Before you start: two rules

1. **Keep your current SSH session open** until you have tested a new one. Changes to SSH and the firewall can lock you out, and the open session is your way back in.
2. **Know where your provider's web console is.** Most providers offer a browser-based console that works even when SSH does not. Find it now, not during a lockout.

If you are still choosing a provider, our guide to [choosing a VPS in Europe](/blog/choosing-a-vps-in-europe/) compares the main options, and [what is a remote server](/blog/what-is-a-remote-server/) covers first-time SSH setup.

## Step 1: update everything

New images are often weeks old. Patch before anything else:

```bash
apt update && apt full-upgrade -y
reboot   # only if a new kernel was installed: check for /var/run/reboot-required
```

While you are here, set the hostname and time zone so logs make sense:

```bash
hostnamectl set-hostname web-1
timedatectl set-timezone Etc/UTC
```

UTC on servers avoids daylight saving surprises in logs and cron schedules.

## Step 2: create a user with sudo

Daily work as `root` turns every typo into a system-wide change. Create a personal user:

```bash
adduser deploy
usermod -aG sudo deploy
```

Copy your SSH key to the new user. If root already has your key from the provider's setup:

```bash
rsync --archive --chown=deploy:deploy ~/.ssh /home/deploy
```

Otherwise, from your own machine:

```bash
ssh-copy-id deploy@203.0.113.7
```

Now open a **new** terminal and confirm you can log in and use sudo:

```bash
ssh deploy@203.0.113.7
sudo whoami   # prints: root
```

## Step 3: SSH keys only, no root login

Password logins are what the bots are guessing. Turn them off, and turn off direct root login. Use a drop-in file instead of editing the main config, so package upgrades never overwrite it:

```bash
sudo tee /etc/ssh/sshd_config.d/10-hardening.conf > /dev/null <<'EOF'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
MaxAuthTries 3
LoginGraceTime 20
X11Forwarding no
AllowUsers deploy
EOF
```

Check the syntax and reload:

```bash
sudo sshd -t && sudo systemctl reload ssh
```

Then, from a new terminal, verify both sides:

```bash
ssh deploy@203.0.113.7                    # works
ssh -o PubkeyAuthentication=no deploy@203.0.113.7   # refused: Permission denied (publickey)
ssh root@203.0.113.7                      # refused
```

Some cloud images ship a file such as `50-cloud-init.conf` in the same directory that sets `PasswordAuthentication yes`. The first value sshd reads wins, and files load in name order, which is why ours starts with `10-`. Confirm with:

```bash
sudo sshd -T | grep -E 'passwordauthentication|permitrootlogin'
```

### Should you change the SSH port?

Moving SSH off port 22 cuts log noise from bots, but it is not a security control: a port scan finds the new port in seconds. Keys-only authentication is what protects you. If you do change it, open the new port in the firewall first. On Ubuntu 22.10 and later, SSH is socket-activated by default, so the port is set in `ssh.socket`, not only in `sshd_config`.

## Step 4: automatic security updates

Most compromises use known, already-patched vulnerabilities. Let the server install security updates on its own:

```bash
sudo apt install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

The defaults install security updates only. To reboot automatically when a kernel update requires it, at a quiet hour:

```bash
sudo tee /etc/apt/apt.conf.d/52unattended-reboot > /dev/null <<'EOF'
Unattended-Upgrade::Automatic-Reboot "true";
Unattended-Upgrade::Automatic-Reboot-Time "04:30";
EOF
```

Skip automatic reboots if the server runs a single instance of something that must not go down unannounced. Then schedule manual reboots instead: `/var/run/reboot-required` tells you when one is due.

## Step 5: a firewall that allows only what you serve

Default deny for incoming traffic, then open only what the server provides. With UFW:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 443/udp     # HTTP/3, if your proxy serves it
sudo ufw enable
sudo ufw status verbose
```

Add a second layer at the provider: most clouds offer a network firewall in front of the server. It blocks traffic before it reaches the machine and is unaffected by anything that happens on the host, which matters for the next point.

### The Docker caveat

If you will run Docker on this server, know this before you trust UFW: **ports published by Docker containers bypass UFW.** Docker writes its own iptables rules that run before UFW's, so `docker run -p 5432:5432 postgres` is reachable from the internet even with `ufw deny 5432`. Our guide to the [Docker and UFW firewall problem](/blog/docker-ufw-firewall/) explains why and shows three ways to fix it.

## Step 6: fail2ban for repeated failures

With passwords off, brute force against SSH cannot succeed, but fail2ban still helps: it bans IPs that hammer the server, keeps logs readable, and can protect other services that do have password logins.

```bash
sudo apt install -y fail2ban
sudo tee /etc/fail2ban/jail.local > /dev/null <<'EOF'
[DEFAULT]
bantime  = 1h
findtime = 10m
maxretry = 5
backend  = systemd

[sshd]
enabled = true
EOF
sudo systemctl enable --now fail2ban
```

Check it:

```bash
sudo fail2ban-client status sshd
```

`backend = systemd` matters on Debian 12 and recent Ubuntu releases, where SSH logs go to the journal and `/var/log/auth.log` may not exist. If you ever lock yourself out from a known IP, add it to `ignoreip` under `[DEFAULT]`.

## Step 7: reduce what is running

Every listening service is attack surface. List them:

```bash
sudo ss -tulpn
```

On a fresh server you should see SSH and little else. Anything you did not install on purpose, such as a mail server, `rpcbind` or a web server from the image, either gets a reason to stay or gets removed:

```bash
sudo systemctl disable --now rpcbind rpcbind.socket   # example
```

## Step 8: backups and monitoring

Hardening lowers the odds of a bad day. Backups and monitoring decide how bad it gets.

- **Provider snapshots** for the whole disk, as a safety net before risky changes.
- **Application-level backups** of databases and volumes, stored off the server. A snapshot on the same provider does not help if the account is compromised. See [database backup](/blog/database-backup/).
- **An external uptime check** and disk, memory and CPU alerts. See [server monitoring](/blog/server-monitoring/).

## Checklist to secure a new VPS

| Step | Command or file | Verify with |
| --- | --- | --- |
| Patch | `apt full-upgrade` | `/var/run/reboot-required` absent |
| Sudo user | `adduser`, `usermod -aG sudo` | `sudo whoami` |
| SSH keys only | `/etc/ssh/sshd_config.d/10-hardening.conf` | `sshd -T`, password login refused |
| Auto updates | `unattended-upgrades` | `/var/log/unattended-upgrades/` |
| Firewall | `ufw default deny incoming` | `ufw status verbose`, external port scan |
| fail2ban | `/etc/fail2ban/jail.local` | `fail2ban-client status sshd` |
| Minimal services | `ss -tulpn` | Only what you serve is listening |
| Backups off-site | Your backup tool | A test restore |

Run a port scan from another machine to see what the internet sees:

```bash
nmap -Pn -p- --min-rate 2000 203.0.113.7
```

## Putting apps on the hardened server

Once the base is solid, you can install LogiStack, an open-source, self-hosted PaaS on Docker Swarm. A few facts from the [install docs](/docs/getting-started/install/) that fit with the checklist above:

- The installer needs Ubuntu 22.04+ or Debian 12+, and ports 80/tcp, 443/tcp and 443/udp open. It does **not** change your firewall.
- Setup is private by default: the API listens on `127.0.0.1:3000`, and you reach the setup wizard through an SSH tunnel.
- If you add more servers, open the Swarm ports (2377/tcp, 7946/tcp and udp, 4789/udp) only between your nodes, for example `ufw allow from 198.51.100.20 to any port 2377 proto tcp`.
- Services get HTTPS through Caddy without publishing their own ports. Managed databases are reachable only inside their environment's private network, so there is nothing for the Docker firewall bypass to expose unless you publish a port on purpose.
- Admin tools can sit behind basic auth, an IP allow list or forward auth. See [access control](/docs/networking/access-control/).

```bash
curl -fsSL https://stack.logicaltech.it/install.sh | sudo bash
```

## FAQ

### What is the first thing to do on a new VPS?

Update every package, then create a non-root user with sudo and your SSH key. Disable password and root login only after you have confirmed key login works from a second terminal.

### Is changing the SSH port worth it?

It reduces log noise from bots but adds no real protection, since a scan finds the new port quickly. Keys-only authentication and fail2ban are what matter. If you change it, open the new port in the firewall before reloading SSH.

### Do I need fail2ban if password login is disabled?

It is less critical but still useful: it bans IPs that hammer the server, keeps logs readable, and protects any other service with a password login. It costs almost nothing to run.

### Does UFW protect Docker containers?

Not for published ports. Docker inserts iptables rules that are evaluated before UFW's, so a published container port is reachable even if UFW denies it. Avoid publishing internal ports, filter with the DOCKER-USER chain, or use your provider's firewall.

### Should I enable automatic reboots?

Yes for servers that can tolerate a minute of downtime at night, since kernel patches only apply after a reboot. For a single critical server, keep automatic updates on but schedule reboots yourself.

When the server is hardened, [install LogiStack](/#install) to deploy apps, databases and HTTPS on it without opening more ports than 80 and 443.
