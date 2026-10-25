# Runbook: Fork pflegen, Upstream nachziehen, App starten

Gilt nur für den Fork `jakobwowy/t3code`. Diese Datei liegt ausschließlich auf dem Branch `wowy` und darf nie in einen Feature-Branch oder einen Upstream-PR gelangen.

## Aufbau

| Remote     | Repo                            | Rechte    |
| ---------- | ------------------------------- | --------- |
| `upstream` | `pingdotgg/t3code`              | nur lesen |
| `origin`   | `jakobwowy/t3code` (öffentlich) | schreiben |

| Branch        | Rolle                                                 | Regel                                                        |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| `main`        | Spiegel von `upstream/main`                           | nie eigene Commits, nur Fast-Forward                         |
| `feat/<name>` | ein Feature                                           | von `main` abzweigen, upstream-tauglich, nichts Fork-Eigenes |
| `wowy`        | Integrationsbranch, daraus wird die eigene App gebaut | `main` plus alle `feat/*` plus Fork-Eigenes (dieses Runbook) |

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

Zusätzlich `volta run --node 24.21.0 vp run check:changed main`: Format, Lint, Knip, Typprüfung der betroffenen Pakete und Tests neben den Änderungen. Für Browser-Tests einmalig `vp exec playwright install chromium-headless-shell` in `apps/web`.

**Lange nicht nachgezogen (Erfahrung vom 25.10.2026, 2451 Upstream-Commits):** Upstream baut die Einhängestellen um, rerere hilft dann nicht. Bewährt hat sich:

1. In einem eigenen Worktree arbeiten, Haupt-Checkout und `wowy` bleiben bis zum grünen Check unberührt: `git worktree add ../t3code-sync -b sync/<feature> feat/<feature>`.
2. Konfliktdateien auf die Upstream-Fassung setzen (`git checkout --ours <datei>` während des Rebase) und die eigene Ergänzung an der neuen Stelle neu einsetzen, statt Konfliktblöcke zu verschmelzen.
3. Zielstand bauen: `sync/target` von `main`, beide Features hineinmergen, Fork-Doku aus `wowy` holen, `check:changed main` grün.
4. `wowy` ohne Force-Push nachziehen: Merge-Commit mit dem Baum des Zielstands und den Eltern `wowy`, `main` und den Features (`git commit-tree <baum> -p wowy -p main -p sync/...`), dann `git merge --ff-only`. Die rebasten Features liegen als `sync/*` vor, `feat/*` und `origin/feat/*` bleiben auf dem alten Stand, bis entschieden ist, ob sie ersetzt werden.

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

**Alltag als App:** aus `wowy` ein DMG bauen. Am 10.10.2026 erstmals gebaut, rund fünf Minuten. Zuletzt am 25.10.2026 als `0.1.3-nightly.20261025.1`.

```sh
volta run --node 24.21.0 vp run dist:desktop:dmg:arm64 --build-version 0.0.46-nightly.JJJJMMTT.N
```

- Die Option heißt `--build-version`. `--version` gibt nur die Version des Skripts aus und baut nichts.
- Eine Version nach dem Muster `-nightly.JJJJMMTT.N` ergibt die App „T3 Code (Nightly)". Sie liegt damit neben der Release-App „T3 Code (Alpha)" und ersetzt sie nicht. Ohne die Option hieße der Bau wie die Release-App.
- Ergebnis in `release/` (gitignored): DMG und ZIP, unsigniert, ohne `app-update.yml`. Der Eigenbau hat keinen Update-Feed, Upstream überschreibt ihn nicht. Neue Versionen kommen nur durch Nachziehen und Neubauen.
- Beim Neubau `N` oder das Datum hochzählen, die App in `/Applications` ersetzen.
- Umgebungsvariablen liest die Desktop-App aus dem Shell-Profil. Für die Heartbeats `export T3CODE_WAKATIME_ENABLED=true` in `~/.zshrc`.
- **T3 Connect braucht `.env` beim Bau.** Ohne `cp .env.example .env` fehlen dem Bau die öffentlichen Clerk- und Relay-Kennungen, die App zeigt dann kein „Sign in to T3 Connect“ (so beim Bau vom 15.10.2026). `.env` ist gitignored und enthält keine Geheimnisse.
- Seit Upstream 0.1.x Versionen nach dem Muster `0.1.3-nightly.JJJJMMTT.N` wählen. App und Server müssen dieselbe Protokoll-Linie haben, sonst verweigern sie die Verbindung (Mac mini läuft mit `t3` 0.1.2, die iPhone-App 2.1.0 gehört zur selben Linie).

Der Eigenbau hat dieselbe App-ID wie die Release-App (`com.t3tools.t3code`) und nutzt denselben Datenordner `~/.t3/userdata`. Beim ersten Start kopiert er `state.sqlite` einmalig nach `statev2.sqlite` und arbeitet auf der Kopie, die Release-App 0.0.45 bleibt auf dem Original. Threads laufen danach auseinander, Einstellungen und Anhänge bleiben gemeinsam (Upstream: `docs/user/thread-migration.md`). Vor dem ersten Start sichern:

```sh
cp -Rp ~/.t3/userdata ~/.t3/backups/userdata-JJJJ-MM-TT
sqlite3 "file:$HOME/.t3/userdata/state.sqlite?mode=ro" ".backup '$HOME/.t3/backups/userdata-JJJJ-MM-TT/state.sqlite'"
```

Die zweite Zeile ersetzt die mitkopierte Datenbank durch einen konsistenten Stand, falls die App beim Kopieren lief. Sicherung vom 10.10.2026: `~/.t3/backups/userdata-2026-10-10-vor-nightly`.

## Nie

- Einen Server gegen `~/.t3/userdata` starten oder den Ordner aufräumen.
- Prozesse nach Namen oder Pfad beenden. Nur die PID, die beim Start gemerkt wurde.
- `VITE_HTTP_URL` oder `VITE_WS_URL` für den Dev-Lauf setzen.
