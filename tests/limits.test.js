// Тесты лимитов попыток (аудит M1, M2, N2, N3). Запуск из папки проекта: node --test tests/
// К настоящей базе и Telegram тест не обращается: fetch подменён фальшивой базой в памяти,
// которая понимает те же запросы к Supabase REST, что и countAttempt в api/_lib.js.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "sb_secret_fake";
process.env.SESSION_SECRET = "test-secret";
process.env.TELEGRAM_BOT_TOKEN = "fake";
process.env.TELEGRAM_CHAT_ID = "1";

const { countAttempt } = await import("../api/_lib.js");
const { default: leadHandler } = await import("../api/lead.js");

// ---------- Фальшивая база: таблицы — массивы строк ----------
let db, nextId, telegramSent;

beforeEach(() => {
  db = { lead_attempts: [], login_attempts: [] };
  nextId = 1;
  telegramSent = [];
});

const reply = (status, data) => new Response(data === undefined ? null : JSON.stringify(data), { status });

globalThis.fetch = async (url, { method = "GET", body } = {}) => {
  const u = new URL(url);
  if (u.hostname === "api.telegram.org") {
    telegramSent.push(JSON.parse(body).text);
    return reply(200, { ok: true });
  }
  const table = u.pathname.replace("/rest/v1/", "");
  const rows = db[table];
  if (!rows) return reply(404, { message: "нет таблицы " + table });

  const match = (r) => [...u.searchParams].every(([key, value]) => {
    if (key === "select" || key === "limit") return true;
    const [op, ...rest] = value.split(".");
    const arg = rest.join(".");
    if (op === "eq") return String(r[key]) === arg;
    if (op === "gte") return r[key] >= arg;
    if (op === "lt") return r[key] < arg;
    if (op === "is") return r[key] === (arg === "true");
    throw new Error("фальшивая база не знает фильтр " + value);
  });

  if (method === "POST") {
    const row = { id: nextId++, at: new Date().toISOString(), passed: false, ...JSON.parse(body) };
    rows.push(row);
    return reply(201, [{ id: row.id }]);
  }
  if (method === "PATCH") {
    rows.filter(match).forEach((r) => Object.assign(r, JSON.parse(body)));
    return reply(204);
  }
  if (method === "DELETE") {
    db[table] = rows.filter((r) => !match(r));
    return reply(204);
  }
  const limit = Number(u.searchParams.get("limit") || Infinity);
  return reply(200, rows.filter(match).slice(0, limit).map((r) => ({ id: r.id })));
};

const LEAD = { windowMin: 60, limitPerIp: 5, limitTotal: 30 };
const LOGIN = { windowMin: 15, limitPerIp: 10, limitTotal: 100 };
const blocked = ({ perIp, total }, lim) => perIp > lim.limitPerIp || total > lim.limitTotal;

// ---------- countAttempt ----------

test("N2: один адрес шлёт 200 заявок — форма для других адресов открыта", async () => {
  let passed = 0;
  for (let i = 0; i < 200; i++) {
    if (!blocked(await countAttempt("lead_attempts", "ip-A", LEAD), LEAD)) passed++;
  }
  assert.equal(passed, 5, "с одного адреса проходят ровно 5 заявок");
  const other = await countAttempt("lead_attempts", "ip-B", LEAD);
  assert.equal(blocked(other, LEAD), false, "заявка с другого адреса проходит");
  assert.equal(other.total, 6, "в общем счётчике 5 заявок адреса A + 1 адреса B");
});

test("N3: один адрес делает 500 попыток входа — вход для других адресов открыт", async () => {
  for (let i = 0; i < 500; i++) await countAttempt("login_attempts", "ip-A", LOGIN);
  const admin = await countAttempt("login_attempts", "ip-admin", LOGIN);
  assert.equal(blocked(admin, LOGIN), false);
  assert.equal(admin.total, 11);
});

test("M2 сохраняется: 7 адресов по 5 заявок — общий лимит 30 срабатывает", async () => {
  const results = [];
  for (let ip = 1; ip <= 7; ip++) {
    for (let i = 0; i < 5; i++) results.push(await countAttempt("lead_attempts", "ip-" + ip, LEAD));
  }
  assert.equal(results.filter((r) => !blocked(r, LEAD)).length, 30);
  assert.equal(results[30].total, 31, "31-я заявка — первая сверх общего лимита (уведомление)");
});

test("M1 сохраняется: 50 параллельных попыток с одного адреса — проходит не больше 10", async () => {
  const results = await Promise.all(Array.from({ length: 50 }, () => countAttempt("login_attempts", "ip-A", LOGIN)));
  assert.ok(results.filter((r) => !blocked(r, LOGIN)).length <= 10);
});

test("заблокированный адрес получает «лимит + 1» один раз, дальше «лимит + 2»", async () => {
  const perIp = [];
  for (let i = 0; i < 8; i++) perIp.push((await countAttempt("lead_attempts", "ip-A", LEAD)).perIp);
  assert.deepEqual(perIp, [1, 2, 3, 4, 5, 6, 7, 7]);
});

test("сбой базы — исключение, а не пропуск без лимита", async () => {
  await assert.rejects(countAttempt("no_such_table", "ip-A", LEAD));
});

// ---------- api/lead.js целиком ----------

function call(handler, ip, body) {
  const req = { method: "POST", headers: { "x-real-ip": ip }, body };
  const res = {
    statusCode: 0, headers: {}, data: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.data = data; return this; },
  };
  return handler(req, res).then(() => res);
}

test("api/lead.js: адрес A забит 50 отправками, адрес B получает обычный ответ, уведомление одно", async () => {
  const codes = [];
  for (let i = 0; i < 50; i++) codes.push((await call(leadHandler, "10.0.0.1", {})).statusCode);
  assert.deepEqual(codes.slice(0, 5), [400, 400, 400, 400, 400], "пустая форма — 400, но считается");
  assert.ok(codes.slice(5).every((c) => c === 429), "дальше адрес A получает 429");
  assert.equal(telegramSent.length, 1, "уведомление о блокировке адреса — одно");

  const b = await call(leadHandler, "10.0.0.2", {});
  assert.equal(b.statusCode, 400, "адрес B не заблокирован: 400 из-за пустой формы, а не 429");
});

// ---------- Аудит N4: смена IP не превращается в поток уведомлений ----------

test("N4: 20 адресов по очереди упираются в лимит — уведомлений о блокировке адресов 3", async () => {
  for (let ip = 1; ip <= 20; ip++) {
    for (let i = 0; i < 6; i++) await call(leadHandler, "10.1.0." + ip, {});
  }
  const ipAlerts = telegramSent.filter((t) => t.includes("с одного адреса"));
  assert.equal(ipAlerts.length, 3, "о заблокированных адресах — не больше 3 сообщений за окно");
  assert.ok(ipAlerts[2].includes("О следующих не пишу"), "третье сообщение предупреждает, что дальше тишина");
  const totalAlerts = telegramSent.filter((t) => t.includes("с разных адресов"));
  assert.equal(totalAlerts.length, 1, "уведомление об общем лимите приходит, как и раньше");
});

test("N4: ipAlert только на первой блокировке адреса, на следующих запросах — 0", async () => {
  const alerts = [];
  for (let i = 0; i < 8; i++) alerts.push((await countAttempt("lead_attempts", "ip-A", LEAD)).ipAlert);
  assert.deepEqual(alerts, [0, 0, 0, 0, 0, 1, 0, 0]);
});
