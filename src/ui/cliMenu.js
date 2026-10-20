import readline from "node:readline";
import { spawn } from "node:child_process";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const REVERSE = "\x1b[7m";
const RESET = "\x1b[0m";

function openBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? ["cmd", ["/c", "start", "", url]]
      : process.platform === "darwin"
        ? ["open", [url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd[0], cmd[1], { stdio: "ignore", detached: true }).unref();
  } catch {}
}

function pauseEnter() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n${DIM}Tekan Enter untuk kembali ke menu...${RESET}`, () => {
      rl.close();
      resolve();
    });
  });
}

function selectMenu(title, subtitle, items) {
  return new Promise((resolve) => {
    let selected = 0;
    let active = true;

    try {
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.setEncoding("utf8");
      process.stdin.resume();
    } catch {
      resolve(-1);
      return;
    }

    const render = () => {
      if (!active) return;
      process.stdout.write("\x1b[2J\x1b[H");
      const width = Math.min(process.stdout.columns || 40, 44);
      console.log(`\n${DIM}${"=".repeat(width)}${RESET}`);
      console.log(`  ${BOLD}${title}${RESET}`);
      if (subtitle) console.log(`  ${DIM}${subtitle}${RESET}`);
      console.log(`${DIM}${"=".repeat(width)}${RESET}\n`);
      items.forEach((item, i) => {
        if (i === selected) console.log(` ${REVERSE}${BOLD}> ${item.label}${RESET}`);
        else console.log(`   ${item.label}`);
      });
      console.log(`\n${DIM}Arrow up/down + Enter, Esc untuk lanjut background${RESET}`);
    };

    const done = (value) => {
      if (!active) return;
      active = false;
      process.stdin.removeListener("keypress", onKey);
      try {
        process.stdin.setRawMode(false);
      } catch {}
      resolve(value);
    };

    const move = (delta) => {
      selected = (selected + delta + items.length) % items.length;
      render();
    };

    const onKey = (_str, key) => {
      if (!active || !key) return;
      if (key.name === "up") return move(-1);
      if (key.name === "down") return move(1);
      if (key.name === "return") return done(selected);
      if (key.name === "escape") return done(-1);
      if (key.ctrl && key.name === "c") process.exit(0);
    };

    process.stdin.on("keypress", onKey);
    render();
  });
}

/**
 * Interactive menu: open dashboard in browser, hide menu, or exit.
 */
export async function showInterfaceMenu({ port, displayHost }) {
  const base = `http://${displayHost}:${port}`;
  while (true) {
    const choice = await selectMenu(
      "Zenith Router",
      `Server: ${base}`,
      [
        { label: "Web UI (Buka Dashboard di Browser)" },
        { label: "Lanjutkan di Background (sembunyikan menu)" },
        { label: "Keluar" },
      ]
    );

    if (choice === 0) {
      openBrowser(`${base}/dashboard`);
      console.log(`\n${DIM}Membuka ${base}/dashboard ...${RESET}`);
      await pauseEnter();
      continue;
    }
    if (choice === 1 || choice === -1) {
      process.stdout.write("\x1b[2J\x1b[H");
      console.log(`\n${BOLD}Zenith Router${RESET} ${DIM}berjalan di background${RESET}`);
      console.log(`  Dashboard:  ${base}/dashboard`);
      console.log(`  Endpoint:   ${base}/v1`);
      console.log(`\n  ${DIM}Ctrl+C untuk berhenti.${RESET}\n`);
      return;
    }
    process.exit(0);
  }
}
