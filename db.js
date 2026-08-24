// Слой работы с базой: PostgreSQL через пул соединений pg.
// Подключение настраивается переменной DATABASE_URL
// (postgres://user:pass@host:5432/dbname) либо стандартными
// переменными окружения pg: PGHOST, PGPORT, PGUSER, PGPASSWORD, PGDATABASE.
const { Pool } = require("pg");

const pool = new Pool(
  process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : { database: process.env.PGDATABASE || "reklam" }
);

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

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS reklamations (
      id         SERIAL PRIMARY KEY,
      text       TEXT NOT NULL,
      problem    TEXT NOT NULL DEFAULT '',
      level      TEXT NOT NULL DEFAULT 'Федеральный уровень',
      status     TEXT NOT NULL DEFAULT 'на рассмотрении',
      position   INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  const { rows: [{ n }] } = await pool.query("SELECT COUNT(*)::int AS n FROM reklamations");
  if (n === 0) {
    for (const [i, s] of SEED.entries()) {
      await pool.query(
        "INSERT INTO reklamations (text, problem, level, status, position) VALUES ($1, $2, $3, $4, $5)",
        [s.text, s.problem, s.level, s.status, i + 1]
      );
    }
  }
}

async function list() {
  const { rows } = await pool.query("SELECT * FROM reklamations ORDER BY position, id");
  return rows;
}

async function create({ text, problem = "", level = "Федеральный уровень", status = "на рассмотрении" }) {
  const { rows: [row] } = await pool.query(
    `INSERT INTO reklamations (text, problem, level, status, position)
     VALUES ($1, $2, $3, $4, (SELECT COALESCE(MAX(position), 0) + 1 FROM reklamations))
     RETURNING *`,
    [text, problem, level, status]
  );
  return row;
}

async function update(id, { text, problem, level, status }) {
  const { rows: [row] } = await pool.query(
    `UPDATE reklamations
        SET text       = COALESCE($2, text),
            problem    = COALESCE($3, problem),
            level      = COALESCE($4, level),
            status     = COALESCE($5, status),
            updated_at = now()
      WHERE id = $1
      RETURNING *`,
    [id, text ?? null, problem ?? null, level ?? null, status ?? null]
  );
  return row || null;
}

async function remove(id) {
  const res = await pool.query("DELETE FROM reklamations WHERE id = $1", [id]);
  return res.rowCount > 0;
}

module.exports = { init, list, create, update, remove };
