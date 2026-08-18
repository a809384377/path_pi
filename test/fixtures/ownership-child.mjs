#!/usr/bin/env node

import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const [modulePath, command, root, domain, key] = process.argv.slice(2);
const { OwnershipLockManager } = await import(pathToFileURL(modulePath).href);
const manager = new OwnershipLockManager(root);

if (command === "contend") {
  process.stdout.write("ready\n");
  await new Promise((resolve) => process.stdin.once("data", resolve));
  try {
    const handle = await manager.acquire(domain, key, { purpose: "multiprocess-test" });
    process.stdout.write("acquired\n");
    await new Promise((resolve) => setTimeout(resolve, 400));
    await handle.close();
    process.exit(0);
  } catch (error) {
    process.stdout.write(`blocked:${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

if (command === "once") {
  try {
    const handle = await manager.acquire(domain, key, { purpose: "multiprocess-test" });
    process.stdout.write("acquired\n");
    await handle.close();
    process.exit(0);
  } catch (error) {
    process.stdout.write(`blocked:${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(2);
  }
}

if (command === "inherit") {
  const handle = await manager.acquire(domain, key, { purpose: "inheritance-test" });
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore", handle.inheritedFd],
  });
  process.stdout.write(`inherited:${child.pid}\n`);
  setInterval(() => {}, 1000);
}
