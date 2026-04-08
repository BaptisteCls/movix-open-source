# Proxies Embed

`API/proxiesembed/` est le gros proxy Python du projet. Il sert à la fois de proxy de streaming, de boîte à outils pour certains extracteurs d'hosters, de passerelle DRM et de couche de contournement pour des cas où le frontend ou le backend Node ne suffisent plus.

Le service est écrit avec `aiohttp` et pensé pour la charge : connexions concurrentes, caches mémoire, coalescing de requêtes, pools proxy et endpoints spécialisés par hoster.

## Ce que le service fait

- proxy générique de flux via `/proxy`
- extracteurs dédiés pour plusieurs hosters embed
- endpoints proxy spécialisés par source
- debrid unlock via API
- surface DRM avec extraction de manifestes et réécriture de ressources
- vérification d'accès VIP via MySQL
- support de pools SOCKS5 et de sessions dédiées pour certains cas comme france.tv

## Démarrage

```bash
cd API/proxiesembed
cp .env.example .env
pip install -r requirements.txt
python server.py
```

Notes utiles :

- le code bind actuellement sur `http://localhost:25569`
- le fichier `.env.example` contient `PORT`, mais `server.py` écoute aujourd'hui `25569` en dur
- certaines routes DRM s'appuient sur des utilitaires additionnels dans `drmproxy/` ; si ces utilitaires sont absents, le serveur démarre quand même mais la partie DRM avancée reste limitée

## Variables d'environnement utiles

Le fichier `API/proxiesembed/.env.example` couvre les besoins principaux :

- base de données : `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- exposition publique : `PROXY_BASE`
- pools proxies : `PROXIES_SOCKS5_JSON`, `SIBNET_PROXY_SOCKS5_JSON`
- france.tv : `FRANCETV_EMAIL`, `FRANCETV_PASSWORD`
- debrid : `DEEPBRID_API_KEY`

## Endpoints à connaître

| Route | Rôle |
| --- | --- |
| `GET /proxy` et `GET /proxy/{path}` | Proxy streaming générique |
| `GET /health` | Healthcheck |
| `GET /stats` | Stats runtime |
| `GET /api/extract-fsvid` | Extraction FSVid |
| `GET /api/extract-vidzy` | Extraction Vidzy |
| `GET /api/extract-vidmoly` | Extraction Vidmoly |
| `GET /api/extract-sibnet` | Extraction Sibnet |
| `GET /api/extract-uqload` | Extraction Uqload |
| `GET /api/extract-doodstream` | Extraction Doodstream |
| `GET /api/extract-seekstreaming` | Extraction SeekStreaming |
| `GET /voe-proxy`, `/fsvid-proxy`, `/vidzy-proxy`, `/vidmoly-proxy`, `/sibnet-proxy`, `/uqload-proxy`, `/doodstream-proxy`, `/seekstreaming-proxy`, `/cinep-proxy` | Proxies dédiés par source |
| `GET/POST /drm/extract` | Extraction de manifeste DRM |
| `GET /drm/manifest` | Réécriture de manifeste HLS ou DASH |
| `GET /drm/resource` | Proxy de ressources DRM |
| `GET /drm/b/{base_b64}/{subpath}` | Proxy path-based pour DASH |
| `POST /api/debrid/unlock` | Unlock de liens debrid |

## Notes d'architecture

- le serveur initialise plusieurs sessions HTTP spécialisées
- certaines ressources lourdes sont cachées en mémoire avec eviction TTL
- la partie france.tv peut utiliser une session SOCKS5H distincte pour l'extraction
- la partie DRM tente de charger les utilitaires WideFrog au démarrage, mais reste optionnelle
- la vérification VIP s'appuie sur MySQL avant d'autoriser certaines surfaces

## Quand regarder aussi ailleurs

Si tu touches ce dossier, il faut souvent vérifier en miroir :

- `API/Mainapi/liveTvRoutes.js`
- `API/Mainapi/routes/debrid.js`
- `src/pages/Watch/`
- `src/components/*Player*`
- `cloudflareproxy/` ou `RivestreamCloudflareProxy/` selon les flux concernés
