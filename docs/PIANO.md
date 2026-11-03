# LogiStack: analisi di Dokploy/Coolify e piano d'azione

Snapshot analizzati: Dokploy `d64ebed` (v0.30.11, 2 nov 2026), Coolify `82d8958` (2 nov 2026).
I riferimenti `file:riga` sono relativi alla root di ciascun repo.

---

## 0. In breve

1. **Traefik in Dokploy non si riavvia a ogni modifica.** Domini, redirect, basic auth e certificati custom sono file YAML in `/etc/dokploy/traefik/dynamic`, che Traefik ricarica a caldo (`watch: true`, `packages/server/src/setup/traefik-setup.ts:425-428`). Il riavvio o la ricreazione del container avviene solo per env, porte, dashboard, cambio versione e il pulsante "Reload" (`services/settings.ts:286-315`). I domini dei **compose** invece sono label, quindi serve ridistribuire lo stack (`routers/domain.ts:194`), e probabilmente è questo che hai notato.
2. **Il proxy giusto per LogiStack è comunque Caddy**, ma il motivo non è il riavvio. Caddy ha un'API admin che accetta la config completa in JSON, la valida, la applica senza downtime e torna alla config precedente se quella nuova è sbagliata. Supporta storage condiviso dei certificati per più nodi, DNS-01 per i wildcard e On-Demand TLS. Sulle prestazioni la differenza conta poco sotto i ~10k req/s per nodo: Traefik va meglio su TLS/HTTP2, HAProxy sul throughput puro (dettagli nella §3).
3. **La complessità di Docker si domina con un'idea sola:** Postgres contiene lo _stato desiderato_, funzioni pure lo _compilano_ in spec Docker e config Caddy, e un _reconciler_ fa convergere la realtà a quello stato. A Dokploy e Coolify manca proprio questo. Da lì vengono quasi tutte le loro fragilità: stato nel DB diverso dalla realtà, shell string, multi-nodo fragile.
4. **Uno stack Swarm sempre, anche su un solo nodo**, come fa Dokploy. Più un **agent per nodo** (servizio globale), così backup, schedule, log e metriche girano sul nodo dove il container vive davvero.

---

## 1. Come funzionano oggi

### 1.1 Confronto rapido

| Area               | Dokploy                                                                                                               | Coolify                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Stack              | Next.js 16 + tRPC + Drizzle + better-auth, un solo processo Node                                                      | Laravel 12 + Livewire + Horizon + Reverb                                                                                              |
| Esecuzione         | Servizi Swarm (`mechanizeDockerContainer`, `utils/builders/index.ts:190-215`)                                         | Container standalone via compose generato. Swarm a metà, con TODO (`ApplicationDeploymentJob.php:903`, `PushServerUpdateJob.php:188`) |
| Parlare con Docker | dockerode (socket, o SSH per i remoti) + tante shell string                                                           | **Tutto via SSH, anche su localhost** (`ProductionSeeder.php:119`), multiplexing ControlMaster                                        |
| Coda job           | **In memoria** (`server/queues/in-memory-queue.ts`), si perde al riavvio                                              | Horizon/Redis, persistente                                                                                                            |
| Cron               | `node-schedule` in-process (doppio run con 2 repliche)                                                                | Scheduler Laravel + `ScheduledJobManager`                                                                                             |
| Proxy              | Traefik container standalone, file provider + label per i compose                                                     | Traefik o caddy-docker-proxy, **label sui container**                                                                                 |
| Rete               | Un overlay condiviso `dokploy-network` per tutto: **nessun isolamento**                                               | Una rete per server + una rete per app (uuid), il proxy entra in tutte                                                                |
| Stato runtime      | Nessuna riconciliazione: "done" = task schedulati entro 3s (`builders/index.ts:217-244`)                              | Polling SSH + push da Sentinel, due implementazioni duplicate                                                                         |
| Metriche           | Agent Go solo sui manager, SQLite locale. I worker restano senza metriche                                             | Sentinel Go per server, SQLite locale, letto via SSH+curl                                                                             |
| Backup DB          | `docker ps \| head -1` + `pg_dump \| gzip \| rclone rcat` (`utils/backups/utils.ts:106-152`)                          | `docker exec pg_dump > file` poi `mc` in un helper container                                                                          |
| Registry           | Solo esterni: `selfHosted` c'è nello schema ma viene rifiutato (`db/schema/registry.ts:14-29`)                        | Esterni                                                                                                                               |
| Audit log          | Solo con licenza enterprise, senza licenza non scrive niente (`services/proprietary/audit-log.ts:25-29`)              | No                                                                                                                                    |
| Permessi           | better-auth org + flag per membro. Ruoli custom solo con licenza                                                      | Livelli `read/read:sensitive/deploy/write/delete/root` per progetto/env/risorsa (`app/Enums/AccessLevel.php`)                         |
| DNS provider       | Cloudflare, Route53, Porkbun, Infomaniak, OVH, ma solo CRUD manuale. Non usati per ACME né alla creazione del dominio | Inizio di DNS gestito (`ConfigureDnsRecordJob.php`)                                                                                   |
| MCP                | No                                                                                                                    | Sì (laravel/mcp)                                                                                                                      |
| Realtime           | `ws` per log/terminale/stats. Lo stato dei deploy è **in polling ogni 1s** (`show-deployments.tsx:77`)                | Reverb (websocket)                                                                                                                    |

### 1.2 Cosa prendere

- **Da Dokploy**: Swarm come target unico. Modello org → progetto → ambiente → servizio, con env a cascata (`builders/index.ts:125-129`). Rollback con snapshot del contesto (`services/rollbacks.ts:49-87`). GitHub App con manifest flow. Elenco di provider di notifica e builder (nixpacks, railpack, dockerfile, static, buildpacks).
- **Da Coolify**:
  - livelli di accesso gerarchici con `read:sensitive` separato (`AccessLevel.php:7-31`) e gli stessi livelli applicati ai token API (`ApiAbility.php`);
  - contenuto dei file mount salvato cifrato nel DB (`LocalFileVolume.php:83`);
  - segreti passati su stdin e non in argv (`RunRemoteProcess.php:219-230`);
  - variabili magiche dei template (`SERVICE_URL_*`, `SERVICE_PASSWORD_*`);
  - retention dei backup per numero, giorni o dimensione;
  - push dello stato dall'agent con dedup tramite hash;
  - 388 template compose in `templates/compose/*.yaml` (licenza Apache-2.0, da verificare prima di importarli).

### 1.3 Cosa evitare (con prove)

1. **Shell string.** Dokploy fa `command.split(" ")` (`builders/index.ts:148`), usa una blocklist regex sui compose (`builders/compose.ts:82-123`) e scrive `docker service rm ${appName}` senza quoting (`docker/utils.ts:459`). Coolify ha ~326 chiamate `instant_remote_process`, escaping a mano con `str_replace` (`docker.php:545`), `sudo` aggiunto con regex (`helpers/sudo.php:96-140`) e `mysqldump -p$password` in argv (`DatabaseBackupJob.php:723`).
2. **Update che in caso di errore diventa create.** In Dokploy qualunque errore di `service.update` porta a `createService` (`builders/index.ts:208-215`). L'errore vero sparisce.
3. **Cancel di un deploy con `pkill -f "docker build"`** su tutto l'host (`queueSetup.ts:129`). Uccide anche le build degli altri e non ferma nixpacks/railpack.
4. **Multi-nodo fragile.**
   - Backup e schedule trovano il container con `docker ps | head -1` sul manager (`backups/utils.ts:141`), quindi falliscono se il task è su un worker.
   - Qualsiasi mount forza la placement sul manager (`docker/utils.ts:676-679`).
   - I file mount sono bind su un solo host.
   - Il tag `:latest` è mutabile.
   - `swarmInit` usa AdvertiseAddr `127.0.0.1` (`setup/setup.ts:9`), il che complica l'aggiunta di nodi.
5. **Label del proxy dentro i container** (Coolify, e i compose in Dokploy). Cambiare dominio o proxy richiede un redeploy. Ogni avvio del proxy in Coolify è `stop/rm/up`, cioè con downtime (`StartProxy.php:67-120`).
6. **Funzioni enterprise chiuse** (audit, ruoli custom, SSO in Dokploy). È esattamente il motivo per cui non riesci a far entrare le tue modifiche.
7. **File giganti** in Coolify (`ApplicationDeploymentJob.php` 6.585 righe, `shared.php` 6.504) e funzioni con più di 20 parametri posizionali (`docker.php:804,961`).
8. **Webhook non GitHub autenticati solo dal token nell'URL** (Dokploy `pages/api/deploy/[refreshToken].ts`). Preview solo per GitHub.

---

## 2. Principi architetturali di LogiStack

1. **Stato desiderato in Postgres, realtà convergente.** Ogni risorsa (servizio, dominio, rete, volume, cron) ha una riga che descrive cosa _deve_ esistere. Il reconciler confronta con Docker e Caddy e fa la differenza. Ogni operazione è idempotente: rieseguirla dopo un crash porta allo stesso stato finale.
2. **Compilatori puri.** `compileService(row) → ServiceSpec` (Docker Engine API) e `compileProxy(allDomains) → Caddy JSON` non toccano la rete. Si testano con snapshot test senza Docker, ed è lì che sta l'80% della logica pericolosa.
3. **Zero shell string.** Docker si usa tramite Engine API (socket Unix). I tool esterni (railpack, buildctl) partono con `Bun.spawn([...argv])`, mai con `sh -c`. I segreti vanno in env o stdin, mai in argv.
4. **Ogni oggetto Docker creato porta label** `logistack.managed=true`, `logistack.resource=<uuid>`, `logistack.kind=service|db|network|volume`, `logistack.org=<id>`. Con queste il reconciler riconosce orfani e drift, e la pulizia non tocca mai cose non sue.
5. **Nomi Docker derivati da ID**, non dai nomi utente. Il nome umano è solo una label.
6. **Tag immutabili.** Le immagini sono `<registry>/<org>/<service>:<deploymentId>`, mai `:latest`. Il rollback diventa un `service update` al tag precedente.
7. **Niente feature dietro licenza.** Tutto open, tutto tuo.
8. **Niente download a runtime da CDN** (Coolify scarica i template da una CDN via cron). Versioni pinnate, aggiornamenti solo espliciti.

---

## 3. Reverse proxy: Traefik vs Caddy vs gli altri

### 3.1 La tua domanda sul riavvio

Come detto in §0, il routing in Traefik si ricarica a caldo. Il problema vero di Traefik è un altro:

- **La config statica** (entrypoint, resolver ACME, provider) si legge una volta sola all'avvio. Cambiare l'email di Let's Encrypt o aggiungere una porta richiede un riavvio (in Dokploy per questo serve il "Reload" manuale: `settings.ts:353-356`, `927-960`).
- **ACME in cluster.** Nella versione open source Traefik salva i certificati in un `acme.json` locale e non coordina più istanze. Questo viene dalla documentazione Traefik (da riverificare, non l'ho controllato in questa sessione). Con più nodi di ingress ogni nodo emette per conto suo e si rischiano i rate limit di Let's Encrypt.
- **Il watch dei file è fragile** su sottodirectory, mount di rete e swap atomici delle directory (vedi le discussioni nella community Traefik linkate in fondo).

### 3.2 Perché Caddy

| Criterio                   | Traefik                                            | Caddy                                                                     | HAProxy                           | Nginx               |
| -------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- | --------------------------------- | ------------------- |
| Config dinamica            | File watch / label / provider                      | **API admin REST, config JSON atomica, rollback automatico se invalida**  | Runtime API limitata + reload     | Reload del processo |
| Cert multi-nodo            | Non nella versione OSS                             | **Storage condiviso** (Redis/Postgres/S3 via moduli) con lock distribuito | Esterno                           | Esterno             |
| ACME                       | HTTP-01, TLS-ALPN, DNS-01                          | HTTP-01, TLS-ALPN, DNS-01 (moduli `caddy-dns/*`), **On-Demand TLS**       | No (serve un tool esterno)        | No                  |
| Prestazioni                | Migliore su HTTPS/HTTP2 nel benchmark più rigoroso | Allineato su HTTP/1.1, RAM bassa                                          | Il più veloce sul throughput puro | Ottimo              |
| Integrazione control plane | Devi scrivere file o label                         | **POST /load dal worker**                                                 | Scomodo                           | Scomodo             |

Prestazioni, in sintesi. Nel benchmark Docker+Vegeta con versioni pinnate (Caddy 2.11.2, Traefik 3.6.13, HAProxy 3.3.6) i quattro sono entro ~5% su HTTP/1.1. Traefik ha il P99 migliore su HTTP/2, con HAProxy subito dopo. Su un test singolo con config di default HAProxy fa ~10.7k req/s, Traefik ~7.9k, Caddy ~7.5k. Per un PaaS self-hosted il collo di bottiglia è quasi sempre l'app, non il proxy. Se un giorno servisse più throughput si può mettere HAProxy davanti in modalità TCP, ma oggi non ci serve. Sono numeri di terzi, non li ho misurati io.

**Decisione: Caddy, guidato via API admin dal worker. Niente label e niente caddy-docker-proxy.**

### 3.3 Come lo usiamo

- **Build custom con `xcaddy`** (`docker/caddy/Dockerfile`), con i moduli DNS (`caddy-dns/cloudflare`, `route53`, `hetzner`, `digitalocean`, `ovh`, `porkbun`, ...) e uno storage Redis per i certificati condivisi.
- **Config dal DB.** Il job `proxy.sync` legge tutti i domini attivi, chiama `compileProxy()` e fa `POST /load` su ogni istanza Caddy. Il job è deduplicato per finestre di ~1s, così 10 modifiche di fila producono un solo `/load`. Caddy non ricarica se la config è identica. Se `/load` fallisce, Caddy resta sulla config vecchia e il job segna l'errore sul dominio.
  - Attenzione. Una richiesta che passa da Caddy e chiama `/load` in modo sincrono può andare in deadlock: Caddy aspetta che finiscano le richieste vecchie e la richiesta aspetta `/load`. Per questo l'API risponde subito e la sync avviene nel worker. È una regola strutturale, non un consiglio.
  - shortcut: `/load` dell'intera config. Se arriviamo a migliaia di route si passa a PATCH per `@id`.
- **API admin** in ascolto solo sulla rete overlay interna `ls-control`, mai pubblicata.
- **Multi-nodo.** Caddy gira come servizio globale sui nodi con label `logistack.ingress=true`. Le porte 80/443 sono pubblicate in **`mode: host`**, perché il routing mesh di Swarm nasconde l'IP reale del client.
- **Upstream** = VIP del servizio Swarm (`ls-svc-<id>:<port>`). Swarm bilancia tra le repliche.
- **Stato dei certificati.** Il worker legge i metadati (scadenza, issuer, errori) dallo storage condiviso e li mostra nella UI.

---

## 4. Architettura

### 4.1 Componenti (tutti in un unico `docker stack`)

| Servizio                                            | Cosa fa                                                                                  | Deploy                                            |
| --------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------- |
| `logistack` (una sola immagine, `ROLE=api\|worker`) | API Hono, WebSocket, frontend statico (api). Job BullMQ, reconciler, sync proxy (worker) | api: 1+ repliche sui manager. worker: 1+ repliche |
| `logistack-agent`                                   | Metriche host/container, eventi Docker, exec locale (backup, cron), stream log, build    | **global** (uno per nodo)                         |
| `caddy`                                             | Ingress + TLS                                                                            | global sui nodi `ingress=true`                    |
| `postgres`                                          | Stato desiderato, audit, metriche aggregate                                              | 1 replica pinnata a un nodo                       |
| `redis`                                             | BullMQ, pub/sub realtime, storage dei cert Caddy                                         | 1 replica pinnata                                 |
| `registry` (opzionale, interruttore)                | Registry locale                                                                          | 1 replica pinnata                                 |

L'agent **apre lui la connessione** verso l'API (WebSocket autenticato con token per nodo). Niente SSH nel funzionamento normale: SSH serve solo per il bootstrap di un nuovo server (installare Docker ed entrare nello swarm).

Linguaggio dell'agent. Lo propongo in Bun compilato (`bun build --compile`), così condivide tipi e protocollo con il server. Il costo stimato è ~30-50 MB di RAM per nodo contro ~10-15 MB di un agent Go. È una stima, da misurare nella Fase 0. Se pesa troppo, si riscrive in Go solo l'agent mantenendo lo stesso protocollo.

### 4.2 Monorepo

```
logistack/
  apps/
    server/      Hono: REST + OpenAPI + WS + MCP, serve apps/web/dist
    worker/      processori BullMQ, reconciler, scheduler
    agent/       agent di nodo
    web/         Vite + React 19 + TanStack Router/Query/Table + shadcn
  packages/
    db/          schema Drizzle + migrazioni
    contracts/   schemi zod: API, eventi, protocollo agent
    core/        dominio puro: state machine, compileService, compileProxy, permessi
    docker/      client tipizzato per Engine API (socket Unix)
    providers/   DNS, git, notifiche, S3: un'interfaccia per famiglia
  docker/caddy/  Dockerfile xcaddy
  install/       install.sh + stack.yml
```

### 4.3 Stack tecnico

- **Backend**: Bun, Hono, `@hono/zod-openapi` (OpenAPI 3.1 dalle stesse route), Drizzle + PostgreSQL 17, BullMQ + Redis, better-auth.
- **Frontend**: Vite, React 19, TanStack Router (file-based, search param tipizzati), TanStack Query, TanStack Table, shadcn/ui + Tailwind v4, CodeMirror 6 (editor script/compose/env), xterm.js (terminale), grafici shadcn (Recharts).
- **Client API**: client RPC di Hono (`hc`) tipizzato end-to-end. Gli eventi WebSocket invalidano le query key di TanStack Query, quindi niente polling.

### 4.4 Rischi tecnici da verificare subito (Fase 0)

1. **dockerode sotto Bun.** `exec`, `attach` e `logs` usano HTTP upgrade e hijack del socket, e la compatibilità di Bun su `node:http` in questi casi è storicamente il punto debole. È da provare. Se non regge, scriviamo un mini-client sull'Engine API con `fetch(..., { unix: "/var/run/docker.sock" })` di Bun e socket raw per l'hijack.
2. **BullMQ su Bun** (supportato ufficialmente, da confermare con job lunghi e cancellazione).
3. **Caddy `/load` con molte route** e storage Redis con 2+ istanze.
4. **Deploy Swarm `start-first` con healthcheck e rollback automatico.**

---

## 5. Docker: servizi, rete, dati

### 5.1 Servizi

- Ogni app e ogni database è un **servizio Swarm** con:
  - `UpdateConfig: { Order: "start-first", FailureAction: "rollback", Monitor: 30s }` e `RollbackConfig`;
  - **healthcheck obbligatorio** quando c'è un dominio (generato di default: TCP sulla porta, oppure HTTP sul path indicato).

  Così il deploy senza downtime lo fa Swarm, non codice nostro che fa `sleep` nel worker come Coolify (`ApplicationDeploymentJob.php:3011`).
- **Stato = osservato.** L'agent si iscrive agli eventi Docker (`/events`) e pubblica lo stato dei task. Il reconciler gira ogni 30s come rete di sicurezza. In UI si vedono sia lo stato desiderato sia quello osservato (`running 2/3`, `unhealthy`, `restarting`).
- **State machine del deploy**: `queued → cloning → building → pushing → deploying → healthy | failed | cancelled | superseded`. Ogni transizione emette un evento, che alimenta realtime, notifiche e audit.
- **Compose**: solo `docker stack deploy` per i servizi gestiti. Prima del deploy il compose viene parsato e riscritto (reti, volumi prefissati, label). Il file originale resta salvato così com'è. I compose con `build:` vengono buildati prima e poi sostituiti con `image:`.
- **Risorse**: limiti/reservation CPU e RAM, repliche, placement constraint, restart policy, tutti dalla UI.

### 5.2 Reti

| Rete                             | Chi c'è                                   | Scopo                                                                       |
| -------------------------------- | ----------------------------------------- | --------------------------------------------------------------------------- |
| `ls-control`                     | api, worker, agent, caddy admin           | Piano di controllo, mai raggiungibile dalle app                             |
| `ls-ingress`                     | caddy + **solo** i servizi con un dominio | Traffico HTTP in entrata                                                    |
| `ls-env-<id>` (una per ambiente) | tutti i servizi dell'ambiente             | Comunicazione interna per nome servizio. Isolamento tra ambienti di default |

- I database **non sono mai su `ls-ingress`**.
- Compromesso: i servizi pubblici si vedono tra loro su `ls-ingress`. L'alternativa (Caddy dentro ogni rete d'ambiente, come Coolify) richiede un `service update` di Caddy per ogni rete nuova, cioè un riavvio dei task. Lo evitiamo.
- Opzione per ambiente: overlay cifrato (`--opt encrypted`).
- Installer e documentazione devono avvisare su due cose. Le porte Swarm (2377/tcp, 7946/tcp+udp, 4789/udp) vanno aperte solo tra i nodi. Docker scavalca UFW per le porte pubblicate, quindi i database non vanno mai pubblicati senza un toggle esplicito con avviso.
- `swarm init` va fatto con l'**IP reale** come advertise address, non `127.0.0.1` come Dokploy.

### 5.3 Dati

- **Volumi named = dati locali al nodo.** Un servizio con volumi è "stateful" e viene **pinnato al nodo dove sta il volume** (`node.id==…`), non "al manager". La UI lo dice chiaramente. Spostarlo su un altro nodo è una procedura guidata: backup, restore sul nodo nuovo, switch.
- **File mount → Swarm `configs`/`secrets`.** Sono distribuiti su tutti i nodi e immutabili, con un nome che include l'hash del contenuto, così una modifica produce un rolling update pulito. Il contenuto resta cifrato in Postgres. Così sparisce il problema "bind file su un host solo".
- **Variabili d'ambiente**: a cascata organizzazione → progetto → ambiente → servizio. Cifrate a riposo (AES-256-GCM, master key in un Docker secret). Mascherate nella UI e nell'API senza il permesso `read:secrets`.
- **Volumi condivisi multi-nodo** (NFS/CIFS via driver `local` con opzioni): supportati come tipo di volume esplicito, mai di default.

### 5.4 Backup e restore

- Li esegue **l'agent del nodo dove gira il task**. Il worker chiede a Docker su quale nodo sta il task e manda il job a quell'agent, quindi niente `docker ps | head -1` sul manager.
- **Database**: exec di `pg_dump -Fc` / `mysqldump` / `mongodump` / `redis-cli --rdb` nel container, con le password in env. Lo stream va dritto su S3 in multipart (client S3 integrato in Bun), senza rclone né file temporanei.
- **Volumi**: stop opzionale, poi container effimero che monta il volume, `tar | zstd` e stream su S3.
- **Retention** per numero, giorni o dimensione. Checksum salvato. **Restore di verifica schedulabile**: ripristina in un container usa e getta, esegue una query di controllo e notifica. Nessuno dei due progetti lo fa, e rende i backup affidabili.
- **Disaster recovery di LogiStack**: backup automatico del proprio Postgres e della master key cifrata su S3. `install.sh --restore s3://...` ricostruisce tutto su un server nuovo.

### 5.5 Build

- **Builder**: Dockerfile (BuildKit), Railpack (Railway l'ha fatto per sostituire nixpacks; nixpacks resta disponibile per compatibilità), static (Caddy file server), immagine pronta. I buildpack arrivano dopo.
- Le build girano in un **container BuildKit** (`moby/buildkit`) sul nodo scelto (build server dedicato o un nodo qualsiasi) e sono pilotate dall'agent con `buildctl`. La cache è per servizio.
- **Cancel = AbortController sul processo di quella build.** Si uccide il process group, nient'altro.
- **Log di build**: salvati in file e streamati dall'agent via Redis pub/sub al WebSocket. Restano consultabili anche dopo.
- Su un solo nodo il push al registry è facoltativo. Con più nodi è obbligatorio (vedi §6.7).

---

## 6. Funzionalità (UI e backend)

### 6.1 Home

- Riepilogo: progetti, servizi per stato (running/unhealthy/stopped), deploy recenti con esito, backup falliti, certificati in scadenza, nodi offline, uso risorse del cluster.
- Tutto in realtime via WebSocket.

### 6.2 Projects (cartelle a 2 livelli)

- Modello proposto:
  - `folder` (con `parent_id`; un vincolo controlla profondità ≤ 2);
  - `project` dentro una cartella oppure alla radice;
  - ogni progetto ha **ambienti** (production/staging/preview, come Dokploy);
  - `service` sta in un ambiente.
- **Da decidere con te**: "cartella → cartella → servizio" vuol dire eliminare il livello progetto/ambiente, oppure cartelle _sopra_ i progetti? Raccomando cartelle sopra i progetti e ambienti mantenuti, perché ambienti, reti e variabili condivise si appoggiano lì.
- I permessi si ereditano lungo l'albero (§6.10).

### 6.3 Monitoring

- **L'agent su ogni nodo** raccoglie metriche host (CPU, RAM, disco, rete, load da `/proc` e `/sys`) e container (cgroup v2 o stats API) ogni 10s.
- **Storage**: tabelle Postgres partizionate per giorno, con rollup a 1 minuto e 1 ora fatti da un job. Retention configurabile (es. raw 24h, 1m per 7gg, 1h per 90gg).
- **Viste**: per nodo, aggregata di cluster, per servizio (somma delle repliche su più nodi), per container.
- **Soglie e alert** (CPU, RAM, disco, nodo down, restart loop) che finiscono nelle notifiche.
- L'agent espone anche `/metrics` in formato Prometheus per chi vuole Grafana.
- shortcut: Postgres al posto di un TSDB. Se servono migliaia di container o retention lunghe a bassa granularità, si passa a VictoriaMetrics.

### 6.4 Schedules

- **Job cron** con script bash modificabile in UI (CodeMirror con syntax highlight), timezone e timeout.
- **Policy di concorrenza**: `forbid` / `allow` / `replace`.
- **Target dove gira lo script**:
  1. **container effimero** da un'immagine (default; tipo CronJob di Kubernetes, il più isolato);
  2. dentro un servizio esistente (exec nel task, sul suo nodo);
  3. sull'host di un nodo (solo admin, con un avviso esplicito).
- Lo scheduling usa i **Job Scheduler di BullMQ**: persistenti, eseguiti una volta sola anche con più worker, non in-process.
- Ogni run salva exit code, durata e output (troncato a N MB). "Run now", storico, notifica su fallimento.

### 6.5 DNS

- Interfaccia `DnsProvider { listZones, listRecords, upsert, delete, verify }`.
- **Provider**: Cloudflare, Route53, Hetzner, DigitalOcean, OVH, Porkbun, Gandi, Namecheap. Si parte da Cloudflare, Route53 e Hetzner.
- **Quando aggiungi un dominio**:
  - se la zona è di un provider collegato, LogiStack crea il record A/AAAA o CNAME e verifica la propagazione;
  - poi abilita il TLS;
  - per Cloudflare avvisa se il proxy arancione è attivo con SSL "Flexible".
- **Lo stesso token serve per DNS-01 in Caddy**, quindi i **wildcard** (`*.app.example.com`) funzionano senza configurazione a mano. Dokploy ha i provider ma non li collega né ai domini né ad ACME.

### 6.6 Domini senza dominio: sslip.io / nip.io

- **Dominio automatico** `<servizio>-<short>.<ip-con-trattini>.sslip.io` (oppure nip.io a scelta), con HTTPS Let's Encrypt via HTTP-01.
- Funziona anche per IPv6 (sslip lo supporta).
- **Da verificare in Fase 0**: se sslip.io e nip.io sono nella Public Suffix List. Se non lo sono, i certificati di _tutti_ gli utenti contano sul limite di Let's Encrypt per dominio registrato.
- In alternativa si imposta un **dominio wildcard per server** (es. `*.srv1.miodominio.it`) e LogiStack genera sotto-domini lì.

### 6.7 Registry

- **Interruttore "Registry locale"**:
  - deploy di un registry come servizio (raccomando **Zot**, registry OCI con GC e retention integrati e meno codice da scrivere; alternativa `distribution/registry:3`);
  - esposto tramite Caddy su `registry.<dominio o sslip>` con HTTPS e credenziali generate;
  - credenziali distribuite ai nodi tramite `--with-registry-auth` sui servizi;
  - GC schedulata.

  Su un nodo solo funziona subito, con più nodi diventa obbligatorio e LogiStack lo propone quando aggiungi il secondo nodo.
- **Procedura guidata GHCR**: istruzioni per il PAT con `write:packages`, test di login/push/pull, scelta del namespace. Lo stesso schema vale per Docker Hub, GitLab Registry e registry generici.
- **Retention delle immagini**: tieni le ultime N per servizio, così i rollback restano possibili.

### 6.8 Git provider

- **GitHub**: GitHub App con manifest flow (come Dokploy), webhook con verifica HMAC, deploy su push, **preview su PR**, commit status.
- **GitLab** (anche self-hosted), **Gitea/Forgejo** e **Bitbucket**: OAuth/app. **Webhook sempre firmati o con secret nell'header**, mai solo un token nell'URL. Preview per tutti dove l'API lo permette.
- **Git generico** via chiave SSH deploy.
- **Watch paths** (deploy solo se cambiano certe cartelle), utile nei monorepo.

### 6.9 S3, backup, notifiche, certificati

- **Destinazioni S3**: qualsiasi endpoint compatibile (AWS, R2, B2, MinIO, Hetzner, Wasabi), con test di connessione e prefisso.
- **Notifiche**:
  - bus di eventi interno tipizzato (`deployment.failed`, `backup.failed`, `node.down`, `cert.expiring`, `schedule.failed`, ...);
  - **regole** del tipo evento × filtro (progetto/servizio) → canale. Non una colonna booleana per ogni combinazione come Coolify;
  - **canali**: email (SMTP/Resend), Slack, Discord, Telegram, Teams, Mattermost, ntfy, Gotify, Pushover, webhook firmato HMAC;
  - la config di ogni canale è JSON validato da uno schema zod per tipo.
- **Certificati**: Let's Encrypt automatico (HTTP-01, DNS-01 per i wildcard), upload di certificati custom, issuer ACME alternativi (ZeroSSL), elenco con scadenze e errori.

### 6.10 Auth e permessi

- **better-auth** con plugin `twoFactor` (TOTP + backup code), `passkey`, social (Google, GitHub), `sso` (OIDC + SAML), `organization`, `apiKey`, `admin`.
- **Permessi** come risorsa × azione, con scope ereditato `org → cartella → progetto → ambiente → servizio`:
  - azioni: `read`, `read:secrets`, `deploy`, `write`, `delete`, `admin`;
  - ruoli predefiniti (owner, admin, developer, viewer) più **ruoli custom senza licenza**;
  - ogni controllo passa da una sola funzione `can(actor, action, resource)` in `packages/core`, testata a tabella.
- **Machine identity**: utenti di tipo `machine` (service account) con chiavi API dagli scope limitati, scadenza e rotazione. Più avanti, token OIDC per la CI (es. GitHub Actions OIDC → token LogiStack di breve durata, senza segreti nella CI).
- **Chiavi API**: prefisso riconoscibile (`lsk_...`), salvate come hash, ultimo utilizzo, IP.

### 6.11 API, MCP, realtime

- **API REST completa**: ogni cosa che fa la UI passa da lì. Spec OpenAPI 3.1 generata dalle route e documentazione su `/api/docs`.
- **Server MCP** (`/mcp`, streamable HTTP), autenticato con chiave API o OAuth. I tool si **generano dallo stesso registro delle route**, così API e MCP non divergono mai. Le operazioni distruttive (delete, stop, restore) sono marcate come tali e richiedono il permesso esplicito.
  - Da confermare: hai scritto "client mcp", ma intendo un **server** MCP che LogiStack espone per farsi pilotare da Claude e simili.
- **WebSocket**: un endpoint, con abbonamento a canali (`deployment:<id>`, `service:<id>:logs`, `node:<id>:metrics`, `org:<id>:events`) e controllo dei permessi all'iscrizione. Fonte: Redis pub/sub, alimentato da worker e agent. Terminale web nel container (xterm.js, exec via agent).

### 6.12 Audit log

- Tabella append-only partizionata per mese. Campi: attore (utente/chiave/machine/sistema), azione, risorsa, **diff con i segreti oscurati**, IP, user agent, request id, esito.
- Scritto da **un solo punto**: il middleware che esegue le mutazioni. Così non si può dimenticare.
- Ricerca e filtri in UI, export CSV/JSON, retention configurabile. Nessuna licenza.

### 6.13 Chiavi SSH e server

- **Chiavi SSH** generate ed25519 o importate, cifrate a riposo, usate per i repo git e per il bootstrap dei server.
- **Aggiunta di un server**: IP + chiave SSH. Uno script idempotente installa Docker, entra nello swarm come worker (o manager), poi parte l'agent globale. Da quel momento SSH non serve più.
- **Label sui nodi dalla UI** (`ingress`, `build`, `gpu`, custom) per le placement.

---

## 7. Roadmap (stime grezze, 1 sviluppatore + Claude)

Ogni fase finisce con una verifica sul sistema reale, non solo con i test che passano.

| Fase                    | Contenuto                                                                                                                                                                                                                                                                                   | Verifica di uscita                                                                                                        | Stima     |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | --------- |
| **0. Spike**            | dockerode/Engine API sotto Bun (exec, logs, events). BullMQ su Bun. Caddy xcaddy + `/load` + storage Redis su 2 istanze. Swarm `start-first` + healthcheck + rollback. PSL di sslip/nip                                                                                                     | Un PoC per punto, con esito scritto nel repo                                                                              | 1-2 sett. |
| **1. MVP nodo singolo** | install.sh + stack. Auth (email, 2FA, passkey). Org, cartelle, progetti, ambienti. App da GitHub App con Dockerfile/Railpack. Env cifrate. Dominio sslip + LE via Caddy. Deploy queue + state machine + rollback. Log realtime. DB Postgres/Redis/MySQL. Reconciler. Registry locale on/off | Deploy di 3 app reali tue su una VPS nuova, kill dei container e cancellazione di reti a mano: il reconciler ripara tutto | 5-7 sett. |
| **2. Operatività**      | Backup S3 + restore + restore di verifica. Schedules. Notifiche. DNS provider (Cloudflare, Route53, Hetzner) + wildcard DNS-01. Audit log. Chiavi API + OpenAPI. Permessi granulari                                                                                                         | Restore riuscito da S3 su un server pulito. Audit completo di una sessione di lavoro                                      | 4-5 sett. |
| **3. Multi-nodo**       | Bootstrap server via SSH, agent globale, gestione nodi e label. Placement per stateful. Metriche per nodo e aggregate. Ingress su più nodi. Registry obbligatorio + procedura GHCR                                                                                                          | Cluster di 3 VM: un nodo si spegne, i servizi stateless ripartono altrove, i backup dei servizi sui worker funzionano     | 4-5 sett. |
| **4. Ecosistema**       | Compose/stack + template (import da Coolify se la licenza lo consente). Preview deploy. GitLab/Gitea/Bitbucket. Server MCP. SSO OIDC/SAML. Machine identity. **Import da Dokploy** via la sua API                                                                                           | Migrazione di un tuo progetto Dokploy reale su LogiStack                                                                  | 4-6 sett. |
| **5. Hardening**        | DR self-backup/restore. Upgrade in-place con migrazioni. Test di caos in CI (swarm DinD multi-nodo). Docs                                                                                                                                                                                   | Upgrade da versione N-1 a N con servizi attivi e zero downtime                                                            | 2-3 sett. |

Totale indicativo: 5-7 mesi per arrivare a sostituire Dokploy nel tuo uso quotidiano. È una stima a sensazione, non calcolata.

### Strategia di test (dove sta la stabilità)

1. **Snapshot test sui compilatori puri** (`compileService`, `compileProxy`, parser compose): input riga DB → output spec. Veloci e numerosi.
2. **Test di integrazione su Docker vero**: swarm Docker-in-Docker a 1 e 3 nodi in CI. Scenari: deploy, update start-first, healthcheck fallito → rollback, cancel, backup/restore.
3. **Test di riconciliazione**: cancella a mano un servizio, una rete o un volume orfano, kill dell'agent, riavvio del worker durante un deploy. Il risultato atteso è sempre convergenza o errore esplicito, mai stato silenziosamente sbagliato.
4. **Test a tabella per `can()`** (permessi) e per la state machine del deploy.

---

## 8. Decisioni (3 nov 2026)

1. **Gerarchia**: cartelle (max 2 livelli) sopra i progetti, progetti con ambienti.
2. **MCP**: LogiStack espone un server MCP.
3. **Agent**: Bun compilato.
4. **Licenza**: privato per ora, open source più avanti. Niente codice copiato da Dokploy/Coolify.
5. **Repo**: `logical-tech/logistack`, privato.
6. **Setup**: ogni configurazione è un wizard guidato.
7. **UI**: feeling premium, ordinato, stile Vercel/better-auth.

---

## Fonti esterne (proxy)

- [reverse-proxy-benchmark (GitHub)](https://github.com/fabianwimberger/reverse-proxy-benchmark)
- [Nginx, Caddy, Traefik, or HAProxy (DEV, 2026)](https://dev.to/shinagawa-web/nginx-caddy-traefik-or-haproxy-how-to-pick-the-right-reverse-proxy-for-your-stack-2026-2doj)
- [Caddy: getting started / API](https://caddyserver.com/docs/getting-started)
- [Caddy community: API in SaaS (deadlock /load, On-Demand TLS)](https://caddy.community/t/using-caddy-api-in-saas-solutions/11960)
- [Caddy issue #3994](https://github.com/caddyserver/caddy/issues/3994)
- [Traefik issue #5495 (inotify e mount di rete)](https://github.com/traefik/traefik/issues/5495)
- [Traefik community: watch nelle sottodirectory](https://community.traefik.io/t/file-watch-not-working-for-subdirectories/27112)
- [Coolify docs: Traefik dynamic config](https://coolify.io/docs/core/networking/proxy/traefik/dynamic-config)
