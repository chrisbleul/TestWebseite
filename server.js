const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');

const app = express();
const dbPath = process.env.DB_PATH || path.join(__dirname, 'crm.db');
const db = new Database(dbPath);

// Schema
db.exec(`
  CREATE TABLE IF NOT EXISTS contacts (
    id          TEXT PRIMARY KEY,
    vorname     TEXT NOT NULL,
    nachname    TEXT NOT NULL,
    email       TEXT,
    telefon     TEXT,
    mobil       TEXT,
    unternehmen TEXT,
    position    TEXT,
    notizen     TEXT,
    erstellt_am TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// GET alle Kontakte
app.get('/api/contacts', (req, res) => {
  const contacts = db.prepare('SELECT * FROM contacts ORDER BY nachname, vorname').all();
  res.json(contacts);
});

// POST neuer Kontakt
app.post('/api/contacts', (req, res) => {
  const { id, vorname, nachname, email, telefon, mobil, unternehmen, position, notizen } = req.body;
  if (!id || !vorname || !nachname) {
    return res.status(400).json({ error: 'id, vorname und nachname sind Pflichtfelder' });
  }
  db.prepare(`
    INSERT INTO contacts (id, vorname, nachname, email, telefon, mobil, unternehmen, position, notizen)
    VALUES (@id, @vorname, @nachname, @email, @telefon, @mobil, @unternehmen, @position, @notizen)
  `).run({ id, vorname, nachname, email: email || null, telefon: telefon || null, mobil: mobil || null, unternehmen: unternehmen || null, position: position || null, notizen: notizen || null });
  res.status(201).json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(id));
});

// PUT Kontakt aktualisieren
app.put('/api/contacts/:id', (req, res) => {
  const { vorname, nachname, email, telefon, mobil, unternehmen, position, notizen } = req.body;
  if (!vorname || !nachname) {
    return res.status(400).json({ error: 'vorname und nachname sind Pflichtfelder' });
  }
  const result = db.prepare(`
    UPDATE contacts SET vorname=@vorname, nachname=@nachname, email=@email,
    telefon=@telefon, mobil=@mobil, unternehmen=@unternehmen, position=@position, notizen=@notizen
    WHERE id=@id
  `).run({ id: req.params.id, vorname, nachname, email: email || null, telefon: telefon || null, mobil: mobil || null, unternehmen: unternehmen || null, position: position || null, notizen: notizen || null });
  if (result.changes === 0) return res.status(404).json({ error: 'Kontakt nicht gefunden' });
  res.json(db.prepare('SELECT * FROM contacts WHERE id = ?').get(req.params.id));
});

// DELETE Kontakt löschen
app.delete('/api/contacts/:id', (req, res) => {
  const result = db.prepare('DELETE FROM contacts WHERE id = ?').run(req.params.id);
  if (result.changes === 0) return res.status(404).json({ error: 'Kontakt nicht gefunden' });
  res.status(204).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SimpleCRM läuft auf http://localhost:${PORT}`));
