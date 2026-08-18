import { createRequire } from "node:module";
import type { flock as FlockFunction } from "fs-ext-extra-prebuilt";

interface FlockBinding {
  flock: typeof FlockFunction;
}

let loaded: FlockBinding | undefined;
let loadError: unknown;

export const ownershipSupportedMatrix = "macOS/Linux x64/arm64 with Node >=22.19 <26";

export async function flockExclusiveNonblocking(fd: number): Promise<void> {
  const binding = loadBinding();
  await new Promise<void>((resolve, reject) => {
    binding.flock(fd, "exnb", (error) => error ? reject(error) : resolve());
  });
}

function loadBinding(): FlockBinding {
  if (loaded) return loaded;
  if (loadError) throw ownershipLoadError(loadError);
  try {
    const require = createRequire(import.meta.url);
    const value = require("fs-ext-extra-prebuilt") as Partial<FlockBinding>;
    if (typeof value.flock !== "function") throw new Error("flock export is unavailable");
    loaded = value as FlockBinding;
    return loaded;
  } catch (error) {
    loadError = error;
    throw ownershipLoadError(error);
  }
}

function ownershipLoadError(error: unknown): Error {
  return new Error(
    `ownership_unavailable: fs-ext-extra-prebuilt@2.2.12 could not be loaded on ${process.platform}/${process.arch} Node ${process.versions.node}; supported matrix is ${ownershipSupportedMatrix}: ${error instanceof Error ? error.message : String(error)}`,
  );
}
