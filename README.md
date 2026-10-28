# Выдыхай

Лендинг для подростков о вреде сигарет и вейпов с формой заявки, админ-панелью и уведомлениями в Telegram.

- `index.html` — лендинг с формой заявки
- `admin.html` — админ-панель (адрес `/admin`, вход по паролю)
- `api/lead.js` — принимает заявку, сохраняет в Supabase, шлёт сообщение в Telegram
- `api/login.js` — вход в админку
- `api/leads.js` — список заявок, фильтр и смена статуса
- `supabase.sql` — создание таблицы заявок

Ключей в коде нет. Все они задаются в Vercel как переменные окружения.

## Запуск: пошагово

### 1. Supabase
1. Зайдите на supabase.com → **New project**. Регион лучше выбрать Frankfurt.
2. Откройте **SQL Editor → New query**, вставьте содержимое `supabase.sql` и нажмите **Run**.
3. Откройте **Project Settings → API Keys** (или Data API) и скопируйте:
   - **Project URL**: это будет `SUPABASE_URL`;
   - **Secret key** (`sb_secret_…`) или старый **service_role**: это будет `SUPABASE_SERVICE_KEY`.
   Ключ `anon` / `publishable` не подходит.

### 2. Telegram-бот
1. Напишите в Telegram боту **@BotFather** команду `/newbot` и придумайте имя. Он пришлёт токен: это `TELEGRAM_BOT_TOKEN`.
2. Найдите своего нового бота и нажмите **Start** (или напишите ему любое сообщение).
3. Откройте в браузере `https://api.telegram.org/bot<ТОКЕН>/getUpdates` и найдите `"chat":{"id":123456789`. Это число — `TELEGRAM_CHAT_ID`.

### 3. Пароль админки и секрет
- `ADMIN_PASSWORD`: придумайте надёжный пароль для входа в `/admin`.
- `SESSION_SECRET`: длинная случайная строка. Её можно получить в PowerShell:
  ```powershell
  $b = New-Object byte[] 32; [Security.Cryptography.RNGCryptoServiceProvider]::new().GetBytes($b); [Convert]::ToBase64String($b)
  ```

### 4. GitHub
1. На github.com нажмите **New repository**, назовите его `vydyhai` и создайте.
2. Нажмите **uploading an existing file** и перетащите все файлы и папку `api` из папки проекта.
3. Нажмите **Commit changes**. Файлов `.env` с настоящими ключами в репозитории быть не должно.

### 5. Vercel
1. На vercel.com выберите **Add New → Project** и импортируйте репозиторий `vydyhai`.
2. В поле **Framework Preset** выберите **Other**. Сборка не нужна.
3. В разделе **Environment Variables** добавьте шесть переменных:
   `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `ADMIN_PASSWORD`, `SESSION_SECRET`.
4. Нажмите **Deploy**. Если переменные меняли позже, нужно сделать **Deployments → … → Redeploy**.

## Проверка по заданию
1. Откройте сайт по публичной ссылке Vercel с телефона. Отправьте пустую форму: должна появиться ошибка. Отправьте заполненную: должно появиться подтверждение.
2. Откройте Supabase → **Table Editor → leads**. Там будет заявка с датой и статусом «новая».
3. Откройте `/admin` в режиме инкогнито: без пароля заявки не видны. После входа видны все заявки (свежие сверху), их можно фильтровать по статусу и менять статус.
4. Проверьте Telegram: после заявки бот присылает сообщение со всеми данными.
5. Поищите на GitHub в репозитории `sb_secret`, `eyJ` и токен бота. Ничего не должно найтись.
