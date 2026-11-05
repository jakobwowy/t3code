# Time tracking with WakaTime

The desktop app can report the thread you are looking at to [WakaTime](https://wakatime.com) or any
server that speaks its API. Time lands on the thread's project and branch, so work you direct
through agents shows up next to the time your editor already tracks. It works for threads on every
environment you connect to, local or remote.

It is off by default. To turn it on, set `T3CODE_WAKATIME_ENABLED=true` in your shell profile (for
example `~/.zshrc`) on macOS and Linux and restart the app. On Windows, set it as a user
environment variable.

The app reads `api_key` and `api_url` from the `[settings]` section of `~/.wakatime.cfg`, the file
every WakaTime plugin shares. `WAKATIME_API_KEY` overrides the key and `WAKATIME_HOME` moves the
file. Without `api_url`, heartbeats go to wakatime.com.

## What counts

A thread counts while it is open in the focused T3 Code window and you are at the machine: the
screen is not locked and there was input within the last 15 minutes. Reading or dictating without
touching the keyboard or mouse still counts until then. Writing the first prompt of a new thread
counts on its project. The app sends a heartbeat when you open a thread and every two minutes while
you stay. A thread whose agent keeps working after you leave does not count.

The web app and the mobile app do not send heartbeats.

## What is sent

A heartbeat carries the project folder name, the branch, and the thread id, or the project id while
you write a new thread's first prompt. A thread in a worktree reports the main repository's folder,
so its time lands on the same project. Prompts, responses, thread titles, and file contents are
never sent.

`hide_project_names` and `hide_branch_names` in the WakaTime config leave those names out. T3 Code
treats any value other than `false` as hide-all and does not match pattern lists.
