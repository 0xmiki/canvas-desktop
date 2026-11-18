import { useMemo, useState } from "react";

import { agentSetups } from "../shared/agents.ts";

const STORAGE_KEY = "canvas.agent";

function loadAgent(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? "claude";
  } catch {
    return "claude";
  }
}

/** Agent picker + the snippet that connects it to this canvas. */
export function ConnectAgents({ url }: { url: string }) {
  const setups = useMemo(() => agentSetups(url), [url]);
  const [selected, setSelected] = useState(loadAgent);
  const [copied, setCopied] = useState(false);
  const setup = setups.find((item) => item.id === selected) ?? setups[0]!;

  const choose = (id: string) => {
    setSelected(id);
    setCopied(false);
    try {
      localStorage.setItem(STORAGE_KEY, id);
    } catch {
      // Remembering the choice is a convenience.
    }
  };

  const copy = () => {
    void navigator.clipboard.writeText(setup.text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div className="cv-connect" onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()}>
      <div className="cv-agents" role="tablist">
        {setups.map((item) => (
          <button
            key={item.id}
            role="tab"
            aria-selected={item.id === setup.id}
            className={`cv-agent${item.id === setup.id ? " is-selected" : ""}`}
            onClick={() => choose(item.id)}
          >
            {item.name}
          </button>
        ))}
      </div>
      <div className="cv-snippet">
        <div className="cv-snippet-head">
          <span>{setup.kind === "command" ? "Terminal" : (setup.file ?? "MCP config")}</span>
          <button onClick={copy}>{copied ? "Copied" : "Copy"}</button>
        </div>
        <pre>{setup.text}</pre>
      </div>
      <p className="cv-connect-hint">{setup.hint}</p>
    </div>
  );
}
