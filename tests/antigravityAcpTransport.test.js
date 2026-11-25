import test from "node:test";
import assert from "node:assert/strict";
import { AntigravityAcpTransport } from "../src/services/antigravityAcp/transport.js";
import process from "node:process";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

const childScript = String.raw`
const readline = require('node:readline');
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', line => {
  const m = JSON.parse(line);
  if (['initialize', 'session/new', 'session/prompt'].includes(m.method)) {
    if (m.params.authError) {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'private remote detail'}})+'\n');
    } else if (m.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:1}})+'\n');
    else if (m.method === 'session/new') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{sessionId:'s'}})+'\n');
    else {
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'session/update',params:{sessionId:m.params.sessionId || 's',update:{sessionUpdate:'agent_message_chunk'}}})+'\n');
      if (!m.params.hang) setImmediate(() => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn'}})+'\n'));
    }
  } else if (m.method === 'hang') { global.hangId = m.id; }
  else if (m.method === 'session/cancel') process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'cancelled',params:m.params})+'\n');
  else if (m.method === 'permission') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:90,method:'session/request_permission',params:{sessionId:'s'}})+'\n');
  else if (m.method === 'unknown-request') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:91,method:'agent/call',params:{payload:'unused'}})+'\n');
  else if (m.method === 'exit') process.exit(7);
  else if (m.method === 'overflow') process.stdout.write('x'.repeat(2048));
  else if (m.method === 'bad') process.stdout.write('not json'+String.fromCharCode(10));
});`;

function fixture(options = {}) {
  return new AntigravityAcpTransport({ command: process.execPath, args: ["-e", childScript], timeoutMs: 5000, ...options });
}

function waitForNotification(transport, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const onNotification = message => {
      if (!predicate(message)) return;
      clearTimeout(timer);
      transport.off("notification", onNotification);
      resolve(message);
    };
    const timer = setTimeout(() => {
      transport.off("notification", onNotification);
      reject(new Error("Timed out waiting for ACP notification"));
    }, timeoutMs);
    transport.on("notification", onNotification);
  });
}

function waitForStdinJson(transport, predicate, timeoutMs = 5000) {
  const stdin = transport.child.stdin;
  const originalWrite = stdin.write.bind(stdin);
  return new Promise((resolve, reject) => {
    const restore = () => { stdin.write = originalWrite; };
    const timer = setTimeout(() => {
      restore();
      reject(new Error("Timed out waiting for ACP child stdin response"));
    }, timeoutMs);
    stdin.write = (chunk, ...args) => {
      try {
        const message = JSON.parse(chunk);
        if (predicate(message)) {
          clearTimeout(timer);
          restore();
          resolve(message);
        }
      } catch {}
      return originalWrite(chunk, ...args);
    };
  });
}

test("ACP transport starts with argv and correlates initialize, prompt and streamed notifications", async t => {
  const transport = fixture();
  t.after(() => transport.close());
  const notifications = [];
  transport.on("notification", message => notifications.push(message));
  assert.deepEqual(await transport.initialize({ client: "test" }), { protocolVersion: 1 });
  assert.deepEqual(await transport.prompt({ sessionId: "session-1", prompt: "hello" }), { stopReason: "end_turn" });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].method, "session/update");
  assert.equal(transport.child.spawnargs[1], "-e");
  assert.equal(transport.child.spawnargs[2], childScript);
});

test("ACP transport cancels timed-out request and can close/clean up child", async t => {
  const transport = fixture();
  t.after(() => transport.close());
  await transport.request("initialize", { protocolVersion: 1 }, { timeoutMs: 10_000 }); // Fixture startup gets its own generous bounded deadline.
  const cancellation = waitForNotification(transport, message => message.method === "cancelled" && message.params.sessionId === "session-timeout");
  await assert.rejects(transport.request("session/prompt", { sessionId: "session-timeout", prompt: [], hang: true }, { timeoutMs: 80 }), { code: "ACP_TIMEOUT" });
  const cancelMessage = await cancellation;
  assert.equal(cancelMessage.params.sessionId, "session-timeout", "timeout sends session/cancel with the session id");
  await transport.close();
  assert.equal(transport.closed, true);
  await assert.rejects(transport.request("hang"), { code: "ACP_CLOSED" });
});

test("ACP auth-required is exposed only as a numeric pre-prompt code without remote details", async t => {
  const transport = fixture();
  t.after(() => transport.close());
  for (const [method, invoke] of [
    ["initialize", () => transport.initialize({ authError: true })],
    ["session/new", () => transport.request("session/new", { authError: true })],
  ]) {
    await assert.rejects(invoke(), error => {
      assert.equal(error.code, -32000, `${method} preserves only the coded pre-prompt signal`);
      assert.equal(error.message, "ACP authentication is required");
      assert.doesNotMatch(error.message, /private remote detail/);
      return true;
    });
  }
  await assert.rejects(transport.prompt({ sessionId: "s", authError: true }), error => {
    assert.equal(error.code, "ACP_REMOTE_ERROR", "a prompt error is never a failover signal");
    assert.equal(error.message, "ACP subprocess returned an error");
    assert.doesNotMatch(error.message, /private remote detail/);
    return true;
  });
});

test("ACP transport close waits for graceful child exit and returns cleanup state", async t => {
  const transport = fixture();
  const child = transport.child;
  t.after(() => transport.close());
  const closed = new Promise(resolve => child.once("close", resolve));
  assert.equal(await transport.close(), true);
  await closed;
  assert.equal(transport.childExited, true);
  assert.equal(await transport.close(), true, "repeated close reuses the completed cleanup result");
});

test("ACP transport escalates termination with bounded failure reporting", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  const signals = [];
  child.kill = signal => {
    signals.push(signal);
    if (signal === "SIGKILL") setImmediate(() => { child.emit("exit", null, signal); child.emit("close", null, signal); });
    return true;
  };
  const transport = new AntigravityAcpTransport({ command: "fixture", args: [], spawnFn: () => child, closeGraceMs: 5, killGraceMs: 100 });
  assert.equal(await transport.close(), true);
  assert.deepEqual(signals, ["SIGTERM", "SIGKILL"]);
});

test("ACP transport reports bounded cleanup failure without leaking process details", async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.kill = () => true;
  const transport = new AntigravityAcpTransport({ command: "fixture", args: [], spawnFn: () => child, closeGraceMs: 5, killGraceMs: 5 });
  let cleanupError;
  transport.on("cleanupError", error => { cleanupError = error; });
  assert.equal(await transport.close(), false);
  assert.equal(cleanupError.code, "ACP_CLEANUP_ERROR");
  assert.equal(cleanupError.message, "ACP subprocess did not exit after termination");
});

test("ACP transport denies permission requests by default without forwarding payload", async t => {
  const transport = fixture();
  t.after(() => transport.close());
  await transport.initialize({ protocolVersion: 1 });
  const denied = waitForStdinJson(transport, value => value.id === 90);
  transport.child.stdin.write('{"jsonrpc":"2.0","method":"permission","params":{}}\n');
  const answer = await denied;
  assert.deepEqual(answer?.result?.outcome, { outcome: "cancelled" });
});

test("ACP transport rejects unknown inbound requests with Method Not Found", async t => {
  const transport = fixture();
  t.after(() => transport.close());
  await transport.initialize({ protocolVersion: 1 });
  const response = waitForStdinJson(transport, value => value.id === 91);
  transport.child.stdin.write('{"jsonrpc":"2.0","method":"unknown-request","params":{}}\n');
  const answer = await response;
  assert.deepEqual(answer?.error, { code: -32601, message: "Method not found" });
});

test("ACP transport rejects malformed protocol, output overflow and remote process exit", async t => {
  const bad = fixture();
  t.after(() => bad.close());
  await assert.rejects(bad.request("bad"), { code: "ACP_PROTOCOL_ERROR" });

  const overflow = fixture({ maxOutputBytes: 100 });
  t.after(() => overflow.close());
  await assert.rejects(overflow.request("overflow"), { code: "ACP_OUTPUT_LIMIT" });

  const exiting = fixture();
  t.after(() => exiting.close());
  await assert.rejects(exiting.request("exit"), { code: "ACP_EXIT" });
});

test("ACP transport treats writable backpressure as accepted and handles asynchronous EPIPE", async t => {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ highWaterMark: 0, write(_chunk, _encoding, callback) { callback(); } });
  const killSignals = [];
  child.kill = signal => {
    killSignals.push(signal);
    setImmediate(() => { child.emit("exit", null, signal); child.emit("close", null, signal); });
    return true;
  };
  const transport = new AntigravityAcpTransport({ command: "fixture", args: [], spawnFn: () => child, timeoutMs: 1000 });
  let returnedFalse = false;
  const write = child.stdin.write.bind(child.stdin);
  child.stdin.write = (...args) => {
    write(...args);
    returnedFalse = true;
    return false;
  };
  const pending = transport.request("pending");
  assert.equal(returnedFalse, true, "fixture write returned false due to backpressure");
  child.stdin.emit("error",  Object.assign(new Error("write failed"), { code: "EPIPE" }));
  await assert.rejects(pending, { code: "ACP_WRITE_ERROR", message: "Could not write to ACP subprocess" });
  assert.equal(await transport.close(), true, "close still kills the child after an EPIPE already marked transport closed");
  assert.deepEqual(killSignals, ["SIGTERM"]);
});

test("ACP transport validates fixed argv and spawns without a shell", t => {
  assert.throws(() => new AntigravityAcpTransport({ command: "", args: [] }), TypeError);
  assert.throws(() => new AntigravityAcpTransport({ command: "agent", args: [1] }), TypeError);
  let spawnOptions;
  const transport = fixture({ spawnFn: (command, args, options) => {
    spawnOptions = options;
    return spawn(command, args, options);
  } });
  t.after(() => transport.close());
  assert.equal(spawnOptions.shell, false);
  assert.deepEqual(spawnOptions.stdio, ["pipe", "pipe", "pipe"]);
});
