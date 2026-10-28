// POST /api/login — проверяет пароль админа и выдаёт токен на 12 часов
import { readBody, safeEqual, makeToken } from "./_lib.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "Метод не поддерживается" });
  }

  const { password } = readBody(req);
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return res.status(500).json({ error: "На сервере не задан ADMIN_PASSWORD" });

  if (!password || !safeEqual(password, expected)) {
    // Небольшая пауза мешает подбирать пароль перебором
    await new Promise((r) => setTimeout(r, 800));
    return res.status(401).json({ error: "Неверный пароль" });
  }

  return res.status(200).json({ token: makeToken() });
}
