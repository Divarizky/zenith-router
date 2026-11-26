import { getAntigravityAcpWorker, workerRuntimeEnv } from "./workers.js";

const MINIMAL_ENV = Object.freeze(process.platform === "win32"
  ? { PATH: `${process.env.SystemRoot || "C:\\Windows"}\\System32;${process.env.SystemRoot || "C:\\Windows"}`, SYSTEMROOT: process.env.SystemRoot || "C:\\Windows" }
  : { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" });

/**
 * Resolve an exact deployment worker ID and adapt the trusted transport
 * to the executor's ACP v1 surface. The caller must provide the audited stdio
 * transport constructor; neither this module nor HTTP requests choose binaries.
 */
export async function createAntigravityAcpClient(workerId, createTransport, { signal } = {}) {
  const worker = await getAntigravityAcpWorker(workerId);
  if (!worker) throw Object.assign(new Error("ACP worker is not allowlisted"), { code: "ACP_LOCAL_UNAVAILABLE" });
  if (typeof createTransport !== "function") throw Object.assign(new Error("ACP transport is unavailable"), { code: "ACP_LOCAL_UNAVAILABLE" });

  let transport;
  let promptActive = false;
  const abortBeforePrompt = () => {
    if (!promptActive) {
      try { transport?.close?.(); } catch {}
    }
  };
  try {
    transport = createTransport({
      command: worker.launcher,
      args: worker.launcherArgs || [],
      cwd: worker.workspace,
      env: {
        ...MINIMAL_ENV,
        ...workerRuntimeEnv(worker),
      },
    });
  } catch {
    throw Object.assign(new Error("ACP worker could not be started"), { code: "ACP_LOCAL_UNAVAILABLE" });
  }
  if (!transport || typeof transport.initialize !== "function" || typeof transport.request !== "function" || typeof transport.cancel !== "function" || typeof transport.close !== "function" || typeof transport.on !== "function") {
    try { transport?.close?.(); } catch {}
    throw Object.assign(new Error("ACP transport does not implement the required v1 surface"), { code: "ACP_LOCAL_UNAVAILABLE" });
  }

  signal?.addEventListener("abort", abortBeforePrompt, { once: true });
  if (signal?.aborted) abortBeforePrompt();
  return {
    cwd: worker.workspace,
    initialize: (params) => transport.initialize(params),
    newSession: (params) => transport.request("session/new", params),
    setConfigOption: (params) => transport.request("session/set_config_option", params),
    setModel: (params) => transport.request("session/set_model", params),
    async prompt(params) {
      promptActive = true;
      try { return await transport.request("session/prompt", params); }
      finally { promptActive = false; }
    },
    cancel: ({ sessionId }) => transport.cancel(sessionId),
    onUpdate(callback) {
      const listener = (message) => {
        if (message?.method === "session/update" && message.params) callback(message.params);
      };
      transport.on("notification", listener);
      return () => transport.off?.("notification", listener) || transport.removeListener?.("notification", listener);
    },
    close() {
      signal?.removeEventListener("abort", abortBeforePrompt);
      return transport.close();
    },
  };
}
