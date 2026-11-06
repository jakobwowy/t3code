import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopShellEnvironment from "../shell/DesktopShellEnvironment.ts";
import * as DesktopWakaTime from "./DesktopWakaTime.ts";

const WINDOW = 1;
const OTHER_WINDOW = 2;
const THREAD = { id: "thread-1", workspaceRoot: "/code/my-repo", branch: "feature/heartbeats" };
const OTHER_THREAD = { id: "thread-2", workspaceRoot: "/code/other-repo", branch: null };

const SentHeartbeats = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      entity: Schema.String,
      type: Schema.String,
      category: Schema.String,
      time: Schema.Number,
      project: Schema.optional(Schema.String),
      branch: Schema.optional(Schema.String),
    }),
  ),
);

const decodeSentHeartbeats = Schema.decodeEffect(SentHeartbeats);

interface SentRequest {
  readonly url: string;
  readonly authorization: string | undefined;
  readonly heartbeats: typeof SentHeartbeats.Type;
}

/**
 * Starts the service against a WakaTime config in a temp home. Every request it
 * sends lands in `requests`; `focused` and `idleState` stand in for the machine.
 * With `processEnv`, the switch and home come from `process.env` instead.
 */
const start = Effect.fn("DesktopWakaTime.test.start")(function* (
  options: {
    readonly enabled?: boolean;
    readonly settings?: string;
    readonly failedSends?: number;
    readonly rejectedSends?: number;
    readonly processEnv?: boolean;
    readonly awaitDiscovery?: Effect.Effect<boolean>;
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-wakatime-test-" });
  yield* fileSystem.writeFileString(
    path.join(home, ".wakatime.cfg"),
    options.settings ?? "[settings]\napi_url = http://waka.test/api/v1\napi_key = test-key\n",
  );

  const requests = yield* Queue.unbounded<SentRequest>();
  let failedSends = options.failedSends ?? 0;
  let rejectedSends = options.rejectedSends ?? 0;
  const machine = {
    focused: Option.some(WINDOW) as Option.Option<number>,
    idleState: "active" as ElectronPowerMonitor.ElectronIdleState,
  };

  const service = yield* Layer.build(
    Layer.effect(
      DesktopWakaTime.DesktopWakaTime,
      DesktopWakaTime.make({
        focusedWebContentsId: Effect.sync(() => machine.focused),
        ...(options.processEnv
          ? {}
          : {
              configProvider: ConfigProvider.fromUnknown({
                T3CODE_WAKATIME_ENABLED: options.enabled ?? true,
                WAKATIME_HOME: home,
              }),
            }),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ElectronPowerMonitor.ElectronPowerMonitor)({
            getSystemIdleState: () => Effect.sync(() => machine.idleState),
          }),
          Layer.mock(ElectronApp.ElectronApp)({ on: () => Effect.void }),
          Layer.mock(DesktopShellEnvironment.DesktopShellEnvironment)({
            awaitDiscovery: options.awaitDiscovery ?? Effect.succeed(true),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                const heartbeats =
                  request.body._tag === "Uint8Array"
                    ? yield* decodeSentHeartbeats(new TextDecoder().decode(request.body.body)).pipe(
                        Effect.orDie,
                      )
                    : [];
                yield* Queue.offer(requests, {
                  url: request.url,
                  authorization: request.headers["authorization"],
                  heartbeats,
                });
                if (failedSends > 0) {
                  failedSends -= 1;
                  return yield* new HttpClientError.HttpClientError({
                    reason: new HttpClientError.TransportError({
                      request,
                      cause: "connection reset",
                    }),
                  });
                }
                const status = rejectedSends > 0 ? 400 : 202;
                if (rejectedSends > 0) rejectedSends -= 1;
                return HttpClientResponse.fromWeb(request, new Response(null, { status }));
              }),
            ),
          ),
        ),
      ),
    ),
  );
  const wakaTime = Context.get(service, DesktopWakaTime.DesktopWakaTime);

  return {
    home,
    machine,
    show: (work: DesktopWakaTime.DisplayedWork | null, window = WINDOW) =>
      wakaTime.setDisplayed(window, work),
    nextRequest: Queue.take(requests),
    sentCount: Queue.size(requests),
  };
});

it("parseWakaTimeSettings reads only the settings section", () => {
  const settings = DesktopWakaTime.parseWakaTimeSettings(
    [
      "# comment",
      "[other]",
      "api_key = wrong",
      "[settings]",
      "api_url = https://example.test/api/v1/",
      "api_key = secret",
      "hide_branch_names = true",
      "hide_project_names = false",
    ].join("\n"),
  );
  assert.deepEqual(settings, {
    apiUrl: "https://example.test/api/v1",
    apiKey: "secret",
    hideProjectNames: false,
    hideBranchNames: true,
  });
});

it("parseWakaTimeSettings falls back to wakatime.com without a key", () => {
  assert.deepEqual(DesktopWakaTime.parseWakaTimeSettings(""), {
    apiUrl: "https://api.wakatime.com/api/v1",
    apiKey: undefined,
    hideProjectNames: false,
    hideBranchNames: false,
  });
});

describe("DesktopWakaTime", () => {
  it.layer(NodeServices.layer)((it) => {
    it.effect("sends a heartbeat when the focused window shows a thread", () =>
      Effect.gen(function* () {
        const service = yield* start();
        yield* service.show(THREAD);

        const request = yield* service.nextRequest;
        assert.equal(request.url, "http://waka.test/api/v1/users/current/heartbeats.bulk");
        assert.equal(request.authorization, `Basic ${btoa("test-key")}`);
        assert.deepEqual(
          request.heartbeats.map(({ time: _time, ...heartbeat }) => heartbeat),
          [
            {
              entity: "T3 Code thread-1",
              type: "app",
              category: "ai coding",
              project: "my-repo",
              branch: "feature/heartbeats",
            },
          ],
        );
      }),
    );

    it.effect("names the project after the last folder of a Windows workspace", () =>
      Effect.gen(function* () {
        const service = yield* start();
        yield* service.show({ ...OTHER_THREAD, workspaceRoot: "C:\\code\\win-repo\\" });

        const request = yield* service.nextRequest;
        assert.equal(request.heartbeats[0]?.project, "win-repo");
        assert.isUndefined(request.heartbeats[0]?.branch);
      }),
    );

    it.effect("repeats every two minutes while the thread stays shown", () =>
      Effect.gen(function* () {
        const service = yield* start();
        yield* service.show(THREAD);
        yield* service.nextRequest;

        yield* TestClock.adjust("110 seconds");
        assert.equal(yield* service.sentCount, 0);

        yield* TestClock.adjust("10 seconds");
        const repeated = yield* service.nextRequest;
        assert.equal(repeated.heartbeats[0]?.entity, "T3 Code thread-1");
      }),
    );

    it.effect("switching threads sends at once, and clearing stops", () =>
      Effect.gen(function* () {
        const service = yield* start();
        yield* service.show(THREAD);
        yield* service.nextRequest;

        yield* TestClock.adjust("30 seconds");
        yield* service.show(OTHER_THREAD);
        const switched = yield* service.nextRequest;
        assert.equal(switched.heartbeats[0]?.entity, "T3 Code thread-2");

        yield* service.show(null);
        yield* TestClock.adjust("10 minutes");
        assert.equal(yield* service.sentCount, 0);
      }),
    );

    it.effect("counts only the focused window, while someone is at the machine", () =>
      Effect.gen(function* () {
        const service = yield* start();
        yield* service.show(OTHER_THREAD, OTHER_WINDOW);
        service.machine.focused = Option.none();
        yield* service.show(THREAD);
        service.machine.focused = Option.some(WINDOW);
        service.machine.idleState = "locked";
        yield* TestClock.adjust("1 minute");
        service.machine.idleState = "idle";
        yield* TestClock.adjust("1 minute");
        assert.equal(yield* service.sentCount, 0);

        service.machine.idleState = "active";
        yield* TestClock.adjust("10 seconds");
        const request = yield* service.nextRequest;
        assert.equal(request.heartbeats[0]?.entity, "T3 Code thread-1");
      }),
    );

    it.effect("sends a failed heartbeat again with the retry", () =>
      Effect.gen(function* () {
        const service = yield* start({ failedSends: 1 });
        yield* service.show(THREAD);
        const failed = yield* service.nextRequest;

        yield* TestClock.adjust("30 seconds");
        const retried = yield* service.nextRequest;
        assert.deepEqual(retried.heartbeats, failed.heartbeats);
      }),
    );

    it.effect("drops a batch the server rejects", () =>
      Effect.gen(function* () {
        const service = yield* start({ rejectedSends: 1 });
        yield* service.show(THREAD);
        yield* service.nextRequest;

        yield* TestClock.adjust("30 seconds");
        assert.equal(yield* service.sentCount, 0);

        yield* TestClock.adjust("90 seconds");
        const next = yield* service.nextRequest;
        assert.equal(next.heartbeats.length, 1);
      }),
    );

    it.effect("leaves out names the WakaTime config hides", () =>
      Effect.gen(function* () {
        const service = yield* start({
          settings:
            "[settings]\napi_key = test-key\nhide_project_names = true\nhide_branch_names = true\n",
        });
        yield* service.show(THREAD);

        const request = yield* service.nextRequest;
        assert.equal(request.url, "https://api.wakatime.com/api/v1/users/current/heartbeats.bulk");
        assert.deepEqual(Object.keys(request.heartbeats[0] ?? {}).toSorted(), [
          "category",
          "entity",
          "time",
          "type",
        ]);
      }),
    );

    it.effect("reads the switch the shell environment adds after startup", () =>
      Effect.gen(function* () {
        const names = ["T3CODE_WAKATIME_ENABLED", "WAKATIME_HOME"] as const;
        yield* Effect.acquireRelease(
          Effect.sync(() => {
            const saved = names.map((name) => [name, process.env[name]] as const);
            for (const name of names) delete process.env[name];
            return saved;
          }),
          (saved) =>
            Effect.sync(() => {
              for (const [name, value] of saved) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
              }
            }),
        );
        const discovered = yield* Deferred.make<boolean>();
        const service = yield* start({
          processEnv: true,
          awaitDiscovery: Deferred.await(discovered),
        });

        process.env.T3CODE_WAKATIME_ENABLED = "true";
        process.env.WAKATIME_HOME = service.home;
        yield* Deferred.succeed(discovered, true);
        yield* service.show(THREAD);

        const request = yield* service.nextRequest;
        assert.equal(request.heartbeats[0]?.entity, "T3 Code thread-1");
      }),
    );

    it.effect("does nothing unless enabled", () =>
      Effect.gen(function* () {
        const service = yield* start({ enabled: false });
        yield* service.show(THREAD);
        yield* TestClock.adjust("5 minutes");
        assert.equal(yield* service.sentCount, 0);
      }),
    );
  });
});
