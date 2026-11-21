import { desktopBrowserEndpoint } from "@pibot/browser-contract";
import { desktopComputerUseEndpoint } from "@pibot/computer-use-contract";
import { desktopOfficeEndpoint } from "@pibot/office-contract";
import { remoteEndpointCapabilities } from "@pibot/remote-contract";
export const endpointCapabilityCatalog = [
  desktopComputerUseEndpoint,
  desktopBrowserEndpoint,
  desktopOfficeEndpoint,
  ...remoteEndpointCapabilities,
] as const;
