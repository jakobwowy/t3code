# Runbook: Fork pflegen, Upstream nachziehen, App starten

Gilt nur für den Fork `jakobwowy/t3code`. Diese Datei liegt ausschließlich auf dem Branch `wowy` und darf nie in einen Feature-Branch oder einen Upstream-PR gelangen.

## Aufbau

| Remote | Repo | Rechte |
|---|---|---|
| `upstream` | `pingdotgg/t3code` | nur lesen |
| `origin` | `jakobwowy/t3code` (öffentlich) | schreiben |

| Branch | Rolle | Regel |
|---|---|---|
| `main` | Spiegel von `upstream/main` | nie eigene Commits, nur Fast-Forward |
| `feat/<name>` | ein Feature | von `main` abzweigen, upstream-tauglich, nichts Fork-Eigenes |
| `wowy` | Integrationsbranch, daraus wird die eigene App gebaut | `main` plus alle `feat/*` plus Fork-Eigenes (dieses Runbook) |

Der Fork ist öffentlich. Pläne, Notizen und alles mit Bezug zum business-os bleiben außerhalb des Repos (Quick-Project im `business-os-hub`). Zugangsdaten kommen nie in den Code.

## Werkzeuge

- `vp` (Vite+) ist global installiert, die Node-Verwaltung von `vp` ist aus (`VP_NODE_MANAGER=no`), damit Volta für die anderen Projekte zuständig bleibt.
- Das Repo verlangt Node `^24.13.1`, der globale Standard ist Node 22. Deshalb jeden Repo-Befehl über Volta mit Node 24 starten:

```sh
volta run --node 24.21.0 vp i
volta run --node 24.21.0 vp test run <dateien>
volta run --node 24.21.0 vp run dev:desktop
```

Ohne das Präfix läuft `node` in den Skripten mit Node 22.

## Upstream nachziehen

Vorher: Arbeitsverzeichnis sauber, Dev-Lauf gestoppt.

```sh
git fetch upstream --tags
git checkout main
git merge --ff-only upstream/main
git push origin main
```

Schlägt `--ff-only` fehl, liegt ein eigener Commit auf `main`. Den auf einen Feature-Branch umziehen, `main` nicht mergen.

Dann jedes offene Feature und zuletzt den Integrationsbranch:

```sh
git checkout feat/<name>
git rebase main            # solange kein Upstream-PR offen ist, sonst: git merge main
git checkout wowy
git merge main
git merge feat/<name>
volta run --node 24.21.0 vp i
git push origin wowy
```

`git rerere` ist eingeschaltet, eine einmal gelöste Konfliktstelle wird beim nächsten Mal wiederverwendet. Konflikte sind vor allem an den Einhängezeilen in `apps/server/src/server.ts` und `apps/web/src/components/ChatView.tsx` zu erwarten, dort ändert Upstream häufig.

Nach dem Nachziehen die Tests der eigenen Features laufen lassen, keine repo-weiten Checks (siehe `AGENTS.md`).

## Starten

**Erprobung (jetzt):** Dev-Lauf aus dem Haupt-Checkout.

```sh
volta run --node 24.21.0 vp run dev:desktop
```

Mit WakaTime-Heartbeats ans business-os (Feature `feat/wakatime-heartbeats`, Doku in `docs/user/time-tracking.md`):

```sh
env T3CODE_WAKATIME_ENABLED=true volta run --node 24.21.0 vp run dev:desktop
```

Den Dev-Lauf für die Arbeit im Alltag selbst im Terminal starten und auf `wowy` lassen. Er lädt Änderungen am ausgecheckten Code sofort nach, ein Branch-Wechsel im selben Checkout ändert also die laufende App. Für paralleles Entwickeln einen Worktree nehmen.

Der Dev-Lauf nutzt `~/.t3/dev` und ein eigenes Electron-Profil. Die installierte Release-App und `~/.t3/userdata` bleiben unberührt. Echte Daten als Kopie holen: `vp run migrate-dev-db` bei gestopptem Dev-Lauf. Einstellungen bei Bedarf aus `~/.t3/userdata` kopieren (`settings.json`, `keybindings.json`, `client-settings.json`), nie verlinken.

**Alltag (ab stabilem 0.0.46, noch nicht erprobt):** `wowy` auf den Release-Tag statt auf `main` aufsetzen, Features hineinmergen, DMG bauen und die Release-App in `/Applications` ersetzen.

```sh
volta run --node 24.21.0 vp run dist:desktop:dmg:arm64   # schreibt nach release/, unsigniert
```

Vor dem ersten Start des Eigenbaus `~/.t3/userdata` sichern. Der neue Stand kopiert `state.sqlite` einmalig nach `statev2.sqlite`, danach laufen alter und neuer Stand auseinander. Der Eigenbau hat dieselbe App-ID wie die Release-App und keinen Update-Feed. Neue Versionen kommen nur durch Nachziehen und Neubauen.

## Nie

- Einen Server gegen `~/.t3/userdata` starten oder den Ordner aufräumen.
- Prozesse nach Namen oder Pfad beenden. Nur die PID, die beim Start gemerkt wurde.
- `VITE_HTTP_URL` oder `VITE_WS_URL` für den Dev-Lauf setzen.
