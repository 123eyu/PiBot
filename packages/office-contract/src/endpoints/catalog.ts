import type { EndpointCapabilityDefinition } from "@pibot/protocol-base";
export const desktopOfficeEndpoint: EndpointCapabilityDefinition = {
  id: "desktop.office-render",
  version: 1,
  kind: "desktop",
  name: { zh: "Office 渲染", en: "Office rendering" },
  attributes: { readOnly: false, writesFile: true, privacy: true, egress: false },
  tools: {},
  toolNames: ["office_render"],
};
