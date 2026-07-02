"use client";

import { useState } from "react";
import Editor, { OnChange } from "@monaco-editor/react";

const LANGUAGES = [
  { label: "JavaScript", value: "javascript" },
  { label: "Python", value: "python" },
  { label: "TypeScript", value: "typescript" },
  { label: "Java", value: "java" },
  { label: "C++", value: "cpp" },
] as const;

const DEFAULT_CODE = `console.log("Hello, world!");\n`;

export default function CodeEditor() {
  const [language, setLanguage] = useState<string>("javascript");
  const [code, setCode] = useState<string>(DEFAULT_CODE);
  const [output] = useState<string>("");

  const handleEditorChange: OnChange = (value) => {
    setCode(value ?? "");
  };

  const handleRun = () => {
    // Execution will be wired up in the next phase.
  };

  return (
    <div className="flex h-full flex-col bg-[#1e1e1e] text-zinc-200">
      <div className="flex items-center gap-3 border-b border-zinc-800 bg-[#252526] px-4 py-2">
        <label htmlFor="language-select" className="text-sm text-zinc-400">
          Language
        </label>
        <select
          id="language-select"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
          className="rounded border border-zinc-700 bg-[#3c3c3c] px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:ring-1 focus:ring-blue-500"
        >
          {LANGUAGES.map((lang) => (
            <option key={lang.value} value={lang.value}>
              {lang.label}
            </option>
          ))}
        </select>
      </div>

      <div className="flex-1 min-h-0">
        <Editor
          height="100%"
          language={language}
          value={code}
          theme="vs-dark"
          onChange={handleEditorChange}
          options={{
            fontSize: 14,
            minimap: { enabled: false },
            automaticLayout: true,
            scrollBeyondLastLine: false,
          }}
        />
      </div>

      <div className="flex items-center gap-3 border-t border-zinc-800 bg-[#252526] px-4 py-2">
        <button
          type="button"
          onClick={handleRun}
          className="rounded bg-green-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-green-500"
        >
          Run
        </button>
        <span className="text-xs text-zinc-500">Execution not wired up yet</span>
      </div>

      <div className="h-48 overflow-auto border-t border-zinc-800 bg-black px-4 py-3">
        <pre className="whitespace-pre-wrap font-mono text-sm text-zinc-300">
          {output || (
            <span className="text-zinc-600">Output will appear here...</span>
          )}
        </pre>
      </div>
    </div>
  );
}
