import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  MCP_REGISTRY_NAME,
  PACKAGE_NAME,
  PACKAGE_VERSION,
} from "../../npm/src/version.js";

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
  const packageJson = JSON.parse(await readFile("../npm/package.json", "utf8")) as PackageJson;
  const serverJson = JSON.parse(await readFile("../npm/server.json", "utf8")) as ServerJson;

  assert.equal(PACKAGE_NAME, packageJson.name);
  assert.equal(PACKAGE_VERSION, packageJson.version);
  assert.equal(MCP_REGISTRY_NAME, packageJson.mcpName);
  assert.equal(serverJson.name, packageJson.mcpName);
  assert.equal(serverJson.version, packageJson.version);
  assert.equal(serverJson.packages[0]?.identifier, packageJson.name);
  assert.equal(serverJson.packages[0]?.version, packageJson.version);
  assert.equal(serverJson.packages[0]?.transport.type, "stdio");
  assert.equal(packageJson.bin["pi-agent-mcp"], "dist/index.js");
  assert.ok(packageJson.files.includes("skills/pi-agent/SKILL.md"));
  assert.ok(packageJson.files.includes("server.json"));
});

test("中文 README 说明使用场景、工作原理和手工安装边界", async () => {
  const readme = await readFile("../npm/README.md", "utf8");
  assert.match(readme, new RegExp(PACKAGE_NAME.replace("/", "\\/")));
  assert.match(readme, /已经安装并认证的 \[Pi Coding Agent/);
  assert.match(readme, /## 为什么需要它/);
  assert.match(readme, /## 适用场景/);
  assert.match(readme, /## 工作原理/);
  assert.match(readme, /Claude Code \/ Codex[\s\S]*Pi Coding Agent：pi --mode rpc/);
  assert.match(readme, /claude mcp add/);
  assert.match(readme, /codex mcp add/);
  assert.match(readme, /npm 不会自动安装 Skill/);
  assert.match(readme, /npm 安装不会自动修改 Host 注册或 Skill 文件/);
  assert.match(readme, /install -m 0644 .*skills\/pi-agent\/SKILL\.md/);
  assert.doesNotMatch(readme, /pi-agent-mcp (setup|doctor|uninstall)/);
  assert.match(readme, /Private Vulnerability Reporting/);
  assert.match(readme, /它不是沙箱/);
});
