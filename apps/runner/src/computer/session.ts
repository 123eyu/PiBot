import type { SessionState } from "@pibot/computer";
import { ComputerError } from "@pibot/computer";
import { probe } from "./process.ts";

const WINDOWS_SESSION = `
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SessionProbe {
[StructLayout(LayoutKind.Sequential)] public struct LASTINPUTINFO { public uint size; public uint time; }
[DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LASTINPUTINFO value);
[DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, System.Text.StringBuilder value, uint length, out uint needed);
[DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
public static string Read() {
if (System.Diagnostics.Process.GetCurrentProcess().SessionId == 0) return "unavailable";
IntPtr desktop=OpenInputDesktop(0,false,1); if(desktop==IntPtr.Zero) return "locked";
try { uint needed; var name=new System.Text.StringBuilder(256); if(!GetUserObjectInformation(desktop,2,name,512,out needed) || name.ToString()!="Default") return "locked";
var input=new LASTINPUTINFO(); input.size=(uint)Marshal.SizeOf(input); if(!GetLastInputInfo(ref input)) return "unknown";
return ((unchecked((uint)Environment.TickCount)-input.time)/1000).ToString(System.Globalization.CultureInfo.InvariantCulture);
} finally { CloseDesktop(desktop); }
}
}
'@
[Console]::Out.Write([SessionProbe]::Read())
`;

export function createRunnerSession(platform: NodeJS.Platform, env: Readonly<NodeJS.ProcessEnv>) {
  return async (signal?: AbortSignal): Promise<SessionState> => {
    if (platform === "win32") {
      const raw = await probe(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-EncodedCommand",
          Buffer.from(WINDOWS_SESSION, "utf16le").toString("base64"),
        ],
        signal,
      );
      if (raw === "locked") return { locked: true, hidIdleSeconds: 0 };
      if (!/^\d{1,10}$/u.test(raw))
        throw new ComputerError("unsupported", "interactive_session_unavailable");
      return { locked: false, hidIdleSeconds: Number(raw) };
    }
    if (platform === "linux") {
      if (env.WAYLAND_DISPLAY || env.XDG_SESSION_TYPE === "wayland")
        throw new ComputerError("unsupported", "wayland_unsupported");
      if (!env.DISPLAY) throw new ComputerError("unsupported", "display_unavailable");
      const id = env.XDG_SESSION_ID;
      if (!id || !/^[a-zA-Z0-9_-]{1,80}$/u.test(id))
        throw new ComputerError("unsupported", "interactive_session_unavailable");
      const raw = await probe(
        "/usr/bin/loginctl",
        ["show-session", id, "--property=LockedHint", "--property=Active", "--property=State"],
        signal,
      );
      const facts = new Map(
        raw.split("\n").map((line) => line.split("=", 2)) as [string, string][],
      );
      if (!["yes", "no"].includes(facts.get("LockedHint") ?? ""))
        throw new ComputerError("unsupported", "interactive_session_unavailable");
      return {
        locked:
          facts.get("LockedHint") === "yes" ||
          facts.get("Active") !== "yes" ||
          facts.get("State") !== "active",
        hidIdleSeconds: 0,
      };
    }
    // macOS uses the shared driver's resident JXA session probe instead of this port.
    throw new ComputerError("unsupported", "session_probe_unavailable");
  };
}
