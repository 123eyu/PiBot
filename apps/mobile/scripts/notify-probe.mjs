// Started by `probe.mjs --notify` under tools/dev/ts-hooks.mjs. Joins the phone's
// notification logic with the desktop's real push sender and the relay's Expo ticket reader;
// only this dev probe imports both sides. No network: link and Expo are in-memory fakes.

import { RemoteNotifications } from "../../../packages/remote/src/brain/push/notifications.ts";
import { sendExpo } from "../../relay/src/push/expo.ts";
import { runNotifyScenario } from "../src/dev/notify-scenario.ts";

const DEVICE = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const TOKEN = "ExpoPushToken[probe-token]";
function desktopSide() {
  const secrets = new Map([
    [`remote-push:${DEVICE}/token`, JSON.stringify({ token: TOKEN, language: "zh" })],
    [`remote-device:${DEVICE}/room`, "probe-room-secret"],
  ]);
  const state = { pushReference: "remote-push" };
  const resources = {
    ctx: { logger: { warn() {}, info() {} }, db: { isTransaction: false, exec() {} } },
    secrets: {
      get: async (scope, name) => secrets.get(`${scope}/${name}`) ?? null,
      remove: (scope, name) => void secrets.delete(`${scope}/${name}`),
    },
    devices: {
      page: () => ({ items: [{ id: DEVICE, pushToken: state.pushReference }] }),
      active: () => ({ id: DEVICE, room: "probe-room" }),
      pushReference: (_id, value) => {
        state.pushReference = value;
      },
    },
    audit() {},
  };
  return { secrets, state, notifications: new RemoteNotifications(resources, () => false) };
}
const desktop = {
  async push(method, payload) {
    const { notifications } = desktopSide();
    const sent = [];
    const link = {
      async push(input) {
        sent.push({ kind: input.kind, route: input.route });
      },
    };
    notifications.publish(
      { method, payload },
      link,
      "wss://relay.example",
      new AbortController().signal,
    );
    await notifications.settled();
    return sent;
  },
  async unregistered(sameToken) {
    const { notifications, secrets, state } = desktopSide();
    const link = {
      async push() {
        // The phone re-registered (a new token) while this push was in flight.
        if (!sameToken)
          secrets.set(
            `remote-push:${DEVICE}/token`,
            JSON.stringify({ token: "ExpoPushToken[newer]", language: "zh" }),
          );
        throw new Error("remote_push_unregistered");
      },
    };
    notifications.publish(
      { method: "approval.requested", payload: { id: crypto.randomUUID() } },
      link,
      "wss://relay.example",
      new AbortController().signal,
    );
    await notifications.settled();
    return state.pushReference === null && !secrets.has(`remote-push:${DEVICE}/token`);
  },
  expoResult(body) {
    const push = { room: {}, expoToken: TOKEN, kind: "approval", route: "sealed" };
    const transport = async () => new Response(JSON.stringify(body), { status: 200 });
    return sendExpo(push, "probe-access-token", new AbortController().signal, transport);
  },
};
process.stdout.write(`${JSON.stringify(await runNotifyScenario(desktop))}\n`);
