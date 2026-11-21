import { CAPABILITIES, type EndpointCapabilityDefinition } from "@pibot/protocol-base";
export const desktopBrowserEndpoint: EndpointCapabilityDefinition = {
  id: "desktop.browser",
  version: 1,
  kind: "desktop",
  name: { zh: "浏览器", en: "Browser" },
  attributes: { readOnly: false, writesFile: true, privacy: true, egress: true },
  tools: {},
  toolNames: CAPABILITIES.find((c) => c.id === "browser")?.builtinTools ?? [],
};
