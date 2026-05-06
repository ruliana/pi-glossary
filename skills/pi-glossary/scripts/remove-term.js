#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Parse CLI arguments
function parseArgs() {
  const args = process.argv.slice(2);
  const result = {
    scope: null,
    term: null,
    cwd: process.cwd(),
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--scope" && i + 1 < args.length) {
      result.scope = args[++i];
    } else if (arg === "--term" && i + 1 < args.length) {
      result.term = args[++i];
    } else if (arg === "--cwd" && i + 1 < args.length) {
      result.cwd = args[++i];
    }
  }

  return result;
}

function resolveGlossaryFile(basePath) {
  const jsonFile = `${basePath}.json`;
  const jsonlFile = `${basePath}.jsonl`;
  const hasJson = fs.existsSync(jsonFile);
  const hasJsonl = fs.existsSync(jsonlFile);

  if (hasJson && hasJsonl) {
    throw new Error(
      `Ambiguous glossary configuration: found both ${jsonFile} and ${jsonlFile}. Keep only one.`
    );
  }

  if (hasJsonl) {
    return jsonlFile;
  }

  if (hasJson) {
    return jsonFile;
  }

  // Neither exists
  return null;
}

function getGlossaryPath(scope, cwd) {
  if (scope === "global") {
    return path.join(os.homedir(), ".pi", "agent", "glossary");
  } else if (scope === "project") {
    return path.join(cwd, ".pi", "glossary");
  }
  throw new Error(`Invalid scope: ${scope}. Must be 'global' or 'project'.`);
}

function readGlossaryFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");

  if (filePath.endsWith(".jsonl")) {
    const entries = raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(
            `Invalid JSON on line ${index + 1} of ${filePath}: ${error.message}`
          );
        }
      });
    return { format: "jsonl", entries };
  }

  if (filePath.endsWith(".json")) {
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        throw new Error("Root value must be an array");
      }
      return { format: "json", entries: parsed };
    } catch (error) {
      throw new Error(`Invalid JSON in ${filePath}: ${error.message}`);
    }
  }

  throw new Error(`Unknown file format: ${filePath}`);
}

function writeGlossaryFile(filePath, format, entries) {
  if (format === "jsonl") {
    const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
    fs.writeFileSync(filePath, lines.length > 0 ? lines + "\n" : "", "utf8");
  } else if (format === "json") {
    fs.writeFileSync(filePath, JSON.stringify(entries, null, 2) + "\n", "utf8");
  } else {
    throw new Error(`Unknown format: ${format}`);
  }
}

async function main() {
  try {
    const opts = parseArgs();

    if (!opts.scope) {
      console.error("Error: --scope is required (global or project)");
      process.exit(1);
    }

    if (!opts.term) {
      console.error("Error: --term is required");
      process.exit(1);
    }

    const basePath = getGlossaryPath(opts.scope, opts.cwd);
    const filePath = resolveGlossaryFile(basePath);

    if (!filePath) {
      console.log("not-found");
      return;
    }

    const { format, entries } = readGlossaryFile(filePath);

    // Find and remove entry with matching term
    const existingIndex = entries.findIndex((e) => e.term === opts.term);
    if (existingIndex < 0) {
      console.log("not-found");
      return;
    }

    entries.splice(existingIndex, 1);
    writeGlossaryFile(filePath, format, entries);

    console.log("removed");
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

main();
