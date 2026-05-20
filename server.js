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
    id             TEXT PRIMARY KEY,
    name           TEXT NOT NULL,
    branche        TEXT,
    mitarbeiter    INTEGER,
    website        TEXT,
    strasse        TEXT,
    plz            TEXT,
    ort            TEXT,
    land           TEXT,
    notizen        TEXT,
    erstellt_am    TEXT NOT NULL DEFAULT (datetime('now')),
    aktualisiert_am TEXT
  )
`);

// Migration: alte contacts-Tabelle (unternehmen TEXT) → neue (unternehmen_id FK)
const contactCols = db.prepare("SELECT name FROM pragma_table_info('contacts')").all().map(r => r.name);

if (contactCols.length === 0) {
  db.exec(`
    CREATE TABLE contacts (
      id              TEXT PRIMARY KEY,
      vorname         TEXT NOT NULL,
      nachname        TEXT NOT NULL,
      email           TEXT,
      telefon         TEXT,
      mobil           TEXT,
      unternehmen_id  TEXT REFERENCES companies(id) ON DELETE SET NULL,
      position        TEXT,
      notizen         TEXT,
      favorit         INTEGER NOT NULL DEFAULT 0,
      erstellt_am     TEXT NOT NULL DEFAULT (datetime('now')),
      aktualisiert_am TEXT
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
        id              TEXT PRIMARY KEY,
        vorname         TEXT NOT NULL,
        nachname        TEXT NOT NULL,
        email           TEXT,
        telefon         TEXT,
        mobil           TEXT,
        unternehmen_id  TEXT REFERENCES companies(id) ON DELETE SET NULL,
        position        TEXT,
        notizen         TEXT,
        favorit         INTEGER NOT NULL DEFAULT 0,
        erstellt_am     TEXT NOT NULL DEFAULT (datetime('now')),
        aktualisiert_am TEXT
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
} else {
  // Add new columns to existing schema if missing
  for (const [col, def] of [
    ['favorit', 'INTEGER NOT NULL DEFAULT 0'],
    ['aktualisiert_am', 'TEXT'],
  ]) {
    if (!contactCols.includes(col)) {
      db.exec(`ALTER TABLE contacts ADD COLUMN ${col} ${def}`);
    }
  }
  const companyCols = db.prepare("SELECT name FROM pragma_table_info('companies')").all().map(r => r.name);
  if (!companyCols.includes('aktualisiert_am')) {
    db.exec('ALTER TABLE companies ADD COLUMN aktualisiert_am TEXT');
  }
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
  res.json(db.prepare(contactWithCompany + ' ORDER BY c.favorit DESC, c.nachname, c.vorname').all());
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
      telefon=@telefon, mobil=@mobil, unternehmen_id=@unternehmen_id, position=@position,
      notizen=@notizen, aktualisiert_am=datetime('now')
    WHERE id=@id
  `).run({ id: req.params.id, vorname, nachname, email: email || null, telefon: telefon || null, mobil: mobil || null, unternehmen_id, position: position || null, notizen: notizen || null });
  if (r.changes === 0) return res.status(404).json({ error: 'Kontakt nicht gefunden' });
  res.json(db.prepare(contactWithCompany + ' WHERE c.id = ?').get(req.params.id));
});

app.patch('/api/contacts/:id/favorit', (req, res) => {
  const r = db.prepare(
    "UPDATE contacts SET favorit = CASE WHEN favorit = 1 THEN 0 ELSE 1 END, aktualisiert_am = datetime('now') WHERE id = ?"
  ).run(req.params.id);
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
      strasse=@strasse, plz=@plz, ort=@ort, land=@land, notizen=@notizen, aktualisiert_am=datetime('now')
    WHERE id=@id
  `).run({ id: req.params.id, name, branche: branche || null, mitarbeiter: mitarbeiter || null, website: website || null, strasse: strasse || null, plz: plz || null, ort: ort || null, land: land || null, notizen: notizen || null });
  if (r.changes === 0) return res.status(404).json({ error: 'Unternehmen nicht gefunden' });
  res.json(db.prepare(companyById).get(req.params.id));
});

app.delete('/api/companies/:id', (req, res) => {
  const r = db.prepare('DELETE FROM companies WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Unternehmen nicht gefunden' });
  res.status(204).end();
});

// ── Deals ─────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS deals (
    id              TEXT PRIMARY KEY,
    titel           TEXT NOT NULL,
    wert            REAL,
    waehrung        TEXT NOT NULL DEFAULT 'EUR',
    status          TEXT NOT NULL DEFAULT 'offen'
                    CHECK(status IN ('offen','in_verhandlung','gewonnen','verloren')),
    unternehmen_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    kontakt_id      TEXT REFERENCES contacts(id) ON DELETE SET NULL,
    abschluss_datum TEXT,
    notizen         TEXT,
    erstellt_am     TEXT NOT NULL DEFAULT (datetime('now')),
    aktualisiert_am TEXT
  )
`);

const dealWithRefs = `
  SELECT d.*,
    co.name AS unternehmen,
    c.vorname || ' ' || c.nachname AS kontakt_name,
    (SELECT COUNT(*) FROM quotes q WHERE q.deal_id = d.id) AS angebote_count
  FROM deals d
  LEFT JOIN companies co ON d.unternehmen_id = co.id
  LEFT JOIN contacts  c  ON d.kontakt_id     = c.id
`;

app.get('/api/deals', (req, res) => {
  const { unternehmen_id } = req.query;
  const sql = dealWithRefs + (unternehmen_id ? ' WHERE d.unternehmen_id = ?' : '') + ' ORDER BY d.erstellt_am DESC';
  res.json(unternehmen_id ? db.prepare(sql).all(unternehmen_id) : db.prepare(sql).all());
});

app.post('/api/deals', (req, res) => {
  const { id, titel, wert, waehrung, status, unternehmen_id, kontakt_id, abschluss_datum, notizen } = req.body;
  if (!id || !titel || !unternehmen_id) return res.status(400).json({ error: 'id, titel und unternehmen_id sind Pflichtfelder' });
  db.prepare(`
    INSERT INTO deals (id, titel, wert, waehrung, status, unternehmen_id, kontakt_id, abschluss_datum, notizen)
    VALUES (@id, @titel, @wert, @waehrung, @status, @unternehmen_id, @kontakt_id, @abschluss_datum, @notizen)
  `).run({ id, titel, wert: wert || null, waehrung: waehrung || 'EUR', status: status || 'offen', unternehmen_id, kontakt_id: kontakt_id || null, abschluss_datum: abschluss_datum || null, notizen: notizen || null });
  res.status(201).json(db.prepare(dealWithRefs + ' WHERE d.id = ?').get(id));
});

app.put('/api/deals/:id', (req, res) => {
  const { titel, wert, waehrung, status, unternehmen_id, kontakt_id, abschluss_datum, notizen } = req.body;
  if (!titel || !unternehmen_id) return res.status(400).json({ error: 'titel und unternehmen_id sind Pflichtfelder' });
  const r = db.prepare(`
    UPDATE deals SET titel=@titel, wert=@wert, waehrung=@waehrung, status=@status,
      unternehmen_id=@unternehmen_id, kontakt_id=@kontakt_id,
      abschluss_datum=@abschluss_datum, notizen=@notizen, aktualisiert_am=datetime('now')
    WHERE id=@id
  `).run({ id: req.params.id, titel, wert: wert || null, waehrung: waehrung || 'EUR', status: status || 'offen', unternehmen_id, kontakt_id: kontakt_id || null, abschluss_datum: abschluss_datum || null, notizen: notizen || null });
  if (r.changes === 0) return res.status(404).json({ error: 'Deal nicht gefunden' });
  res.json(db.prepare(dealWithRefs + ' WHERE d.id = ?').get(req.params.id));
});

app.patch('/api/deals/:id/status', (req, res) => {
  const { status } = req.body;
  if (!['offen','in_verhandlung','gewonnen','verloren'].includes(status))
    return res.status(400).json({ error: 'Ungültiger Status' });
  const r = db.prepare("UPDATE deals SET status=?, aktualisiert_am=datetime('now') WHERE id=?").run(status, req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Deal nicht gefunden' });
  res.json(db.prepare(dealWithRefs + ' WHERE d.id = ?').get(req.params.id));
});

app.delete('/api/deals/:id', (req, res) => {
  const r = db.prepare('DELETE FROM deals WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Deal nicht gefunden' });
  res.status(204).end();
});

// ── Products ──────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS products (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    beschreibung    TEXT,
    preis           REAL NOT NULL DEFAULT 0,
    waehrung        TEXT NOT NULL DEFAULT 'EUR',
    einheit         TEXT NOT NULL DEFAULT 'Stück',
    erstellt_am     TEXT NOT NULL DEFAULT (datetime('now')),
    aktualisiert_am TEXT
  )
`);

app.get('/api/products', (req, res) => {
  res.json(db.prepare('SELECT * FROM products ORDER BY name').all());
});

app.post('/api/products', (req, res) => {
  const { id, name, beschreibung, preis, waehrung, einheit } = req.body;
  if (!id || !name) return res.status(400).json({ error: 'id und name sind Pflichtfelder' });
  db.prepare(`
    INSERT INTO products (id, name, beschreibung, preis, waehrung, einheit)
    VALUES (@id, @name, @beschreibung, @preis, @waehrung, @einheit)
  `).run({ id, name, beschreibung: beschreibung || null, preis: preis ?? 0, waehrung: waehrung || 'EUR', einheit: einheit || 'Stück' });
  res.status(201).json(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
});

app.put('/api/products/:id', (req, res) => {
  const { name, beschreibung, preis, waehrung, einheit } = req.body;
  if (!name) return res.status(400).json({ error: 'name ist ein Pflichtfeld' });
  const r = db.prepare(`
    UPDATE products SET name=@name, beschreibung=@beschreibung, preis=@preis,
      waehrung=@waehrung, einheit=@einheit, aktualisiert_am=datetime('now')
    WHERE id=@id
  `).run({ id: req.params.id, name, beschreibung: beschreibung || null, preis: preis ?? 0, waehrung: waehrung || 'EUR', einheit: einheit || 'Stück' });
  if (r.changes === 0) return res.status(404).json({ error: 'Produkt nicht gefunden' });
  res.json(db.prepare('SELECT * FROM products WHERE id = ?').get(req.params.id));
});

app.delete('/api/products/:id', (req, res) => {
  const r = db.prepare('DELETE FROM products WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Produkt nicht gefunden' });
  res.status(204).end();
});

// ── Quotes ────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS quotes (
    id              TEXT PRIMARY KEY,
    titel           TEXT NOT NULL,
    deal_id         TEXT REFERENCES deals(id) ON DELETE SET NULL,
    status          TEXT NOT NULL DEFAULT 'Entwurf'
                    CHECK(status IN ('Entwurf','Gesendet','Angenommen','Abgelehnt')),
    gueltig_bis     TEXT,
    waehrung        TEXT NOT NULL DEFAULT 'EUR',
    notizen         TEXT,
    erstellt_am     TEXT NOT NULL DEFAULT (datetime('now')),
    aktualisiert_am TEXT
  )
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS quote_items (
    id           TEXT PRIMARY KEY,
    quote_id     TEXT NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
    position     INTEGER NOT NULL DEFAULT 0,
    bezeichnung  TEXT NOT NULL,
    beschreibung TEXT,
    menge        REAL NOT NULL DEFAULT 1,
    einheit      TEXT NOT NULL DEFAULT 'Stück',
    einzelpreis  REAL NOT NULL DEFAULT 0,
    rabatt_proz  REAL NOT NULL DEFAULT 0
  )
`);

const quoteWithDeal = `
  SELECT q.*,
    d.titel AS deal_titel,
    COALESCE((SELECT SUM(qi.menge * qi.einzelpreis * (1.0 - qi.rabatt_proz / 100.0))
              FROM quote_items qi WHERE qi.quote_id = q.id), 0) AS gesamtwert,
    (SELECT COUNT(*) FROM quote_items qi WHERE qi.quote_id = q.id) AS positionen
  FROM quotes q
  LEFT JOIN deals d ON q.deal_id = d.id
`;

app.get('/api/quotes', (req, res) => {
  const { deal_id } = req.query;
  const sql = quoteWithDeal + (deal_id ? ' WHERE q.deal_id = ?' : '') + ' ORDER BY q.erstellt_am DESC';
  res.json(deal_id ? db.prepare(sql).all(deal_id) : db.prepare(sql).all());
});

app.get('/api/quotes/:id', (req, res) => {
  const quote = db.prepare(quoteWithDeal + ' WHERE q.id = ?').get(req.params.id);
  if (!quote) return res.status(404).json({ error: 'Angebot nicht gefunden' });
  quote.items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY position').all(req.params.id);
  res.json(quote);
});

function upsertQuoteItems(quoteId, items) {
  db.prepare('DELETE FROM quote_items WHERE quote_id = ?').run(quoteId);
  const ins = db.prepare(`
    INSERT INTO quote_items (id, quote_id, position, bezeichnung, beschreibung, menge, einheit, einzelpreis, rabatt_proz)
    VALUES (@id, @quote_id, @position, @bezeichnung, @beschreibung, @menge, @einheit, @einzelpreis, @rabatt_proz)
  `);
  items.forEach((it, i) => ins.run({
    id: it.id || randomUUID(),
    quote_id: quoteId,
    position: i,
    bezeichnung: it.bezeichnung,
    beschreibung: it.beschreibung || null,
    menge: it.menge ?? 1,
    einheit: it.einheit || 'Stück',
    einzelpreis: it.einzelpreis ?? 0,
    rabatt_proz: it.rabatt_proz ?? 0,
  }));
}

app.post('/api/quotes', (req, res) => {
  const { id, titel, deal_id, status, gueltig_bis, waehrung, notizen, items = [] } = req.body;
  if (!id || !titel) return res.status(400).json({ error: 'id und titel sind Pflichtfelder' });
  db.transaction(() => {
    db.prepare(`
      INSERT INTO quotes (id, titel, deal_id, status, gueltig_bis, waehrung, notizen)
      VALUES (@id, @titel, @deal_id, @status, @gueltig_bis, @waehrung, @notizen)
    `).run({ id, titel, deal_id: deal_id || null, status: status || 'Entwurf', gueltig_bis: gueltig_bis || null, waehrung: waehrung || 'EUR', notizen: notizen || null });
    upsertQuoteItems(id, items);
  })();
  const quote = db.prepare(quoteWithDeal + ' WHERE q.id = ?').get(id);
  quote.items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY position').all(id);
  res.status(201).json(quote);
});

app.put('/api/quotes/:id', (req, res) => {
  const { titel, deal_id, status, gueltig_bis, waehrung, notizen, items = [] } = req.body;
  if (!titel) return res.status(400).json({ error: 'titel ist ein Pflichtfeld' });
  let notFound = false;
  db.transaction(() => {
    const r = db.prepare(`
      UPDATE quotes SET titel=@titel, deal_id=@deal_id, status=@status,
        gueltig_bis=@gueltig_bis, waehrung=@waehrung, notizen=@notizen, aktualisiert_am=datetime('now')
      WHERE id=@id
    `).run({ id: req.params.id, titel, deal_id: deal_id || null, status: status || 'Entwurf', gueltig_bis: gueltig_bis || null, waehrung: waehrung || 'EUR', notizen: notizen || null });
    if (r.changes === 0) { notFound = true; return; }
    upsertQuoteItems(req.params.id, items);
  })();
  if (notFound) return res.status(404).json({ error: 'Angebot nicht gefunden' });
  const quote = db.prepare(quoteWithDeal + ' WHERE q.id = ?').get(req.params.id);
  quote.items = db.prepare('SELECT * FROM quote_items WHERE quote_id = ? ORDER BY position').all(req.params.id);
  res.json(quote);
});

app.delete('/api/quotes/:id', (req, res) => {
  const r = db.prepare('DELETE FROM quotes WHERE id = ?').run(req.params.id);
  if (r.changes === 0) return res.status(404).json({ error: 'Angebot nicht gefunden' });
  res.status(204).end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SimpleCRM läuft auf http://localhost:${PORT}`));
