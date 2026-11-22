import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopWakaTime from "../../app/DesktopWakaTime.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const setDisplayed = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.TIME_TRACKING_DISPLAYED_CHANNEL,
  payload: Schema.NullOr(DesktopWakaTime.DisplayedWork),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.timeTracking.setDisplayed")(function* (work, event) {
    if (event === undefined) return;
    const wakaTime = yield* DesktopWakaTime.DesktopWakaTime;
    yield* wakaTime.setDisplayed(event.sender.id, work);
  }),
});
