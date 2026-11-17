// Тесты согласия на обработку контактов и возраста (аудит безопасности, L5). Запуск из папки проекта: node --test tests/
// К настоящей базе и Telegram тест не обращается: fetch подменён фальшивой базой в памяти.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

process.env.SUPABASE_URL = "https://fake.supabase.test";
process.env.SUPABASE_SERVICE_KEY = "sb_secret_fake";
process.env.SESSION_SECRET = "test-secret";
process.env.TELEGRAM_BOT_TOKEN = "fake-bot-token";
process.env.TELEGRAM_CHAT_ID = "1";
process.env.VOICE_SECRET = "voice-test-secret";

const lib = await import("../api/_lib.js");
const { default: leadHandler } = await import("../api/lead.js");
const { default: voiceHandler } = await import("../api/voice-lead.js");
const { default: appHandler } = await import("../api/app.js");

// ---------- Фальшивая база: таблицы — массивы строк ----------
let db, nextId, telegramSent;

beforeEach(() => {
  db = { lead_attempts: [], voice_attempts: [], app_attempts: [], leads: [] };
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
    if (["select", "limit", "order"].includes(key)) return true;
    const [op, ...rest] = value.split(".");
    const arg = rest.join(".");
    if (op === "eq") return String(r[key]) === arg;
    if (op === "gte") return r[key] >= arg;
    if (op === "lt") return r[key] < arg;
    if (op === "is") return r[key] === (arg === "null" ? null : arg === "true");
    if (op === "in") return arg.replace(/^\(|\)$/g, "").split(",").map((s) => s.replace(/"/g, "")).includes(String(r[key]));
    throw new Error("фальшивая база не знает фильтр " + value);
  });

  if (method === "POST") {
    const now = new Date().toISOString();
    const row = { id: nextId++, at: now, created_at: now, passed: false, ...JSON.parse(body) };
    rows.push(row);
    return reply(201, [row]);
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
  return reply(200, rows.filter(match).slice(0, limit));
};

function call(handler, { headers = {}, body = {}, method = "POST" }) {
  const res = {
    statusCode: 200, headers: {}, data: null,
    setHeader(k, v) { this.headers[k] = v; },
    status(code) { this.statusCode = code; return this; },
    json(data) { this.data = data; return this; },
  };
  return handler({ method, headers, body }, res).then(() => res);
}

const PARENT = "Младше 14";

// Каждая заявка — со своего адреса и телефона, чтобы лимит и «повтор за 30 минут» не мешали проверкам
let seq = 0;
const lead = (extra) => {
  seq++;
  return call(leadHandler, {
    headers: { "x-real-ip": "10.9.0." + seq },
    body: { name: "Test", phone: "+373 600 20 " + String(seq).padStart(3, "0"), ...extra },
  });
};

// ---------- ageValue и needsParent ----------

test("ageValue: границы, пустые значения и строки из формы", () => {
  const ok = (v, age) => assert.deepEqual(lib.ageValue(v), { ok: true, age }, "ageValue(" + JSON.stringify(v) + ")");
  const bad = (v) => assert.equal(lib.ageValue(v).ok, false, "ageValue(" + JSON.stringify(v) + ") должен быть не ок");
  ok("", null); ok(null, null); ok(undefined, null);
  ok(10, 10); ok(14, 14); ok(99, 99); ok("12", 12); ok(" 12 ", 12);
  bad(9); bad(100); bad(12.5); bad("12.5"); bad("abc"); bad("7"); bad(" "); bad(-12);
});

test("needsParent: только известный возраст младше 14", () => {
  assert.equal(lib.needsParent(13), true);
  assert.equal(lib.needsParent(14), false);
  assert.equal(lib.needsParent(null), false, "null < 14 в JS — true, но возраста нет — пометки нет");
  assert.equal(lib.needsParent(undefined), false);
});

// ---------- Форма сайта: api/lead.js ----------

test("lead: без согласия — 400, заявка не сохраняется, Telegram молчит", async () => {
  const r = await lead({});
  assert.equal(r.statusCode, 400);
  assert.match(r.data.error, /согласие/);
  assert.equal(db.leads.length, 0);
  assert.equal(telegramSent.length, 0);
});

test("lead: согласие только строго true — строка и единица не считаются", async () => {
  assert.equal((await lead({ consent: "true" })).statusCode, 400);
  assert.equal((await lead({ consent: 1 })).statusCode, 400);
  assert.equal(db.leads.length, 0);
});

test("lead: нет имени и нет согласия — сначала ошибка про имя, как в браузере", async () => {
  const r = await lead({ name: "" });
  assert.equal(r.statusCode, 400);
  assert.match(r.data.error, /обращаться/);
});

test("lead: с согласием — 201, время согласия ставит сервер", async () => {
  const before = Date.now();
  const r = await lead({ consent: true, consent_at: "2000-01-01T00:00:00.000Z" });
  assert.equal(r.statusCode, 201);
  assert.equal(db.leads.length, 1);
  const at = Date.parse(db.leads[0].consent_at);
  assert.ok(at >= before && at <= Date.now(), "consent_at — время сервера, а не из запроса");
});

test("lead: без возраста — 201, age null, пометки «до 14» нет", async () => {
  const r = await lead({ consent: true, age: "" });
  assert.equal(r.statusCode, 201);
  assert.equal(db.leads[0].age, null);
  assert.equal(telegramSent.length, 1);
  assert.ok(!telegramSent[0].includes(PARENT));
});

test("lead: возраст строкой из формы — «12» принимается, мусор и вне 10–99 — 400", async () => {
  assert.equal((await lead({ consent: true, age: "12" })).statusCode, 201);
  assert.equal(db.leads[0].age, 12);
  for (const age of ["12.5", "abc", "7", 7, 100]) {
    const r = await lead({ consent: true, age });
    assert.equal(r.statusCode, 400, "возраст " + JSON.stringify(age));
    assert.match(r.data.error, /возраст/);
  }
  assert.equal(db.leads.length, 1);
});

test("lead: пометка «до 14» — у 13 есть, у 14 и 16 нет", async () => {
  await lead({ consent: true, age: 13 });
  await lead({ consent: true, age: 14 });
  await lead({ consent: true, age: 16 });
  assert.equal(telegramSent.length, 3);
  assert.ok(telegramSent[0].includes(PARENT));
  assert.ok(!telegramSent[1].includes(PARENT));
  assert.ok(!telegramSent[2].includes(PARENT));
});

// ---------- Голосовой агент: api/voice-lead.js ----------

const voice = (extra) => {
  seq++;
  return call(voiceHandler, {
    headers: { "x-voice-secret": process.env.VOICE_SECRET },
    body: { name: "Test", phone: "+373 600 30 " + String(seq).padStart(3, "0"), consent: true, topic: "Психолог", ...extra },
  });
};

test("voice: время согласия записывается", async () => {
  const r = await voice({ age: 16 });
  assert.equal(r.statusCode, 201);
  assert.ok(db.leads[0].consent_at, "consent_at заполнен");
  assert.ok(!telegramSent.some((t) => t.includes(PARENT)));
});

test("voice: ребёнок 8 лет — возраст сохраняется, в Telegram пометка «до 14»", async () => {
  const r = await voice({ age: 8 });
  assert.equal(r.statusCode, 201);
  assert.equal(db.leads[0].age, 8);
  assert.ok(db.leads[0].consent_at);
  assert.ok(telegramSent.some((t) => t.includes(PARENT)));
});

// ---------- Mini App: api/app.js ----------

function initData(userId) {
  const params = new URLSearchParams({
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: userId, first_name: "Test" }),
  });
  const check = [...params].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(process.env.TELEGRAM_BOT_TOKEN).digest();
  params.set("hash", crypto.createHmac("sha256", secret).update(check).digest("hex"));
  return params.toString();
}

const tomorrow = new Date(Date.now() + 86400000).toLocaleDateString("sv-SE", { timeZone: "Europe/Chisinau" });
const book = (userId, extra) => call(appHandler, {
  headers: { authorization: "tma " + initData(userId) },
  body: { topic: "Психолог", date: tomorrow, time: "12:00", phone: "+373 600 00 000", ...extra },
});

test("app: без согласия — 400, запись не создаётся, лимит не расходуется", async () => {
  const r = await book(5001, {});
  assert.equal(r.statusCode, 400);
  assert.match(r.data.error, /согласие/);
  assert.equal(db.leads.length, 0);
  assert.equal(db.app_attempts.length, 0);
});

test("app: с согласием — 201, время согласия записано", async () => {
  const r = await book(5002, { consent: true });
  assert.equal(r.statusCode, 201);
  assert.ok(db.leads[0].consent_at);
});
