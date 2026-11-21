import "expo";
import { getRandomValues, randomUUID } from "expo-crypto";

// Peer needs UUIDs; use the platform CSPRNG, never Math.random for request identities.
if (!globalThis.crypto)
  Object.defineProperty(globalThis, "crypto", { value: { randomUUID, getRandomValues } });
else if (!globalThis.crypto.randomUUID)
  Object.defineProperty(globalThis.crypto, "randomUUID", { value: randomUUID });
if (!globalThis.crypto.getRandomValues)
  Object.defineProperty(globalThis.crypto, "getRandomValues", { value: getRandomValues });
// Expo SDK 58 supplies structuredClone. Fail at startup rather than silently losing binary values.
if (typeof globalThis.structuredClone !== "function")
  throw new Error("structured_clone_unavailable");
