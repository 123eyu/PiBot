import type { Params, Payload, Result } from "@pibot/protocol-base";
import { CredentialEvents, CredentialMethods } from "./api/credentials.ts";
import { GoogleCompatEvents, GoogleCompatMethods } from "./api/google-compat.ts";
import { UserSecretEvents, UserSecretMethods } from "./api/user-secrets.ts";

export * from "./api/credentials.ts";
export * from "./api/google-compat.ts";
export * from "./api/user-secrets.ts";

export const CredentialsContractMethods = {
  ...CredentialMethods,
  ...GoogleCompatMethods,
  ...UserSecretMethods,
} as const;
export const CredentialsContractEvents = {
  ...CredentialEvents,
  ...GoogleCompatEvents,
  ...UserSecretEvents,
} as const;
export type CredentialMethodParams = {
  [K in keyof typeof CredentialsContractMethods]: Params<typeof CredentialsContractMethods, K>;
};
export type CredentialMethodResults = {
  [K in keyof typeof CredentialsContractMethods]: Result<typeof CredentialsContractMethods, K>;
};
export type CredentialEventPayloads = {
  [K in keyof typeof CredentialsContractEvents]: Payload<typeof CredentialsContractEvents, K>;
};
