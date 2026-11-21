// RPC responses must not rewind an event-driven login or a disposed peer's form.
export function createOAuthProgress() {
  let active = true;
  let version = 0;
  return {
    capture: () => version,
    alive: () => active,
    current: (snapshot: number) => active && version === snapshot,
    changed: () => ++version,
    dispose: () => {
      active = false;
    },
  };
}
