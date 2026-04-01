# Frontend Movix

Le frontend Movix porte l'expérience utilisateur complète : navigation dans le catalogue, pages détails, lecture vidéo, Live TV, WatchParty, profils, listes partagées, Wishboard, VIP et Wrapped.

Le point important pour contribuer ici : `src/App.tsx` ne fait pas que router. Il centralise aussi plusieurs comportements transverses, dont la persistance locale et la sync de certains morceaux de `localStorage` vers `POST /api/sync`.

## Démarrage

```bash
cp .env.example .env
npm install
npm run dev
```

Le serveur Vite écoute sur `http://localhost:3000`.

Commandes utiles :

```bash
npm run lint
npm run build
npm run preview
npm run wasm:watchparty-sync:setup
npm run wasm:watchparty-sync:build
```

## Ce que le frontend gère

- découverte de films, séries, anime, collections et fiches personnes
- pages de lecture pour films, séries et anime
- Live TV et providers annexes
- WatchParty, création de room, join, liste publique et Sync Pro
- comptes, auth, profils multiples et sessions
- listes partagées, suggestions, Wishboard et soumission de liens
- pages VIP, dons, cadeaux, invoices et Wrapped

## Variables d'environnement utiles

Les variables principales sont documentées dans `.env.example` :

- `VITE_MAIN_API`
- `VITE_TMDB_API_KEY`
- `VITE_SITE_URL`
- `VITE_WATCHPARTY_API`
- `VITE_PROXY_BASE_URL`
- `VITE_API_PROXY_BASE_URL`
- `VITE_PROXIES_EMBED_API`
- `VITE_RIVESTREAM_PROXIES`
- `VITE_SUPPORT_TELEGRAM_URL`
- `VITE_TURNSTILE_SITE_KEY`
- `VITE_TURNSTILE_INVISIBLE_SITEKEY`

La normalisation des URLs runtime est centralisée dans `src/config/runtime.ts`.

## Architecture

```text
src/
|-- main.tsx                 # Point d'entrée
|-- App.tsx                  # Routing principal + comportements transverses
|-- pages/                   # Une page = une route
|-- components/              # UI et composants métier
|-- context/                 # État global via React Context
|-- services/                # Appels HTTP
|-- hooks/                   # Hooks custom
|-- utils/                   # Helpers
|-- config/                  # Runtime, Firebase, proxies
|-- workers/                 # Web workers, dont WatchParty Sync
|-- i18n/                    # Traductions
`-- components/ui/           # Primitives UI réutilisables
```

## Routes à connaître

Le routeur principal est dans `src/App.tsx`. Les grandes familles de routes sont :

- navigation catalogue : `/`, `/movies`, `/tv-shows`, `/collections`, `/movie/:id`, `/tv/:id`
- lecture : `/watch/movie/:tmdbid`, `/watch/tv/:tmdbid/s/:season/e/:episode`, `/watch/anime/...`
- social / communautaire : `/wishboard`, `/list/:shareCode`, `/top10`, `/wrapped`
- compte / profils / VIP : `/profile`, `/profile-selection`, `/settings`, `/vip`, `/vip/don`
- temps réel : `/watchparty/create`, `/watchparty/join`, `/watchparty/room/:roomId`
- services annexes : `/live-tv`, `/debrid`, `/extension`, `/ftv`

## État global

Movix n'utilise ni Redux ni Zustand. L'état global passe surtout par React Context, le stockage local et quelques synchronisations backend.

Les contexts à connaître en premier :

- `AuthContext.tsx`
- `ProfileContext.tsx`
- `SearchContext.tsx`
- `VipModalContext.tsx`
- `AdFreePopupContext.tsx`
- `AdWarningContext.tsx`
- `IntroContext.tsx`

## Où intervenir selon le sujet

- Auth et persistance : `src/App.tsx`, `src/context/AuthContext.tsx`, `src/context/ProfileContext.tsx`
- Calls backend : `src/services/` puis les pages/composants consommateurs
- WatchParty : `src/pages/WatchParty*.tsx`, `src/hooks/useWatchParty.ts`, `src/utils/watchparty.ts`, `src/workers/watchpartySync.worker.ts`
- Lecture vidéo : `src/pages/Watch/` et les composants `*Player*`
- Traductions : `src/i18n/`

## Notes de contribution

- Les imports inutilisés cassent le lint.
- Certaines features de lecture combinent plusieurs players et plusieurs proxies ; évite les simplifications rapides.
- Si tu touches une feature transversale, regarde aussi le backend correspondant dans `API/Mainapi/` ou `API/watchpartyAPI/`.
