// How to connect each MCP client to the canvas endpoint. Shown in the editor's
// "Connect an agent" panel. Every entry uses streamable HTTP directly except
// the generic fallback, which offers a stdio bridge for clients without it.

export interface AgentSetup {
  id: string;
  name: string;
  /** "command": paste into a terminal. "config": merge into the named file. */
  kind: "command" | "config";
  /** Config file to edit, for kind "config". */
  file?: string;
  text: string;
  hint: string;
}

const json = (value: unknown) => JSON.stringify(value, null, 2);

export function agentSetups(url: string): AgentSetup[] {
  return [
    {
      id: "claude",
      name: "Claude Code",
      kind: "command",
      text: `claude mcp add --scope user --transport http canvas ${url}`,
      hint: "Run once in a terminal. Start a new session (or /mcp) to pick it up.",
    },
    {
      id: "codex",
      name: "Codex",
      kind: "command",
      text: `codex mcp add canvas --url ${url}`,
      hint: "Run once in a terminal. Adds it to ~/.codex/config.toml.",
    },
    {
      id: "gemini",
      name: "Gemini CLI",
      kind: "command",
      text: `gemini mcp add --scope user --transport http canvas ${url}`,
      hint: "Run once in a terminal. Adds it to ~/.gemini/settings.json.",
    },
    {
      id: "cursor",
      name: "Cursor",
      kind: "config",
      file: "~/.cursor/mcp.json",
      text: json({ mcpServers: { canvas: { url } } }),
      hint: "Merge into ~/.cursor/mcp.json (or .cursor/mcp.json in a project), then enable it in Settings → MCP.",
    },
    {
      id: "vscode",
      name: "VS Code",
      kind: "command",
      text: `code --add-mcp '${JSON.stringify({ name: "canvas", type: "http", url })}'`,
      hint: "Run once in a terminal. Copilot agent mode lists the canvas tools.",
    },
    {
      id: "windsurf",
      name: "Windsurf",
      kind: "config",
      file: "~/.codeium/windsurf/mcp_config.json",
      text: json({ mcpServers: { canvas: { serverUrl: url } } }),
      hint: "Merge into ~/.codeium/windsurf/mcp_config.json, then refresh MCP servers in Cascade.",
    },
    {
      id: "opencode",
      name: "OpenCode",
      kind: "config",
      file: "opencode.json",
      text: json({ $schema: "https://opencode.ai/config.json", mcp: { canvas: { type: "remote", url, enabled: true } } }),
      hint: "Merge into opencode.json in your project, or ~/.config/opencode/opencode.json for every project.",
    },
    {
      id: "other",
      name: "Other",
      kind: "config",
      text: json({ mcpServers: { canvas: { command: "npx", args: ["-y", "mcp-remote", url] } } }),
      hint: `Any client with streamable HTTP can use ${url} directly. For stdio-only clients, this bridges through mcp-remote (needs Node).`,
    },
  ];
}
