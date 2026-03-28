<div align="center">

<img src="../public/movix.png" alt="Extension Movix" width="120" />

# Extension Movix

**Extension navigateur utilisée par Movix pour l'extraction locale des flux vidéo.**

[![Firefox Add-ons](https://img.shields.io/badge/Firefox-Add--ons-FF7139?style=flat&logo=firefoxbrowser&logoColor=white)](https://addons.mozilla.org/en-US/firefox/addon/movix-proxy-extension/)
[![Userscript](https://img.shields.io/badge/Alternative-Userscript-blue?style=flat)](../userscript/README.md)

</div>

---

L'extension Movix permet d'exécuter certaines extractions directement dans le navigateur, d'injecter les headers nécessaires selon les hosters, et de contourner certains blocages CORS ou de contexte appareil/domaine.

## Liens utiles

- [README Movix OS](../README_MOVIX_OS.md)
- [README Userscript Movix](../userscript/README.md)
- [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/movix-proxy-extension/)
- [Archive Firefox](Firefox/Firefox.zip)
- [Archive Chrome](Chrome/Chrome.zip)

## Quelle option choisir ?

- **Firefox** : l'extension native est l'option recommandée.
- **Chrome / Edge / Brave** : le [userscript Tampermonkey](../userscript/README.md) est souvent le plus simple à installer.
- **Développement local** : tu peux charger directement les dossiers `Chrome/` ou `Firefox/`.

## Installation

### Firefox

1. Ouvre la page [Firefox Add-ons](https://addons.mozilla.org/en-US/firefox/addon/movix-proxy-extension/).
2. Clique sur **Ajouter à Firefox**.
3. Accepte les permissions demandées.
4. Recharge Movix.

### Installation locale sur Chrome / Brave / Edge

1. Ouvre `chrome://extensions`.
2. Active le mode développeur.
3. Clique sur **Charger l'extension non empaquetée**.
4. Sélectionne le dossier [`extension/Chrome`](Chrome/).

### Installation locale sur Firefox

1. Ouvre `about:debugging#/runtime/this-firefox`.
2. Clique sur **Charger un module complémentaire temporaire**.
3. Sélectionne [`extension/Firefox/manifest.json`](Firefox/manifest.json).

Tu peux aussi consulter l'archive [`Firefox.zip`](Firefox/Firefox.zip).

## Structure

- [`Chrome/`](Chrome/) : version Chrome / Chromium de l'extension
- [`Firefox/`](Firefox/) : version Firefox de l'extension

## Permissions

L'extension utilise principalement :

- `declarativeNetRequest`
- `declarativeNetRequestWithHostAccess`
- `storage`
- des `host_permissions` larges pour intercepter et adapter certaines requêtes vidéo

Ces permissions sont nécessaires pour :

- injecter les bons headers
- traiter des flux protégés par CORS
- exécuter l'extraction locale dans le navigateur

## Alternative userscript

Si tu ne veux pas installer l'extension native, ou si tu préfères Tampermonkey sur un navigateur Chromium, utilise le userscript Movix :

- [README Userscript Movix](../userscript/README.md)
- [Installation directe de `movix.user.js`](https://github.com/MysticSaba-max/movix-open-source/raw/refs/heads/main/userscript/movix.user.js)
