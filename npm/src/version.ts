import { createRequire } from "node:module";

interface PackageMetadata {
  name: string;
  version: string;
  mcpName: string;
}

const require = createRequire(import.meta.url);
const metadata = require("../package.json") as PackageMetadata;

export const PACKAGE_NAME = metadata.name;
export const PACKAGE_VERSION = metadata.version;
export const MCP_REGISTRY_NAME = metadata.mcpName;
export const MCP_SERVER_NAME = "pi-agent";
export const SUPPORTED_PI_RANGE = ">=0.84.1 <0.85.0";
