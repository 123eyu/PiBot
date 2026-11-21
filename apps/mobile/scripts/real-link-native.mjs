// Use RN's actual JS abort/event/WebSocket implementation; only native I/O is replaced.

export { default as ProbeWebSocket } from "../node_modules/react-native/Libraries/WebSocket/WebSocket.js";
export { AbortController } from "../node_modules/react-native/src/private/webapis/dom/abort-api/AbortController.js";
export { AbortSignal_public as AbortSignal } from "../node_modules/react-native/src/private/webapis/dom/abort-api/AbortSignal.js";

const listeners = new Map();
let native;
let storage;
export function configureNative(value) {
  native = value;
}
export function configureStorage(value) {
  storage = value;
}
export const secureNative = {
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 6,
  getItemAsync: (...args) => storage.getItemAsync(...args),
  setItemAsync: (...args) => storage.setItemAsync(...args),
  deleteItemAsync: (...args) => storage.deleteItemAsync(...args),
};
export const openProbeDatabase = (...args) => storage.openDatabaseAsync(...args);
export function emitNative(type, event) {
  for (const fn of [...(listeners.get(type) ?? [])]) fn(event);
}
export class ProbeEmitter {
  addListener(type, fn) {
    const set = listeners.get(type) ?? new Set();
    listeners.set(type, set);
    set.add(fn);
    return {
      remove() {
        set.delete(fn);
      },
    };
  }
}
export const socketNative = {
  connect: (...args) => native.connect(...args),
  send: (...args) => native.send(...args),
  sendBinary: (...args) => native.sendBinary(...args),
  close: (...args) => native.close(...args),
};
const timers = new Set();
export function setTimeout(fn, ms, ...args) {
  const timer = globalThis.setTimeout(() => {
    timers.delete(timer);
    fn(...args);
  }, ms);
  timers.add(timer);
  return timer;
}
export function clearTimeout(timer) {
  timers.delete(timer);
  globalThis.clearTimeout(timer);
}
export function disposeProbeGlobals() {
  for (const timer of timers) globalThis.clearTimeout(timer);
  timers.clear();
  listeners.clear();
  native = undefined;
  storage = undefined;
}
