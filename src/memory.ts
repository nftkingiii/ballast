// Remembering the last accepted hashprice between runs, so a single-shot plan can reuse it (inside the site's window) when a
// fresh answer is unavailable. A plain JSON file chosen by the caller (--state), never written unless asked, never holds a secret.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { parseMemory, type Memory } from "./reuse.ts";
import type { Plan } from "./types.ts";

export function loadMemory(path: string): Memory {
  if (!existsSync(path)) return {};
  try {
    return parseMemory(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

/** Keeps what the plan accepted (or the unchanged earlier value when it carried one). */
export function memoryAfter(plan: Plan): Memory {
  return plan.hashpriceMemory ? { hashprice: plan.hashpriceMemory } : {};
}

export function saveMemory(path: string, memory: Memory): void {
  writeFileSync(path, JSON.stringify(memory, null, 2) + "\n");
}
