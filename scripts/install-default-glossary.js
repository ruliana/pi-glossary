#!/usr/bin/env node
import { access, copyFile, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

async function exists(filePath) {
  try {
    await access(filePath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const agentDir = path.join(os.homedir(), ".pi", "agent");
  const targetJson = path.join(agentDir, "glossary.json");
  const targetJsonl = path.join(agentDir, "glossary.jsonl");

  if ((await exists(targetJson)) || (await exists(targetJsonl))) {
    console.log("pi-glossary: existing global glossary found; leaving it unchanged.");
    return;
  }

  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  const source = path.join(scriptDir, "..", "glossary.json");

  await mkdir(agentDir, { recursive: true });
  await copyFile(source, targetJson);
  console.log(`pi-glossary: installed default global glossary at ${targetJson}`);
}

main().catch((error) => {
  console.warn(`pi-glossary: could not install default global glossary: ${error.message}`);
});
