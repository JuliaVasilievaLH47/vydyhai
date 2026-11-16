// Тесты clean() из api/_lib.js. Запуск из папки проекта: node --test tests/
// Без зависимостей: встроенный тестовый модуль Node. Папка tests не публикуется на сайте (.vercelignore).
import { test } from "node:test";
import assert from "node:assert/strict";
import { clean } from "../api/_lib.js";

test("строка короче предела не меняется", () => {
  assert.equal(clean("хочет к психологу", 300), "хочет к психологу");
});

test("длинная строка обрезается до предела (summary голосовой заявки, аудит M4)", () => {
  assert.equal(clean("x".repeat(400), 300).length, 300);
});

test("пустые значения дают пустую строку", () => {
  assert.equal(clean(undefined, 300), "");
  assert.equal(clean(null, 300), "");
  assert.equal(clean("", 300), "");
});

test("пробелы по краям убираются до обрезки", () => {
  assert.equal(clean("   тема   ", 300), "тема");
  assert.equal(clean("  " + "y".repeat(10), 5), "yyyyy");
});
