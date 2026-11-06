/**
 * WakaTime heartbeats for the thread or draft the focused window shows, on any
 * environment. Off unless `T3CODE_WAKATIME_ENABLED` is set; key and endpoint come
 * from the WakaTime config. Heartbeats carry project folder, branch and thread id,
 * never prompts or file contents.
 */
import * as NodeOS from "node:os";

import * as Electron from "electron";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
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
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import packageJson from "../../package.json" with { type: "json" };
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";

const DEFAULT_API_URL = "https://api.wakatime.com/api/v1";
// WakaTime counts a heartbeat for at most two minutes.
const HEARTBEAT_INTERVAL_MS = 120_000;
// Reading or dictating produces no input but is work, so a short idle still counts.
const HOST_IDLE_CUTOFF_SECONDS = 15 * 60;
const TICK_INTERVAL = "10 seconds";
const RETRY_INTERVAL = "30 seconds";
const SEND_TIMEOUT = "10 seconds";
// The bulk endpoint accepts at most 25 heartbeats per request.
const MAX_HEARTBEATS_PER_REQUEST = 25;
const MAX_PENDING_HEARTBEATS = 500;

/** What a window displays: a thread, or a draft by its project's id. */
export const DisplayedWork = Schema.Struct({
  id: Schema.String.check(Schema.isMaxLength(256)),
  workspaceRoot: Schema.String.check(Schema.isMaxLength(4096)),
  branch: Schema.NullOr(Schema.String.check(Schema.isMaxLength(512))),
});
export type DisplayedWork = typeof DisplayedWork.Type;

interface Heartbeat {
  readonly entity: string;
  readonly type: "app";
  readonly category: "ai coding";
  readonly time: number;
  readonly project?: string;
  readonly branch?: string;
}

export class DesktopWakaTime extends Context.Service<
  DesktopWakaTime,
  {
    readonly setDisplayed: (
      webContentsId: number,
      work: DisplayedWork | null,
    ) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopWakaTime") {}

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

// The workspace may live on another machine, so either separator can occur.
const folderName = (workspaceRoot: string) =>
  workspaceRoot.split(/[\\/]+/).findLast((part) => part.length > 0);

const WakaTimeEnvConfig = Config.all({
  enabled: Config.Boolean("T3CODE_WAKATIME_ENABLED").pipe(Config.withDefault(false)),
  wakaTimeHome: Config.String("WAKATIME_HOME").pipe(Config.option),
  apiKey: Config.Redacted("WAKATIME_API_KEY").pipe(Config.option),
});

export const make = Effect.fn("DesktopWakaTime.make")(function* (options: {
  /** The webContents of the focused window, if a window has focus. */
  readonly focusedWebContentsId: Effect.Effect<Option.Option<number>>;
  /** Defaults to `process.env` as it stands once the shell environment is discovered. */
  readonly configProvider?: ConfigProvider.ConfigProvider;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const httpClient = yield* HttpClient.HttpClient;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const electronApp = yield* ElectronApp.ElectronApp;
  const shellEnvironment = yield* DesktopShellEnvironment.DesktopShellEnvironment;
  const hostPlatform = yield* HostProcess.Platform;
  const hostArchitecture = yield* HostProcess.Architecture;

  const displayedBySender = new Map<number, DisplayedWork>();
  const lastSentRef = yield* Ref.make<{ readonly entity: string; readonly at: number } | null>(
    null,
  );
  const pendingRef = yield* Ref.make<ReadonlyArray<Heartbeat>>([]);
  // A tick and the retry loop must not send the same batch at once.
  const flushLock = yield* Semaphore.make(1);
  const userAgent = `t3code/${packageJson.version} (${hostPlatform}-${hostArchitecture}) t3code-wakatime/${packageJson.version}`;

  // The shell profile that holds the switch is read in the background after startup.
  const loadTarget = yield* Effect.cached(
    Effect.gen(function* () {
      yield* shellEnvironment.awaitDiscovery;
      // Not the ambient provider: Effect's default copies process.env before discovery fills it.
      const env = yield* WakaTimeEnvConfig.parse(
        options.configProvider ?? ConfigProvider.fromEnv(),
      );
      if (!env.enabled) return Option.none();
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
        return Option.none();
      }
      return Option.some({
        settings,
        bulkUrl: `${settings.apiUrl}/users/current/heartbeats.bulk`,
        authorization: `Basic ${Base64.encode(Redacted.value(apiKey.value))}`,
      });
    }).pipe(Effect.orElseSucceed(() => Option.none())),
  );

  const send = (
    target: { readonly bulkUrl: string; readonly authorization: string },
    heartbeats: ReadonlyArray<Heartbeat>,
  ) =>
    HttpClientRequest.post(target.bulkUrl).pipe(
      HttpClientRequest.setHeader("Authorization", target.authorization),
      HttpClientRequest.setHeader("User-Agent", userAgent),
      HttpClientRequest.bodyJson(heartbeats),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.timeout(SEND_TIMEOUT),
    );

  // Sends until nothing is pending or a send fails. A failed batch goes back to
  // the front and waits for the next heartbeat or the retry loop.
  const flush = Effect.gen(function* () {
    const target = yield* loadTarget;
    if (Option.isNone(target)) return;
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
      const sent = yield* Effect.result(send(target.value, batch));
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

  // What the focused window shows while someone is at this machine.
  const presentWork = Effect.gen(function* () {
    const focused = yield* options.focusedWebContentsId;
    if (Option.isNone(focused)) return Option.none();
    const work = displayedBySender.get(focused.value);
    if (work === undefined) return Option.none();
    const idleState = yield* powerMonitor.getSystemIdleState(HOST_IDLE_CUTOFF_SECONDS);
    return idleState === "idle" || idleState === "locked" ? Option.none() : Option.some(work);
  });

  // Sends when the displayed work changes, and every two minutes while it stays.
  const tick = Effect.gen(function* () {
    const target = yield* loadTarget;
    if (Option.isNone(target)) return;
    const work = yield* presentWork;
    if (Option.isNone(work)) return;
    const { id, workspaceRoot, branch } = work.value;
    const entity = `T3 Code ${id}`;
    const now = yield* Clock.currentTimeMillis;
    const lastSent = yield* Ref.get(lastSentRef);
    if (lastSent?.entity === entity && now - lastSent.at < HEARTBEAT_INTERVAL_MS) return;
    yield* Ref.set(lastSentRef, { entity, at: now });
    const project = folderName(workspaceRoot);
    const { hideProjectNames, hideBranchNames } = target.value.settings;
    const heartbeat: Heartbeat = {
      entity,
      type: "app",
      category: "ai coding",
      time: now / 1000,
      ...(project === undefined || hideProjectNames ? {} : { project }),
      ...(branch === null || hideBranchNames ? {} : { branch }),
    };
    yield* Ref.update(pendingRef, (pending) =>
      [...pending, heartbeat].slice(-MAX_PENDING_HEARTBEATS),
    );
    yield* flush;
  }).pipe(Effect.withSpan("DesktopWakaTime.tick"));

  yield* tick.pipe(Effect.repeat(Schedule.spaced(TICK_INTERVAL)), Effect.forkScoped);
  yield* flush.pipe(Effect.repeat(Schedule.spaced(RETRY_INTERVAL)), Effect.forkScoped);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  yield* electronApp.on("browser-window-focus", () => void runFork(tick));

  return DesktopWakaTime.of({
    setDisplayed: Effect.fn("DesktopWakaTime.setDisplayed")(function* (webContentsId, work) {
      if (work === null) displayedBySender.delete(webContentsId);
      else displayedBySender.set(webContentsId, work);
      yield* tick;
    }),
  });
});

export const layer = Layer.effect(
  DesktopWakaTime,
  make({
    focusedWebContentsId: Effect.sync(() =>
      Option.fromNullishOr(Electron.BrowserWindow.getFocusedWindow()?.webContents.id),
    ),
  }),
);
