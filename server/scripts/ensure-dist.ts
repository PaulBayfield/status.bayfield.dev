// wrangler dev serves ../dist; it refuses to start when the folder is missing (no build yet).
// With Vite on :1460 for the pages, an empty folder is all the API needs.

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const dist = resolve(import.meta.dirname, "../../dist");
if (!existsSync(dist)) {
  mkdirSync(dist, { recursive: true });
  writeFileSync(resolve(dist, "index.html"), "<!doctype html><title>Status</title><p>Run <code>npm run build</code>, or open the Vite dev server on :1460.</p>");
  console.log("Created an empty dist/ for wrangler dev (run `npm run build` in the project root for the real one).");
}
