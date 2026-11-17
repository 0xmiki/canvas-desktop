import { useEffect, useRef, useState } from "react";

import type { AppState } from "../shared/ipc.ts";

const bridge = () => window.canvasBridge;

export function Sidebar({ state }: { state: AppState }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    window.addEventListener("pointerdown", close);
    return () => window.removeEventListener("pointerdown", close);
  }, [menuOpen]);

  const { project, projects, designs, filePath } = state;

  return (
    <aside className="cv-sidebar">
      <div className="cv-project" ref={menuRef}>
        <button className="cv-project-button" onClick={() => setMenuOpen((open) => !open)} title={project?.path}>
          <span className="cv-project-mark">{(project?.name ?? "?").slice(0, 1).toUpperCase()}</span>
          <span className="cv-project-name">{project?.name ?? "No project"}</span>
          <Chevron />
        </button>
        {menuOpen && (
          <div className="cv-menu">
            {projects.length > 0 && <div className="cv-menu-label">Projects</div>}
            {projects.map((item) => (
              <div key={item.path} className={`cv-menu-row${item.path === project?.path ? " is-current" : ""}`}>
                <button
                  className="cv-menu-item"
                  title={item.path}
                  onClick={() => {
                    setMenuOpen(false);
                    bridge().project({ type: "open-project", path: item.path });
                  }}
                >
                  <span className="cv-menu-name">{item.name}</span>
                  <span className="cv-menu-path">{shortenPath(item.path)}</span>
                </button>
                <button
                  className="cv-icon-button"
                  title="Remove from list (files stay on disk)"
                  onClick={() => bridge().project({ type: "forget-project", path: item.path })}
                >
                  ×
                </button>
              </div>
            ))}
            <div className="cv-menu-sep" />
            <button
              className="cv-menu-item"
              onClick={() => {
                setMenuOpen(false);
                bridge().project({ type: "open-project" });
              }}
            >
              New or open project folder…
            </button>
          </div>
        )}
      </div>

      <div className="cv-section">
        <span>Designs</span>
        <button className="cv-icon-button" title="New design (Ctrl+N)" onClick={() => bridge().project({ type: "new-design" })}>
          +
        </button>
      </div>

      <ul className="cv-designs">
        {!project && (
          <li className="cv-designs-empty">
            {filePath ? "This file isn't in a project." : "Untitled design."}
            <button onClick={() => bridge().project({ type: "open-project" })}>Open a project folder</button>
          </li>
        )}
        {project && designs.length === 0 && <li className="cv-designs-empty">No designs yet.</li>}
        {designs.map((design) => {
          const current = design.path === filePath;
          if (renaming === design.path) {
            return (
              <li key={design.path}>
                <RenameField
                  initial={design.name.split("/").pop() ?? design.name}
                  onDone={(name) => {
                    setRenaming(null);
                    if (name) bridge().project({ type: "rename-design", path: design.path, name });
                  }}
                />
              </li>
            );
          }
          return (
            <li key={design.path} className={`cv-design${current ? " is-current" : ""}`}>
              <button
                className="cv-design-open"
                title={`${design.path}\nDouble-click to rename`}
                onClick={() => !current && bridge().project({ type: "open-design", path: design.path })}
                onDoubleClick={() => setRenaming(design.path)}
              >
                <FileIcon />
                <span>{design.name}</span>
              </button>
              <button
                className="cv-icon-button cv-design-delete"
                title="Move to trash"
                onClick={() => bridge().project({ type: "delete-design", path: design.path })}
              >
                <TrashIcon />
              </button>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}

function RenameField({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const done = useRef(false);
  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);
  const finish = (name: string | null) => {
    if (done.current) return;
    done.current = true;
    onDone(name && name.trim() && name.trim() !== initial ? name.trim() : null);
  };
  return (
    <input
      ref={input}
      className="cv-rename"
      defaultValue={initial}
      spellCheck={false}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Enter") finish(event.currentTarget.value);
        if (event.key === "Escape") finish(null);
      }}
      onBlur={(event) => finish(event.currentTarget.value)}
    />
  );
}

function shortenPath(full: string) {
  const parts = full.split(/[\\/]/).filter(Boolean);
  return parts.length > 3 ? `…/${parts.slice(-3).join("/")}` : full;
}

const Chevron = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <path d="m6 9 6 6 6-6" />
  </svg>
);

const FileIcon = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="3" y="3" width="18" height="18" rx="2" />
    <path d="M3 9h18M9 21V9" />
  </svg>
);

const TrashIcon = () => (
  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6" />
  </svg>
);
