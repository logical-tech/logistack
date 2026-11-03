#!/usr/bin/env bash
# Placeholder. Servers will be added from the LogiStack UI ("Servers > Add
# server" wizard): you give an IP and an SSH key, and LogiStack connects once
# over SSH to install Docker, join the swarm with a fresh join token, and label
# the node. The global agent then starts on it and SSH is no longer used.
set -euo pipefail

cat <<'EOF'
Adding servers from the command line is not supported yet.

Use the LogiStack dashboard: Servers > Add server. The wizard installs Docker,
joins this server to the swarm and starts the agent on it.

Until then, a node can join by hand. On the manager:
  docker swarm join-token worker
Then run the printed 'docker swarm join ...' command on the new server, and
open 2377/tcp, 7946/tcp+udp and 4789/udp between the two servers only.
EOF
