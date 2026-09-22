// ==UserScript==
// @name         Tilda — Monaco HTML + публикация
// @namespace    local.tilda.monaco
// @version      1.1.10
// @description  Monaco latest, темы, Prettier, минификация, публикация и копирование ID/классов блоков.
// @match        https://tilda.ru/page/*
// @match        https://tilda.cc/page/*
// @run-at       document-end
// @noframes
// @sandbox      raw
// @grant        unsafeWindow
// @grant        GM_registerMenuCommand
// @grant        GM_openInTab
// @grant        GM_getResourceText
// @resource     tmlStyles file:///Users/golygin/Downloads/tilda-monaco/src/tilda-monaco.css
// ==/UserScript==

// Monaco обновляется независимо от менеджера. У этого локального скрипта пока нет URL автообновления.
(function (window) {
  const css = GM_getResourceText("tmlStyles"),
    styledDocuments = new WeakMap();

  // Share one stylesheet per document; remove it when its last consumer stops.
  function useStyles(doc) {
    let entry = styledDocuments.get(doc);
    if (!entry) {
      const style = doc.createElement("style");
      style.id = "tml-styles";
      style.textContent = css;
      doc.head.append(style);
      entry = { style, users: 0 };
      styledDocuments.set(doc, entry);
    }
    entry.users++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--entry.users === 0) {
        entry.style.remove();
        styledDocuments.delete(doc);
      }
    };
  }

  // Tilda Monaco HTML
  // Monaco latest is resolved once per page; editor/CSS/workers use that exact version.
  (function installTildaMonaco(frameMain) {
    "use strict";
    if (
      window !== window.top ||
      !/^https:\/\/tilda\.(ru|cc)\/page\//.test(location.href)
    )
      return;
    if (!document.body) {
      document.addEventListener(
        "DOMContentLoaded",
        () => installTildaMonaco(frameMain),
        { once: true },
      );
      return;
    }
    window.__tildaMonaco?.dispose();
    const releaseStyles = useStyles(document);
    const entries = new Map(),
      panels = new Map(),
      abort = new AbortController();
    let versionPromise,
      stopped = false;
    const panelSelector = "#editformsxl .editrecordcontent_container_code";
    function sizeLoading(panel) {
      panel.style.setProperty(
        "--tml-loading-height",
        Math.max(280, window.innerHeight - panel.getBoundingClientRect().top) + "px",
      );
    }
    function finishLoading(panel, phase) {
      const pending = panels.get(panel);
      if (!pending) return;
      clearTimeout(pending.timeout);
      pending.phase = phase;
      pending.loader.remove();
      panel.classList.remove("tml-pending");
      if (pending.busy === null) panel.removeAttribute("aria-busy");
      else panel.setAttribute("aria-busy", pending.busy);
      for (const name of ["height", "bg", "fg"])
        panel.style.removeProperty("--tml-loading-" + name);
    }
    function forgetPanel(panel) {
      finishLoading(panel, "closed");
      panels.delete(panel);
    }
    function preparePanel(panel) {
      if (panels.has(panel)) return;
      let theme = "vs";
      try { theme = localStorage.getItem("tml-editor-theme-v1") || theme; } catch {}
      const dark = theme === "vs-dark" || theme === "hc-black" ||
        (theme === "auto" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      const loader = document.createElement("div");
      loader.className = "tml-loading";
      loader.setAttribute("role", "status");
      loader.textContent = "Загрузка редактора…";
      const pending = { loader, phase: "pending", busy: panel.getAttribute("aria-busy") };
      panels.set(panel, pending);
      panel.classList.add("tml-pending");
      panel.setAttribute("aria-busy", "true");
      panel.style.setProperty("--tml-loading-bg", dark ? "#1e1e1e" : "#fff");
      panel.style.setProperty("--tml-loading-fg", dark ? "#aaa" : "#666");
      sizeLoading(panel);
      panel.append(loader);
      // A missing/changed native Ace initializer must never leave the panel hidden.
      pending.timeout = setTimeout(() => finishLoading(panel, "fallback"), 12000);
    }
    async function latest() {
      if (!versionPromise)
        versionPromise = fetch(
          "https://registry.npmjs.org/monaco-editor/latest",
          {
            cache: "no-store",
            credentials: "omit",
            referrerPolicy: "no-referrer",
            signal: AbortSignal.timeout(12000),
          },
        )
          .then(async (r) => {
            if (!r.ok) throw new Error("npm HTTP " + r.status);
            const { version } = await r.json();
            if (!/^\d+\.\d+\.\d+$/.test(version))
              throw new Error("No stable Monaco release");
            return version;
          })
          .catch((e) => {
            versionPromise = undefined;
            throw e;
          });
      return versionPromise;
    }
    function resize(e) {
      if (e.active) {
        const height =
          Math.max(
            280,
            window.innerHeight - e.frame.getBoundingClientRect().top,
          ) + "px";
        if (e.frame.style.height !== height) e.frame.style.height = height;
      }
    }
    function restore(e) {
      e.element.style.setProperty("display", e.display, e.priority);
      if (!e.display) e.element.style.removeProperty("display");
      e.active = false;
      finishLoading(e.panel, "fallback");
      if (e.element.isConnected) e.ace.resize(true);
    }
    function dispose(e) {
      if (!entries.delete(e.element)) return;
      clearTimeout(e.timeout);
      e.ace.off("change", e.onAce);
      try {
        (e.frameWindow || e.frame.contentWindow)?.__tmlDispose?.();
      } catch {}
      e.frame.remove();
      e.frameWindow = null;
      restore(e);
    }
    function fail(e, error) {
      if (!entries.has(e.element) || e.error) return;
      clearTimeout(e.timeout);
      e.error = String(error?.message || error);
      try {
        (e.frameWindow || e.frame.contentWindow)?.__tmlDispose?.();
      } catch {}
      e.editor = null;
      e.monaco = null;
      e.frame.remove();
      e.frameWindow = null;
      restore(e);
      console.warn("[Tilda Monaco] Ace is available:", e.error);
    }
    async function mount(element) {
      const ace = element.env?.editor,
        panel = element.closest(panelSelector),
        textarea = element.parentElement?.querySelector(
          "textarea.js-aceeditor",
        );
      if (!ace || !textarea || entries.has(element)) return;
      if (panel) preparePanel(panel);
      const pending = panels.get(panel);
      if (pending?.phase === "fallback") return;
      if (pending) clearTimeout(pending.timeout);
      const frame = document.createElement("iframe");
      frame.title = "Monaco — HTML";
      frame.referrerPolicy = "no-referrer";
      frame.className = "tml-frame";
      element.after(frame);
      const e = {
        element,
        panel,
        ace,
        textarea,
        frame,
        display: element.style.getPropertyValue("display"),
        priority: element.style.getPropertyPriority("display"),
        active: false,
        syncing: false,
        editor: null,
        error: null,
      };
      entries.set(element, e);
      e.timeout = setTimeout(() => fail(e, "Editor load timeout"), 30000);
      e.onAce = (delta) => {
        if (e.syncing || !e.editor) return;
        e.syncing = true;
        try {
          const r =
            delta.action === "insert"
              ? new e.monaco.Range(
                  delta.start.row + 1,
                  delta.start.column + 1,
                  delta.start.row + 1,
                  delta.start.column + 1,
                )
              : new e.monaco.Range(
                  delta.start.row + 1,
                  delta.start.column + 1,
                  delta.end.row + 1,
                  delta.end.column + 1,
                );
          e.editor.getModel().pushEditOperations(
            [],
            [
              {
                range: r,
                text: delta.action === "insert" ? delta.lines.join("\n") : "",
                forceMoveMarkers: true,
              },
            ],
            () => null,
          );
          textarea.value = ace.getValue();
        } finally {
          e.syncing = false;
        }
      };
      ace.on("change", e.onAce);
      try {
        e.version = await latest();
        if (!entries.has(element) || !element.isConnected) return;
        frame.srcdoc =
          '<!doctype html><html class="tml-editor-document"><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"></head><body><div id="editor"></div><script type="module">(' +
          frameMain.toString() +
          ")(" +
          JSON.stringify(e.version) +
          ");<\/script></body></html>";
      } catch (error) {
        if (entries.has(element)) fail(e, error);
      }
    }
    function scan() {
      if (stopped) return;
      for (const [el, e] of entries) if (!el.isConnected) dispose(e);
      for (const panel of panels.keys()) if (!panel.isConnected) forgetPanel(panel);
      document.querySelectorAll(panelSelector).forEach(preparePanel);
      document
        .querySelectorAll('.ace_editor[id^="aceeditor"]')
        .forEach((el) => {
          if (!entries.has(el) && el.getClientRects().length) mount(el);
        });
    }
    const editorSelector = '.ace_editor[id^="aceeditor"]';
    const observer = new MutationObserver((records) => {
      const relevant = records.some((record) => {
        const editor = record.target.closest?.(editorSelector);
        if (editor) return !entries.has(editor);
        return [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node.nodeType === 1 &&
            (node.matches(editorSelector + ", " + panelSelector) ||
              node.querySelector(editorSelector + ", " + panelSelector)),
        );
      });
      if (!relevant) return;
      // MutationObserver already batches changes before the browser paints.
      scan();
    });
    observer.observe(document.body, { childList: true, subtree: true });
    // Tilda dispatches open before drawing fields, and close before removing the iframe.
    window.addEventListener("edrec:record-panel-open", () => {
      document.querySelectorAll(panelSelector).forEach(preparePanel);
    }, { signal: abort.signal });
    window.addEventListener("edrec:record-panel-close", (event) => {
      const recordId = String(event.detail?.recordId || "");
      for (const e of entries.values())
        if (e.element.closest("form")?.dataset.recId === recordId) dispose(e);
      for (const panel of panels.keys())
        if (panel.closest("form")?.dataset.recId === recordId) forgetPanel(panel);
    }, { signal: abort.signal });
    window.addEventListener("resize", () => {
      entries.forEach(resize);
      for (const [panel, pending] of panels)
        if (pending.phase === "pending") sizeLoading(panel);
    }, {
      signal: abort.signal,
    });
    window.__tildaMonaco = {
      scan,
      status: () =>
        [...entries.values()].map((e) => ({
          id: e.element.id,
          version: e.version,
          active: e.active,
          error: e.error,
          length: e.ace.getValue().length,
        })),
      bridge(frame) {
        const e = [...entries.values()].find((e) => e.frame === frame);
        if (!e) return null;
        return {
          alive: () =>
            entries.has(e.element) && e.element.isConnected && !e.error,
          addStyles: () => useStyles(e.frame.contentDocument),
          notice: (text, error) => window.__tildaEditorTools?.notice(text, error),
          getValue: () => e.ace.getValue(),
          ready(editor, monaco) {
            if (!entries.has(e.element) || e.error) return;
            e.editor = editor;
            e.monaco = monaco;
            e.frameWindow = e.frame.contentWindow;
            clearTimeout(e.timeout);
            e.element.style.setProperty("display", "none", "important");
            e.frame.style.visibility = "visible";
            e.active = true;
            finishLoading(e.panel, "ready");
            resize(e);
            editor.focus();
            console.info("[Tilda Monaco] latest stable " + e.version);
            window.dispatchEvent(
              new CustomEvent("tml:ready", { detail: e.frame }),
            );
          },
          changed(event) {
            if (e.syncing || !e.editor) return;
            e.syncing = true;
            try {
              for (const c of [...event.changes].sort(
                (a, b) => b.rangeOffset - a.rangeOffset,
              ))
                e.ace.session.replace(
                  {
                    start: {
                      row: c.range.startLineNumber - 1,
                      column: c.range.startColumn - 1,
                    },
                    end: {
                      row: c.range.endLineNumber - 1,
                      column: c.range.endColumn - 1,
                    },
                  },
                  c.text,
                );
              const value = e.editor.getValue();
              if (e.ace.getValue() !== value) e.ace.setValue(value, -1);
              e.textarea.value = value;
              e.textarea.dispatchEvent(new Event("input", { bubbles: true }));
              e.textarea.dispatchEvent(new Event("change", { bubbles: true }));
              window.edrec_isChanged = true;
            } finally {
              e.syncing = false;
            }
          },
          save() {
            e.element
              .closest("form")
              ?.querySelector("button[onclick*=\"sendForm('update'\"]")
              ?.click();
          },
          failed: (error) => fail(e, error),
        };
      },
      dispose() {
        stopped = true;
        observer.disconnect();
        abort.abort();
        [...entries.values()].forEach(dispose);
        [...panels.keys()].forEach(forgetPanel);
        releaseStyles();
        delete window.__tildaMonaco;
      },
    };
    scan();
  })(async function (version) {
    const bridge = parent.__tildaMonaco?.bridge(window.frameElement);
    if (!bridge) return;
    const base = "https://esm.sh/monaco-editor@" + version,
      workers = new Map(),
      disposables = [{ dispose: bridge.addStyles() }];
    let editor,
      model,
      disposed = false,
      diagnosticsTimer;
    function createWorker(source, name) {
      const url = URL.createObjectURL(
        new Blob([source], { type: "application/javascript" }),
      );
      try {
        const worker = new Worker(url, { type: "module", name });
        workers.set(worker, url);
        return worker;
      } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
      }
    }
    function releaseWorker(worker) {
      if (!workers.has(worker)) return;
      worker.terminate();
      URL.revokeObjectURL(workers.get(worker));
      workers.delete(worker);
    }
    window.__tmlDispose = () => {
      if (disposed) return;
      disposed = true;
      clearTimeout(diagnosticsTimer);
      disposables.forEach((d) => d.dispose());
      editor?.dispose();
      model?.dispose();
      for (const worker of workers.keys()) releaseWorker(worker);
    };
    window.addEventListener("pagehide", window.__tmlDispose, { once: true });
    window.MonacoEnvironment = {
      getWorker(_, label) {
        const paths = {
          html: "language/html/html.worker",
          handlebars: "language/html/html.worker",
          razor: "language/html/html.worker",
          css: "language/css/css.worker",
          scss: "language/css/css.worker",
          less: "language/css/css.worker",
          javascript: "language/typescript/ts.worker",
          typescript: "language/typescript/ts.worker",
          json: "language/json/json.worker",
        };
        const path = paths[label] || "editor/editor.worker";
        return createWorker(
          "import " +
            JSON.stringify(base + "/esm/vs/" + path + "?bundle&target=es2022") +
            ";",
          "monaco-" + label + "-" + version,
        );
      },
    };
    try {
      // Use the standard browser process shim; the CDN's Node shim masks the real OS.
      const imports = document.createElement("script");
      imports.type = "importmap";
      imports.textContent = JSON.stringify({
        imports: {
          "node:process": "https://cdn.jsdelivr.net/npm/process@0.11.10/browser.js/+esm",
        },
      });
      document.head.append(imports);
      const styles = new Promise((resolve, reject) => {
        const l = document.createElement("link");
        l.rel = "stylesheet";
        l.href = base + "?bundle&target=es2022&css";
        l.onload = resolve;
        l.onerror = () => reject(new Error("Monaco CSS failed"));
        document.head.append(l);
      });
      const [monaco] = await Promise.all([
        import(base + "?bundle&target=es2022&external=node:process"),
        styles,
      ]);
      if (disposed || !bridge.alive()) return;
      window.monaco = monaco;
      monaco.html.htmlDefaults.setModeConfiguration({
        ...monaco.html.htmlDefaults.modeConfiguration,
        documentFormattingEdits: false,
        documentRangeFormattingEdits: true,
      });
      monaco.typescript.javascriptDefaults.setDiagnosticsOptions({
        noSemanticValidation: true,
        noSyntaxValidation: true,
        noSuggestionDiagnostics: true,
      });
      // Diagnostics are mapped back to HTML below; do not validate hidden mirrors twice.
      monaco.css.cssDefaults.setModeConfiguration({
        ...monaco.css.cssDefaults.modeConfiguration,
        diagnostics: false,
      });
      model = monaco.editor.createModel(
        bridge.getValue(),
        "html",
        monaco.Uri.parse("inmemory://tilda/block.html"),
      );
      editor = monaco.editor.create(document.getElementById("editor"), {
        model,
        theme: "vs",
        automaticLayout: true,
        fontSize: 14,
        lineHeight: 22,
        fontFamily: "Menlo, Monaco, Consolas, monospace",
        minimap: { enabled: true },
        wordWrap: "on",
        tabSize: 4,
        insertSpaces: true,
        autoIndent: "full",
        autoIndentOnPaste: true,
        formatOnPaste: true,
        renderWhitespace: "trailing",
        scrollBeyondLastLine: false,
        padding: { top: 12, bottom: 12 },
        ariaLabel: "HTML-код блока Тильды",
        quickSuggestions: { other: true, comments: false, strings: true },
        suggestOnTriggerCharacters: true,
        parameterHints: { enabled: true },
        linkedEditing: true,
        folding: true,
        colorDecorators: true,
        bracketPairColorization: { enabled: true },
        guides: { bracketPairs: true },
        autoClosingBrackets: "languageDefined",
        autoClosingQuotes: "languageDefined",
        formatOnType: true,
      });
      window.editor = editor;
      editor.onDidChangeModelContent((event) => {
        bridge.changed(event);
        monaco.editor.setModelMarkers(model, "prettier", []);
        clearTimeout(diagnosticsTimer);
        diagnosticsTimer = setTimeout(validateEmbedded, 600);
      });
      editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
        bridge.save(),
      );

      // Prettier runs locally in a worker. Editable code never goes to a CDN.
      async function prettierMain() {
        let modules;
        self.onmessage = async ({ data }) => {
          try {
            modules ||= Promise.all(
              [
                "standalone",
                "plugins/html",
                "plugins/babel",
                "plugins/estree",
                "plugins/postcss",
              ].map(
                (p) =>
                  import(
                    "https://cdn.jsdelivr.net/npm/prettier@3.9.6/" + p + ".mjs"
                  ),
              ),
            );
            const [prettier, ...plugins] = await modules;
            const text = await prettier.format(data.text, {
              parser: "html",
              plugins,
              tabWidth: data.tabSize,
              useTabs: !data.insertSpaces,
              printWidth: 100,
              htmlWhitespaceSensitivity: "css",
              embeddedLanguageFormatting: "auto",
              endOfLine: "auto",
            });
            self.postMessage({ id: data.id, text });
          } catch (e) {
            modules = undefined;
            self.postMessage({ id: data.id, error: e.message, loc: e.loc });
          }
        };
      }
      let prettierWorker,
        requestId = 0;
      const pending = new Map();
      function beautify(text, options) {
        if (!prettierWorker) {
          prettierWorker = createWorker(
            "(" + prettierMain.toString() + ")();",
            "prettier-html",
          );
          prettierWorker.onmessage = ({ data }) => {
            const request = pending.get(data.id);
            if (!request) return;
            pending.delete(data.id);
            clearTimeout(request.timer);
            data.error
              ? request.reject(
                  Object.assign(new Error(data.error), { loc: data.loc }),
                )
              : request.resolve(data.text);
          };
          prettierWorker.onerror = () => {
            for (const request of pending.values()) {
              clearTimeout(request.timer);
              request.reject(new Error("Prettier worker failed"));
            }
            pending.clear();
            releaseWorker(prettierWorker);
            prettierWorker = null;
          };
        }
        return new Promise((resolve, reject) => {
          const id = ++requestId,
            timer = setTimeout(() => {
              pending.delete(id);
              reject(
                new Error(
                  "Prettier download timed out; try Format Document again",
                ),
              );
            }, 30000);
          pending.set(id, { resolve, reject, timer });
          prettierWorker.postMessage({ id, text, ...options });
        });
      }
      disposables.push({
        dispose() {
          for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.resolve("");
          }
          pending.clear();
        },
      });
      const formatter = {
        displayName: "Prettier (HTML, CSS, JavaScript)",
        async provideDocumentFormattingEdits(document, options, token) {
          const versionId = document.getVersionId();
          try {
            const text = await beautify(document.getValue(), options);
            if (
              disposed ||
              token.isCancellationRequested ||
              document.getVersionId() !== versionId
            )
              return [];
            monaco.editor.setModelMarkers(document, "prettier", []);
            return [{ range: document.getFullModelRange(), text }];
          } catch (e) {
            if (!disposed && document.getVersionId() === versionId) {
              const p = e.loc?.start || e.loc || { line: 1, column: 1 };
              monaco.editor.setModelMarkers(document, "prettier", [
                {
                  severity: monaco.MarkerSeverity.Error,
                  message: e.message,
                  source: "Prettier",
                  startLineNumber: p.line || 1,
                  startColumn: p.column || 1,
                  endLineNumber: p.line || 1,
                  endColumn: (p.column || 1) + 1,
                },
              ]);
            }
            return [];
          }
        },
      };
      disposables.push(
        monaco.languages.registerDocumentFormattingEditProvider(
          "html",
          formatter,
        ),
      );

      // Minify HTML on demand; edits share Monaco's normal undo stack.
      (function installMinification() {
        const busy = editor.createContextKey("tmlMinifying", false),
          encoder = new TextEncoder();
        let worker,
          pending,
          sequence = 0,
          dead = false;

        function minifierMain() {
          let library;
          self.onmessage = async ({ data }) => {
            try {
              library ||= Promise.all([
                import("https://cdn.jsdelivr.net/npm/html-minifier-terser@7.2.0/dist/htmlminifier.esm.bundle.min.js"),
                import("https://cdn.jsdelivr.net/npm/css-tree@3.2.1/dist/csstree.esm.js"),
              ]);
              const [{ minify }, cssTree] = await library;
              const text = await minify(data.text, {
                // HTML whitespace may be significant because of page CSS.
                collapseWhitespace: false,
                removeComments: true,
                caseSensitive: true,
                keepClosingSlash: true,
                includeAutoGeneratedTags: false,
                // Serialize syntax only: no rule merging, URL loading or rewriting.
                // CSSTree preserves unrecognized syntax in Raw nodes.
                minifyCSS(text, type) {
                  const context = type === "inline" ? "declarationList"
                    : type === "media" ? "mediaQueryList" : "stylesheet";
                  // String serialization can decode a CSS escape into </style>.
                  return cssTree.generate(cssTree.parse(text, { context }))
                    .replace(/<(?=\/style)/gi, "\\3c ");
                },
                minifyJS: {
                  compress: false,
                  mangle: false,
                  format: { comments: /^!|@preserve|@license|@cc_on/i },
                },
              });
              self.postMessage({ id: data.id, text });
            } catch (error) {
              self.postMessage({ id: data.id, error: error.message || String(error) });
            }
          };
        }

        function stop(error) {
          releaseWorker(worker);
          worker = null;
          if (!pending) return;
          const request = pending;
          pending = null;
          clearTimeout(request.timer);
          request.reject(error);
        }

        function minify(text) {
          if (!worker) {
            const active = worker = createWorker(
              "(" + minifierMain.toString() + ")();",
              "tml-minify-html",
            );
            active.onmessage = ({ data }) => {
              if (worker !== active || pending?.id !== data.id) return;
              if (data.error || typeof data.text !== "string") {
                stop(new Error(data.error || "Минификатор вернул некорректный результат."));
                return;
              }
              const request = pending;
              pending = null;
              clearTimeout(request.timer);
              request.resolve(data.text);
            };
            active.onerror = active.onmessageerror = () => {
              if (worker === active)
                stop(new Error("Не удалось запустить минификатор. Попробуйте ещё раз."));
            };
          }
          return new Promise((resolve, reject) => {
            const id = ++sequence;
            pending = {
              id, resolve, reject,
              timer: setTimeout(() => stop(new Error(
                "Минификация не завершилась за 30 секунд. Попробуйте ещё раз.",
              )), 30000),
            };
            try {
              worker.postMessage({ id, text });
            } catch (error) {
              stop(error);
            }
          });
        }

        const alive = () => !dead && !disposed && bridge.alive();
        const readonly = () => editor.getOption(monaco.editor.EditorOption.readOnly);
        async function run() {
          if (!alive() || busy.get() || readonly() || editor.getModel() !== model) return;
          const input = model.getValue(),
            revision = model.getVersionId();
          if (!input.trim()) {
            bridge.notice("В редакторе нет кода для минификации.");
            return;
          }
          busy.set(true);
          bridge.notice("Минифицирую HTML…");
          try {
            const output = await minify(input);
            if (!alive()) return;
            if (editor.getModel() !== model || model.getVersionId() !== revision || readonly()) {
              bridge.notice("Редактор изменился во время обработки. Запустите минификацию ещё раз.");
              return;
            }
            const before = encoder.encode(input).length,
              after = encoder.encode(output).length;
            if (after >= before) {
              bridge.notice("Код уже достаточно компактный.");
              return;
            }
            editor.pushUndoStop();
            const applied = editor.executeEdits("tml.minifyHTML", [{
              range: model.getFullModelRange(),
              text: output,
              forceMoveMarkers: true,
            }], [new monaco.Selection(1, 1, 1, 1)]);
            editor.pushUndoStop();
            if (!applied) throw new Error("Редактор не применил изменения.");
            editor.focus();
            bridge.notice(
              `Минификация: −${Math.round((1 - after / before) * 100)}% (${before} → ${after} байт).`,
            );
          } catch (error) {
            if (alive()) bridge.notice("Не удалось минифицировать HTML: " + error.message, true);
          } finally {
            if (!dead) busy.set(false);
          }
        }
        disposables.push(editor.addAction({
          id: "tml.minifyHTML",
          label: "Минифицировать HTML / Minify HTML",
          precondition: "!editorReadonly && !tmlMinifying",
          contextMenuGroupId: "1_modification",
          contextMenuOrder: 3,
          run,
        }), {
          dispose() {
            dead = true;
            busy.reset();
            stop(new Error("Редактор закрыт."));
          },
        });
      })();

      // Reuse Monaco's HTML tokenization to mirror only embedded JS and CSS.
      // Whitespace preserves UTF-16 offsets, line numbers and the original HTML.
      const jsModel = monaco.editor.createModel(
        "",
        "javascript",
        monaco.Uri.parse("inmemory://tilda/embedded.js"),
      );
      const cssModel = monaco.editor.createModel(
        "",
        "css",
        monaco.Uri.parse("inmemory://tilda/embedded.css"),
      );
      disposables.push(jsModel, cssModel);
      let cacheVersion = -1,
        tokenRows = [],
        cssModulePromise,
        cssTree,
        cssTreeVersion = -1;
      function syncEmbedded() {
        if (cacheVersion === model.getVersionId()) return;
        cacheVersion = model.getVersionId();
        const lines = model.getLinesContent();
        tokenRows = monaco.editor.tokenize(model.getValue(), "html");
        for (const [language, mirror] of [
          ["javascript", jsModel],
          ["css", cssModel],
        ]) {
          const text = lines
            .map((line, row) => {
              const tokens = tokenRows[row] || [];
              let out = "";
              for (let i = 0; i < tokens.length; i++) {
                const token = tokens[i],
                  end = tokens[i + 1]?.offset ?? line.length,
                  chunk = line.slice(token.offset, end);
                out +=
                  token.language === language
                    ? chunk
                    : " ".repeat(chunk.length);
              }
              return tokens.length ? out : " ".repeat(line.length);
            })
            .join(model.getEOL());
          if (mirror.getValue() !== text) mirror.setValue(text);
        }
      }
      function region(position) {
        syncEmbedded();
        const row = tokenRows[position.lineNumber - 1] || [];
        const offset = position.column - 1;
        let current, previous;
        for (const token of row) {
          if (token.offset > offset) break;
          previous = current;
          current = token;
        }
        if (
          current?.language === "html" &&
          current.offset === offset &&
          previous?.language !== "html"
        )
          return previous?.language;
        return current?.language || "html";
      }
      function rangeFromOffsets(start, length) {
        const a = model.getPositionAt(start),
          b = model.getPositionAt(start + length);
        return new monaco.Range(a.lineNumber, a.column, b.lineNumber, b.column);
      }
      const cssDocument = () => ({
        uri: cssModel.uri.toString(),
        languageId: "css",
        version: cssModel.getVersionId(),
        lineCount: cssModel.getLineCount(),
        getText: (r) =>
          r
            ? cssModel.getValueInRange(
                new monaco.Range(
                  r.start.line + 1,
                  r.start.character + 1,
                  r.end.line + 1,
                  r.end.character + 1,
                ),
              )
            : cssModel.getValue(),
        positionAt: (o) => {
          const p = cssModel.getPositionAt(o);
          return { line: p.lineNumber - 1, character: p.column - 1 };
        },
        offsetAt: (p) =>
          cssModel.getOffsetAt({
            lineNumber: p.line + 1,
            column: p.character + 1,
          }),
      });
      async function cssService() {
        cssModulePromise ||=
          import("https://esm.sh/vscode-css-languageservice@6.3.10?bundle&target=es2022")
            .then((m) => m.getCSSLanguageService())
            .catch((e) => {
              cssModulePromise = undefined;
              throw e;
            });
        return cssModulePromise;
      }
      function cssStylesheet(service, document) {
        if (cssTreeVersion !== document.version) {
          cssTree = service.parseStylesheet(document);
          cssTreeVersion = document.version;
        }
        return cssTree;
      }
      async function jsService() {
        const factory = await monaco.typescript.getJavaScriptWorker();
        return factory(jsModel.uri);
      }
      const lspRange = (r) =>
        new monaco.Range(
          r.start.line + 1,
          r.start.character + 1,
          r.end.line + 1,
          r.end.character + 1,
        );
      const cssKinds = [
        "Text",
        "Text",
        "Method",
        "Function",
        "Constructor",
        "Field",
        "Variable",
        "Class",
        "Interface",
        "Module",
        "Property",
        "Unit",
        "Value",
        "Enum",
        "Keyword",
        "Snippet",
        "Color",
        "File",
        "Reference",
        "Folder",
        "EnumMember",
        "Constant",
        "Struct",
        "Event",
        "Operator",
        "TypeParameter",
      ];
      const parts = (p) => (p || []).map((p) => p.text).join("");
      const completionProvider = {
        triggerCharacters: [".", " ", ":", "-", '"', "'"],
        async provideCompletionItems(document, position, context, token) {
          const language = region(position),
            versionId = document.getVersionId(),
            word = document.getWordUntilPosition(position);
          const range = new monaco.Range(
            position.lineNumber,
            word.startColumn,
            position.lineNumber,
            word.endColumn,
          );
          try {
            if (language === "javascript") {
              const worker = await jsService(),
                offset = document.getOffsetAt(position),
                list = await worker.getCompletionsAtPosition(
                  jsModel.uri.toString(),
                  offset,
                  {},
                );
              if (
                token.isCancellationRequested ||
                document.getVersionId() !== versionId
              )
                return;
              return {
                suggestions: (list?.entries || []).map((item) => ({
                  label: item.name,
                  insertText: item.insertText || item.name,
                  kind: /method/.test(item.kind)
                    ? monaco.languages.CompletionItemKind.Method
                    : /function/.test(item.kind)
                      ? monaco.languages.CompletionItemKind.Function
                      : /class/.test(item.kind)
                        ? monaco.languages.CompletionItemKind.Class
                        : monaco.languages.CompletionItemKind.Variable,
                  sortText: item.sortText,
                  range: item.replacementSpan
                    ? rangeFromOffsets(
                        item.replacementSpan.start,
                        item.replacementSpan.length,
                      )
                    : range,
                  insertTextRules: item.isSnippet
                    ? monaco.languages.CompletionItemInsertTextRule
                        .InsertAsSnippet
                    : 0,
                  _tml: { offset, name: item.name, source: item.source },
                })),
              };
            }
            if (language === "css") {
              const service = await cssService(),
                doc = cssDocument(),
                list = service.doComplete(
                  doc,
                  {
                    line: position.lineNumber - 1,
                    character: position.column - 1,
                  },
                  cssStylesheet(service, doc),
                );
              if (
                token.isCancellationRequested ||
                document.getVersionId() !== versionId
              )
                return;
              return {
                suggestions: list.items.map((item) => ({
                  label: item.label,
                  insertText:
                    item.textEdit?.newText || item.insertText || item.label,
                  detail: item.detail,
                  documentation: item.documentation,
                  kind: monaco.languages.CompletionItemKind[
                    cssKinds[item.kind] || "Property"
                  ],
                  sortText: item.sortText,
                  range: item.textEdit?.range
                    ? lspRange(item.textEdit.range)
                    : range,
                  insertTextRules:
                    item.insertTextFormat === 2
                      ? monaco.languages.CompletionItemInsertTextRule
                          .InsertAsSnippet
                      : 0,
                })),
              };
            }
          } catch (e) {
            console.warn("[Tilda Monaco] embedded completion", e.message);
          }
          return { suggestions: [] };
        },
        async resolveCompletionItem(item, token) {
          if (!item._tml || token.isCancellationRequested) return item;
          try {
            const worker = await jsService(),
              q = item._tml,
              d = await worker.getCompletionEntryDetails(
                jsModel.uri.toString(),
                q.offset,
                q.name,
                {},
                q.source,
                {},
              );
            if (d) {
              item.detail = parts(d.displayParts);
              item.documentation = parts(d.documentation);
            }
          } catch {}
          return item;
        },
      };
      disposables.push(
        monaco.languages.registerCompletionItemProvider(
          "html",
          completionProvider,
        ),
      );
      const hoverProvider = {
        async provideHover(document, position, token) {
          const language = region(position);
          try {
            if (language === "javascript") {
              const worker = await jsService(),
                q = await worker.getQuickInfoAtPosition(
                  jsModel.uri.toString(),
                  document.getOffsetAt(position),
                );
              if (!q || token.isCancellationRequested) return;
              return {
                range: rangeFromOffsets(q.textSpan.start, q.textSpan.length),
                contents: [
                  {
                    value: "```javascript\n" + parts(q.displayParts) + "\n```",
                  },
                  { value: parts(q.documentation) },
                ],
              };
            }
            if (language === "css") {
              const service = await cssService(),
                doc = cssDocument(),
                q = service.doHover(
                  doc,
                  {
                    line: position.lineNumber - 1,
                    character: position.column - 1,
                  },
                  cssStylesheet(service, doc),
                );
              if (!q || token.isCancellationRequested) return;
              return {
                range: q.range ? lspRange(q.range) : undefined,
                contents: (Array.isArray(q.contents)
                  ? q.contents
                  : [q.contents]
                ).map((c) => ({ value: typeof c === "string" ? c : c.value })),
              };
            }
          } catch {}
          return null;
        },
      };
      disposables.push(
        monaco.languages.registerHoverProvider("html", hoverProvider),
      );
      disposables.push(
        monaco.languages.registerSignatureHelpProvider("html", {
          signatureHelpTriggerCharacters: ["(", ","],
          async provideSignatureHelp(document, position, token) {
            if (region(position) !== "javascript") return null;
            try {
              const worker = await jsService(),
                q = await worker.getSignatureHelpItems(
                  jsModel.uri.toString(),
                  document.getOffsetAt(position),
                  {},
                );
              if (!q || token.isCancellationRequested) return null;
              return {
                value: {
                  activeSignature: q.selectedItemIndex,
                  activeParameter: q.argumentIndex,
                  signatures: q.items.map((item) => ({
                    label:
                      parts(item.prefixDisplayParts) +
                      item.parameters
                        .map((p) => parts(p.displayParts))
                        .join(parts(item.separatorDisplayParts)) +
                      parts(item.suffixDisplayParts),
                    documentation: parts(item.documentation),
                    parameters: item.parameters.map((p) => ({
                      label: parts(p.displayParts),
                      documentation: parts(p.documentation),
                    })),
                  })),
                },
                dispose() {},
              };
            } catch {
              return null;
            }
          },
        }),
      );
      disposables.push(
        monaco.languages.registerDefinitionProvider("html", {
          async provideDefinition(document, position, token) {
            if (region(position) !== "javascript") return null;
            try {
              const worker = await jsService(),
                definitions = await worker.getDefinitionAtPosition(
                  jsModel.uri.toString(),
                  document.getOffsetAt(position),
                );
              if (token.isCancellationRequested) return null;
              return (definitions || [])
                .filter((d) => d.fileName === jsModel.uri.toString())
                .map((d) => ({
                  uri: document.uri,
                  range: rangeFromOffsets(d.textSpan.start, d.textSpan.length),
                }));
            } catch {
              return null;
            }
          },
        }),
      );
      async function validateEmbedded() {
        if (disposed) return;
        syncEmbedded();
        const versionId = model.getVersionId();
        try {
          const markers = [];
          if (jsModel.getValue().trim()) {
            const worker = await jsService(),
              diagnostics = await worker.getSyntacticDiagnostics(
                jsModel.uri.toString(),
              );
            for (const d of diagnostics) {
              const r = rangeFromOffsets(
                d.start || 0,
                Math.max(1, d.length || 1),
              );
              markers.push({
                ...r,
                severity: monaco.MarkerSeverity.Error,
                source: "JavaScript",
                message:
                  typeof d.messageText === "string"
                    ? d.messageText
                    : d.messageText.messageText,
              });
            }
          }
          if (cssModel.getValue().trim()) {
            const service = await cssService(),
              doc = cssDocument();
            for (const d of service.doValidation(
              doc,
              cssStylesheet(service, doc),
            ))
              markers.push({
                ...lspRange(d.range),
                severity:
                  d.severity === 1
                    ? monaco.MarkerSeverity.Error
                    : monaco.MarkerSeverity.Warning,
                source: "CSS",
                message: d.message,
              });
          }
          if (!disposed && model.getVersionId() === versionId)
            monaco.editor.setModelMarkers(model, "embedded", markers);
        } catch (e) {
          console.warn("[Tilda Monaco] validation", e.message);
        }
      }
      window.__tmlFeatures = {
        formatter,
        completionProvider,
        hoverProvider,
        region,
        syncEmbedded,
        validateEmbedded,
      };
      bridge.ready(editor, monaco);
      diagnosticsTimer = setTimeout(validateEmbedded, 600);
    } catch (error) {
      if (!disposed) bridge.failed(error);
    }
  });

  // Theme catalogue and native Tilda publishing helpers.
  (function installTildaTools(attachThemes) {
    "use strict";
    if (
      window !== window.top ||
      !/^https:\/\/tilda\.(ru|cc)\/page\//.test(location.href)
    )
      return;
    if (!document.body) {
      document.addEventListener(
        "DOMContentLoaded",
        () => installTildaTools(attachThemes),
        { once: true },
      );
      return;
    }
    window.__tildaEditorTools?.dispose();
    const abort = new AbortController(),
      attached = new Map(),
      recordButtons = new Map(),
      revisions = new WeakMap();
    let busy = false,
      stopped = false,
      timer,
      latestLink,
      projectController,
      projectProgress = "";
    // Google Material Symbols Sharp: drive_folder_upload (Apache 2.0).
    const projectPublishIcon =
      '<path d="M440-280h80v-168l64 64 56-56-160-160-160 160 56 56 64-64v168ZM160-160q-33 0-56.5-23.5T80-240v-480q0-33 23.5-56.5T160-800h240l80 80h320q33 0 56.5 23.5T880-640v400q0 33-23.5 56.5T800-160H160Zm0-80h640v-400H447l-80-80H160v480Zm0 0v-480 480Z"/>';
    const releaseStyles = useStyles(document);
    function notice(text, error = false) {
      const safe =
        typeof window.tp__escapeHtml === "function"
          ? window.tp__escapeHtml(text)
          : text.replace(/[<>&]/g, "");
      if (typeof window.td__showBubbleNotice === "function")
        window.td__showBubbleNotice(
          safe,
          error ? 8000 : 3500,
          error ? "error" : "",
        );
      else console[error ? "warn" : "info"]("[Tilda Tools] " + text);
    }
    function field(body, key) {
      return Array.isArray(body)
        ? body.find((x) => x.name === key)?.value
        : body instanceof URLSearchParams
          ? body.get(key)
          : body?.[key];
    }
    async function observed(work, predicate, required = false) {
      const original = window.tp__fetch,
        results = [];
      if (typeof original !== "function")
        throw new Error(
          "Тильда ещё не готова. Попробуйте через несколько секунд.",
        );
      function wrapped(options) {
        const matches = predicate(options);
        let promise;
        try {
          promise = original.apply(this, arguments);
        } catch (error) {
          if (matches) results.push(Promise.resolve({ error }));
          throw error;
        }
        if (matches)
          results.push(
            Promise.resolve(promise).then(
              (value) => ({ value }),
              (error) => ({ error }),
            ),
          );
        return promise;
      }
      window.tp__fetch = wrapped;
      let outcomes;
      try {
        await work();
        outcomes = await Promise.all(results);
      } finally {
        if (window.tp__fetch === wrapped) window.tp__fetch = original;
      }
      if (required && !outcomes.length)
        throw new Error("Блок не сохранён. Проверьте обязательные поля формы.");
      for (const result of outcomes) {
        if (result.error) throw result.error;
        if (
          result.value !== "" &&
          result.value !== "OK" &&
          result.value !== "ok"
        )
          throw new Error(
            "Тильда не подтвердила сохранение. Публикация остановлена.",
          );
      }
    }
    function visibleForm() {
      return [
        ...document.querySelectorAll(".pe-content-form,.pe-settings-form"),
      ].find(
        (f) =>
          f.getClientRects().length &&
          getComputedStyle(f).visibility !== "hidden",
      );
    }
    async function saveForm(form, action) {
      if (form.dataset.saveEvent)
        throw new Error(
          "Этот блок использует отдельный редактор. Сначала сохраните его штатной кнопкой.",
        );
      if (typeof window.edrec__sendForm !== "function")
        throw new Error("Не найдено штатное сохранение Тильды.");
      const type = form.classList.contains("pe-settings-form")
          ? "settings"
          : "content",
        recordId = form.dataset.recId;
      const revision = revisions.get(form) || 0,
        frame = form.querySelector(".tml-frame"),
        editor = frame?.contentWindow?.editor,
        version = editor?.getModel()?.getAlternativeVersionId();
      if (form.querySelector(".pe-" + type + "__savebtns-wrapper.disabled"))
        throw new Error("Сохранение уже идёт. Дождитесь завершения.");
      await observed(
        () => window.edrec__sendForm(action, type),
        (o) =>
          o.url === "/page/submit/" &&
          field(o.body, "comm") === "saverecord" &&
          String(field(o.body, "recordid")) === recordId,
        true,
      );
      if (
        (revisions.get(form) || 0) !== revision ||
        (frame?.isConnected &&
          editor?.getModel()?.getAlternativeVersionId() !== version)
      )
        throw new Error(
          "Во время сохранения появились новые правки. Сохраните и опубликуйте ещё раз.",
        );
    }
    async function saveOrder() {
      if (typeof window.tp__saveRecordsSort !== "function")
        throw new Error("Не найдено сохранение порядка блоков Тильды.");
      await observed(
        () => window.tp__saveRecordsSort(),
        (o) =>
          o.url === "/page/submit/" &&
          field(o.body, "comm") === "saverecordssort",
      );
    }
    function validURL(value) {
      const u = new URL(value, location.origin);
      if (!["http:", "https:"].includes(u.protocol) || u.username || u.password)
        throw new Error("Некорректный адрес страницы");
      return u;
    }
    function pageURL(fresh = false) {
      let url;
      if (latestLink) url = validURL(latestLink);
      else {
        const host = window.tp__getProjectUrl?.().url;
        if (!host) throw new Error("Тильда ещё не передала адрес сайта.");
        const root = /^https?:\/\//i.test(host) ? host : "https://" + host;
        const path =
          window.pageisindex === "y"
            ? ""
            : (window.pagealias || "page" + window.pageid + ".html").replace(
                /^\/+/,
                "",
              );
        url = validURL(root.replace(/\/+$/, "") + "/" + path);
      }
      if (fresh) url.searchParams.set("tml_preview", String(Date.now()));
      return url.href;
    }
    function openTab(url) {
      if (typeof GM_openInTab !== "function")
        throw new Error("Для открытия после публикации обновите скрипт в Tampermonkey.");
      // The extension opens a tab after async publication; no blank popup or DOM access.
      return GM_openInTab(validURL(url).href, { active: true, setParent: true });
    }
    function openPage(fresh = false) {
      try {
        if (!window.pagepublished && !latestLink) {
          notice("Сначала опубликуйте страницу.");
          return;
        }
        openTab(pageURL(fresh));
      } catch (error) {
        notice(error.message, true);
      }
    }
    async function preparePublication(options, message) {
      if (window.tp__checkOpenedWidgets?.())
        throw new Error("Сначала завершите редактирование открытого виджета.");
      const form = options.form || visibleForm();
      if (
        !form &&
        document.querySelector("#mainmenu")?.classList.contains("hidden")
      )
        throw new Error("Сначала сохраните и закройте текущий редактор Тильды.");
      notice(form ? "Сохраняю блок…" : message);
      if (form) await saveForm(form, options.action || "update");
      await saveOrder();
    }
    function publicationData(result) {
      let data;
      try {
        data = typeof result === "string" ? JSON.parse(result) : result;
      } catch {
        throw new Error(
          "Тильда вернула ошибку публикации: " + String(result).slice(0, 300),
        );
      }
      if (!data || typeof data !== "object" || data.error)
        throw new Error(String(data?.error || "Тильда не подтвердила публикацию."));
      return data;
    }
    async function projectPublicationContext() {
      const projectId = String(window.projectid || "");
      if (!/^\d+$/.test(projectId) || typeof window.tp__menu__getProjectsData !== "function")
        throw new Error("Тильда ещё не готова к публикации сайта.");
      // The same fresh project, page and folder data used by Tilda's page switcher.
      const [data] = await window.tp__menu__getProjectsData(true);
      const { project, pages } = data || {};
      // Tilda omits folders for projects that have none.
      const folders = data?.folders ?? [];
      if (
        String(window.projectid) !== projectId ||
        String(project?.id) !== projectId ||
        !Array.isArray(pages) ||
        !Array.isArray(folders)
      )
        throw new Error("Не удалось получить актуальный список страниц сайта.");
      const roles = Array.isArray(project.roles) ? project.roles : [];
      if (project.shared === "y" && !roles.includes("all") && !roles.includes("pg_p"))
        throw new Error("В Тильде нет прав на публикацию этого сайта.");
      // Match TDPublishModal.getTotalPages: publishing the entire site excludes archived folders.
      const archived = new Set(
        folders.filter((folder) => folder.archive === "y").map((folder) => String(folder.id)),
      );
      const total = pages.filter((page) => !archived.has(String(page.folderid))).length;
      return { projectId, total };
    }
    async function publishProject(options = {}) {
      if (busy || stopped) return { ok: false, busy: true };
      busy = true;
      const controller = new AbortController();
      projectController = controller;
      let published = 0;
      const report = (text) => {
        projectProgress = text;
        scanButtons();
        notice(text);
      };
      const checkActive = () => {
        if (stopped || controller.signal.aborted)
          throw new Error("Публикация сайта остановлена.");
      };
      try {
        report("Подготавливаю публикацию сайта…");
        const { projectId, total } = await projectPublicationContext();
        checkActive();
        if (!total) {
          notice("На сайте нет страниц для публикации вне архивных папок.");
          return { ok: false, empty: true };
        }
        await preparePublication(options, "Публикую сайт…");
        checkActive();
        // Match TDPublishModal.progressivePublish: continue each server batch using toindex.
        let fromIndex = 0;
        while (fromIndex < total) {
          checkActive();
          if (String(window.projectid) !== projectId)
            throw new Error("Текущий проект изменился. Публикация остановлена.");
          report(`Публикация сайта: ${published} из ${total}…`);
          const result = await window.tp__fetch({
            url: "/page/publish/",
            body: {
              projectid: projectId,
              comm: "projectpublish",
              fromindex: fromIndex || undefined,
              csrf: window.getCSRF(),
              returnjson: "yes",
            },
            explanation: "project publishing",
            silent: true,
            controller,
            timeout: 30,
          });
          checkActive();
          const data = publicationData(result);
          const next = Number(data.toindex);
          if (!Number.isSafeInteger(next) || next <= fromIndex)
            throw new Error("Тильда не подтвердила продолжение публикации сайта.");
          fromIndex = next;
          published = Math.min(fromIndex, total);
        }
        notice(`Сайт опубликован: ${total} стр.`);
        return { ok: true, projectId, published: total };
      } catch (error) {
        const message = error?.message || String(error);
        if (!stopped)
          notice(
            published ? `Публикация остановлена после ${published} стр. ${message}` : message,
            true,
          );
        return { ok: false, published, error: message };
      } finally {
        projectController = undefined;
        projectProgress = "";
        busy = false;
        if (!stopped) scanButtons();
      }
    }
    async function publish(options = {}) {
      if (busy || stopped) return { ok: false, busy: true };
      busy = true;
      scanButtons();
      try {
        await preparePublication(options, "Публикую страницу…");
        const result = await window.tp__fetch({
          url: "/page/publish/",
          body: {
            comm: "pagepublish",
            pageid: window.pageid,
            csrf: window.getCSRF(),
            returnjson: "yes",
          },
          explanation: "page publishing",
          silent: true,
          timeout: 45,
        });
        const data = publicationData(result);
        if (!data || data.error || typeof data.link !== "string" || !data.link)
          throw new Error(
            String(data?.error || "Тильда не подтвердила публикацию."),
          );
        latestLink = validURL(data.link).href;
        window.pagepublished = String(Math.floor(Date.now() / 1000));
        let opened = false;
        notice("Страница опубликована");
        if (options.open) {
          try {
            openTab(pageURL(true));
            opened = true;
          } catch (error) {
            notice(
              "Страница опубликована, но вкладка не открылась. Используйте кнопку перехода. " +
                (error?.message || String(error)),
            );
          }
        }
        return { ok: true, link: latestLink, opened };
      } catch (error) {
        notice(error?.message || String(error), true);
        return { ok: false, error: error?.message || String(error) };
      } finally {
        busy = false;
        scanButtons();
      }
    }
    function keydown(event) {
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        (event.code === "KeyS" || event.key?.toLowerCase() === "s")
      ) {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (!event.repeat) publish({ open: event.altKey });
      }
    }
    function click(event) {
      const target = event.target instanceof Element ? event.target : null;
      if (!target) return;
      const tool = target.closest("[data-tml-action]");
      if (tool) {
        if (tool.dataset.tmlAction === "open") {
          try {
            if (!window.pagepublished && !latestLink)
              throw new Error("Сначала опубликуйте страницу.");
            if (event.shiftKey) {
              event.preventDefault();
              openTab(pageURL(true));
            } else tool.href = pageURL();
            // Preserve normal browser navigation, including modifier clicks.
          } catch (error) {
            event.preventDefault();
            notice(error.message, true);
          }
          return;
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        if (tool.dataset.tmlAction === "publish-project") {
          publishProject({ form: tool.closest(".pe-content-form") });
          return;
        }
        publish({ open: event.altKey });
        return;
      }
      const save = target.closest('button[onclick*="edrec__sendForm"]');
      if (save && (event.shiftKey || event.altKey)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        const form = save.closest(".pe-content-form,.pe-settings-form");
        if (!form) return;
        const action = /sendForm\(['"]save['"]/.test(
          save.getAttribute("onclick"),
        )
          ? "save"
          : "update";
        publish({ form, action, open: event.altKey });
      } else if (busy && target.closest("#page_menu_publishlink")) {
        event.preventDefault();
        event.stopImmediatePropagation();
        notice("Публикация уже идёт…");
      }
    }
    function scanButtons() {
      const native = document.querySelector("#page_menu_publishlink"),
        navbar = native?.closest(".tp-menu__navbar");
      if (navbar) {
        const first = navbar.firstElementChild;
        // Google Material Symbols Sharp, Apache 2.0: google/material-design-icons.
        for (const [action, label, svg] of [
          [
            "publish-project",
            "Опубликовать весь сайт",
            projectPublishIcon,
          ],
          [
            "publish",
            "Быстрая публикация · Ctrl/Cmd + Shift + S · Alt: опубликовать и открыть",
            '<path d="M440-160v-326L336-382l-56-58 200-200 200 200-56 58-104-104v326h-80ZM160-600v-200h640v200h-80v-120H240v120h-80Z"/>',
          ],
          [
            "open",
            "Открыть опубликованную страницу · Shift: открыть с обновлением",
            '<path d="M120-120v-720h360v80H200v560h560v-280h80v360H120Zm268-212-56-56 372-372H560v-80h280v280h-80v-144L388-332Z"/>',
          ],
        ]) {
          if (navbar.querySelector(`[data-tml-action="${action}"]`)) continue;
          const li = document.createElement("li");
          li.className =
            "tp-menu__navbar__item tml-page-tool tml-page-tool-" + action;
          const button = document.createElement(action === "open" ? "a" : "button");
          if (action === "open") {
            button.target = "_blank";
            button.rel = "noopener noreferrer";
          } else button.type = "button";
          button.className = "t-button";
          button.dataset.tmlAction = action;
          button.title = label;
          button.setAttribute("aria-label", label);
          button.innerHTML =
            '<svg aria-hidden="true" viewBox="0 -960 960 960">' +
            svg +
            "</svg>";
          li.append(button);
          navbar.insertBefore(li, first);
        }
      }
      document.querySelectorAll(".pe-content__savebtns-wrapper").forEach((wrapper) => {
        if (wrapper.querySelector('[data-tml-action="publish-project"]')) return;
        const button = document.createElement("button");
        button.type = "button";
        button.className = "tbtn tml-project-publish-button";
        button.dataset.tmlAction = "publish-project";
        button.innerHTML =
          '<svg aria-hidden="true" viewBox="0 -960 960 960">' + projectPublishIcon + "</svg>";
        const close = wrapper.querySelector('button[onclick*="edrec__closeEditForm"]');
        wrapper.insertBefore(button, close);
      });
      document.querySelectorAll('[data-tml-action="publish"],[data-tml-action="publish-project"]').forEach((b) => {
        if (b.disabled !== busy) b.disabled = busy;
        b.setAttribute("aria-busy", String(busy));
        if (b.dataset.tmlAction === "publish-project") {
          const title = projectProgress || (b.closest(".pe-content-form")
            ? "Сохранить блок и опубликовать весь сайт"
            : "Опубликовать весь сайт");
          if (b.title !== title) {
            b.title = title;
            b.setAttribute("aria-label", title);
          }
        }
      });
      const openLink = document.querySelector('a[data-tml-action="open"]');
      if (openLink) {
        try {
          if (window.pagepublished || latestLink) openLink.href = pageURL();
          else openLink.removeAttribute("href");
        }
        catch { openLink.removeAttribute("href"); }
      }
      document
        .querySelectorAll('button[onclick*="edrec__sendForm"]')
        .forEach((b) => {
          b.title =
            "Shift + клик: сохранить и опубликовать. Alt/Option + клик: сохранить, опубликовать и открыть.";
        });
    }
    function updateRecordButtons(record) {
      const entry = recordButtons.get(record);
      if (!entry) return;
      // Use the same alias ID and saved class as Tilda's block dropdown.
      const id = record.uiControl?.data?.aliasid || record.getAttribute("recordid");
      const customClass = (record.getAttribute("data-custom-class") || "").trim();
      for (const [kind, value] of [["id", id ? `#rec${id}` : ""], ["class", customClass]]) {
        const button = entry[kind];
        // Absent buttons leave the group, preserving Tilda's :last-child borders.
        if (!value) button.remove();
        else if (button.parentElement !== entry.group) entry.group.append(button);
        button.dataset.tmlCopyValue = value;
        const label = button.firstElementChild;
        if (label.textContent !== value) label.textContent = value;
        const title = `Скопировать ${kind === "id" ? "ID блока" : "класс блока"}: ${value}`;
        button.title = title;
        button.setAttribute("aria-label", title);
      }
    }
    function scanRecordButtons() {
      for (const [record, entry] of recordButtons) {
        if (!record.isConnected || !entry.group.isConnected ||
            record.uiControl?.elements?.wrapper !== entry.wrapper) {
          entry.id.remove();
          entry.class.remove();
          recordButtons.delete(record);
        }
      }
      for (const record of document.querySelectorAll("#allrecords > .record")) {
        const wrapper = record.uiControl?.elements?.wrapper;
        const groups = wrapper?.querySelectorAll(
          ".tp-record-ui__container_top.tp-record-ui__container_right > .tp-record-ui__group_borders",
        );
        const group = groups?.[groups.length - 1];
        if (!group) continue;
        let entry = recordButtons.get(record);
        if (!entry) {
          entry = { wrapper, group };
          for (const kind of ["id", "class"]) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "tp-record-ui__button tp-record-ui__button_white tml-record-copy";
            button.dataset.tmlCopyKind = kind;
            button.dataset.tmlRecordId = record.getAttribute("recordid");
            const label = document.createElement("span");
            label.className = "tp-record-ui__button-text";
            button.append(label);
            button.addEventListener("pointerdown", event => event.stopPropagation());
            button.addEventListener("click", event => {
              event.preventDefault();
              event.stopPropagation();
              updateRecordButtons(record);
              const value = button.dataset.tmlCopyValue;
              if (!value) return;
              if (typeof window.tp__copyTextToClipboard !== "function") {
                notice("Копирование Тильды недоступно. Перезагрузите страницу.", true);
                return;
              }
              window.tp__copyTextToClipboard(
                value,
                kind === "id" ? "ID блока скопирован" : "Класс блока скопирован",
                "Не удалось скопировать. Попробуйте ещё раз.",
              );
            });
            entry[kind] = button;
          }
          recordButtons.set(record, entry);
        }
        entry.group = group;
        updateRecordButtons(record);
      }
    }
    function scan() {
      if (stopped) return;
      scanButtons();
      scanRecordButtons();
      for (const [frame, entry] of attached)
        if (!frame.isConnected) {
          entry.dispose();
          attached.delete(frame);
        }
      document.querySelectorAll(".tml-frame").forEach((frame) => {
        if (
          attached.has(frame) ||
          !frame.contentWindow?.editor ||
          !frame.contentWindow?.monaco
        )
          return;
        const themes = attachThemes(frame),
          win = frame.contentWindow,
          disposeThemes = themes.dispose;
        win.addEventListener("keydown", keydown, { capture: true });
        themes.dispose = () => {
          win.removeEventListener("keydown", keydown, true);
          disposeThemes();
        };
        attached.set(frame, themes);
      });
    }
    const controlsSelector =
      '#mainmenu,#page_menu_publishlink,.tml-frame,.tml-page-tool,.pe-content__savebtns-wrapper,button[onclick*="edrec__sendForm"],#allrecords > .record,.tp-record-ui,.tp-record-ui__group';
    const observer = new MutationObserver((records) => {
      for (const record of records)
        if (record.type === "attributes") updateRecordButtons(record.target);
      const relevant = records.some((record) =>
        [...record.addedNodes, ...record.removedNodes].some(
          (node) =>
            node.nodeType === 1 &&
            (node.matches(controlsSelector) ||
              node.querySelector(controlsSelector)),
        ),
      );
      if (!relevant) return;
      clearTimeout(timer);
      timer = setTimeout(scan, 100);
    });
    observer.observe(document.body, { childList: true, subtree: true,
      attributes: true, attributeFilter: ["data-custom-class", "recordid"] });
    window.addEventListener("tml:ready", scan, { signal: abort.signal });
    window.addEventListener("keydown", keydown, {
      capture: true,
      signal: abort.signal,
    });
    window.addEventListener("click", click, {
      capture: true,
      signal: abort.signal,
    });
    function edited(event) {
      const form = event.target.closest?.(".pe-content-form,.pe-settings-form");
      if (form) revisions.set(form, (revisions.get(form) || 0) + 1);
    }
    document.addEventListener("input", edited, {
      capture: true,
      signal: abort.signal,
    });
    document.addEventListener("change", edited, {
      capture: true,
      signal: abort.signal,
    });
    window.__tildaEditorTools = {
      notice,
      publish,
      publishProject,
      openPage,
      pageURL,
      scan,
      themes: () => [...attached.values()],
      status: () => ({
        busy,
        frames: attached.size,
        buttons: document.querySelectorAll(".tml-page-tool").length,
      }),
      dispose() {
        stopped = true;
        projectController?.abort();
        abort.abort();
        observer.disconnect();
        clearTimeout(timer);
        attached.forEach((e) => e.dispose());
        attached.clear();
        recordButtons.forEach((entry) => { entry.id.remove(); entry.class.remove(); });
        recordButtons.clear();
        releaseStyles();
        document.querySelectorAll(".tml-page-tool,.tml-project-publish-button").forEach((e) => e.remove());
        delete window.__tildaEditorTools;
      },
    };
    scan();
  })(function (frame) {
    const win = frame.contentWindow,
      doc = win.document,
      monaco = win.monaco,
      editor = win.editor;
    const key = "tml-editor-theme-v1",
      base = "https://cdn.jsdelivr.net/npm/monaco-themes@0.4.8/themes/";
    const builtins = [
      { id: "auto", label: "Как в системе" },
      { id: "vs", label: "Visual Studio — светлая" },
      { id: "vs-dark", label: "Visual Studio — тёмная" },
      { id: "hc-black", label: "Контрастная — тёмная" },
      { id: "hc-light", label: "Контрастная — светлая" },
    ];
    const cache = new Map(),
      abort = new AbortController(),
      media = win.matchMedia("(prefers-color-scheme: dark)");
    let cataloguePromise,
      selected = "vs",
      requestId = 0,
      dialog,
      pickerCancel,
      dead = false;
    try {
      selected = localStorage.getItem(key) || "vs";
    } catch {}
    async function catalogue() {
      if (!cataloguePromise)
        cataloguePromise = fetch(base + "themelist.json", {
          credentials: "omit",
          referrerPolicy: "no-referrer",
          signal: AbortSignal.timeout(12000),
        })
          .then((r) => {
            if (!r.ok) throw new Error("Не удалось загрузить каталог тем");
            return r.json();
          })
          .then((data) => [
            ...builtins,
            ...Object.entries(data).map(([id, label]) => ({
              id: "extra:" + id,
              label,
            })),
          ])
          .catch((e) => {
            cataloguePromise = undefined;
            throw e;
          });
      return cataloguePromise;
    }
    async function apply(id) {
      const token = ++requestId;
      let name = id === "auto" ? (media.matches ? "vs-dark" : "vs") : id;
      if (id.startsWith("extra:")) {
        let data = cache.get(id);
        if (!data) {
          const item = (await catalogue()).find((t) => t.id === id);
          if (!item) throw new Error("Тема отсутствует в каталоге");
          const response = await fetch(
            base + encodeURIComponent(item.label) + ".json",
            {
              credentials: "omit",
              referrerPolicy: "no-referrer",
              signal: AbortSignal.timeout(12000),
            },
          );
          if (!response.ok)
            throw new Error("Не удалось загрузить тему " + item.label);
          data = await response.json();
          if (
            !["vs", "vs-dark", "hc-black", "hc-light"].includes(data.base) ||
            !Array.isArray(data.rules)
          )
            throw new Error("Некорректная тема");
          cache.set(id, data);
        }
        name = "tml-" + id.slice(6);
        monaco.editor.defineTheme(name, data);
      } else if (!builtins.some((t) => t.id === id))
        throw new Error("Неизвестная тема");
      if (dead || token !== requestId) return false;
      monaco.editor.setTheme(name);
      return true;
    }
    function restore() {
      ++requestId;
      apply(selected).catch(() => apply("vs"));
    }
    function show() {
      if (dialog?.open) {
        dialog.querySelector("input").focus();
        return;
      }
      let items = builtins,
        filtered = [],
        index = 0,
        accepted = false,
        finished = false;
      dialog = doc.createElement("dialog");
      dialog.className = "tml-theme-picker";
      dialog.setAttribute("aria-label", "Тема редактора");
      dialog.innerHTML =
        '<input type="search" aria-label="Найти тему" placeholder="Найти тему…" autocomplete="off" role="combobox" aria-expanded="true" aria-controls="tml-theme-list"><div class="tml-theme-list" id="tml-theme-list" role="listbox" aria-label="Темы редактора"></div><p role="status">↑ ↓ — предпросмотр · Enter — выбрать · Esc — отмена</p>';
      const input = dialog.querySelector("input"),
        list = dialog.querySelector(".tml-theme-list"),
        status = dialog.querySelector("[role=status]");
      function finish() {
        if (finished) return;
        finished = true;
        if (!accepted) restore();
        dialog?.remove();
        dialog = null;
        pickerCancel = null;
        editor.focus();
      }
      pickerCancel = () => {
        if (dialog?.open) dialog.close();
        finish();
      };
      async function preview(i) {
        index = i;
        list
          .querySelectorAll("button")
          .forEach((b, n) => b.setAttribute("aria-selected", String(n === i)));
        const item = filtered[i];
        if (!item) return;
        input.setAttribute("aria-activedescendant", "tml-theme-" + i);
        const b = list.children[i];
        b?.scrollIntoView({ block: "nearest" });
        status.textContent = "Загрузка темы…";
        try {
          if (await apply(item.id))
            status.textContent =
              item.label + " · Enter — выбрать · Esc — отмена";
        } catch (e) {
          if (!finished) status.textContent = e.message;
        }
      }
      async function choose(i) {
        const item = filtered[i];
        if (!item) return;
        try {
          if (!(await apply(item.id))) return;
          selected = item.id;
          try {
            localStorage.setItem(key, selected);
          } catch {}
          accepted = true;
          dialog.close();
          finish();
        } catch (e) {
          status.textContent = e.message;
        }
      }
      function render() {
        const query = input.value.toLowerCase();
        filtered = items.filter((t) =>
          (t.label + " " + t.id).toLowerCase().includes(query),
        );
        index = Math.max(
          0,
          filtered.findIndex((t) => t.id === selected),
        );
        list.replaceChildren();
        filtered.forEach((item, i) => {
          const b = doc.createElement("button");
          b.type = "button";
          b.id = "tml-theme-" + i;
          b.setAttribute("role", "option");
          b.setAttribute("aria-selected", String(i === index));
          b.tabIndex = -1;
          b.textContent = item.label + (item.id === selected ? " ✓" : "");
          b.addEventListener("pointerenter", () => preview(i));
          b.addEventListener("click", () => choose(i));
          list.append(b);
        });
        input.setAttribute("aria-activedescendant", "tml-theme-" + index);
        status.textContent = filtered.length
          ? "↑ ↓ — предпросмотр · Enter — выбрать · Esc — отмена"
          : "Ничего не найдено";
      }
      input.addEventListener("input", render);
      dialog.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          e.stopPropagation();
          if (filtered.length)
            preview(
              (index + (e.key === "ArrowDown" ? 1 : -1) + filtered.length) %
                filtered.length,
            );
        } else if (e.key === "Enter") {
          e.preventDefault();
          e.stopPropagation();
          choose(index);
        } else if (e.key === "Escape") {
          e.preventDefault();
          e.stopPropagation();
          pickerCancel?.();
        }
      });
      dialog.addEventListener("close", finish, { once: true });
      dialog.addEventListener("cancel", () => {}, { once: true });
      dialog.addEventListener("click", (e) => {
        if (e.target === dialog) {
          const r = dialog.getBoundingClientRect();
          if (
            e.clientX < r.left ||
            e.clientX > r.right ||
            e.clientY < r.top ||
            e.clientY > r.bottom
          )
            pickerCancel?.();
        }
      });
      editor.getDomNode().append(dialog);
      render();
      dialog.showModal();
      input.focus();
      catalogue()
        .then((all) => {
          if (finished) return;
          items = all;
          render();
        })
        .catch(() => {
          if (!finished)
            status.textContent =
              "Каталог недоступен. Встроенные темы работают.";
        });
    }
    const action = editor.addAction({
      id: "tml.colorTheme",
      label: "Тема редактора / Color Theme",
      contextMenuGroupId: "2_configuration",
      contextMenuOrder: 10,
      run: show,
    });
    const onSystemChange = () => {
      if (selected === "auto" && !dialog?.open) apply("auto").catch(() => {});
    };
    media.addEventListener("change", onSystemChange, { signal: abort.signal });
    win.addEventListener(
      "storage",
      (event) => {
        if (event.key === key) {
          selected = event.newValue || "vs";
          if (!dialog?.open) restore();
        }
      },
      { signal: abort.signal },
    );
    apply(selected).catch(() => apply("vs"));
    return {
      show,
      catalogue,
      apply,
      get selected() {
        return selected;
      },
      dispose() {
        dead = true;
        ++requestId;
        pickerCancel?.();
        action.dispose();
        abort.abort();
      },
    };
  });

  function tildaMenu(command) {
    const tools = window.__tildaEditorTools;
    if (!tools) return;
    if (command === "theme") {
      const themes = tools.themes()[0];
      if (themes) themes.show();
      else
        window.td__showBubbleNotice?.(
          "Сначала откройте HTML-редактор блока.",
          3500,
          "",
        );
    } else if (command === "open") tools.openPage();
    else tools.publish();
  }
  GM_registerMenuCommand("Тема редактора…", () => tildaMenu("theme"));
  GM_registerMenuCommand("Открыть опубликованную страницу", () =>
    tildaMenu("open"),
  );
  GM_registerMenuCommand("Опубликовать страницу", () => tildaMenu("publish"));
})(typeof unsafeWindow !== "undefined" ? unsafeWindow : window);
