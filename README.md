# Syph

A small, local-first agent harness with a clean UI: **Chat**, **Projects**, **Tasks** (scheduled prompts) and **Evolve** (Syph improves its own prompts, skills, memory and code, measured on evals, with you approving every change).

It works with OpenRouter (DeepSeek by default) and local models through Ollama, LM Studio or any OpenAI-compatible `/v1` endpoint.

## Quick start on Windows: Syph.exe

Double-click **Syph.exe**. It needs no Node or npm. It opens the app and starts its local server. Closing the window keeps Syph in the tray so Tasks keep running. The tray menu has **Start at login**, **Open data folder** and **Quit**.

Windows may show "Windows protected your PC" the first time, because the exe isn't code-signed. Click **More info → Run anyway**.

### Add your OpenRouter key

Open **Settings → OpenRouter**, paste your key (from [openrouter.ai/keys](https://openrouter.ai/keys)) and press **Save key**.

- Syph checks the key with OpenRouter first. If OpenRouter rejects it, you see why and nothing is saved.
- Once saved, Settings shows a masked form (`sk-or-v1-…abcd`), how much the key has used and what it has left.
- **Check** re-tests the key, **Replace** swaps it, and **Remove** deletes it.
- The key is stored in the `.env` of the Syph data folder (`%USERPROFILE%\.syph`). Syph's own file tools can't read it.
- A `.env` or `.env.txt` next to Syph.exe also works. It can hold `OPENROUTER_API_KEY=sk-or-v1-...` or just the bare key. A key saved in Settings takes priority.

### Many chats at once

Every chat runs on Syph's local server, not in the window. Start a long job, open **New chat** and start another, or go to Settings: both keep working. Running chats have a pulsing dot in the sidebar, and an amber dot when one is waiting for your approval. Open a chat again to see it catch up live. The square button stops that chat only.

### YOLO mode

By default Syph asks before running shell commands (PowerShell on Windows), creating Tasks or using MCP tools. Click **Ask first** in the chat box to switch to **YOLO on**, or use **Settings → Tool approvals**. With YOLO on, those tools run without asking, and any that are already waiting run straight away. Scheduled Tasks have their own **YOLO for scheduled Tasks** switch, off by default, because nobody is watching them.

### Connectors: Google Workspace and other apps

Open **Connectors** in the sidebar.

- **Google Workspace** lets the agent work in Gmail, Drive, Docs, Sheets, Slides, Calendar, Contacts and Tasks. Google requires your own free OAuth client (about five minutes, once). The card walks you through it: create a Google Cloud project, turn on the APIs, create a **Desktop app** client, paste the Client ID and secret, then press **Sign in with Google**. Sign-in happens in your browser and comes back to Syph on its own.
- Reading (search mail, read docs, list events) runs freely. Sending mail, creating files and events, or changing anything asks first, unless YOLO is on. `google_api` reaches any other Google API with the same sign-in.
- **GitHub** is built in. Paste a personal access token (the card links to a GitHub page with the right scopes ticked) and Syph can list your repositories, clone them, pull, commit, push to main, open pull requests and call any GitHub API. A GitHub connector Syph wrote for you earlier is replaced by this one, and its token carries over.
- **Any other app:** ask in chat, e.g. "connect my Notion" or "add a connector for the Linear API". Syph writes the connector (you approve it), then its card appears here for you to add the key or sign in.
- Each card shows its status, its tools and whether they ask first. You can turn a connector off, disconnect it, or remove it (built-in ones are reset).
- Keys and sign-in tokens are stored in `~/.syph/secrets/connectors.json`, out of reach of Syph's file tools, and are only ever shown masked. The local server only accepts requests from Syph's own pages, so other websites can't use your connectors.

### Working on GitHub repos

Link a repository and Syph works on it on its own: it pulls, edits, commits with clear messages and pushes to main (or a branch and a pull request, if you ask).

- **Link a repo** from the **Repo** button in the chat bar, or **Link repo** on a project page. Pick from your GitHub repositories, or paste `owner/name` or a URL. Link it to the **whole project** (every chat in it works on it) or **this chat only**. Syph clones it into the project's folder (or `%USERPROFILE%\.syph\workspace`).
- **See what you're working on:** the chip at the top of a chat shows the active repo, its branch, uncommitted changes (●) and commits to push (↑) or pull (↓). Its menu has **Pull latest**, **Push**, **Show folder** and **Open on GitHub**. With several repos linked, pick the active one from the **Repo** button.
- **Syph handles git itself** with the `git` tool, signed in with your token for github.com only (the token is passed to git in its environment, never saved in the repo). Commits are made as your GitHub account (`id+login@users.noreply.github.com`) unless git already has a name and email. Force-pushes, `reset --hard`, `clean`, deleting branches or tags, and throwing away uncommitted changes ask first unless YOLO is on. `github_api` reaches issues, reviews, Actions and anything else on GitHub; only `DELETE` asks first.
- Git must be installed ([git-scm.com](https://git-scm.com/download/win), default options).

### Plans and tool calls in a chat

For tasks with several steps, Syph shows its plan as a checklist at the top of its answer and ticks steps off as it works, like Claude Code does. Its tool calls fold into one line, such as **Used 12 tools · 48.3s**. Click it to see each call and its result.

### Long tasks

Syph keeps long work on track with the harness, not with longer prompts:

- **Short or long, automatically.** A quick request gets 30 steps. Past that, or for any job Syph plans in three or more steps, it becomes a long task and runs until it is done, with no step, time or spend cap by default.
- **Contract.** For a big job Syph writes a contract: the goal, the paths it may change, the paths it must never touch, and *done when* checks, which are commands such as `npm test`. It sits behind the **Contract** button in the chat header, where you can edit it, and every ongoing contract is listed on the Tasks page. Writes outside the scope are refused.
- **Checks, not claims.** When the work is finished, Syph runs the done-when commands itself and shows the exit codes in the contract card. If one fails, the real output goes back to the agent so it fixes the cause.
- **Progress outside the chat.** Decisions, dead ends and finished steps are saved to a progress file (in `~/.syph/progress/`). Every turn reads it, so nothing is lost when old messages are trimmed, and scheduled Tasks resume where the last run stopped.
- **Exits.** Limits live in Settings → Long tasks. The daily chat budget still applies and pauses a run gracefully. If the same error comes back, Syph tries a different approach, then stops and says what it needs instead of burning tokens. A run with many failed calls is reviewed and a fix is proposed in Evolve.
- **Steer while it works.** Messages you send during a run reach the agent at its next step. When it needs a decision, it asks with answer buttons.
- **Checkpoints.** After each finished plan step in a linked repo, Syph saves a checkpoint commit on `refs/syph/checkpoints/`. Your branch is never touched and nothing is pushed.
- **Lean context.** Old tool output is cut down to a short stub, file reads come in pages, and app and MCP tools are loaded only when a chat asks for them. Anthropic and Gemini models through OpenRouter use prompt caching, and the status line shows how much was cached.

Drop or paste files and images into the message box to attach them. Type `/` for skills and `@` for files.

### Files Syph makes

Every file a chat creates or changes shows up under the answer as a card. That covers files from `write_file` and files a script writes, such as a deck built by a Python script. Each card shows:

- The full path on your computer, with a copy button.
- **Preview**, which opens a side panel: PowerPoint slides (text, shapes, tables, charts and pictures), Word documents, Excel and CSV sheets, PDFs, images, web pages, Markdown and code. Syph draws these previews itself, so fonts and effects can look a little different from Office.
- **Open**, which opens the file in its app (PowerPoint, Excel, ...). Programs and scripts are never opened from Syph, only shown in their folder.
- **Show in folder**, which opens File Explorer with the file selected.

The **N files** button at the top of a chat lists every file in that chat. A project page shows the project's folder (**Open folder**), its connected repositories, and a **Files** tab where any file can be previewed or opened. Files are saved in the project's folder, or in `%USERPROFILE%\.syph\workspace` for chats without a project.

### Syph can change its own interface

Ask in chat, for example "add a button to connect my GitHub repos". Syph writes the change and checks it against the interface schema. A card then appears in the chat showing what will be added and where, with **Approve** and **Reject**. Nothing changes until you approve.

- **Where buttons can go:** next to the message box, the top of a chat, the new-chat screen, project pages, or the sidebar (including whole pages).
- **What buttons can do:** send a prompt, fill the message box, open a link, show a searchable list read through a connector (such as your GitHub repositories), ask for a few values, or clone a repository into the project.
- **Connect repo:** with a GitHub connector set up, Syph can add a **Connect repo** button. It lists your repositories, clones the one you pick into the project folder (using the connector's sign-in, sent only to github.com), and connects it to the project. Chats in that project then know where the repo is. Cloning needs [Git for Windows](https://git-scm.com/download/win).
- **Undo:** each change has **Undo** on its card and in Evolve. **Settings → Interface** lists every change, with a switch and Remove for each.
- **If something breaks:**
  - **Safe mode** (in Settings, or **Open in safe mode** in the tray menu) hides every change Syph made.
  - **Reset interface** removes them all and keeps a backup in the history folder.
  - If the window itself fails, it offers to reopen in safe mode.
- **Why your own app can't break:** these changes are declarative files in `~/.syph/ui/` drawn by Syph's own components. Syph never edits the app's code, so the changes also work in Syph.exe.

### Syph on your iPhone

The iPhone app (in `ios/`) is a chat bar and its answers, with Projects, Tasks, Evolve, Connectors and Settings in a menu you slide open from the left. It talks to Syph on your computer, so your models, files, keys and connectors stay there.

- **Pair:** on the computer open **Settings → Phone** (or **Connect phone** in the sidebar) and press **Show QR code**. On the iPhone, open Syph and tap **Scan QR code**, or point the Camera app at the code. The phone and computer must be on the same Wi-Fi. A code works once and expires after 10 minutes.
- **What works from the phone:** chats (with live plans, tool calls, timings and approvals), files Syph made (preview slides, docs, sheets, PDFs and images, or share them), linked GitHub repos (link, pull, push, switch the active one), projects, tasks, Evolve, connectors and settings.
- **Security:** the phone talks to a second listener on port 7338. It only starts while a QR code is showing or a phone is paired. Every request needs the phone's own token (only its hash is stored, in `~/.syph/secrets/devices.json`). Browsers are refused, and a phone can't manage phones or open files on the computer's screen. Remove a phone in **Settings → Phone** to cut it off.
- **Build it:** open `ios/Syph.xcodeproj` in Xcode (iOS 18 or later), pick your team under Signing & Capabilities, choose your iPhone and press Run. **Explore the demo** on the welcome screen tries the app without a computer.

## Running from source (Windows, macOS, Linux)

You need [Node.js 22 or newer](https://nodejs.org).

```bash
cd Syph
npm install
```

| Command | What it does |
| --- | --- |
| `npm run desktop` | Opens Syph as a desktop app from source |
| `npm start` | Runs Syph in your browser at http://localhost:7337 |
| `npm run dev` | Development mode with live reload (UI on http://localhost:5173) |
| `npm test` | Runs the core test suite (no network, no key needed) |
| `npm run dist` | Rebuilds `desktop/dist/Syph.exe` (portable, x64) |

### Local models with Ollama

1. Install [Ollama](https://ollama.com) and pull a model, for example `ollama pull qwen3:8b`.
2. In Syph, open the model picker in the chat box. Local models appear under **Local · Ollama** while Ollama is running, stored as `ollama:qwen3:8b`.
3. In **Settings → Model profiles**, pick that model and set how Syph should help it. Local models default to the `verify` strategy (draft, self-check, revise) and 2 retrieved examples per prompt.

LM Studio and other servers work the same way through the **OpenAI-compatible** provider (`lmstudio:<model>`, default `http://localhost:1234/v1`).

## How it fits together

```
ui/       React app (Chat, Projects, Tasks, Evolve, Settings)
server/   Local HTTP + SSE server on 127.0.0.1:7337, and the `syph` CLI
core/     The harness: providers, agent loop, tools, strategies, evals, evolve, scheduler
desktop/  Electron shell that starts the server and adds a tray (npm run dist builds Syph.exe)
scripts/  dev runner and the server bundler used for Syph.exe
```

Everything Syph knows lives as plain files in its **home folder** (`~/.syph`, or set `SYPH_HOME`). Settings shows the exact path.

```
~/.syph/
  config.json          providers, default models, budgets, approval policy
  .env                 keys (never readable by Syph's file tools)
  prompts/system.md    core system prompt                       ← Syph may propose edits
  prompts/variants/    alternative prompts per model             ← Syph may propose edits
  skills/<name>/       SKILL.md + helper files                   ← Syph may propose edits
  memory/*.md          what Syph has learned about you           ← Syph may propose edits
  profiles/*.json      per-model settings (strategy, context)    ← Syph may propose edits
  extensions/*.ts      new tools and strategies, written by Syph ← Syph may propose edits
  ui/*.json            buttons and pages Syph added to its app   ← Syph may propose edits
  projects/<id>/       instructions.md, files/, chats
  evals/cases/*.json   the yardstick (Syph can never edit it)
  traces/              every run as JSONL, plus your ratings
  proposals/, history/ every change, with full before/after for rollback
  examples/bank.jsonl  good answers reused as few-shot examples
```

### The improvement loop

1. **Use it.** Every chat and task run is traced. Thumbs up/down and "Turn into eval" in chat feed the loop.
2. **Measure.** `Run evals` scores the current setup on 30 seed cases plus the ones mined from your ratings. 20% of cases are held out and never shown to the reflector, so improvements have to generalise.
3. **Propose.** `Improve now` sends failing cases to a reflector model, which proposes file changes (prompt, skill, memory, profile or a TypeScript extension).
4. **Gate.** Each proposal is applied in a shadow copy and re-scored. It passes only if the targeted cases improve, the overall score goes up, nothing regresses, and the held-out score holds.
5. **Decide.** Proposals wait in Evolve with the diff and the score change. Accept, reject, or roll back any time.

By default every change waits for you. In Settings you can let memory or skill changes that pass the gate apply on their own. Daily spend budgets per area (chat, tasks, evolve) and a kill switch stop all model calls.

### Making a small model better

Model profiles are how Syph lifts weaker models: a tuned prompt variant, a strategy (`verify`, `best_of_n`, `cascade` to escalate hard turns to a stronger model), retrieved few-shot examples from answers you rated well, and a text tool-call protocol for models without native tool calling. The recommended path is to evolve with a strong model first (DeepSeek), then pick your local model in Evolve and press **Improve now** to tune its profile against the same evals. `npm run syph -- export` writes SFT and DPO datasets from your rated runs if you want to fine-tune.

### Extending Syph

- **Skills:** a folder in `~/.syph/skills/` with a `SKILL.md` (frontmatter `name` and `description`). The agent reads a skill when it is relevant.
- **Extensions:** a `.ts` file in `~/.syph/extensions/` exporting `(syph) => ({ tools, strategies, test })`. Syph can write these itself; they go through the same proposal and gate, and their `test` must pass.
- **MCP servers:** add them to `config.json` under `mcpServers` (`[{ "name": "files", "command": "npx", "args": ["-y", "..."] }]`). Their tools appear as `name__tool` and always ask before running.

## CLI

```bash
npm run syph -- serve [--port 7337] [--home <dir>]
npm run syph -- chat "summarise the files in my workspace" [--model ollama:qwen3:8b]
npm run syph -- eval [model] [--samples 2]
npm run syph -- evolve [model]
npm run syph -- export
npm run syph -- home
```

## Safety

- The server listens on `127.0.0.1` only.
- File tools are confined to the project's `files/` folder (or `~/.syph/workspace`).
- `shell` (PowerShell on Windows), `create_task` and MCP tools ask before running in chat unless YOLO mode is on. In unattended Tasks they are declined unless YOLO for scheduled Tasks is on.
- Syph can never edit its evals, judge or reflector prompts, config, keys, traces or history.
- The file preview and Open / Show in folder only reach the workspace, project folders and files Syph made. They never reach its keys or config. Previews of web pages run sandboxed.
- GitHub: your token reaches git only as a header for `https://github.com`, through git's environment. The `git` tool only runs everyday subcommands, refuses options that run other programs (`rebase --exec`, `--upload-pack`, ...) and only writes a few safe config keys. Git hooks run only in YOLO mode, since they are programs too.
- Interface changes can't contain code. A list in a button can only read: either a GET through a connector, or a tool that needs no approval.
