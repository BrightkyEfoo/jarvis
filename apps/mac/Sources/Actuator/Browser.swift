import AppKit

/// Brightky's own browser profile (Arc or Chrome) through Apple Events. The page script below is
/// fixed; the daemon's parameters reach it as a JSON literal, never as code.
enum Browser {
    static let bundles = ["Arc": "company.thebrowser.Browser", "Google Chrome": "com.google.Chrome"]

    static func perform(kind: String, _ a: [String: Any], cancel: CancelToken) throws -> Any {
        guard let browser = a["browser"] as? String, let bundle = bundles[browser] else {
            throw ActGuard.Refused(message: "navigateur non pris en charge")
        }
        let running = !NSRunningApplication.runningApplications(withBundleIdentifier: bundle).isEmpty
        if kind != "browser.open" && !running { throw ActGuard.Refused(message: "\(browser) n'est pas ouvert") }

        switch kind {
        case "browser.tabs":
            return try call(browser, "tabs", [:], cancel: cancel, timeout: 15)
        case "browser.read":
            let r = try call(browser, "read", ["op": "read", "mode": a["mode"] ?? "interactive", "maxChars": a["maxChars"] ?? 40000],
                             cancel: cancel, timeout: 45)
            if let url = (r as? [String: Any])?["url"] as? String { try ActGuard.check(url: url) }
            return r
        case "browser.click", "browser.fill":
            var p: [String: Any] = ["op": kind == "browser.click" ? "click" : "fill"]
            for k in ["tab", "element", "fingerprint", "text"] { if let v = a[k] { p[k] = v } }
            let r = try call(browser, "act", p, cancel: cancel, timeout: 20)
            if let url = (r as? [String: Any])?["url"] as? String { try ActGuard.check(url: url) }
            return r
        case "browser.open":
            guard let url = a["url"] as? String, let u = URL(string: url), ["http", "https"].contains(u.scheme ?? "") else {
                throw ActGuard.Refused(message: "URL invalide")
            }
            try ActGuard.check(url: url)
            do {
                guard running else { throw ActGuard.Refused(message: "not running") }
                return try call(browser, "open", ["url": url, "newTab": a["newTab"] as? Bool ?? true], cancel: cancel, timeout: 15)
            } catch {
                // No window / not running: let Launch Services hand the URL to that browser.
                guard let appURL = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundle) else { throw error }
                let sem = DispatchSemaphore(value: 0)
                var failure: Error?
                let cfg = NSWorkspace.OpenConfiguration()
                cfg.activates = false
                NSWorkspace.shared.open([u], withApplicationAt: appURL, configuration: cfg) { _, e in
                    failure = e
                    sem.signal()
                }
                sem.wait()
                if let failure { throw failure }
                return [String: Any]()
            }
        case "browser.back":
            return try call(browser, "back", [:], cancel: cancel, timeout: 10)
        default:
            throw ActGuard.Refused(message: "action inconnue \(kind)")
        }
    }

    private static func call(_ browser: String, _ op: String, _ payload: [String: Any], cancel: CancelToken, timeout: TimeInterval) throws -> Any {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: payload), as: UTF8.self)
        let out = try Osa.run(jxa, args: [browser, op, json, pageScript], timeout: timeout, cancel: cancel)
        return try JSONSerialization.jsonObject(with: Data(out.utf8))
    }

    /// argv: browser name, op, JSON payload, page function source.
    static let jxa = #"""
    function run(argv) {
      const [name, op, payload, pageFn] = argv;
      const app = Application(name);
      const p = JSON.parse(payload);
      const out = (v) => JSON.stringify(v);
      const front = () => {
        const ws = app.windows();
        if (!ws.length) throw new Error('no ' + name + ' window open');
        return ws[0];
      };
      const findTab = (id) => {
        for (const w of app.windows()) {
          const ids = w.tabs.id();
          const i = ids.findIndex((x) => String(x) === id);
          if (i >= 0) return w.tabs[i];
        }
        throw new Error('the tab was closed: read the page again');
      };
      const waitLoaded = (t) => {
        for (let i = 0; i < 50; i++) {
          let loading = false;
          try { loading = t.loading(); } catch (e) {}
          if (!loading) return;
          delay(0.1);
        }
      };
      const exec = (t, args) => {
        const r = t.execute({ javascript: '(' + pageFn + ')(' + JSON.stringify(args) + ')' });
        if (r === undefined || r === null || r === '') {
          throw new Error('the page returned nothing: enable "Allow JavaScript from Apple Events" in ' + name);
        }
        const v = JSON.parse(String(r));
        if (v && v.error) throw new Error(v.error);
        return v;
      };
      switch (op) {
        case 'tabs': {
          const tabs = [];
          app.windows().forEach((w, wi) => {
            const ids = w.tabs.id(), titles = w.tabs.title(), urls = w.tabs.url();
            let active = null;
            try { active = String(w.activeTab().id()); } catch (e) {}
            ids.forEach((id, i) => tabs.push({
              id: String(id), window: wi + 1, title: titles[i] || '', url: urls[i] || '',
              active: wi === 0 && String(id) === active,
            }));
          });
          return out({ tabs });
        }
        case 'read': {
          const t = front().activeTab();
          waitLoaded(t);
          const v = exec(t, p);
          return out({ tab: String(t.id()), url: t.url(), title: t.title() || '', text: v.text, elements: v.elements });
        }
        case 'act': {
          const t = findTab(p.tab);
          exec(t, p);
          delay(0.4);
          return out({ url: t.url() });
        }
        case 'open': {
          const w = front();
          if (!p.newTab) {
            w.activeTab().url = p.url;
            return out({});
          }
          try {
            w.tabs.push(app.Tab({ url: p.url }));
          } catch (e) {
            app.make({ new: 'tab', at: w, withProperties: { url: p.url } });
          }
          return out({});
        }
        case 'back': {
          front().activeTab().goBack();
          return out({});
        }
      }
      throw new Error('unknown op ' + op);
    }
    """#

    /// Runs inside the page. read: text with [n] markers + element list; click / fill: re-checks the
    /// element's fingerprint (same origin, tag, label, href) before touching it.
    static let pageScript = #"""
    function (p) {
      const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
      const labelOf = (el) => {
        let lab = el.getAttribute('aria-label') || '';
        const by = el.getAttribute('aria-labelledby');
        if (!lab && by) lab = by.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' ');
        if (!lab && el.labels && el.labels.length) lab = el.labels[0].innerText;
        if (!lab && el.tagName === 'INPUT' && /^(submit|button|reset)$/i.test(el.type)) lab = el.value;
        if (!lab && !/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName)) lab = el.innerText;
        if (!lab) lab = el.getAttribute('title') || el.getAttribute('placeholder') || el.getAttribute('alt') || '';
        if (!lab && el.querySelector) {
          const img = el.querySelector('img[alt],[aria-label]');
          if (img) lab = img.getAttribute('alt') || img.getAttribute('aria-label') || '';
        }
        return norm(lab).slice(0, 120);
      };
      const hash = (s) => {
        let h = 2166136261;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
        return (h >>> 0).toString(16);
      };
      const fp = (el) => hash([location.origin, el.tagName, el.type || '', el.name || '', labelOf(el), el.getAttribute('href') || ''].join('|'));
      const secret = (el) => {
        const t = String(el.type || '').toLowerCase();
        const ac = String(el.getAttribute('autocomplete') || '').toLowerCase();
        return t === 'password' || /current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp/.test(ac);
      };
      const ROLES = /^(button|link|checkbox|radio|tab|menuitem|menuitemcheckbox|menuitemradio|switch|textbox|searchbox|combobox|option|treeitem)$/;
      const interactive = (el) => {
        const t = el.tagName;
        if (t === 'A') return el.hasAttribute('href');
        if (t === 'BUTTON' || t === 'SELECT' || t === 'TEXTAREA' || t === 'SUMMARY') return !el.disabled;
        if (t === 'INPUT') return el.type !== 'hidden' && !el.disabled;
        const r = el.getAttribute('role');
        if (r && ROLES.test(r)) return true;
        return el.isContentEditable && el.getAttribute('contenteditable') !== null;
      };
      const visible = (el) => el.checkVisibility
        ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })
        : (el.offsetParent !== null || el.tagName === 'BODY');

      if (p.op === 'read') {
        document.querySelectorAll('[data-jarvis-id]').forEach((e) => e.removeAttribute('data-jarvis-id'));
        const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'CANVAS', 'IFRAME', 'OBJECT', 'EMBED', 'HEAD']);
        const BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|TR|TABLE|SECTION|ARTICLE|HEADER|FOOTER|NAV|MAIN|ASIDE|FORM|FIELDSET|BLOCKQUOTE|PRE|DL|DT|DD|FIGURE|FIGCAPTION|DETAILS|BR|HR)$/;
        const want = p.mode === 'interactive';
        const parts = [];
        const elements = [];
        let size = 0, n = 0;
        const push = (s) => { if (size < p.maxChars) { parts.push(s); size += s.length; } };
        const walk = (node) => {
          if (size >= p.maxChars) return;
          if (node.nodeType === 3) {
            const t = node.nodeValue.replace(/\s+/g, ' ');
            if (t.trim()) push(t);
            return;
          }
          if (node.nodeType !== 1) return;
          const el = node;
          if (SKIP.has(el.tagName) || el.getAttribute('aria-hidden') === 'true' || !visible(el)) return;
          const block = BLOCK.test(el.tagName);
          if (block) push('\n');
          if (/^H[1-6]$/.test(el.tagName)) push('#'.repeat(Number(el.tagName[1])) + ' ');
          if (el.tagName === 'LI') push('- ');
          if (want && interactive(el) && elements.length < 2000) {
            n += 1;
            el.setAttribute('data-jarvis-id', String(n));
            const tag = el.tagName.toLowerCase();
            const role = el.getAttribute('role');
            const e = { id: n, tag, label: labelOf(el), fingerprint: fp(el) };
            if (role) e.role = role;
            if ((tag === 'input' || tag === 'button') && el.type) e.type = String(el.type);
            if (el.name) e.name = String(el.name).slice(0, 200);
            const ac = el.getAttribute('autocomplete');
            if (ac) e.autocomplete = ac.slice(0, 200);
            if (tag === 'a') e.href = el.href;
            const form = el.form || el.closest('form');
            const submits = (tag === 'button' && (el.type || 'submit') === 'submit') || (tag === 'input' && /^(submit|image)$/i.test(el.type));
            if (submits && form && String(form.method || '').toLowerCase() === 'post') e.submitsPost = true;
            elements.push(e);
            const kind = tag === 'input' && el.type ? 'input[' + el.type + ']' : role && role !== tag ? tag + '/' + role : tag;
            let extra = '';
            if ((tag === 'input' || tag === 'textarea') && !secret(el) && el.value && !/^(submit|button|reset)$/i.test(el.type)) extra = ' = "' + norm(el.value).slice(0, 80) + '"';
            if (tag === 'select' && el.selectedOptions && el.selectedOptions[0]) extra = ' = "' + norm(el.selectedOptions[0].text) + '"';
            if (el.type === 'checkbox' || el.type === 'radio') extra = el.checked ? ' (checked)' : ' (unchecked)';
            push(' [' + n + '] ' + kind + ' "' + e.label + '"' + extra + ' ');
            // Generic containers with a role: walk inside only when they hold more than their label.
            if ((tag !== 'div' && tag !== 'span' && tag !== 'li') || (!el.isContentEditable && norm(el.innerText) === e.label)) {
              if (block) push('\n');
              return;
            }
          }
          if (el.shadowRoot) for (const c of el.shadowRoot.childNodes) walk(c);
          for (const c of el.childNodes) walk(c);
          if (block) push('\n');
        };
        walk(document.body || document.documentElement);
        let text = parts.join('').replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (size >= p.maxChars) text = text.slice(0, p.maxChars) + '\n[… page truncated]';
        return JSON.stringify({ text, elements });
      }

      const el = document.querySelector('[data-jarvis-id="' + Number(p.element) + '"]');
      if (!el) return JSON.stringify({ error: 'element [' + p.element + '] is gone: read the page again' });
      if (fp(el) !== p.fingerprint) return JSON.stringify({ error: 'element [' + p.element + '] changed since the read: read the page again' });
      el.scrollIntoView({ block: 'center', inline: 'center' });
      if (p.op === 'click') {
        const r = el.getBoundingClientRect();
        const o = { bubbles: true, cancelable: true, view: window, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 };
        el.dispatchEvent(new PointerEvent('pointerdown', o));
        el.dispatchEvent(new MouseEvent('mousedown', o));
        if (el.focus) el.focus();
        el.dispatchEvent(new PointerEvent('pointerup', o));
        el.dispatchEvent(new MouseEvent('mouseup', o));
        el.click();
        return JSON.stringify({ ok: true });
      }
      if (p.op === 'fill') {
        if (secret(el)) return JSON.stringify({ error: 'password, code or card field: Jarvis never types there' });
        el.focus();
        if (el.tagName === 'SELECT') {
          const opt = Array.from(el.options).find((x) => norm(x.text) === norm(p.text) || x.value === p.text);
          if (!opt) return JSON.stringify({ error: 'no option "' + p.text + '"' });
          el.value = opt.value;
        } else if (el.isContentEditable) {
          document.execCommand('selectAll', false);
          document.execCommand('insertText', false, p.text);
        } else {
          const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, p.text);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return JSON.stringify({ ok: true });
      }
      return JSON.stringify({ error: 'unknown op' });
    }
    """#
}
