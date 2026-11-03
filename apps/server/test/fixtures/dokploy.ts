/** The three real Dokploy compose shapes, with fake `.env` values, keyed by Dokploy appName. */
export const dokployComposes: Record<string, { compose: string; env: string }> =
	{
		"factorio-server-o8zeig": {
			compose: `services:
  factorio:
    image: factoriotools/factorio:stable
    restart: unless-stopped
    ports:
      - 34197:34197/udp
    volumes:
      - /srv/factorio:/factorio
    environment:
      - UPDATE_MODS_ON_START=true
      - DLC_SPACE_AGE=false
`,
			env: "APP_NAME=factorio-server-o8zeig\nCOMPOSE_PROJECT_NAME=factorio-server-o8zeig\nDOCKER_CONFIG=/root/.docker\n",
		},
		"panel-k3x9qa": {
			compose: `services:
  panel:
    image: ghcr.io/example/panel:1.4.2
    user: "1000:1000"
    cap_add:
      - NET_ADMIN
    expose:
      - 80
    volumes:
      - /srv/panel/data:/data
      - type: bind
        source: ../files/config
        target: /config
        read_only: true
    environment:
      PANEL_PASSWORD: \${PANEL_PASSWORD}
      PANEL_URL: https://\${PANEL_HOST}
      PANEL_THEME: \${PANEL_THEME:-dark}
    labels:
      - traefik.enable=true
      - traefik.http.routers.panel-k3x9qa-1-web.rule=Host(\`panel.example.com\`)
      - traefik.http.routers.panel-k3x9qa-1-web.entrypoints=web
      - traefik.http.routers.panel-k3x9qa-1-web.service=panel-k3x9qa-1-web
      - traefik.http.services.panel-k3x9qa-1-web.loadbalancer.server.port=80
      - traefik.http.routers.panel-k3x9qa-1-websecure.rule=Host(\`panel.example.com\`)
      - traefik.http.routers.panel-k3x9qa-1-websecure.entrypoints=websecure
      - traefik.http.routers.panel-k3x9qa-1-websecure.tls.certresolver=letsencrypt
      - traefik.http.routers.panel-k3x9qa-1-websecure.service=panel-k3x9qa-1-websecure
      - traefik.http.services.panel-k3x9qa-1-websecure.loadbalancer.server.port=80
    networks:
      - dokploy-network
networks:
  dokploy-network:
    external: true
`,
			env: "APP_NAME=panel-k3x9qa\nCOMPOSE_PROJECT_NAME=panel-k3x9qa\nDOCKER_CONFIG=/root/.docker\nPANEL_PASSWORD=fake-panel-secret-9f2\nPANEL_HOST=panel.example.com\n",
		},
		"minecraft-p2m7rt": {
			compose: `services:
  minecraft:
    image: itzg/minecraft-server:java21
    restart: always
    ports:
      - target: 25565
        published: 25565
        protocol: tcp
    volumes:
      - /srv/minecraft:/data
    environment:
      EULA: "TRUE"
      TYPE: PAPER
      VERSION: "1.21.4"
      MEMORY: 4G
      TZ: Europe/Rome
      ENABLE_RCON: "true"
      RCON_PASSWORD: \${RCON_PASSWORD}
      OPS: \${OPS}
`,
			env: "APP_NAME=minecraft-p2m7rt\nCOMPOSE_PROJECT_NAME=minecraft-p2m7rt\nDOCKER_CONFIG=/root/.docker\nRCON_PASSWORD=fake-rcon-secret-71c\nOPS=steve\n",
		},
	};

/** Every value a fixture `.env` holds outside Dokploy's own keys; none may ever be printed. */
export const fakeSecrets = [
	"fake-panel-secret-9f2",
	"fake-rcon-secret-71c",
	"steve",
];
