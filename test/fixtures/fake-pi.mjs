#!/usr/bin/env node

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const cwd = process.cwd();
const argv = process.argv.slice(2);
const statePath = join(cwd, `.fake-pi-state-${process.pid}.json`);
const argsPath = join(cwd, `.fake-pi-args-${process.pid}.json`);
writeFileSync(argsPath, JSON.stringify(argv));

function argument(name) {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

const restorePath = argument("--session");
const sessionDirectory = argument("--session-dir");
let sessionId = argument("--session-id") ?? `fake-${process.pid}`;
let sessionFile = restorePath
  ? resolve(restorePath)
  : sessionDirectory
    ? join(resolve(sessionDirectory), `session-${sessionId}.jsonl`)
    : join(cwd, `.fake-pi-session-${process.pid}.jsonl`);
let messages = [];
let lastText = null;
let buffer = "";
let taskTimer;
let toolChild;
let leaderExitsOnTerm = false;

function loadSession() {
  try {
    const lines = readFileSync(sessionFile, "utf8").trimEnd().split("\n");
    const header = JSON.parse(lines[0]);
    if (header.type === "session") sessionId = header.id;
    const state = lines.length > 1 ? JSON.parse(lines.at(-1)) : {};
    messages = state.messages ?? [];
    lastText = state.lastText ?? null;
  } catch {}
  publishProcessState();
}

function persist() {
  mkdirSync(dirname(sessionFile), { recursive: true });
  const header = { type: "session", version: 3, id: sessionId, cwd };
  const state = { type: "fake_state", messages, lastText };
  writeFileSync(sessionFile, `${JSON.stringify(header)}\n${JSON.stringify(state)}\n`);
  publishProcessState();
}

function publishProcessState() {
  writeFileSync(statePath, JSON.stringify({ pid: process.pid, toolChildPid: toolChild?.pid, sessionFile, sessionId, messages, lastText }));
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function response(command, id, data) {
  send({ id, type: "response", command, success: true, ...(data === undefined ? {} : { data }) });
}

function handle(command) {
  switch (command.type) {
    case "get_state":
      response("get_state", command.id, {
        model: null,
        thinkingLevel: "off",
        isStreaming: Boolean(taskTimer),
        isCompacting: false,
        steeringMode: "all",
        followUpMode: "one-at-a-time",
        sessionFile,
        sessionId,
        messageCount: messages.length,
        pendingMessageCount: 0,
      });
      break;
    case "switch_session":
      sessionFile = resolve(command.sessionPath);
      loadSession();
      writeFileSync(join(cwd, ".fake-pi-switches.log"), `${sessionFile}\n`, { flag: "a" });
      response("switch_session", command.id, { cancelled: false });
      break;
    case "prompt": {
      messages.push(command.message);
      persist();
      const rejectPrompt = command.message.includes("reject-prompt");
      const settleBeforeResponse = command.message.includes("settle-before-response");
      if (!settleBeforeResponse) {
        if (rejectPrompt) {
          send({ id: command.id, type: "response", command: "prompt", success: false, error: "prompt rejected" });
          break;
        }
        response("prompt", command.id);
      }
      const delayMatch = command.message.match(/delay:(\d+)/);
      const delay = delayMatch ? Number(delayMatch[1]) : 15;
      if (command.message.includes("spawn-tool-child")) {
        const stubborn = command.message.includes("stubborn-tool-child");
        const code = stubborn
          ? 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'
          : "setInterval(() => {}, 1000)";
        toolChild = spawn(process.execPath, ["-e", code], { stdio: "ignore" });
        leaderExitsOnTerm = command.message.includes("leader-exits-on-term");
        publishProcessState();
      }
      if (command.message === "CRASH") {
        setTimeout(() => process.exit(23), delay);
        break;
      }
      taskTimer = setTimeout(() => {
        const assistantError = command.message.includes("assistant-error");
        lastText = assistantError ? null : `reply:${messages.join("|")}`;
        taskTimer = undefined;
        persist();
        send({
          type: "message_end",
          message: assistantError
            ? { role: "assistant", content: [], stopReason: "error", errorMessage: "provider authentication failed" }
            : { role: "assistant", content: [{ type: "text", text: lastText }], stopReason: "stop" },
        });
        send({ type: "agent_settled" });
        if (settleBeforeResponse) {
          setImmediate(() => {
            if (rejectPrompt) {
              send({ id: command.id, type: "response", command: "prompt", success: false, error: "prompt rejected" });
            } else {
              response("prompt", command.id);
            }
          });
        }
      }, delay);
      break;
    }
    case "get_last_assistant_text":
      response("get_last_assistant_text", command.id, { text: lastText });
      break;
    case "abort":
      if (messages.at(-1)?.includes("ignore-abort")) break;
      if (taskTimer) clearTimeout(taskTimer);
      taskTimer = undefined;
      response("abort", command.id);
      break;
    default:
      send({ id: command.id, type: "response", command: command.type, success: false, error: "unsupported" });
  }
}

if (restorePath) loadSession();
else publishProcessState();
process.on("SIGTERM", () => {
  if (leaderExitsOnTerm) process.exit(0);
});
process.stdin.on("data", (chunk) => {
  buffer += chunk.toString("utf8");
  let index = buffer.indexOf("\n");
  while (index !== -1) {
    let line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line) handle(JSON.parse(line));
    index = buffer.indexOf("\n");
  }
});
