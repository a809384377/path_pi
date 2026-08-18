#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const cwd = process.cwd();
const statePath = join(cwd, `.fake-pi-state-${process.pid}.json`);
const argsPath = join(cwd, `.fake-pi-args-${process.pid}.json`);
writeFileSync(argsPath, JSON.stringify(process.argv.slice(2)));

let sessionFile = join(cwd, `.fake-pi-session-${process.pid}.jsonl`);
let sessionId = `fake-${process.pid}`;
let messages = [];
let lastText = null;
let buffer = "";
let taskTimer;
let toolChild;

function ensureSession() {
  mkdirSync(dirname(sessionFile), { recursive: true });
  try {
    const state = JSON.parse(readFileSync(sessionFile, "utf8"));
    messages = state.messages ?? [];
    lastText = state.lastText ?? null;
    sessionId = state.sessionId ?? sessionId;
  } catch {}
  persist();
}

function persist() {
  writeFileSync(sessionFile, JSON.stringify({ sessionId, messages, lastText }));
  writeFileSync(statePath, JSON.stringify({ pid: process.pid, toolChildPid: toolChild?.pid, sessionFile, messages, lastText }));
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
      sessionFile = command.sessionPath;
      ensureSession();
      appendFileSync(join(cwd, ".fake-pi-switches.log"), `${sessionFile}\n`);
      response("switch_session", command.id, { cancelled: false });
      break;
    case "prompt": {
      messages.push(command.message);
      persist();
      response("prompt", command.id);
      const delayMatch = command.message.match(/delay:(\d+)/);
      const delay = delayMatch ? Number(delayMatch[1]) : 15;
      if (command.message.includes("spawn-tool-child")) {
        toolChild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        persist();
      }
      if (command.message === "CRASH") {
        setTimeout(() => process.exit(23), delay);
        break;
      }
      taskTimer = setTimeout(() => {
        lastText = `reply:${messages.join("|")}`;
        taskTimer = undefined;
        persist();
        send({ type: "agent_settled" });
      }, delay);
      break;
    }
    case "get_last_assistant_text":
      response("get_last_assistant_text", command.id, { text: lastText });
      break;
    case "abort":
      if (taskTimer) clearTimeout(taskTimer);
      taskTimer = undefined;
      response("abort", command.id);
      break;
    default:
      send({ id: command.id, type: "response", command: command.type, success: false, error: "unsupported" });
  }
}

ensureSession();
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
