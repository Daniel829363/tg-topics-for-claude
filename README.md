# tg-topics — Claude Code в Telegram, отдельная сессия на каждую тему

Надстройка над официальным Telegram-плагином Claude Code (`telegram@claude-plugins-official`).

- **Каждая тема супергруппы — своя сессия Claude Code.** У сессии своя папка, свои правила (`INSTRUCTIONS.md`), своя сжатая память (`MEMORY.md`) и история (`history.jsonl`). Личка с ботом — основная сессия. Сессии работают параллельно и открываются сами на первое сообщение (вкладки Windows Terminal).
- **Меню команд бота настраивается само**: при первом подключении, при смене токена на другого бота и после обновления плагина. Старые команды бота, если он раньше использовался для другого, затираются.
- **Команды бота:** `/start`, `/help` (подробная справка), `/setup` (что вводить в терминал), `/id` (ID человека, группы, темы и готовая команда подключения), `/status`, `/sessions`. На них отвечает роутер, сессию Claude они не будят.
- **Установка одной командой** `/tg-topics:setup`, автозапуск роутера при входе в Windows, самовосстановление после обновлений официального плагина.

```
Telegram ──getUpdates──► tg-router (127.0.0.1:8789) ──WebSocket──► сессии claude
                          ├ команды бота → отвечает сам            ├ dm          — личка (основная)
                          ├ личка → dm                             ├ -100…:12    — тема «Видео»
                          └ тема  → <chat_id>:<thread_id>          └ -100…:34    — тема «Сценарии»
                            нет сессии → открывает вкладку Windows Terminal, держит сообщения в очереди
Ответы каждая сессия шлёт прямо в Telegram, в свою тему.
```

## Почему надстройка, а не свой канал

Claude Code пускает без вопросов только каналы из своего одобренного списка. Свой канал запускается лишь с флагом `--dangerously-load-development-channels`, и на каждом старте нужно подтверждать предупреждение. Сессии тем, которые роутер открывает сам, на этом окне зависали бы. Поэтому tg-topics оставляет канал официальным, а его `server.ts` заменяет своей версией: она умеет темы и роутер. Оригинал сохраняется рядом как `server.ts.upstream`. Если официальный плагин обновится, оверлей вернётся сам: при старте любой сессии и раз в 10 минут из роутера. Вернуть оригинал: `/tg-topics:router unpatch`.

## Требования

- Windows 10/11 и Windows Terminal: в нём открываются вкладки сессий. На macOS и Linux роутер и команды работают, но сессии тем придётся запускать через `launcher: "command"` в конфиге.
- Claude Code 2.1+. Каналы (`--channels`) — research preview. В организациях Team и Enterprise их должен включить админ.
- [Bun](https://bun.sh): `powershell -c "irm bun.sh/install.ps1 | iex"`.
- Бот от [@BotFather](https://t.me/BotFather): `/newbot` → токен вида `123456789:AAH…`.

## Установка

В любой сессии Claude Code:

```
/plugin install telegram@claude-plugins-official
/plugin marketplace add <github-user>/tg-topics
/plugin install tg-topics@tg-topics
/reload-plugins
/telegram:configure 123456789:AAH...
/tg-topics:setup
```

Вместо GitHub можно указать папку, распакованную из архива: `/plugin marketplace add C:\путь\к\tg-topics`.

`/tg-topics:setup`:
1. Ставит оверлей в официальный плагин.
2. Создаёт конфиг роутера в `~/.claude/tg-router/`.
3. Включает Telegram только для Telegram-сессий: файл `~/.claude/telegram-session.settings.json`. Иначе любая обычная сессия перехватывала бы личку бота.
4. Создаёт `claude-telegram.bat`: основная сессия. Если на рабочем столе такого файла нет, кладёт туда копию.
5. Включает автозапуск роутера.
6. Записывает меню команд бота и запускает роутер.

Флаги:
- `--skip-permissions` — сессии запускаются с `--dangerously-skip-permissions`, Claude не спрашивает разрешений. Без флага запросы приходят в Telegram кнопками ✅/❌.
- `--no-autostart` — не запускать роутер при входе в Windows.

### Доступ

1. Напиши боту в личку `/id`. Он пришлёт твой ID и готовую команду.
2. Открой `claude-telegram.bat` и введи в этом окне Claude Code:
   ```
   /telegram:access allow <твой ID>
   /telegram:access policy allowlist
   ```
   Вторая команда закрывает бота от чужих: им перестают приходить коды подтверждения.

### Группа с темами

1. Добавь бота в супергруппу и сделай админом. Включи **Темы** в настройках группы.
2. Напиши в группе `/id`. Бот пришлёт ID группы и готовые команды.
3. В терминале Claude Code с Telegram:
   ```
   /telegram:access group add -100… --no-mention --allow <твой ID>
   ```
   `--no-mention`: отвечать на все сообщения, без @упоминания. `--allow`: слушать только этих людей.
4. Пиши в любую тему. Для неё откроется своя сессия: первый ответ через 20–30 секунд, дальше сразу.

## Команды

**В Telegram** (меню появляется само):

| Команда | Что делает |
|---|---|
| `/start` | начало, для чужих — как получить доступ |
| `/help` | подробная справка |
| `/setup` | команды для терминала: группы, люди, токен (копируются нажатием) |
| `/id` | в личке — твой ID; в группе — ID группы и темы, статус и готовая команда `group add` |
| `/status` | есть ли доступ |
| `/sessions` | какие сессии Claude запущены |

**В терминале Claude Code:**

| Команда | Что делает |
|---|---|
| `/tg-topics:setup` | установить или починить всё |
| `/tg-topics:help` | шпаргалка по командам и текущее состояние |
| `/tg-topics:router status` | роутер, сессии, автозапуск, меню, доступ |
| `/tg-topics:router start` / `stop` / `restart` | роутер. Сессии переживают перезапуск и переподключаются сами |
| `/tg-topics:router logs 50` | последние строки лога |
| `/tg-topics:router autostart on` / `off` | автозапуск при входе в Windows |
| `/tg-topics:router commands --force` | заново записать меню команд бота |
| `/tg-topics:router patch` / `unpatch` | поставить или снять оверлей с официального плагина |
| `/telegram:configure <токен>` | сменить токен. Роутер сам переключится на нового бота и настроит ему меню; открытые сессии перезапусти |
| `/telegram:access …` | доступ: `pair`, `allow`, `remove`, `policy`, `group add/rm`, `set` |

## Где что лежит

| Путь | Что это |
|---|---|
| `~/.claude/tg-router/config.json` | настройки роутера: порт, папка тем, лимит сессий, команда запуска claude |
| `~/.claude/tg-router/state/` | названия тем, привязка тема → папка, offset |
| `~/.claude/tg-router/logs/router.log` | лог роутера |
| `~/.claude/tg-router/claude-telegram.bat` | запуск основной сессии |
| `~/tg-topics/<группа>/<тема>-<id>/` | папка темы: `CLAUDE.md` (генерируется), `INSTRUCTIONS.md`, `MEMORY.md`, `history.jsonl` |
| `~/tg-topics/_template/INSTRUCTIONS.md` | твой шаблон инструкции для новых тем (по желанию) |
| `~/.claude/channels/telegram/` | токен и `access.json` официального плагина |
| http://127.0.0.1:8789/status | состояние роутера в JSON |

## Обновление и удаление

Обновить:

```
/plugin marketplace update tg-topics
/plugin update tg-topics@tg-topics
```

При следующем старте сессии хук сам перезапустит роутер на новой версии.

Удалить:

```
/tg-topics:router unpatch
/tg-topics:router autostart off
/tg-topics:router stop
/plugin uninstall tg-topics@tg-topics
```

## Как передать другим

- **GitHub.** Залей эту папку в публичный репозиторий. Другие ставят по шагам из раздела «Установка» с `/plugin marketplace add <твой-github>/tg-topics`. Обновления получают через `/plugin marketplace update tg-topics`.
- **Архивом.** Отправь zip этой папки. Человек распаковывает и выполняет `/plugin marketplace add C:\путь\к\tg-topics`, дальше те же шаги.

У каждого свой бот, токен и доступ. В репозитории нет ничего личного: токен и `access.json` хранятся в `~/.claude/channels/telegram/`, а не в плагине.

## Безопасность

- Роутер слушает только `127.0.0.1`. Сессии подключаются к нему с общим секретом из `~/.claude/channels/telegram/router.secret`.
- Правила доступа те же, что у официального плагина. Чужие в режиме allowlist и в неподключённых группах не получают ответа даже на команды.
- `--skip-permissions` даёт Claude действовать без подтверждений. Включай только для бота, к которому есть доступ лишь у тебя.

## Разработка

- `bun test/e2e.ts`: мок Telegram, роутер и официальный плагин с оверлеем в фейковых сессиях. Покрывает темы, очереди, команды, меню, падение и возврат роутера, смену токена.
- `claude plugin validate .` и `claude plugin validate plugins/tg-topics`: проверка манифестов.

## Лицензия

Apache-2.0. `plugins/tg-topics/overlay/server.ts` — изменённая версия `server.ts` из официального Telegram-плагина ([anthropics/claude-plugins-official](https://github.com/anthropics/claude-plugins-official), Apache-2.0). Изменения описаны в шапке файла. См. `NOTICE`.
