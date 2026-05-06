---
name: pi-glossary
description: Add or remove terms from the pi-glossary. Use when the user asks to add a new term, definition, alias, or pattern to the glossary, or to remove or disable an existing term. Works with both global (~/.pi/agent/glossary) and project (.pi/glossary) scopes.
---

# pi-glossary Skill

Manage glossary entries dynamically. Add new terms with definitions and aliases, or remove existing terms.

## Add a term

```bash
node scripts/add-term.js \
  --scope <global|project> \
  --term "term-name" \
  --definition "What the term means." \
  [--aliases "alias1,alias2"] \
  [--source "optional provenance"] \
  [--cwd "$PWD"]
```

**Parameters:**

- `--scope <global|project>` — Required. Where to store the term.
  - `global`: `~/.pi/agent/glossary.json` or `~/.pi/agent/glossary.jsonl`
  - `project`: `.pi/glossary.json` or `.pi/glossary.jsonl` in the current project
- `--term <string>` — Required. The canonical term name (e.g., `explore-plan-execute-review`)
- `--definition <string>` — Required. The definition text.
- `--aliases <comma-separated>` — Optional. Aliases for matching (e.g., `EPER,EPR`)
- `--source <string>` — Optional. Provenance label (defaults to the file path)
- `--cwd <path>` — Optional. Project root for scope resolution (defaults to current working directory)

**Behavior:**

- If the glossary file doesn't exist, creates a fresh `.jsonl` file with the entry.
- If the file exists and the same `term` already exists, updates it in place.
- If both `.json` and `.jsonl` exist in the same scope, exits with an error (user must remove one).
- Writes the entry and prints `added` or `updated` on stdout.

**Example:**

```bash
node scripts/add-term.js \
  --scope project \
  --term "explore-plan-execute-review" \
  --aliases "EPER,EPR" \
  --definition "Spawn a team of subagents to explore, plan, execute, and review a task end to end."
```

## Remove a term

```bash
node scripts/remove-term.js \
  --scope <global|project> \
  --term "term-name" \
  [--cwd "$PWD"]
```

**Parameters:**

- `--scope <global|project>` — Required. Which scope to remove from.
- `--term <string>` — Required. The term name to remove.
- `--cwd <path>` — Optional. Project root for scope resolution (defaults to current working directory)

**Behavior:**

- If the glossary file or term doesn't exist, prints `not-found` on stdout.
- If the term is found, removes it and prints `removed` on stdout.
- Handles both `.json` (array) and `.jsonl` (line-delimited) formats.

**Example:**

```bash
node scripts/remove-term.js --scope project --term "explore-plan-execute-review"
```

## After changes, reload the glossary

Always run this command after adding or removing terms so the extension picks up the changes:

```
/glossary reload
```

This command:
- Clears the session's loaded-terms tracker
- Reloads both global and project glossary files
- Shows a confirmation message

## Notes

- **File format:** The scripts prefer `.jsonl` (one entry per line). If a `.json` file already exists, they use it. If neither exists, `add-term.js` creates a `.jsonl`.
- **JSON format:** Each entry is a JSON object with `term`, `definition`, optional `aliases` (string array), optional `pattern` (regex string), optional `flags` (regex flags), and optional `source` (provenance).
- **Ambiguity:** If both `.json` and `.jsonl` exist in the same scope, both scripts exit with an error and tell the user to keep only one file.

## Typical workflow

1. User: *"Add 'finance-safe' to the project glossary: Use the conservative workflow."*
2. Agent runs: `node scripts/add-term.js --scope project --term "finance-safe" --definition "Use the conservative workflow: explicit assumptions, no destructive actions, and a reviewer pass before execution."`
3. Agent runs: `/glossary reload`
4. Future prompts mentioning `finance-safe` will inject the definition automatically.

Or to remove:

1. User: *"Remove 'finance-safe' from the glossary."*
2. Agent runs: `node scripts/remove-term.js --scope project --term "finance-safe"`
3. Agent runs: `/glossary reload`
