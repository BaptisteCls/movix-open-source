# WatchParty Sync WASM

Moteur Rust/WASM pour `Sync Pro`.

## Sortie attendue

Le bundle généré doit finir dans:

- `public/wasm/watchparty-sync/watchparty_sync.js`
- `public/wasm/watchparty-sync/watchparty_sync_bg.wasm`

Le Worker front essaie de charger ce bundle automatiquement. S'il est absent, il retombe sur le moteur JS.

## Prérequis

```bash
rustup target add wasm32-unknown-unknown
cargo install wasm-bindgen-cli
```

## Build release

Depuis la racine du repo:

```bash
cargo build --manifest-path wasm/watchparty-sync/Cargo.toml --target wasm32-unknown-unknown --release
wasm-bindgen --target web --out-dir public/wasm/watchparty-sync wasm/watchparty-sync/target/wasm32-unknown-unknown/release/watchparty_sync.wasm
```

## Build debug

```bash
cargo build --manifest-path wasm/watchparty-sync/Cargo.toml --target wasm32-unknown-unknown
wasm-bindgen --target web --out-dir public/wasm/watchparty-sync wasm/watchparty-sync/target/wasm32-unknown-unknown/debug/watchparty_sync.wasm
```

## API exportée

Le wrapper généré doit exposer:

- `default init()`
- `WatchPartySyncEngine`

Le Worker consomme ensuite:

- `new WatchPartySyncEngine()`
- `set_mode(mode)`
- `reset()`
- `ingest_master_state(state)`
- `ingest_schedule(event)`
- `update_clock_offset(result)`
- `tick(localState)`
- `get_status()`
