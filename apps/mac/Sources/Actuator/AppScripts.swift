import Foundation

/// Notes and Reminders through Apple Events: no screen involved, no app brought to the front.
enum AppScripts {
    static func perform(kind: String, _ a: [String: Any], cancel: CancelToken) throws -> Any {
        let parts = kind.split(separator: ".").map(String.init)
        guard parts.count == 2 else { throw ActGuard.Refused(message: "action inconnue \(kind)") }
        let script: String
        switch parts[0] {
        case "notes": script = notes
        case "reminders": script = reminders
        default: throw ActGuard.Refused(message: "action inconnue \(kind)")
        }
        let json = String(decoding: try JSONSerialization.data(withJSONObject: a), as: UTF8.self)
        let out = try Osa.run(script, args: [parts[1], json], timeout: 60, cancel: cancel)
        return try JSONSerialization.jsonObject(with: Data(out.utf8))
    }

    static let notes = #"""
    function run(argv) {
      const [op, payload] = argv;
      const p = JSON.parse(payload);
      const Notes = Application('Notes');
      const out = (v) => JSON.stringify(v);
      const iso = (d) => { try { return d ? d.toISOString() : ''; } catch (e) { return ''; } };
      const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const html = (text) => text.split('\n').map((l) => '<div>' + (l ? esc(l) : '<br>') + '</div>').join('');
      const folderOf = (n) => { try { return n.container().name(); } catch (e) { return ''; } };
      switch (op) {
        case 'list': {
          const ids = Notes.notes.id(), names = Notes.notes.name(), mods = Notes.notes.modificationDate();
          const locked = Notes.notes.passwordProtected();
          let idx = ids.map((_, i) => i);
          if (p.query) {
            const q = String(p.query).toLowerCase();
            idx = idx.filter((i) => String(names[i] || '').toLowerCase().includes(q));
          }
          idx.sort((a, b) => (mods[b] || 0) - (mods[a] || 0));
          const notes = [];
          for (const i of idx) {
            if (notes.length >= p.limit) break;
            const folder = folderOf(Notes.notes.byId(ids[i]));
            if (folder === 'Recently Deleted' || folder === 'Suppressions récentes') continue;
            notes.push({ id: ids[i], name: names[i] || '', folder, modified: iso(mods[i]), locked: !!locked[i] });
          }
          return out({ notes });
        }
        case 'read': {
          const n = Notes.notes.byId(p.id);
          const locked = n.passwordProtected();
          return out({ id: p.id, name: n.name(), folder: folderOf(n), text: locked ? '' : n.plaintext(), locked });
        }
        case 'create': {
          const folder = p.folder ? Notes.folders.byName(p.folder) : Notes.defaultAccount().defaultFolder();
          if (p.folder && !folder.exists()) throw new Error('no folder named "' + p.folder + '"');
          const n = Notes.Note({ body: '<div><h1>' + esc(p.title) + '</h1></div>' + html(p.body) });
          folder.notes.push(n);
          return out({ id: n.id() });
        }
        case 'append': {
          const n = Notes.notes.byId(p.id);
          if (n.passwordProtected()) throw new Error('the note is locked');
          n.body = n.body() + html(p.text);
          return out({ id: p.id });
        }
      }
      throw new Error('unknown op ' + op);
    }
    """#

    static let reminders = #"""
    function run(argv) {
      const [op, payload] = argv;
      const p = JSON.parse(payload);
      const R = Application('Reminders');
      const out = (v) => JSON.stringify(v);
      const iso = (d) => { try { return d ? d.toISOString() : null; } catch (e) { return null; } };
      switch (op) {
        case 'list': {
          const lists = p.list ? [R.lists.byName(p.list)] : R.lists();
          const res = [];
          for (const l of lists) {
            const lname = l.name();
            const rs = p.includeCompleted ? l.reminders : l.reminders.whose({ completed: false });
            const ids = rs.id(), names = rs.name(), dues = rs.dueDate(), done = rs.completed(), bodies = rs.body();
            ids.forEach((id, i) => res.push({
              id, name: names[i] || '', list: lname, due: iso(dues[i]), completed: !!done[i], notes: bodies[i] || null,
            }));
            if (res.length >= 2000) break;
          }
          return out({ reminders: res.slice(0, 2000) });
        }
        case 'add': {
          const l = p.list ? R.lists.byName(p.list) : R.defaultList();
          if (p.list && !l.exists()) throw new Error('no list named "' + p.list + '"');
          const props = { name: p.title };
          if (p.notes) props.body = p.notes;
          if (p.due) props.dueDate = new Date(p.due);
          const r = R.Reminder(props);
          l.reminders.push(r);
          return out({ id: r.id() });
        }
        case 'complete': {
          R.reminders.byId(p.id).completed = true;
          return out({});
        }
      }
      throw new Error('unknown op ' + op);
    }
    """#
}
