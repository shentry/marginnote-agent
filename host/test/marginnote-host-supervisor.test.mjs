import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  isMarginNoteProcess,
  MarginNoteHostSupervisor,
} from "../../scripts/marginnote-host-supervisor.mjs";

class FakeChild extends EventEmitter {
  constructor() {
    super();
    this.pid = 12345;
    this.exitCode = null;
    this.signalCode = null;
    this.signals = [];
  }

  kill(signal) {
    this.signals.push(signal);
    this.exitCode = 0;
    this.signalCode = signal;
    this.emit("exit", 0, signal);
    return true;
  }
}

const logger = { log() {}, warn() {}, error() {} };

test("supervisor identifies installed MarginNote 4 executables", () => {
  assert.equal(
    isMarginNoteProcess("/Applications/MarginNote 4 2.app/Contents/MacOS/MarginNote 4"),
    true,
  );
  assert.equal(
    isMarginNoteProcess("/Applications/MarginNote 4.app/Contents/MacOS/MarginNote 4"),
    true,
  );
  assert.equal(isMarginNoteProcess("node host/src/main.mjs"), false);
});

test("supervisor starts with MarginNote and stops only its own Host child", async () => {
  let marginNoteRunning = true;
  let spawnCount = 0;
  const child = new FakeChild();
  const supervisor = new MarginNoteHostSupervisor({
    projectDir: "/tmp/marginnote-agent",
    isMarginNoteRunning: () => marginNoteRunning,
    isPortInUse: () => false,
    spawnHost: () => {
      spawnCount += 1;
      return child;
    },
    stopGraceMs: 0,
    logger,
  });

  await supervisor.reconcile();
  assert.equal(spawnCount, 1);
  assert.equal(supervisor.hostProcess, child);

  marginNoteRunning = false;
  await supervisor.reconcile();
  await supervisor.reconcile();
  assert.deepEqual(child.signals, ["SIGTERM"]);
  assert.equal(supervisor.hostProcess, null);
});

test("supervisor ignores a transient MarginNote process gap", async () => {
  let marginNoteRunning = true;
  let now = 0;
  const child = new FakeChild();
  const supervisor = new MarginNoteHostSupervisor({
    projectDir: "/tmp/marginnote-agent",
    isMarginNoteRunning: () => marginNoteRunning,
    isPortInUse: () => false,
    spawnHost: () => child,
    stopGraceMs: 2000,
    now: () => now,
    logger,
  });

  await supervisor.reconcile();
  marginNoteRunning = false;
  now = 1000;
  await supervisor.reconcile();
  marginNoteRunning = true;
  now = 1500;
  await supervisor.reconcile();

  assert.deepEqual(child.signals, []);
  assert.equal(supervisor.hostProcess, child);
});

test("supervisor leaves an unrelated listener on the Host port untouched", async () => {
  let spawnCount = 0;
  const supervisor = new MarginNoteHostSupervisor({
    projectDir: "/tmp/marginnote-agent",
    isMarginNoteRunning: () => true,
    isPortInUse: () => true,
    spawnHost: () => {
      spawnCount += 1;
      return new FakeChild();
    },
    logger,
  });

  await supervisor.reconcile();
  assert.equal(spawnCount, 0);
  assert.equal(supervisor.hostProcess, null);
});
