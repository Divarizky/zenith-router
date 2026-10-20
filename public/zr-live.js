// Mesin swap tanpa reload untuk seluruh form dashboard: submit dikirim via fetch,
// lalu isi <main> diganti dengan hasilnya. Semua listener memakai delegation di
// document dan script di-body dieksekusi ulang setelah swap, jadi elemen baru
// tetap berfungsi tanpa reload browser.
(function () {
  if (window.__zrLiveReady) return;
  window.__zrLiveReady = true;

  window.__zrSwapCleanups = window.__zrSwapCleanups || [];
  window.__zrSwapInit = window.__zrSwapInit || [];

  var TRANSIENT_PARAMS = ["import", "sync", "saved", "status", "notice", "count"];

  function toast(message, isError) {
    var el = document.createElement("div");
    el.className = "zr-toast" + (isError ? " zr-toast-error" : "");
    el.setAttribute("role", isError ? "alert" : "status");
    el.textContent = message;
    document.body.appendChild(el);
    setTimeout(function () { el.remove(); }, 5000);
  }
  window.zrToast = toast;

  // Cleanup dijalankan sebelum <main> dibuang: menutup EventSource, interval,
  // dan timer halaman lama supaya tidak menulis ke elemen yang sudah lepas.
  function runCleanups() {
    window.__zrSwapCleanups.splice(0).forEach(function (fn) {
      try { fn(); } catch (e) {}
    });
  }

  function runInits() {
    window.__zrSwapInit.forEach(function (fn) {
      try { fn(); } catch (e) {}
    });
  }

  function cleanUrl(href) {
    try {
      var url = new URL(href, window.location.href);
      TRANSIENT_PARAMS.forEach(function (k) { url.searchParams.delete(k); });
      return url.pathname + (url.searchParams.toString() ? "?" + url.searchParams.toString() : "");
    } catch (e) {
      return href;
    }
  }

  // innerHTML tidak mengeksekusi <script>, jadi buat ulang nodenya agar
  // script halaman (mis. polling Usage) berjalan kembali dengan elemen baru.
  // Script bertanda data-once (engine dan script dasar layout) dilewati.
  function reexecScripts(root) {
    root.querySelectorAll("script").forEach(function (oldScript) {
      if (oldScript.hasAttribute("data-once")) return;
      var el = document.createElement("script");
      for (var i = 0; i < oldScript.attributes.length; i++) {
        el.setAttributeNode(oldScript.attributes[i].cloneNode(true));
      }
      el.textContent = oldScript.textContent;
      oldScript.replaceWith(el);
    });
  }

  function swapFromDoc(doc, finalUrl, keepScroll) {
    var nextMain = doc.querySelector("main");
    var currentMain = document.querySelector("main");
    if (!nextMain || !currentMain) {
      window.location.assign(finalUrl);
      return;
    }
    var scrollY = window.scrollY;
    runCleanups();
    if (doc.title) document.title = doc.title;
    currentMain.innerHTML = nextMain.innerHTML;
    reexecScripts(document.body);
    runInits();
    window.history.replaceState({}, document.title, cleanUrl(finalUrl));
    window.scrollTo(0, keepScroll ? scrollY : 0);
  }

  document.addEventListener("submit", function (event) {
    if (event.defaultPrevented) return;
    var form = event.target;
    if (!form || form.tagName !== "FORM") return;
    if (form.hasAttribute("data-native") || form.getAttribute("data-busy")) return;

    var submitter = event.submitter || null;
    // Baca atribut, bukan properti: submitter.formAction mengembalikan URL halaman
    // saat atribut formaction tidak ada, dan form.action bisa tertutup input bernama "action".
    var action = (submitter && submitter.getAttribute("formaction")) || form.getAttribute("action") || window.location.href;
    var url = new URL(action, window.location.href);
    if (url.origin !== window.location.origin) return; // submit lintas host dibiarkan normal

    event.preventDefault();
    var method = ((submitter && submitter.getAttribute("formmethod")) || form.getAttribute("method") || "GET").toUpperCase();
    var btn = submitter || form.querySelector('button[type="submit"], input[type="submit"]');
    if (btn) { btn.disabled = true; btn.classList.add("is-busy"); }
    form.setAttribute("data-busy", "1");

    var init = { method: method, redirect: "follow", credentials: "same-origin", headers: { "X-Zenith-Ajax": "1" } };
    // FormData(form) saja tidak memuat name/value tombol yang diklik (mis. direction=up).
    var data = new FormData(form);
    if (submitter && submitter.name) data.append(submitter.name, submitter.value || "");
    if (method === "GET") {
      data.forEach(function (value, key) {
        if (typeof value === "string") url.searchParams.append(key, value);
      });
    } else {
      init.body = data;
    }

    fetch(url, init)
      .then(function (res) {
        var type = res.headers.get("content-type") || "";
        if (type.indexOf("application/json") !== -1) {
          return res.json().then(function (data) {
            if (!res.ok || (data && data.ok === false)) {
              toast((data && (data.error || data.msg || data.text)) || "Permintaan gagal (HTTP " + res.status + ").", true);
            } else if (data && data.text) {
              toast(data.text, false);
            }
          });
        }
        return res.text().then(function (html) {
          var finalUrl = res.url || url.href;
          var doc = new DOMParser().parseFromString(html, "text/html");
          if (!doc.querySelector("main")) {
            // Halaman di luar layout. Halaman login admin berarti sesi berakhir:
            // navigasi ulang supaya form login tampil dengan tujuan yang benar.
            if (doc.querySelector('form[action="/dashboard/login"]')) {
              window.location.reload();
            } else {
              toast("Permintaan ditolak (HTTP " + res.status + ").", true);
            }
            return;
          }
          var samePage = new URL(finalUrl, window.location.href).pathname === window.location.pathname;
          swapFromDoc(doc, finalUrl, samePage);
        });
      })
      .catch(function () {
        toast("Tidak bisa terhubung ke Zenith Router.", true);
      })
      .finally(function () {
        form.removeAttribute("data-busy");
        if (btn) { btn.disabled = false; btn.classList.remove("is-busy"); }
      });
  });
})();
