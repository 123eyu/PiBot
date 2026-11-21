/**
 * Routines, host entry: the desktop main-process half of routines. It turns OS power and
 * focus signals into routine controls for the brain, holds the keep-awake lease and the tray state,
 * and buffers controls while the brain is being replaced. Electron objects are injected by the
 * desktop app (`powerMonitor`, `powerSaveBlocker`, the window), so this entry stays plain Node.
 */
export { createRoutineHost, type RoutineControl, type TrayState } from "./control.ts";
export { routineOutbox } from "./outbox.ts";
export { type Blocker, createPowerLease, type PowerSupply } from "./power/lease.ts";
