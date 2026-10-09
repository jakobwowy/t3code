import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AuthSessionId,
  type BackgroundPolicySnapshot,
  type ClientActivityLease,
  type HostPowerSnapshot,
  type OrchestrationV2ThreadShell,
  ProjectId,
  RpcClientId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
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
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as WakaTimeHeartbeats from "./WakaTimeHeartbeats.ts";

const NOW = DateTime.makeUnsafe("2026-10-09T12:00:00.000Z");
const PROJECT_ID = ProjectId.make("project-1");
const MAIN_CHECKOUT_THREAD = ThreadId.make("thread-main");
const WORKTREE_THREAD = ThreadId.make("thread-worktree");

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

function secondsBetween(earlier: SentRequest, later: SentRequest): number {
  return (later.heartbeats[0]?.time ?? Number.NaN) - (earlier.heartbeats[0]?.time ?? Number.NaN);
}

const presentHost: HostPowerSnapshot = {
  source: "electron-main",
  idle: "false",
  idleSeconds: 0,
  locked: "false",
  suspended: false,
  onBattery: "false",
  lowPowerMode: "false",
  thermalState: "nominal",
  stale: false,
  updatedAt: NOW,
};

function displaying(
  threadId: ThreadId,
  overrides: Partial<ClientActivityLease> = {},
): ClientActivityLease {
  return {
    sessionId: AuthSessionId.make("session-1"),
    rpcClientId: RpcClientId.make(1),
    clientId: "client-1",
    clientKind: "desktop-renderer",
    visible: true,
    focused: true,
    recentlyInteracted: true,
    scopes: [{ type: "thread", threadId }],
    updatedAt: NOW,
    expiresAt: DateTime.add(NOW, { seconds: 45 }),
    ...overrides,
  };
}

function snapshotOf(
  leases: ReadonlyArray<ClientActivityLease>,
  hostPower: HostPowerSnapshot = presentHost,
): BackgroundPolicySnapshot {
  return {
    hostPower,
    leases,
    activeForegroundLeaseCount: leases.length,
    activeScopeKeys: [],
    shouldRunOpportunisticWork: true,
    updatedAt: NOW,
  };
}

/**
 * Starts the service against a WakaTime config in a temp home. Push snapshots
 * to drive it; every request it sends lands in `requests`.
 */
const start = Effect.fn("WakaTimeHeartbeats.test.start")(function* (
  options: {
    readonly enabled?: boolean;
    readonly settings?: string;
    readonly failedSends?: number;
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-wakatime-test-" });
  yield* fileSystem.writeFileString(
    path.join(home, ".wakatime.cfg"),
    options.settings ?? "[settings]\napi_url = http://waka.test/api/v1\napi_key = test-key\n",
  );

  const snapshots = yield* Queue.unbounded<BackgroundPolicySnapshot>();
  const requests = yield* Queue.unbounded<SentRequest>();
  let failedSends = options.failedSends ?? 0;

  const layerDependencies = Layer.mergeAll(
    Layer.mock(BackgroundPolicy.BackgroundPolicy)({
      subscribe: Effect.succeed({
        latest: snapshotOf([]),
        changes: Stream.fromQueue(snapshots),
      }),
    }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadShell: (threadId) =>
        Effect.succeed(
          threadId === WORKTREE_THREAD
            ? ({
                id: threadId,
                projectId: PROJECT_ID,
                branch: "feature/heartbeats",
                worktreePath: "/worktrees/heartbeats",
              } as OrchestrationV2ThreadShell)
            : threadId === MAIN_CHECKOUT_THREAD
              ? ({
                  id: threadId,
                  projectId: PROJECT_ID,
                  branch: null,
                  worktreePath: null,
                } as OrchestrationV2ThreadShell)
              : null,
        ),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () =>
        Effect.succeed(
          Option.some({
            projectId: PROJECT_ID,
            workspaceRoot: "/code/my-repo",
          } as ProjectStore.ProjectRow),
        ),
    }),
    Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
      refreshLocalStatus: () =>
        Effect.succeed({
          isRepo: true,
          hasPrimaryRemote: true,
          isDefaultRef: true,
          refName: "main",
          hasWorkingTreeChanges: false,
          workingTree: { files: [], insertions: 0, deletions: 0 },
        }),
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
              reason: new HttpClientError.TransportError({ request, cause: "connection reset" }),
            });
          }
          return HttpClientResponse.fromWeb(request, new Response(null, { status: 202 }));
        }),
      ),
    ),
  );

  yield* Layer.build(
    WakaTimeHeartbeats.layer.pipe(
      Layer.provide(layerDependencies),
      Layer.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({
            T3CODE_WAKATIME_ENABLED: options.enabled ?? true,
            WAKATIME_HOME: home,
          }),
        ),
      ),
    ),
  );

  return {
    display: (...threadIds: ReadonlyArray<ThreadId>) =>
      Queue.offer(snapshots, snapshotOf(threadIds.map((threadId) => displaying(threadId)))),
    push: (snapshot: BackgroundPolicySnapshot) => Queue.offer(snapshots, snapshot),
    nextRequest: Queue.take(requests),
    sentCount: Queue.size(requests),
  };
});

it("parseWakaTimeSettings reads only the settings section", () => {
  const settings = WakaTimeHeartbeats.parseWakaTimeSettings(
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
  assert.deepEqual(WakaTimeHeartbeats.parseWakaTimeSettings(""), {
    apiUrl: "https://api.wakatime.com/api/v1",
    apiKey: undefined,
    hideProjectNames: false,
    hideBranchNames: false,
  });
});

it.layer(NodeServices.layer)("WakaTimeHeartbeats", (it) => {
  it.effect("sends a heartbeat when a displayed thread enters the foreground", () =>
    Effect.gen(function* () {
      const service = yield* start();
      yield* service.display(WORKTREE_THREAD);

      const request = yield* service.nextRequest;
      assert.equal(request.url, "http://waka.test/api/v1/users/current/heartbeats.bulk");
      assert.equal(request.authorization, `Basic ${btoa("test-key")}`);
      assert.deepEqual(
        request.heartbeats.map(({ time: _time, ...heartbeat }) => heartbeat),
        [
          {
            entity: `T3 Code ${WORKTREE_THREAD}`,
            type: "app",
            category: "ai coding",
            // The main repository's folder, not the worktree's.
            project: "my-repo",
            branch: "feature/heartbeats",
          },
        ],
      );
    }),
  );

  it.effect("uses the checkout's current ref for a thread without its own branch", () =>
    Effect.gen(function* () {
      const service = yield* start();
      yield* service.display(MAIN_CHECKOUT_THREAD);

      const request = yield* service.nextRequest;
      assert.equal(request.heartbeats[0]?.project, "my-repo");
      assert.equal(request.heartbeats[0]?.branch, "main");
    }),
  );

  it.effect("repeats every two minutes while the thread stays displayed", () =>
    Effect.gen(function* () {
      const service = yield* start();
      yield* service.display(WORKTREE_THREAD);
      const first = yield* service.nextRequest;

      // More snapshots of the same state do not add heartbeats.
      yield* service.display(WORKTREE_THREAD);
      yield* TestClock.adjust("119 seconds");
      assert.equal(yield* service.sentCount, 0);

      yield* TestClock.adjust("1 second");
      const repeated = yield* service.nextRequest;
      assert.equal(secondsBetween(first, repeated), 120);
    }),
  );

  it.effect("switching threads sends at once and stops the previous thread", () =>
    Effect.gen(function* () {
      const service = yield* start();
      yield* service.display(WORKTREE_THREAD);
      const first = yield* service.nextRequest;

      yield* TestClock.adjust("30 seconds");
      yield* service.display(MAIN_CHECKOUT_THREAD);
      const switched = yield* service.nextRequest;
      assert.equal(switched.heartbeats[0]?.entity, `T3 Code ${MAIN_CHECKOUT_THREAD}`);
      assert.equal(secondsBetween(first, switched), 30);

      yield* TestClock.adjust("2 minutes");
      const repeated = yield* service.nextRequest;
      assert.equal(repeated.heartbeats[0]?.entity, `T3 Code ${MAIN_CHECKOUT_THREAD}`);
      assert.equal(yield* service.sentCount, 0);
    }),
  );

  it.effect("returning to a thread sends again without waiting", () =>
    Effect.gen(function* () {
      const service = yield* start();
      yield* service.display(WORKTREE_THREAD);
      yield* service.nextRequest;
      yield* service.display(MAIN_CHECKOUT_THREAD);
      const away = yield* service.nextRequest;

      yield* TestClock.adjust("10 seconds");
      yield* service.display(WORKTREE_THREAD);
      const returned = yield* service.nextRequest;
      assert.equal(returned.heartbeats[0]?.entity, `T3 Code ${WORKTREE_THREAD}`);
      assert.equal(secondsBetween(away, returned), 10);
    }),
  );

  it.effect("stays quiet while nobody is looking", () =>
    Effect.gen(function* () {
      const service = yield* start();
      yield* service.push(
        snapshotOf([displaying(WORKTREE_THREAD, { focused: false, recentlyInteracted: false })]),
      );
      yield* service.push(snapshotOf([displaying(WORKTREE_THREAD, { visible: false })]));
      yield* service.push(
        snapshotOf([displaying(WORKTREE_THREAD)], { ...presentHost, locked: "true" }),
      );
      yield* service.push(
        snapshotOf([displaying(WORKTREE_THREAD)], { ...presentHost, idle: "true" }),
      );
      yield* service.display(MAIN_CHECKOUT_THREAD);

      // The first request is for the thread someone finally looked at.
      const request = yield* service.nextRequest;
      assert.equal(request.heartbeats[0]?.entity, `T3 Code ${MAIN_CHECKOUT_THREAD}`);
    }),
  );

  it.effect("sends a failed heartbeat again with the retry", () =>
    Effect.gen(function* () {
      const service = yield* start({ failedSends: 1 });
      yield* service.display(WORKTREE_THREAD);
      const failed = yield* service.nextRequest;

      yield* TestClock.adjust("30 seconds");
      const retried = yield* service.nextRequest;
      assert.deepEqual(retried.heartbeats, failed.heartbeats);
    }),
  );

  it.effect("leaves out names the WakaTime config hides", () =>
    Effect.gen(function* () {
      const service = yield* start({
        settings:
          "[settings]\napi_key = test-key\nhide_project_names = true\nhide_branch_names = true\n",
      });
      yield* service.display(WORKTREE_THREAD);

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

  it.effect("does nothing unless enabled", () =>
    Effect.gen(function* () {
      const service = yield* start({ enabled: false });
      yield* service.display(WORKTREE_THREAD);
      yield* TestClock.adjust("5 minutes");
      assert.equal(yield* service.sentCount, 0);
    }),
  );
});
