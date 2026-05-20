const express = require('express');
const Database = require('better-sqlite3');
const { randomUUID } = require('crypto');
const path = require('path');

const app = express();
const dbPath = process.env.DB_PATH || path.join(__dirname, 'crm.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS companies (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    branche     TEXT,
    mitarbeiter INTEGER,
    website     TEXT,
    strasse     TEXT,
    plz         TEXT,
    ort         TEXT,
    land        TEXT,
    notizen     TEXT,
    erstellt_am TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

// Migration: alte contacts-Tabelle (unternehmen TEXT) → neue (unternehmen_id FK)
const contactCols = db.prepare("SELECT name FROM pragma_table_info('contacts')").all().map(r => r.name);

if (contactCols.length === 0) {
  db.exec(`
    CREATE TABLE contacts (
      id             TEXT PRIMARY KEY,
      vorname        TEXT NOT NULL,
      nachname       TEXT NOT NULL,
      email          TEXT,
      telefon        TEXT,
      mobil          TEXT,
      unternehmen_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
      position       TEXT,
      notizen        TEXT,
      erstellt_am    TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);
} else if (contactCols.includes('unternehmen') && !contactCols.includes('unternehmen_id')) {
  db.transaction(() => {
    const names = db.prepare(
      "SELECT DISTINCT unternehmen FROM contacts WHERE unternehmen IS NOT NULL AND unternehmen != ''"
    ).all();
    const nameToId = {};
    for (const { unternehmen } of names) {
      const id = randomUUID();
      db.prepare('INSERT OR IGNORE INTO companies (id, name) VALUES (?, ?)').run(id, unternehmen);
      nameToId[unternehmen] = id;
    }
    db.exec(`
      CREATE TABLE contacts_new (
        id             TEXT PRIMARY KEY,
        vorname        TEXT NOT NULL,
        nachname       TEXT NOT NULL,
        email          TEXT,
        telefon        TEXT,
        mobil          TEXT,
        unternehmen_id TEXT REFERENCES companies(id) ON DELETE SET NULL,
        position       TEXT,
        notizen        TEXT,
        erstellt_am    TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);
    const ins = db.prepare(`
      INSERT INTO contacts_new
        (id, vorname, nachname, email, telefon, mobil, unternehmen_id, position, notizen, erstellt_am)
      VALUES
        (@id, @vorname, @nachname, @email, @telefon, @mobil, @unternehmen_id, @position, @notizen, @erstellt_am)
    `);
    for (const c of db.prepare('SELECT * FROM contacts').all()) {
      ins.run({ ...c, unternehmen_id: c.unternehmen ? (nameToId[c.unternehmen] || null) : null });
    }
    db.exec('DROP TABLE contacts');
    db.exec('ALTER TABLE contacts_new RENAME TO contacts');
  })();
}

// ── Helpers ───────────────────────────────────────────
function resolveCompany(name) {
  if (!name || !name.trim()) return null;
  const n = name.trim();
  let co = db.prepare('SELECT id FROM companies WHERE name = ? COLLATE NOCASE').get(n);
  if (!co) {
    const id = randomUUID();
    db.prepare('INSERT INTO companies (id, name) VALUES (?, ?)').run(id, n);
    co = { id };
  }
  return co.id;
}

const contactWithCompany = `
  SELECT c.*, co.name AS unternehmen
  FROM contacts c
  LEFT JOIN companies co ON c.unternehmen_id = co.id
`;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Contacts ──────────────────────────────────────────
app.get('/api/contacts', (req, res) => {
  res.json(db.prepare(contactWithCompany + ' ORDER BY c.nachname, c.vorname').all());
});

app.post('/api/contacts', (req, res) => {
  const { id, vorname, nachname, email, telefon, mobil, unternehmen, position, notizen } = req.body;
  if (!id || !vorname || !nachname) return res.status(400).json({ error: 'id, vorname und nachname sind Pflichtfelder' });
  const unternehmen_id = resolveCompany(unternehmen);
  db.prepare(`
    INSERT INTO contacts (id, vorname, nachname, email, telefon, mobil, unternehmen_id, position, notizen)
    VALUES (@id, @vorname, @nachname, @email, @telefon, @mobil, @unternehmen_id, @position, @notizen)
  `).run({ id, vorname, nachname, email: email || null, telefon: telefon || null, mobil: mobil || null, unternehmen_id, position: position || null, notizen: notizen || null });
  res.status(201).json(db.prepare(contactWithCompany + ' WHERE c.id = ?').get(id));
});

app.put('/api/contacts/:id', (req, res) => {
  const { vorname, nachname, email, telefon, mobil, unternehmen, position, notizen } = req.body;
  if (!vorname || !nachname) return res.status(400).json({ error: 'vorname und nachname sind Pflichtfelder' });
  const unternehmen_id = resolveCompany(unternehmen);
  const r = db.prepare(`
    UPDATE contacts SET vorname=@vorname, nachname=@nachname, email=@email,
      telefon=@telefon, mobil=@mobil, unternehmen_id=@unternehmen_id, position=@position, notizen=@notizen
    WHERE id=@id
  `).run({ id: req.params.id, vorname, nachname, email: email || null, telefon: telefon || null, mobil: mobil || null, unternehmen_id, position: position || null, notizen: notizen || null });
  if (r.changes === 0) return res.status(404).json({ error: 'Kontakt nicht gefunden' });
  res.json(db.prepare(contactWithCompany + ' WHERE c.id = ?').get(req.params.id));
});

app.delete('/api/contacts/:id', (req, res) => {
  const r = db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Kontakt nicht gefunden' });
  res.status(204).end();
});

// ── Companies ─────────────────────────────────────────
const companyWithCount = `
  SELECT co.*, COUNT(c.id) AS kontakte
  FROM companies co
  LEFT JOIN contacts c ON c.unternehmen_id = co.id
  GROUP BY co.id
`;

const companyById = `
  SELECT co.*, COUNT(c.id) AS kontakte
  FROM companies co
  LEFT JOIN contacts c ON c.unternehmen_id = co.id
  WHERE co.id = ?
  GROUP BY co.id
`;

app.get('/api/companies', (req, res) => {
  res.json(db.prepare(companyWithCount + ' ORDER BY co.name').all());
});

app.post('/api/companies', (req, res) => {
  const { id, name, branche, mitarbeiter, website, strasse, plz, ort, land, notizen } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id und name sind Pflichtfelder' });
  db.prepare(`
    INSERT INTO companies (id, name, branche, mitarbeiter, website, strasse, plz, ort, land, notizen)
    VALUES (@id, @name, @branche, @mitarbeiter, @website, @strasse, @plz, @ort, @land, @notizen)
  `).run({ id, name, branche: branche || null, mitarbeiter: mitarbeiter || null, website: website || null, strasse: strasse || null, plz: plz || null, ort: ort || null, land: land || null, notizen: notizen || null });
  res.status(201).json(db.prepare(companyById).get(id));
});

app.put('/api/companies/:id', (req, res) => {
  const { name, branche, mitarbeiter, website, strasse, plz, ort, land, notizen } = req.body;
  if (!name) return res.status(400).json({ error: 'name ist ein Pflichtfeld' });
  const r = db.prepare(`
    UPDATE companies SET name=@name, branche=@branche, mitarbeiter=@mitarbeiter, website=@website,
      strasse=@strasse, plz=@plz, ort=@ort, land=@land, notizen=@notizen
    WHERE id=@id
  `).run({ id: req.params.id, name, branche: branche || null, mitarbeiter: mitarbeiter || null, website: website || null, strasse: strasse || null, plz: plz || null, ort: ort || null, land: land || null, notizen: notizen || null });
  if (r.changes === 0) return res.status(404).json({ error: 'Unternehmen nicht gefunden' });
  res.json(db.prepare(companyWithCount + ' WHERE co.id = ?').get(req.params.id));
});

app.delete('/api/companies/:id', (req, res) => {
  const r = db.prepare('DELETE FROM companies WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Unternehmen nicht gefunden' });
  res.status(204).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SimpleCRM läuft auf http://localhost:${PORT}`));
