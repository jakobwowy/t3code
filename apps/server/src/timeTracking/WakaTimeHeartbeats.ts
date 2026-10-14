/**
 * WakaTime heartbeats for the thread a foreground client is displaying.
 *
 * Off unless `T3CODE_WAKATIME_ENABLED` is set. `api_url` and `api_key` come
 * from the WakaTime config file, as with every other WakaTime plugin. A thread
 * gets a heartbeat when it enters the foreground and another every two minutes
 * while it stays there. A heartbeat carries the project folder name, the
 * branch, and the thread id; never prompts, titles, or file contents.
 *
 * @module WakaTimeHeartbeats
 */
import * as NodeOS from "node:os";

import type { BackgroundPolicySnapshot, ThreadId } from "@t3tools/contracts";
import { HostProcessArchitecture, HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import packageJson from "../../package.json" with { type: "json" };
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";

const DEFAULT_API_URL = "https://api.wakatime.com/api/v1";
// WakaTime counts a heartbeat for at most two minutes.
const HEARTBEAT_INTERVAL = "2 minutes";
const RETRY_INTERVAL = "30 seconds";
const SEND_TIMEOUT = "10 seconds";
// The bulk endpoint accepts at most 25 heartbeats per request.
const MAX_HEARTBEATS_PER_REQUEST = 25;
const MAX_PENDING_HEARTBEATS = 500;

interface Heartbeat {
  readonly entity: string;
  readonly type: "app";
  readonly category: "ai coding";
  readonly time: number;
  readonly project?: string;
  readonly branch?: string;
}

const WakaTimeEnvConfig = Config.all({
  enabled: Config.Boolean("T3CODE_WAKATIME_ENABLED").pipe(Config.withDefault(false)),
  wakaTimeHome: Config.String("WAKATIME_HOME").pipe(Config.option),
  apiKey: Config.Redacted("WAKATIME_API_KEY").pipe(Config.option),
});

/**
 * Reads the `[settings]` section of a WakaTime config file. A `hide_*` option
 * set to anything but `false` hides the value; pattern lists are not matched.
 */
export function parseWakaTimeSettings(text: string) {
  const values = new Map<string, string>();
  let inSettings = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      inSettings = line.toLowerCase() === "[settings]";
      continue;
    }
    if (!inSettings || line.startsWith("#") || line.startsWith(";")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    values.set(line.slice(0, separator).trim().toLowerCase(), line.slice(separator + 1).trim());
  }
  const isHidden = (key: string) => {
    const value = values.get(key);
    return value !== undefined && value !== "" && value.toLowerCase() !== "false";
  };
  return {
    apiUrl: (values.get("api_url") || DEFAULT_API_URL).replace(/\/+$/, ""),
    apiKey: values.get("api_key") || undefined,
    hideProjectNames: isHidden("hide_project_names"),
    hideBranchNames: isHidden("hide_branch_names"),
  };
}

/**
 * Threads a foreground client displays while the host is awake and unlocked.
 * Host idle does not count as away: reading output or dictating the next
 * prompt produces no input, but is still work.
 */
function foregroundThreadIds(snapshot: BackgroundPolicySnapshot): ReadonlySet<ThreadId> {
  const threadIds = new Set<ThreadId>();
  const { hostPower } = snapshot;
  const hostAway = !hostPower.stale && (hostPower.suspended || hostPower.locked === "true");
  if (hostAway) return threadIds;
  for (const lease of snapshot.leases) {
    if (!BackgroundPolicy.isForegroundLease(lease, snapshot.updatedAt)) continue;
    for (const scope of lease.scopes) {
      if (scope.type === "thread") threadIds.add(scope.threadId);
    }
  }
  return threadIds;
}

const make = Effect.gen(function* () {
  const env = yield* WakaTimeEnvConfig;
  if (!env.enabled) return;

  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configPath = path.join(
    Option.getOrElse(env.wakaTimeHome, () => NodeOS.homedir()),
    ".wakatime.cfg",
  );
  const settings = yield* fileSystem.readFileString(configPath).pipe(
    Effect.orElseSucceed(() => ""),
    Effect.map(parseWakaTimeSettings),
  );
  const apiKey = Option.orElse(env.apiKey, () =>
    Option.map(Option.fromUndefinedOr(settings.apiKey), Redacted.make),
  );
  if (Option.isNone(apiKey)) {
    yield* Effect.logWarning("WakaTime heartbeats are enabled, but no API key is configured");
    return;
  }

  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const httpClient = yield* HttpClient.HttpClient;
  const hostPlatform = yield* HostProcessPlatform;
  const hostArchitecture = yield* HostProcessArchitecture;
  const pendingRef = yield* Ref.make<ReadonlyArray<Heartbeat>>([]);
  // A displayed thread and the retry loop must not send the same batch at once.
  const flushLock = yield* Semaphore.make(1);
  const displayedThreads = yield* FiberMap.make<ThreadId>();

  const bulkUrl = `${settings.apiUrl}/users/current/heartbeats.bulk`;
  const authorization = `Basic ${Base64.encode(Redacted.value(apiKey.value))}`;
  const userAgent = `t3code/${packageJson.version} (${hostPlatform}-${hostArchitecture}) t3code-wakatime/${packageJson.version}`;

  const send = (heartbeats: ReadonlyArray<Heartbeat>) =>
    HttpClientRequest.post(bulkUrl).pipe(
      HttpClientRequest.setHeader("Authorization", authorization),
      HttpClientRequest.setHeader("User-Agent", userAgent),
      HttpClientRequest.bodyJson(heartbeats),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout(SEND_TIMEOUT),
    );

  // Sends until nothing is pending or a send fails. A failed batch goes back to
  // the front and waits for the next heartbeat or the retry loop.
  const flush = Effect.gen(function* () {
    while (true) {
      const batch = yield* Ref.modify(
        pendingRef,
        (pending) =>
          [
            pending.slice(0, MAX_HEARTBEATS_PER_REQUEST),
            pending.slice(MAX_HEARTBEATS_PER_REQUEST),
          ] as const,
      );
      if (batch.length === 0) return;
      const sent = yield* Effect.result(send(batch));
      if (Result.isSuccess(sent)) continue;
      yield* Ref.update(pendingRef, (pending) =>
        [...batch, ...pending].slice(-MAX_PENDING_HEARTBEATS),
      );
      yield* Effect.logDebug("Failed to send WakaTime heartbeats; will retry", {
        heartbeats: batch.length,
      });
      return;
    }
  }).pipe(flushLock.withPermit);

  // The project is the main repository's folder even when the thread runs in a
  // worktree, so time lands on one project. A thread in the main checkout has
  // no branch of its own; the checkout's current ref stands in.
  const describeThread = Effect.fn("WakaTimeHeartbeats.describeThread")(function* (
    threadId: ThreadId,
  ) {
    const thread = yield* projectionStore.getThreadShell(threadId);
    if (thread === null) return Option.none();
    const project = yield* projectStore.get(thread.projectId);
    if (Option.isNone(project)) return Option.none();
    const { workspaceRoot } = project.value;
    const branch =
      thread.branch ??
      (yield* vcsStatus.refreshLocalStatus(thread.worktreePath ?? workspaceRoot).pipe(
        Effect.map((status) => status.refName),
        Effect.orElseSucceed(() => null),
      ));
    return Option.some({ project: path.basename(workspaceRoot), branch });
  });

  const record = Effect.fn("WakaTimeHeartbeats.record")(function* (threadId: ThreadId) {
    const described = yield* describeThread(threadId).pipe(
      Effect.orElseSucceed(() => Option.none()),
    );
    if (Option.isNone(described)) return;
    const { project, branch } = described.value;
    const heartbeat: Heartbeat = {
      entity: `T3 Code ${threadId}`,
      type: "app",
      category: "ai coding",
      time: (yield* Clock.currentTimeMillis) / 1000,
      ...(settings.hideProjectNames ? {} : { project }),
      ...(branch === null || settings.hideBranchNames ? {} : { branch }),
    };
    yield* Ref.update(pendingRef, (pending) =>
      [...pending, heartbeat].slice(-MAX_PENDING_HEARTBEATS),
    );
    yield* flush;
  });

  const reconcile = Effect.fn("WakaTimeHeartbeats.reconcile")(function* (
    snapshot: BackgroundPolicySnapshot,
  ) {
    const displayed = foregroundThreadIds(snapshot);
    for (const [threadId] of Array.from(displayedThreads)) {
      if (!displayed.has(threadId)) {
        yield* FiberMap.remove(displayedThreads, threadId);
      }
    }
    for (const threadId of displayed) {
      yield* FiberMap.run(
        displayedThreads,
        threadId,
        record(threadId).pipe(Effect.andThen(Effect.sleep(HEARTBEAT_INTERVAL)), Effect.forever),
        { onlyIfMissing: true },
      );
    }
  });

  const { latest, changes } = yield* backgroundPolicy.subscribe;
  yield* reconcile(latest);
  yield* Stream.runForEach(changes, reconcile).pipe(Effect.forkScoped);
  yield* flush.pipe(Effect.repeat(Schedule.spaced(RETRY_INTERVAL)), Effect.forkScoped);
});

export const layer = Layer.effectDiscard(make);
