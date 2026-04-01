# bypass403

`bypass403.py` est un micro-service Flask très ciblé. Il sert de relais quand certaines sources renvoient un `403` ou imposent des conditions réseau que le reste du stack ne passe pas facilement.

Ce service est volontairement minimal : un healthcheck, un endpoint proxy, un peu de cache mémoire et quelques ajustements de headers selon le domaine demandé.

## Démarrage

```bash
cd API/miscs
cp .env.example .env
pip install flask requests python-dotenv
python bypass403.py
```

Le service écoute actuellement sur `http://localhost:25568`.

## Configuration

Le seul paramètre exposé dans `API/miscs/.env.example` est :

- `BYPASS403_SOCKS5_PROXY_URL`

## Endpoints

| Route | Rôle |
| --- | --- |
| `GET /health` | Retourne l'état du service et la taille du cache |
| `GET/POST/HEAD/OPTIONS /proxy/<target>` | Relaie la requête vers la cible demandée |

## Ce que le service fait en pratique

- reconstruit l'URL cible à partir du path et de la query string
- peut activer un proxy SOCKS5 pour certains domaines ou si `proxy=true` est passé dans l'URL
- injecte quelques headers métier pour des domaines connus
- met en cache certaines réponses `GET` de petite taille pendant 10 minutes
- ré-expose la réponse avec des headers CORS permissifs

## Quand l'utiliser

- quand une source précise casse avec un `403`
- quand le backend principal ou le frontend ne doivent pas gérer ce cas eux-mêmes
- quand tu veux un relais léger plutôt que mobiliser `API/proxiesembed/`
