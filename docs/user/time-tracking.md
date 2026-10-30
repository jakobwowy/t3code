# Time tracking with WakaTime

The T3 Code server can report the thread you are looking at to [WakaTime](https://wakatime.com) or
any server that speaks its API. Time lands on the thread's project and branch, so work you direct
through agents shows up next to the time your editor already tracks.

It is off by default. To turn it on, set `T3CODE_WAKATIME_ENABLED=true` in the server's environment
before starting it. The desktop app reads the variable from your shell profile (for example
`~/.zshrc`) on macOS and Linux, so export it there and restart the app. On Windows, set it as a
user environment variable.

The server reads `api_key` and `api_url` from the `[settings]` section of `~/.wakatime.cfg`, the
file every WakaTime plugin shares. `WAKATIME_API_KEY` overrides the key and `WAKATIME_HOME` moves
the file. Without `api_url`, heartbeats go to wakatime.com.

## What counts

A thread counts while a T3 Code window or the mobile app shows it and you are there: the client is
visible and focused or recently used, and the host is not locked or asleep. Reading or dictating
without touching the keyboard or mouse still counts, up to 15 minutes without any input on the
host. Using a client, such as the mobile app, counts regardless of the host. The server sends a
heartbeat when you open or return to a thread, and again every two minutes while you stay. A thread
whose agent keeps working after you leave does not count.

Each environment reports for itself, so the machine running the server needs the WakaTime config.

## What is sent

A heartbeat carries the project folder name, the branch, and the thread id. A thread in a worktree
reports the main repository's folder, so its time lands on the same project. Prompts, responses,
thread titles, and file contents are never sent.

`hide_project_names` and `hide_branch_names` in the WakaTime config leave those names out. T3 Code
treats any value other than `false` as hide-all and does not match pattern lists.
