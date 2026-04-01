# WatchParty API

La WatchParty est le service temps réel de Movix. C'est lui qui gère les rooms, le chat, les rôles, les votes, la synchro de lecture et la persistance minimale entre deux redémarrages.

Le service est volontairement concentré dans un seul fichier ESM, `watchparty.js`, qui combine Express, serveur HTTP et namespace Socket.IO.

## Ce que la WatchParty gère

- création de room avec code d'invitation
- synchro lecture / pause / seek
- deux modes de sync : `classic` et `pro`
- chat live, réactions et participants
- contrôle par hôte, co-hosts ou mode démocratique
- pause timer et vote de pause
- rooms publiques et liste des rooms visibles
- sauvegarde JSON sur disque au shutdown

## Démarrage

Depuis la racine du repo:

```bash
npm install
cp API/watchpartyAPI/.env.example API/watchpartyAPI/.env
node API/watchpartyAPI/watchparty.js
```

Notes utiles :

- le port par défaut est `25566`
- `API/watchpartyAPI/` n'a pas son propre `package.json`
- les dépendances sont résolues depuis le `node_modules` racine

## Configuration

Les variables exposées par `API/watchpartyAPI/.env.example` sont :

- `WATCHPARTY_PORT`
- `WATCHPARTY_CORS_CREDENTIALS`
- `WATCHPARTY_REST_CORS_ORIGIN`
- `WATCHPARTY_SOCKET_CORS_ORIGIN`
- `WATCHPARTY_SOCKET_CORS_METHODS`

## Surface HTTP

| Route | Rôle |
| --- | --- |
| `POST /api/watchparty/create` | Crée une room et renvoie `roomId` + `roomCode` |
| `POST /api/watchparty/join` | Rejoint une room via code |
| `GET /api/watchparty/room/:roomId` | Retourne l'état détaillé d'une room |
| `GET /api/watchparty/info/:code` | Retourne les infos publiques d'une room via son code |
| `GET /api/watchparty/public` | Liste les rooms publiques |
| `GET /api/watchparty/all` | Liste toutes les rooms connues du service |

## Surface Socket.IO

Le namespace dédié est `/watchparty`.

Les familles d'événements à connaître :

- room : `room:info`, `room:participants`, `room:chat`, `room:chatToggled`
- playback : `playback:update`, `playback:state`, `playback:schedule`, `playback:buffering`
- contrôle : `control:request`, `control:approve`, `control:deny`, `control:revoke`, `control:setMode`
- sync pro : `sync:setMode`, `sync:probe`, `sync:probeResult`
- collaboration : `ready:toggle`, `reaction:send`, `media:change`
- moderation : `message:delete`, `participant:kick`
- vote / pause : `pause:start`, `pause:cancel`, `vote:request`, `vote:cast`

## Persistance et cycle de vie

- les rooms sont gardées en mémoire dans un `Map`
- au shutdown, le service sauve dans `API/watchpartyAPI/cache/watchparty-rooms.json`
- au redémarrage, ce fichier est relu puis supprimé
- les rooms vides sont nettoyées après 5 minutes
- un cleanup périodique ferme aussi les rooms trop vieilles ou inactives

## Frontend lié

Si tu touches la WatchParty, vérifie aussi :

- `src/pages/WatchPartyCreate.tsx`
- `src/pages/WatchPartyJoin.tsx`
- `src/pages/WatchPartyList.tsx`
- `src/pages/WatchPartyRoom.tsx`
- `src/hooks/useWatchParty.ts`
- `src/utils/watchparty.ts`
- `src/utils/watchpartySync.ts`
- `src/workers/watchpartySync.worker.ts`
