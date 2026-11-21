import { ipcRenderer } from "electron";

// Indicator page. The page itself has no script (CSP default-src 'none'); this sandboxed
// preload draws the rows with textContent only and sends button clicks back to the process
// that owns the window. Nothing is exposed to the page's main world.

interface Row {
  botId: string;
  mode: "background" | "foreground" | "paused" | "waiting";
  text: string;
  color?: string;
  canPause: boolean;
  canResume: boolean;
  confirm: { requestId: string; text: string } | null;
}
interface State {
  theme: "light" | "dark";
  labels: {
    pause: string;
    resume: string;
    stop: string;
    allow: string;
    skip: string;
    hint: string;
  };
  rows: Row[];
}

function button(label: string, primary: boolean, action: Record<string, unknown>) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = primary ? "btn primary" : "btn";
  element.textContent = label;
  element.addEventListener("click", () => ipcRenderer.send("pibot-guard:action", action));
  return element;
}

function render(state: State) {
  document.documentElement.dataset.theme = state.theme;
  const root = document.getElementById("rows");
  if (!root) return;
  root.replaceChildren(
    ...state.rows.flatMap((row) => {
      const bar = document.createElement("div");
      bar.className = `bar ${row.mode}`;
      const dot = document.createElement("span");
      dot.className = "dot";
      // The Bot's own avatar colour (a theme token); paused / waiting bars keep their own dot.
      if (row.color && /^[a-z]+$/.test(row.color))
        dot.style.setProperty("--dot", `var(--avatar-${row.color})`);
      const text = document.createElement("span");
      text.className = "text";
      text.textContent = row.text;
      bar.append(dot, text);
      if (row.canPause)
        bar.append(button(state.labels.pause, false, { kind: "pause", botId: row.botId }));
      if (row.canResume)
        bar.append(button(state.labels.resume, false, { kind: "resume", botId: row.botId }));
      const stop = button(state.labels.stop, true, { kind: "stop", botId: row.botId });
      stop.title = state.labels.hint;
      bar.append(stop);
      if (!row.confirm) return [bar];
      const ask = document.createElement("div");
      ask.className = "bar confirm";
      const question = document.createElement("span");
      question.className = "text";
      question.textContent = row.confirm.text;
      ask.append(
        question,
        button(state.labels.skip, false, {
          kind: "foreground",
          requestId: row.confirm.requestId,
          allow: false,
        }),
        button(state.labels.allow, true, {
          kind: "foreground",
          requestId: row.confirm.requestId,
          allow: true,
        }),
      );
      return [bar, ask];
    }),
  );
}

ipcRenderer.on("pibot-guard:state", (_event, state: State) => render(state));
window.addEventListener("DOMContentLoaded", () => ipcRenderer.send("pibot-guard:ready"));
