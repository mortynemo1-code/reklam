// Слой работы с базой: SQLite через встроенный node:sqlite (Node 22+),
// внешних зависимостей нет.
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");
const fs = require("node:fs");

const DATA_DIR = process.env.REKLAM_DATA_DIR || path.join(__dirname, "data");
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, "reklam.db"));

db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS reklamations (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    text       TEXT NOT NULL,
    problem    TEXT NOT NULL DEFAULT '',
    level      TEXT NOT NULL DEFAULT 'Федеральный уровень',
    status     TEXT NOT NULL DEFAULT 'на рассмотрении',
    position   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const SEED = [
  {
    level: "Федеральный уровень",
    status: "принято",
    problem: "Собственники не видят, куда направляются взносы на капитальный ремонт.",
    text: "Ввести обязательный публичный отчёт регионального оператора капитального ремонта с детализацией по каждому дому, срокам работ и фактической стоимости выполненных этапов."
  },
  {
    level: "Региональный уровень",
    status: "на голосовании",
    problem: "Тепловые сети изношены более чем на 60%, аварии повторяются в одних и тех же участках.",
    text: "Сформировать региональные программы замены тепловых сетей на основе данных о повторяющихся аварийных участках, с приоритетом на объекты социальной инфраструктуры."
  },
  {
    level: "Муниципальный уровень",
    status: "на доработке",
    problem: "Заявки жителей теряются между диспетчерскими службами и подрядчиками.",
    text: "Внедрить единое муниципальное окно приёма заявок с фиксацией срока реакции, автоматической маршрутизацией к исполнителю и обратной связью заявителю на каждом этапе."
  }
];

function seedIfEmpty() {
  const { n } = db.prepare("SELECT COUNT(*) AS n FROM reklamations").get();
  if (n > 0) return;
  const ins = db.prepare(
    "INSERT INTO reklamations (text, problem, level, status, position) VALUES (?, ?, ?, ?, ?)"
  );
  SEED.forEach((s, i) => ins.run(s.text, s.problem, s.level, s.status, i + 1));
}
seedIfEmpty();

const rowById = db.prepare("SELECT * FROM reklamations WHERE id = ?");

function list() {
  return db.prepare("SELECT * FROM reklamations ORDER BY position, id").all();
}

function create({ text, problem = "", level = "Федеральный уровень", status = "на рассмотрении" }) {
  const { p } = db.prepare("SELECT COALESCE(MAX(position), 0) AS p FROM reklamations").get();
  const res = db
    .prepare("INSERT INTO reklamations (text, problem, level, status, position) VALUES (?, ?, ?, ?, ?)")
    .run(text, problem, level, status, p + 1);
  return rowById.get(res.lastInsertRowid);
}

function update(id, { text, problem, level, status }) {
  const row = rowById.get(id);
  if (!row) return null;
  db.prepare(
    `UPDATE reklamations
       SET text = ?, problem = ?, level = ?, status = ?, updated_at = datetime('now')
     WHERE id = ?`
  ).run(
    text ?? row.text,
    problem ?? row.problem,
    level ?? row.level,
    status ?? row.status,
    id
  );
  return rowById.get(id);
}

function remove(id) {
  return db.prepare("DELETE FROM reklamations WHERE id = ?").run(id).changes > 0;
}

module.exports = { list, create, update, remove };
