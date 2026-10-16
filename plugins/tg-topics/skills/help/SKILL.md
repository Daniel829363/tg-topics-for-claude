---
name: help
description: Show the tg-topics / Telegram bot guide — which commands to type in the Claude Code terminal to connect a group, add or remove a person, change the bot token, lock the bot, check sessions and the router. Use when the user asks how to connect a Telegram group or user, what to type in the terminal for the Telegram bot, or for tg-topics help.
argument-hint: "[ru|en]"
user-invocable: true
allowed-tools:
  - Bash(bun *)
---

# /tg-topics:help — what to type in the terminal

1. Get the guide and the current state:

   ```bash
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/tgt.ts" guide $ARGUMENTS
   bun "${CLAUDE_PLUGIN_ROOT}/scripts/tgt.ts" status
   ```

2. Show the guide to the user as a compact Markdown cheat sheet, with every
   terminal command in a code span so it can be copied. Keep the sections:
   bot and token, people (DMs), group, sessions and router, other. Answer in
   the user's language (the guide is Russian by default; pass `en` for
   English).

3. Under the guide, add 2–4 lines on the current state from `status`: what is
   missing or broken, with the exact command that fixes it. If everything is
   ✅, say so in one line.

4. Mention that the Telegram bot shows the same guide: `/setup` in a DM with
   the bot; `/id` in a group replies with a ready `group add` command for
   that group.

The `/telegram:access` and `/telegram:configure` commands belong to the
official telegram plugin. They're available in Telegram sessions, which load
it via `--settings ~/.claude/telegram-session.settings.json`.
