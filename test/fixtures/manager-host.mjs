#!/usr/bin/env node

import { pathToFileURL } from "node:url";

const [managerModule, storeModule, ownershipModule, root, cwd, executable] = process.argv.slice(2);
const [{ SessionManager }, { SessionRecordStore }, { OwnershipLockManager }] = await Promise.all([
  import(pathToFileURL(managerModule).href),
  import(pathToFileURL(storeModule).href),
  import(pathToFileURL(ownershipModule).href),
]);
let sequence = 0;
const manager = new SessionManager({
  store: new SessionRecordStore(root),
  ownership: new OwnershipLockManager(root),
  executable,
  idFactory: () => String(++sequence),
  nativeIdFactory: () => `native-${++sequence}`,
  commandTimeoutMs: 3_000,
  shutdownGraceMs: 100,
});
await manager.initialize();
const result = await manager.spawn({ task: "orphan delay:10000", cwd });
process.stdout.write(`${JSON.stringify(result)}\n`);
setInterval(() => {}, 1000);
