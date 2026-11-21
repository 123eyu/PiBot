import { useNavigation } from "@pibot/renderer-kit";
import { ProfessionOverlay } from "../builtin/ProfessionOverlay.tsx";
import { TemplatePreview } from "../builtin/TemplatePreview.tsx";
import { TeamExport } from "./TeamExport.tsx";
import { TeamImport } from "./TeamImport.tsx";

export function TeamOverlays() {
  const { teamOverlay, closeTeamOverlay } = useNavigation();
  if (teamOverlay?.name === "share")
    return (
      <TeamExport
        key={JSON.stringify(teamOverlay.target)}
        target={teamOverlay.target}
        close={closeTeamOverlay}
      />
    );
  if (teamOverlay?.name === "template")
    return <TemplatePreview key={teamOverlay.id} id={teamOverlay.id} close={closeTeamOverlay} />;
  if (teamOverlay?.name === "professions") return <ProfessionOverlay close={closeTeamOverlay} />;
  return teamOverlay?.name === "team" ? <TeamImport close={closeTeamOverlay} /> : null;
}
