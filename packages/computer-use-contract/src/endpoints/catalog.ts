import type { EndpointCapabilityDefinition } from "@pibot/protocol-base";
export const desktopComputerUseEndpoint: EndpointCapabilityDefinition = {
  id: "desktop.computer",
  version: 1,
  kind: "desktop",
  name: { zh: "操作电脑", en: "Computer" },
  attributes: { readOnly: false, writesFile: true, privacy: true, egress: true },
  tools: {},
  toolNames: [
    "screenshot",
    "ui_tree",
    "ui_action",
    "pointer",
    "keys",
    "open_app",
    "open_file",
    "list_apps",
  ],
};
