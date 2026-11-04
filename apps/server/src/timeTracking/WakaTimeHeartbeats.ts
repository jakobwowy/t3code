/**
 * WakaTime heartbeats for the thread or draft a foreground client displays. Off unless
 * `T3CODE_WAKATIME_ENABLED` is set; key and endpoint come from the WakaTime config.
 * Heartbeats carry project folder, branch and thread id, never prompts or file contents.
 */
import * as NodeOS from "node:os";

import type { BackgroundPolicySnapshot, BackgroundScope } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FiberMap from "effect/FiberMap";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
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

import packageJson from "../../package.json" with { type: "json" };
import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";

const DEFAULT_API_URL = "https://api.wakatime.com/api/v1";
// WakaTime counts a heartbeat for at most two minutes.
const HEARTBEAT_INTERVAL = "2 minutes";
const HOST_IDLE_CUTOFF_SECONDS = 15 * 60;
// The background policy publishes no changes, and a growing `idleSeconds` would not be one.
const RECONCILE_INTERVAL = "5 seconds";
const RETRY_INTERVAL = "30 seconds";
const SEND_TIMEOUT = "10 seconds";
// The bulk endpoint accepts at most 25 heartbeats per request.
const MAX_HEARTBEATS_PER_REQUEST = 25;
const MAX_PENDING_HEARTBEATS = 500;

type DisplayedScope = Extract<BackgroundScope, { readonly type: "thread" | "project" }>;

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
 * The host's last input is older than the cutoff. A sample can be one monitor
 * interval old, five minutes by default on an idle host, so its age counts too.
 */
function isHostIdlePastCutoff({ hostPower, updatedAt }: BackgroundPolicySnapshot): boolean {
  if (hostPower.stale || hostPower.idleSeconds === null) return false;
  const sampleAgeSeconds = Duration.toSeconds(DateTime.distance(hostPower.updatedAt, updatedAt));
  return hostPower.idleSeconds + sampleAgeSeconds > HOST_IDLE_CUTOFF_SECONDS;
}

/**
 * The server refused the batch itself, so sending it again cannot succeed and
 * would hold back every heartbeat queued behind it.
 */
function isRejected(error: unknown): boolean {
  if (!HttpClientError.isHttpClientError(error) || error.reason._tag !== "StatusCodeError") {
    return false;
  }
  const { status } = error.reason.response;
  return status >= 400 && status < 500 && status !== 408 && status !== 429;
}

/**
 * Threads and drafts a foreground client displays on an awake, unlocked host.
 * Reading or dictating produces no input but is work, so a short idle counts.
 * A client in use outranks the cutoff: a phone drives the host without input.
 */
function foregroundScopes(snapshot: BackgroundPolicySnapshot): ReadonlyMap<string, DisplayedScope> {
  const displayed = new Map<string, DisplayedScope>();
  const { hostPower } = snapshot;
  const hostAway = !hostPower.stale && (hostPower.suspended || hostPower.locked === "true");
  if (hostAway) return displayed;
  const hostIdle = isHostIdlePastCutoff(snapshot);
  for (const lease of snapshot.leases) {
    if (!BackgroundPolicy.isForegroundLease(lease, snapshot.updatedAt)) continue;
    if (hostIdle && !lease.recentlyInteracted) continue;
    for (const scope of lease.scopes) {
      if (scope.type === "thread") displayed.set(`thread:${scope.threadId}`, scope);
      if (scope.type === "project") displayed.set(`project:${scope.projectId}`, scope);
    }
  }
  return displayed;
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
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;
  const pendingRef = yield* Ref.make<ReadonlyArray<Heartbeat>>([]);
  // A displayed thread and the retry loop must not send the same batch at once.
  const flushLock = yield* Semaphore.make(1);
  const displayedFibers = yield* FiberMap.make<string>();

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
      if (isRejected(sent.failure)) {
        yield* Effect.logWarning("WakaTime rejected heartbeats; dropping them", {
          heartbeats: batch.length,
          cause: sent.failure,
        });
        continue;
      }
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
  // worktree, so time lands on one project. A thread in the main checkout, or a
  // draft, has no branch of its own; the checkout's current ref stands in.
  const describe = Effect.fn("WakaTimeHeartbeats.describe")(function* (displayed: DisplayedScope) {
    const thread =
      displayed.type === "thread"
        ? yield* projectionStore.getThreadShell(displayed.threadId)
        : null;
    const projectId = displayed.type === "project" ? displayed.projectId : thread?.projectId;
    if (projectId === undefined) return Option.none();
    const project = yield* projectStore.get(projectId);
    if (Option.isNone(project)) return Option.none();
    const { workspaceRoot } = project.value;
    const branch =
      thread?.branch ??
      (yield* vcsStatus.refreshLocalStatus(thread?.worktreePath ?? workspaceRoot).pipe(
        Effect.map((status) => status.refName),
        Effect.orElseSucceed(() => null),
      ));
    return Option.some({ project: path.basename(workspaceRoot), branch });
  });

  const record = Effect.fn("WakaTimeHeartbeats.record")(function* (displayed: DisplayedScope) {
    const described = yield* describe(displayed).pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isNone(described)) return;
    const { project, branch } = described.value;
    const heartbeat: Heartbeat = {
      entity: `T3 Code ${displayed.type === "thread" ? displayed.threadId : displayed.projectId}`,
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
    const displayed = foregroundScopes(snapshot);
    for (const [key] of Array.from(displayedFibers)) {
      if (!displayed.has(key)) {
        yield* FiberMap.remove(displayedFibers, key);
      }
    }
    for (const [key, scope] of displayed) {
      yield* FiberMap.run(
        displayedFibers,
        key,
        record(scope).pipe(Effect.andThen(Effect.sleep(HEARTBEAT_INTERVAL)), Effect.forever),
        { onlyIfMissing: true },
      );
    }
  });

  yield* backgroundPolicy.snapshot.pipe(
    Effect.flatMap(reconcile),
    Effect.repeat(Schedule.spaced(RECONCILE_INTERVAL)),
    Effect.forkScoped,
  );
  yield* flush.pipe(Effect.repeat(Schedule.spaced(RETRY_INTERVAL)), Effect.forkScoped);
});

export const layer = Layer.effectDiscard(make);
