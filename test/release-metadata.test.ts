import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MCP_REGISTRY_NAME,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "../src/version.js";

interface PackageJson {
  name: string;
  version: string;
  mcpName: string;
  bin: Record<string, string>;
  files: string[];
}

interface ServerJson {
  name: string;
  version: string;
  packages: Array<{
    identifier: string;
    version: string;
    transport: { type: string };
  }>;
}

test("package and MCP Registry metadata stay version-aligned", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8")) as PackageJson;
  const serverJson = JSON.parse(await readFile("server.json", "utf8")) as ServerJson;

  assert.equal(PACKAGE_NAME, packageJson.name);
  assert.equal(PACKAGE_VERSION, packageJson.version);
  assert.equal(MCP_REGISTRY_NAME, packageJson.mcpName);
  assert.equal(serverJson.name, packageJson.mcpName);
  assert.equal(serverJson.version, packageJson.version);
  assert.equal(serverJson.packages[0]?.identifier, packageJson.name);
  assert.equal(serverJson.packages[0]?.version, packageJson.version);
  assert.equal(serverJson.packages[0]?.transport.type, "stdio");
  assert.equal(packageJson.bin["pi-agent-mcp"], "dist/src/index.js");
  assert.ok(packageJson.files.includes("skills/pi-agent/SKILL.md"));
  assert.ok(packageJson.files.includes("server.json"));
});

test("README documents manual installation and external Pi prerequisite", async () => {
  const readme = await readFile("README.md", "utf8");
  assert.match(readme, new RegExp(PACKAGE_NAME.replace("/", "\\/")));
  assert.match(readme, /Pi Coding Agent.*installed and authenticated/i);
  assert.match(readme, /claude mcp add/);
  assert.match(readme, /codex mcp add/);
  assert.match(readme, /npm root -g/);
  assert.match(readme, /install -m 0644 .*skills\/pi-agent\/SKILL\.md/);
  assert.match(readme, /cmp -s .*skills\/pi-agent\/SKILL\.md/);
  assert.match(readme, /diff -u[\s\S]*Only after reviewing/);
  assert.match(readme, /The npm package never rewrites Host registrations or Skill files/);
  assert.doesNotMatch(readme, /pi-agent-mcp (setup|doctor|uninstall)/);
  assert.match(readme, /private vulnerability reporting/i);
  assert.match(readme, /not a sandbox/i);
});
