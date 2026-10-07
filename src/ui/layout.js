/**
 * Base HTML Layout for zenroute Minimal Dashboard
 */
export function renderLayout({ title = "zenroute", activeTab = "overview", content = "", port = 20128 }) {
  const tabs = [
    { id: "overview", label: "Overview", href: "/dashboard" },
    { id: "connections", label: "Connections", href: "/dashboard/connections" },
    { id: "usage", label: "Usage", href: "/dashboard/usage" },
    { id: "settings", label: "Settings", href: "/dashboard/settings" },
  ];

  const navHtml = tabs
    .map(
      (t) => `
      <a href="${t.href}" class="tab-link ${t.id === activeTab ? "active" : ""}">
        ${t.label}
      </a>`
    )
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title} &middot; zenroute</title>
  <style>
    :root {
      --bg: #090d16;
      --card-bg: #121927;
      --card-border: #1e293b;
      --text: #f1f5f9;
      --text-muted: #94a3b8;
      --primary: #38bdf8;
      --primary-hover: #0284c7;
      --success: #34d399;
      --warning: #fbbf24;
      --danger: #f87171;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.5;
      padding: 1.5rem;
      min-height: 100vh;
      display: flex;
      flex-direction: column;
    }
    .container {
      max-width: 960px;
      margin: 0 auto;
      width: 100%;
      flex: 1;
    }
    header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding-bottom: 1.25rem;
      border-bottom: 1px solid var(--card-border);
      margin-bottom: 1.5rem;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
    }
    .brand h1 {
      font-size: 1.5rem;
      color: var(--primary);
      letter-spacing: -0.025em;
    }
    .badge {
      display: inline-block;
      padding: 0.15rem 0.6rem;
      border-radius: 9999px;
      font-size: 0.75rem;
      font-weight: 600;
      background: #0c4a6e;
      color: #bae6fd;
    }
    .badge-success { background: #064e3b; color: #a7f3d0; }
    .badge-warning { background: #78350f; color: #fde68a; }
    .badge-danger { background: #7f1d1d; color: #fecaca; }
    nav {
      display: flex;
      gap: 0.5rem;
      margin-bottom: 1.5rem;
      border-bottom: 1px solid var(--card-border);
      padding-bottom: 0.5rem;
    }
    .tab-link {
      padding: 0.5rem 1rem;
      color: var(--text-muted);
      text-decoration: none;
      font-weight: 500;
      font-size: 0.9rem;
      border-radius: 0.375rem;
      transition: all 0.15s ease;
    }
    .tab-link:hover { color: var(--text); background: rgba(255,255,255,0.04); }
    .tab-link.active { color: var(--primary); background: rgba(56, 189, 248, 0.1); }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 1rem;
      margin-bottom: 1.5rem;
    }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--card-border);
      border-radius: 0.5rem;
      padding: 1.25rem;
    }
    .card h3 {
      font-size: 0.85rem;
      color: var(--text-muted);
      text-transform: uppercase;
      letter-spacing: 0.05em;
      margin-bottom: 0.5rem;
    }
    .card .value {
      font-size: 1.75rem;
      font-weight: 700;
      color: var(--text);
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin-top: 1rem;
      font-size: 0.9rem;
    }
    th, td {
      padding: 0.75rem 1rem;
      text-align: left;
      border-bottom: 1px solid var(--card-border);
    }
    th { color: var(--text-muted); font-weight: 600; font-size: 0.8rem; text-transform: uppercase; }
    tr:last-child td { border-bottom: none; }
    .btn {
      display: inline-block;
      padding: 0.4rem 0.85rem;
      border-radius: 0.375rem;
      font-size: 0.85rem;
      font-weight: 500;
      border: none;
      cursor: pointer;
      background: var(--primary);
      color: #000;
      text-decoration: none;
    }
    .btn:hover { background: var(--primary-hover); }
    .btn-danger { background: var(--danger); color: #fff; }
    .btn-danger:hover { background: #dc2626; }
    input, select {
      background: #0a0f1d;
      border: 1px solid var(--card-border);
      color: var(--text);
      padding: 0.5rem 0.75rem;
      border-radius: 0.375rem;
      font-size: 0.9rem;
      width: 100%;
      margin-top: 0.25rem;
    }
    input:focus, select:focus {
      outline: none;
      border-color: var(--primary);
    }
    .form-group { margin-bottom: 1rem; }
    label { font-size: 0.85rem; color: var(--text-muted); font-weight: 500; }
    footer {
      text-align: center;
      margin-top: 2rem;
      font-size: 0.8rem;
      color: var(--text-muted);
      border-top: 1px solid var(--card-border);
      padding-top: 1rem;
    }
    code {
      background: rgba(0,0,0,0.3);
      padding: 0.2rem 0.4rem;
      border-radius: 0.25rem;
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 0.85rem;
      color: #38bdf8;
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div class="brand">
        <h1>zenroute</h1>
        <span class="badge">Port ${port}</span>
      </div>
      <div>
        <span class="badge badge-success">Online &middot; Ready</span>
      </div>
    </header>
    <nav>
      ${navHtml}
    </nav>
    <main>
      ${content}
    </main>
    <footer>
      zenroute &middot; Ultra-lightweight personal AI gateway
    </footer>
  </div>
</body>
</html>`;
}
