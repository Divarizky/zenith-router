import {
  createCombo,
  updateCombo,
  renameCombo,
  moveComboMember,
  setComboEnabled,
  deleteCombo,
  getComboByName,
  listCombos,
} from "../../services/combos.js";
import { escapeHtml } from "../html.js";

// The chain is ordered under fallback and rotates under round-robin (TASK-27).
const STRATEGY_OPTIONS = [
  { value: "fallback", label: "Urutan (fallback)" },
  { value: "round-robin", label: "Giliran (round-robin)" },
];

/** One chain row: position badge, the member, and its move controls. */
function renderMemberRow(name, member, index, total) {
  const row = `
    <div class="combo-member">
      <span class="combo-order">${index + 1}</span>
      <code>${escapeHtml(member)}</code>
      <form action="/dashboard/combos/reorder" method="POST" class="combo-move">
        <input type="hidden" name="name" value="${escapeHtml(name)}" />
        <input type="hidden" name="index" value="${index}" />
        <button type="submit" name="direction" value="up" class="btn btn-ghost" title="Naikkan prioritas" ${
          index === 0 ? "disabled" : ""
        }>&uarr;</button>
        <button type="submit" name="direction" value="down" class="btn btn-ghost" title="Turunkan prioritas" ${
          index === total - 1 ? "disabled" : ""
        }>&darr;</button>
      </form>
    </div>`;
  return row;
}

function renderComboCard(combo) {
  const name = escapeHtml(combo.name);
  const total = combo.models.length;
  return `
    <div class="card combo-card">
      <div class="card-head">
        <h3>${name}</h3>
        <div class="combo-card-actions">
          ${
            combo.enabled === 1
              ? `<span class="pill pill-success">Aktif</span>`
              : `<span class="pill">Nonaktif</span>`
          }
          <form action="/dashboard/combos/toggle" method="POST">
            <input type="hidden" name="name" value="${name}" />
            <button type="submit" class="btn btn-ghost">${combo.enabled === 1 ? "Nonaktifkan" : "Aktifkan"}</button>
          </form>
          <form action="/dashboard/combos/delete" method="POST"
                onsubmit="return confirm('Hapus combo ini beserta definisinya?')">
            <input type="hidden" name="name" value="${name}" />
            <button type="submit" class="btn btn-danger">Hapus</button>
          </form>
        </div>
      </div>
      <div class="combo-card-row">
        <span class="combo-card-label">Strategi</span>
        <div class="combo-card-value">
          <form action="/dashboard/combos/update" method="POST">
            <input type="hidden" name="name" value="${name}" />
            <select name="strategy" class="input-select" onchange="this.form.submit()">
              ${STRATEGY_OPTIONS.map(
                (s) => `<option value="${s.value}" ${combo.strategy === s.value ? "selected" : ""}>${escapeHtml(s.label)}</option>`
              ).join("")}
            </select>
            <noscript><button type="submit" class="btn btn-ghost">Simpan</button></noscript>
          </form>
        </div>
      </div>
      <div class="combo-card-row">
        <span class="combo-card-label">Rantai (${total})</span>
        <div class="combo-card-value">
          ${
            total === 0
              ? `<span class="hint">Belum ada anggota</span>`
              : combo.models.map((m, i) => renderMemberRow(combo.name, m, i, total)).join("")
          }
        </div>
      </div>
      <details class="combo-card-details">
        <summary class="hint">Edit</summary>
        <form action="/dashboard/combos/rename" method="POST" class="combo-rename-form">
          <input type="hidden" name="name" value="${name}" />
          <input type="text" name="new_name" value="${name}" maxlength="64" required />
          <button type="submit" class="btn btn-ghost">Simpan nama</button>
        </form>
        <form action="/dashboard/combos/update" method="POST" class="combo-edit-chain">
          <input type="hidden" name="name" value="${name}" />
          <input type="hidden" name="strategy" value="${escapeHtml(combo.strategy)}" />
          <div class="combo-chain-editor">
            <button type="button" class="btn btn-ghost" data-picker-open>Pilih model…</button>
            <textarea name="models" rows="${Math.max(3, total)}">${escapeHtml(combo.models.join("\n"))}</textarea>
            <ul class="combo-selected"></ul>
          </div>
          <button type="submit" class="btn btn-ghost">Simpan rantai</button>
        </form>
      </details>
    </div>`;
}

export function renderCombosContent(query = {}) {
  const combos = listCombos();

  const notice =
    query.created === "1"
      ? `<div class="notice notice-ok"><span>Combo berhasil dibuat.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
      : query.updated === "1"
        ? `<div class="notice notice-ok"><span>Combo berhasil diperbarui.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
        : query.deleted === "1"
          ? `<div class="notice notice-ok"><span>Combo berhasil dihapus.</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
          : query.error === "1"
            ? `<div class="notice notice-error"><span>${escapeHtml(query.msg || "Combo gagal disimpan.")}</span><button type="button" class="notice-close" onclick="this.parentElement.remove()">&times;</button></div>`
            : "";

  const cards = combos.map(renderComboCard).join("");

  const content = `
    ${notice}

    <div class="card" style="margin-bottom: 1.5rem;">
      <h3>Buat Combo</h3>
      <p class="hint" style="margin-bottom: 1rem;">
        Combo adalah rantai model lintas provider yang dipanggil dengan satu nama.
        Urutan dari atas ke bawah adalah urutan percobaan: anggota berikutnya hanya dicoba
        saat anggota di atasnya gagal karena kondisi account, rate limit, atau upstream yang sibuk.
      </p>
      <form action="/dashboard/combos/create" method="POST">
        <div class="field">
          <label for="combo-name">Nama combo</label>
          <input
            type="text"
            id="combo-name"
            name="name"
            placeholder="mis. cepat-dan-hemat"
            maxlength="64"
            required
          />
          <p class="hint">
            Hanya huruf, angka, titik, garis, dan garis bawah. Nama yang berawalan nama model
            milik provider otomatis ditolak.
          </p>
        </div>
        <div class="field">
          <label for="combo-models">Anggota rantai</label>
          <div class="combo-chain-editor">
            <button type="button" class="btn btn-ghost" data-picker-open>Pilih model…</button>
            <textarea
              id="combo-models"
              name="models"
              rows="4"
              placeholder="mistral/mistral-large-latest&#10;glm/glm-4-flash"
            ></textarea>
            <ul class="combo-selected"></ul>
          </div>
          <p class="hint">Satu model per baris, ditulis <code>provider/model</code>. Baris pertama adalah anggota yang dicoba lebih dulu. Baris kosong dan anggota yang sama lebih dari sekali diabaikan.</p>
        </div>
        <div style="display: flex; justify-content: flex-end;">
          <button type="submit" class="btn btn-primary">Buat Combo</button>
        </div>
      </form>
    </div>

    <h3 class="combos-section-title">Combos (${combos.length})</h3>
    ${
      combos.length === 0
        ? `<div class="card"><div class="empty"><p class="big">Belum ada combo</p><p>Buat combo pertama lewat form di atas, lalu panggil namanya seperti model biasa.</p></div></div>`
        : cards
    }

    <div class="modal-backdrop" id="model-picker-modal">
      <div class="modal combo-picker">
        <h3>Pilih model</h3>
        <input type="search" id="combo-picker-search" placeholder="Cari model atau provider…" autocomplete="off" />
        <div id="combo-picker-list" class="combo-picker-list"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-primary" data-close-modal="model-picker-modal">Selesai</button>
        </div>
      </div>
    </div>

    <style>
      .combo-chain-editor > .btn { margin-bottom: 0.4rem; }
      .combos-section-title { font-size: 0.95rem; font-weight: 600; margin: 0 0 0.75rem; }
      .combo-card-actions { display: flex; align-items: center; gap: 0.4rem; }
      .combo-card-actions form { display: flex; gap: 0.35rem; }
      .combo-card-row { display: flex; align-items: flex-start; gap: 0.9rem; margin-top: 0.85rem; }
      .combo-card-label { flex: none; width: 6.5rem; padding-top: 0.3rem; font-size: 0.75rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-subtle); }
      .combo-card-value { flex: 1; min-width: 0; }
      .combo-card-details { margin-top: 0.9rem; padding-top: 0.6rem; border-top: 1px solid var(--border-subtle); }
      .combo-rename-form { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.75rem; flex-wrap: wrap; }
      .combo-rename-form input[type="text"] { flex: 1; min-width: 12rem; max-width: 20rem; }
      .combo-edit-chain { margin-top: 0.5rem; }
      .combo-selected { list-style: none; margin: 0.5rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
      .combo-selected li { display: flex; align-items: center; gap: 0.5rem; border: 1px solid var(--border); border-radius: 6px; padding: 0.35rem 0.55rem; font-size: 0.85rem; background: var(--surface-2); }
      .combo-selected li.cs-empty { border: none; padding: 0.2rem 0; color: var(--text-subtle); background: transparent; }
      .combo-selected .cs-order { color: var(--text-subtle); font-size: 0.75rem; min-width: 1.4em; text-align: center; }
      .combo-selected code { font-size: 0.82rem; flex: 1; min-width: 0; overflow-wrap: anywhere; }
      .combo-selected-actions { display: flex; gap: 0.2rem; flex: none; }
      .combo-selected-actions .btn-ghost { padding: 0.15rem 0.4rem; min-height: auto; line-height: 1.1; font-size: 0.85rem; }
      .combo-picker { max-width: 640px; }
      .combo-picker input[type="search"] { width: 100%; box-sizing: border-box; }
      .combo-picker-list { margin-top: 0.75rem; max-height: 420px; overflow-y: auto; }
      .picker-group-head { position: sticky; top: 0; z-index: 1; background: var(--surface); display: flex; align-items: center; gap: 0.4rem; padding: 0.45rem 0; border-bottom: 1px solid var(--border-subtle); font-size: 0.8rem; font-weight: 600; color: var(--text-subtle); }
      .picker-group-head img { width: 14px; height: 14px; }
      .picker-row { display: flex; align-items: center; gap: 0.5rem; width: 100%; padding: 0.4rem 0.5rem; border: none; background: none; color: var(--text); text-align: left; font-size: 0.85rem; cursor: pointer; border-radius: 6px; }
      .picker-row:hover { background: var(--border-subtle); }
      .picker-check { width: 1em; text-align: center; color: var(--text-subtle); }
      .picker-caps { margin-left: auto; display: flex; gap: 0.5rem; font-size: 0.7rem; color: var(--text-subtle); flex-shrink: 0; }
    </style>

    <script>
    (function () {
      var LOAD_FAIL = "Daftar model gagal dimuat. Model tetap bisa ditulis manual di textarea.";
      var listEl = document.getElementById("combo-picker-list");
      var searchEl = document.getElementById("combo-picker-search");
      var activeTa = null;
      var catalog = null;

      function lines(ta) {
        return ta.value.split(/\\r?\\n/).map(function (s) { return s.trim(); }).filter(Boolean);
      }
      function writeLines(ta, arr) { ta.value = arr.join("\\n"); }

      function mutate(ta, fn) {
        var vals = lines(ta);
        fn(vals);
        writeLines(ta, vals);
        renderSelected(ta);
      }

      function mkBtn(text, title, disabled, onClick) {
        var b = document.createElement("button");
        b.type = "button";
        b.className = "btn btn-ghost";
        b.textContent = text;
        b.title = title;
        b.disabled = disabled;
        b.addEventListener("click", onClick);
        return b;
      }

      function capSpan(text) {
        var s = document.createElement("span");
        s.textContent = text;
        return s;
      }

      function renderSelected(ta) {
        var ul = ta.parentElement.querySelector(".combo-selected");
        if (!ul) return;
        ul.textContent = "";
        var vals = lines(ta);
        if (!vals.length) {
          var empty = document.createElement("li");
          empty.className = "cs-empty";
          empty.textContent = "Belum ada model dipilih";
          ul.appendChild(empty);
        }
        vals.forEach(function (v, i) {
          var li = document.createElement("li");
          var order = document.createElement("span");
          order.className = "cs-order";
          order.textContent = String(i + 1);
          var code = document.createElement("code");
          code.textContent = v;
          var actions = document.createElement("div");
          actions.className = "combo-selected-actions";
          actions.appendChild(mkBtn("↑", "Naikkan", i === 0, function () {
            mutate(ta, function (a) { var t = a[i - 1]; a[i - 1] = a[i]; a[i] = t; });
          }));
          actions.appendChild(mkBtn("↓", "Turunkan", i === vals.length - 1, function () {
            mutate(ta, function (a) { var t = a[i + 1]; a[i + 1] = a[i]; a[i] = t; });
          }));
          actions.appendChild(mkBtn("×", "Hapus", false, function () {
            mutate(ta, function (a) { a.splice(i, 1); });
            renderList();
          }));
          li.appendChild(order);
          li.appendChild(code);
          li.appendChild(actions);
          ul.appendChild(li);
        });
      }

      function renderList() {
        listEl.textContent = "";
        if (!catalog) { listEl.textContent = LOAD_FAIL; return; }
        var q = (searchEl.value || "").trim().toLowerCase();
        var sel = {};
        if (activeTa) lines(activeTa).forEach(function (v) { sel[v] = true; });
        var shown = 0;
        catalog.forEach(function (g) {
          var models = g.models.filter(function (m) {
            return !q || m.id.toLowerCase().indexOf(q) !== -1 ||
              g.name.toLowerCase().indexOf(q) !== -1 || g.id.toLowerCase().indexOf(q) !== -1;
          });
          if (!models.length) return;
          shown += models.length;
          var head = document.createElement("div");
          head.className = "picker-group-head";
          if (g.icon) {
            var img = document.createElement("img");
            img.src = g.icon;
            img.alt = "";
            head.appendChild(img);
          }
          var nm = document.createElement("span");
          nm.textContent = g.name;
          var cnt = document.createElement("span");
          cnt.textContent = "(" + models.length + ")";
          head.appendChild(nm);
          head.appendChild(cnt);
          listEl.appendChild(head);
          models.forEach(function (m) {
            var row = document.createElement("button");
            row.type = "button";
            row.className = "picker-row";
            var check = document.createElement("span");
            check.className = "picker-check";
            check.textContent = sel[m.id] ? "✓" : "";
            var idEl = document.createElement("code");
            idEl.textContent = m.id;
            var caps = document.createElement("span");
            caps.className = "picker-caps";
            if (m.custom) caps.appendChild(capSpan("custom"));
            if (m.capabilities && m.capabilities.vision) caps.appendChild(capSpan("vision"));
            if (m.capabilities && m.capabilities.reasoning) caps.appendChild(capSpan("reasoning"));
            if (m.context_length) {
              var ctx = document.createElement("span");
              ctx.textContent = Math.round(m.context_length / 1000) + "k";
              caps.appendChild(ctx);
            }
            row.appendChild(check);
            row.appendChild(idEl);
            row.appendChild(caps);
            row.addEventListener("click", function () { toggle(m.id); });
            listEl.appendChild(row);
          });
        });
        if (shown === 0) {
          var p = document.createElement("p");
          p.className = "hint";
          p.textContent = "Tidak ada model yang cocok.";
          listEl.appendChild(p);
        }
      }

      function toggle(id) {
        if (!activeTa) return;
        mutate(activeTa, function (a) {
          var i = a.indexOf(id);
          if (i === -1) a.push(id); else a.splice(i, 1);
        });
        renderList();
      }

      function load() {
        listEl.textContent = "Memuat daftar model…";
        fetch("/api/models", { cache: "no-store" })
          .then(function (r) { return r.ok ? r.json() : null; })
          .then(function (data) {
            catalog = data && Array.isArray(data.providers) ? data.providers : null;
            if (!catalog && activeTa) activeTa.hidden = false;
            renderList();
          })
          .catch(function () {
            catalog = null;
            if (activeTa) activeTa.hidden = false;
            listEl.textContent = LOAD_FAIL;
          });
      }

      function open(ta) {
        activeTa = ta;
        searchEl.value = "";
        openModal("model-picker-modal");
        load();
      }

      searchEl.addEventListener("input", renderList);
      document.querySelectorAll("[data-picker-open]").forEach(function (btn) {
        btn.addEventListener("click", function () {
          var wrap = btn.closest(".combo-chain-editor");
          var ta = wrap ? wrap.querySelector('textarea[name="models"]') : null;
          if (ta) open(ta);
        });
      });
      document.querySelectorAll(".combo-chain-editor").forEach(function (wrap) {
        var ta = wrap.querySelector('textarea[name="models"]');
        if (ta) {
          ta.hidden = true;
          renderSelected(ta);
        }
      });
    })();
    </script>
  `;

  return content;
}

export async function handleCreateCombo(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const models = parseMemberLines(body.models);

  try {
    createCombo({ name, models });
  } catch (err) {
    return c.redirect(`/dashboard/providers?tab=combos&error=1&msg=${encodeURIComponent(err.message)}`);
  }

  return c.redirect("/dashboard/providers?tab=combos&created=1");
}

/** The textarea is the source of truth for the chain; blank lines are dropped. */
function parseMemberLines(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function backWithError(c, message) {
  return c.redirect(`/dashboard/providers?tab=combos&error=1&msg=${encodeURIComponent(message)}`);
}

export async function handleUpdateCombo(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();

  try {
    const payload = { strategy: String(body.strategy || "").trim() };
    if (body.models !== undefined) payload.models = parseMemberLines(body.models);
    updateCombo(name, payload);
  } catch (err) {
    return backWithError(c, err.message);
  }

  return c.redirect("/dashboard/providers?tab=combos&updated=1");
}

export async function handleReorderCombo(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const direction = String(body.direction || "").trim();

  try {
    moveComboMember(name, Number.parseInt(body.index, 10), direction);
  } catch (err) {
    return backWithError(c, err.message);
  }

  return c.redirect("/dashboard/providers?tab=combos&updated=1");
}

export async function handleRenameCombo(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();
  const newName = String(body.new_name || "").trim();

  try {
    renameCombo(name, newName);
  } catch (err) {
    return backWithError(c, err.message);
  }

  return c.redirect("/dashboard/providers?tab=combos&updated=1");
}

export async function handleToggleCombo(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();

  const current = getComboByName(name);
  if (!current) return backWithError(c, `combo "${name}" tidak ada`);
  setComboEnabled(name, current.enabled !== 1);

  return c.redirect("/dashboard/providers?tab=combos&updated=1");
}

export async function handleDeleteCombo(c) {
  const body = await c.req.parseBody();
  const name = String(body.name || "").trim();

  try {
    deleteCombo(name);
  } catch (err) {
    return backWithError(c, err.message);
  }

  return c.redirect("/dashboard/providers?tab=combos&deleted=1");
}
