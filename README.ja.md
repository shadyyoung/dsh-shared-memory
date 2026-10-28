<p align="center">
  <a href="README.md">中文</a> ·
  <a href="README.en.md">English</a> ·
  <b>日本語</b> ·
  <a href="README.ko.md">한국어</a> ·
  <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/shadyyoung/dsh-shared-memory/releases">
    <img src="docs/assets/banner.svg" alt="AI クロスプラットフォーム記憶拡張 · Shared Memory" width="100%">
  </a>
</p>

<h1 align="center">Shared Memory · AI クロスプラットフォーム記憶拡張</h1>

<p align="center">
  <b>ひとつの記憶を、すべての AI アプリで共有。</b><br>
  好み・プロジェクト・「いま何をしているか」を、セッション・ワークスペース・アプリをまたいで記憶します。
</p>

<p align="center">
  <a href="https://github.com/shadyyoung/dsh-shared-memory/releases"><img src="https://img.shields.io/github/v/release/shadyyoung/dsh-shared-memory?label=release&color=8b5cf6" alt="Release"></a>
  <a href="https://github.com/shadyyoung/dsh-shared-memory/actions/workflows/ci.yml"><img src="https://github.com/shadyyoung/dsh-shared-memory/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT">
  <img src="https://img.shields.io/badge/Node-%E2%89%A518-339933?logo=node.js&logoColor=white" alt="Node >= 18">
  <img src="https://img.shields.io/badge/MCP-stdio-16a34a" alt="MCP stdio">
</p>

<p align="center">
  <a href="docs/API.md">API</a> ·
  <a href="docs/HOW-IT-WORKS.md">仕組み</a> ·
  <a href="docs/CONNECT-APPS.md">アプリ連携</a> ·
  <a href="CHANGELOG.md">変更履歴</a>
</p>

> [!NOTE]
> これは Agent Skill ではありません。Skill は WorkBuddy などクライアント向けのアダプターです。実体は DSH プラグイン（またはスタンドアロン Hub）で、他のアプリは MCP または HTTP で接続します。

> [!IMPORTANT]
> **単一書き込み者**：同じ store ディレクトリで「DSH プラグイン」と「スタンドアロン Hub」を同時に動かさないでください。

## これは何か

ローカルファーストの共有記憶レイヤーです。**DeepSeek Harness プラグイン**として動作し、**MCP stdio ブリッジ**と **HTTP API** を提供します。Cursor、Claude Desktop、ChatGPT デスクトップ（Codex）、WorkBuddy、任意のスクリプトが同じ記憶を読み書きできます。

| | 機能 | 内容 |
|---|---|---|
| 🎯 | **自動キャプチャ** | 各セッションのユーザーメッセージ、現在のフォーカス、セッション状況を自動保存 |
| 🧠 | **自動抽出** | 好み・属性・目標・プロジェクトを抽出し「承認待ち」へ。承認したものだけが記憶になる |
| 🔍 | **BM25 検索** | 中国語 bigram + 英単語 + タグの転置インデックス、関連度順 |
| 💉 | **関連記憶の注入** | 各リクエスト前に要約（最大 1200 文字）+ 現在の話題に関連する記憶を注入 |

## UI

<p align="center">
  <img src="docs/assets/ui.png" alt="Web UI：フォーカス、バックアップ、記憶一覧、承認待ち、ゴミ箱" width="100%">
</p>

ブラウザで `/dsh-memory/ui` を開きます（ポートは Harness の再起動ごとに変わります。`~/.dsh/shared-memory/runtime.json` から取得するか `~/.dsh/shared-memory/open-ui.sh` を実行してください）。

- 記憶 / ゴミ箱 / 承認待ちの 3 ビュー、検索ハイライト + 関連度/新着順
- 編集、論理削除、復元、完全削除、編集履歴の復元
- フォーカス編集、JSONL エクスポート
- バックアップ/復元、ChatGPT/Claude の履歴インポート
- 統計：記憶数、生メッセージ数、ゴミ箱数、セッション数、使用回数

## クイックスタート

### A. DeepSeek Harness にインストール（推奨）

前提：DeepSeek Harness Desktop、Node.js ≥ 18。

```bash
git clone https://github.com/shadyyoung/dsh-shared-memory.git
```

DSH の `plugin_manager` で bundle をインストールします（絶対パス）：

```text
plugin_manager: install_bundle  target=/絶対パス/dsh-shared-memory
cordis_inspect_query: Tool.listTools   # memory_remember / memory_search … が見えるはず
```

> [!TIP]
> プラグインのソースを変更したら Harness を再起動してください。HMR 登録された schema は実環境と異なる場合があります。

### B. 他の AI アプリを「起動するだけで使える」状態に

```bash
cd dsh-shared-memory
npm run install-apps    # Cursor / Claude Desktop / Codex / Claude Code / WorkBuddy を検出して設定
npm run autostart       # 任意 (macOS)：ログイン時に DSH を起動してサービスを常駐
npm run doctor          # サービス・MCP ハンドシェイク・各アプリ設定を検証
```

- `install-apps` は既存設定を**バックアップしてから**書き込みます。
- 起動中のアプリは MCP 設定を再読み込みしないため、**`Cmd+Q` で完全終了して再起動**が必要です。
- `npm run autostart:uninstall` でログイン項目を削除できます。

### C. スタンドアロン Hub（DSH 不要・クロスプラットフォーム）

```bash
node standalone/server.mjs                       # http://127.0.0.1:7400/dsh-memory
node standalone/server.mjs --port 7400 --store ~/.dsh/shared-memory
```

保存・検索・HTTP・MCP を提供しますが、自動キャプチャとプロンプト注入はありません。

## 連携マトリクス

| アプリ | 方式 | 読み書き | 設定 |
|---|---|---|---|
| DeepSeek Harness | 内蔵プラグイン | ✅ | 自動キャプチャ + 注入 + 6 ツール |
| Cursor | MCP stdio | ✅ | `~/.cursor/mcp.json` |
| Claude Desktop | MCP stdio | ✅ | `claude_desktop_config.json` |
| Claude Code | MCP stdio | ✅ | `~/.claude.json` |
| ChatGPT デスクトップ (Codex) | MCP stdio | ✅ | `~/.codex/config.toml` |
| WorkBuddy | MCP stdio + skill | ✅ | `~/.workbuddy/mcp.json`（ローカル MCP を一度信頼） |
| 任意のスクリプト / ブラウザ | HTTP | ✅ | `/dsh-memory/api/*` |
| ChatGPT Web | ❌ | — | リモート Connector のみ |

## ツール

**DSH ツール（6）**：`memory_remember` · `memory_search` · `memory_forget` · `memory_update` · `memory_restore` · `memory_current`

**MCP ツール（7）**：上記 6 つ + `memory_digest` · `memory_status`

`memory_forget` は既定でゴミ箱へ（`purge: true` で完全削除）、`memory_update` は編集履歴を保持、`memory_restore` は復元します。

## HTTP API（概要）

詳細は [docs/API.md](docs/API.md)。プレフィックスは `/dsh-memory`：

`/health` · `/api/digest` · `/api/search` · `/api/items` · `/api/current` · `/api/remember` · `/api/forget` · `/api/restore` · `/api/purge-trash` · `/api/update` · `/api/candidates/*` · `/api/import` · `/api/backups` · `/api/backup` · `/api/restore-backup` · `/api/export` · `/ui`

## 設定

[cordis.patch.yml](cordis.patch.yml) を編集し、bundle を再読み込みします。

| キー | 既定値 | 説明 |
|---|---|---|
| `storeDir` | `~/.dsh/shared-memory` | データディレクトリ |
| `captureUserMessages` | `true` | ルートセッションのユーザーメッセージをキャプチャ |
| `messageRetentionDays` | `30` | 生メッセージの保持日数（0 = 永久） |
| `maxStoredMessages` | `3000` | 生メッセージの上限 |
| `promptDigest` | `true` | 毎ステップ要約を注入 |
| `maxDigestChars` | `1200` | 要約の上限 |
| `maxRelevantMemories` | `4` | 「関連記憶」の行数（0 = 無効） |
| `autoFocusMinutes` | `90` | 自動フォーカスの更新間隔（0 = 無効） |
| `trashRetentionDays` | `30` | ゴミ箱の保持日数 |
| `maxRevisions` | `20` | 編集履歴の保持数 |
| `backupDir` | `~/.dsh/shared-memory-backups` | バックアップ先（store 外。iCloud/Dropbox も可） |
| `backupKeep` | `14` | 保持するバックアップ数 |
| `autoBackupHours` | `24` | 自動バックアップ間隔 |
| `autoExtract` | `rules` | `off` / `rules`（無料）/ `llm` |
| `extractModel` | 空 | LLM 抽出に使う provider/model（空 = 既定モデル） |
| `maxExtractPerDay` | `30` | 1 日の LLM 抽出回数上限 |
| `piiPolicy` | `redact` | `off` / `warn` / `redact` |
| `apiEnabled` | `true` | HTTP ルートを有効化 |
| `apiPath` | `/dsh-memory` | ルートのプレフィックス |
| `apiToken` | `""` | 空でなければ `Authorization: Bearer <token>` を要求 |

## アーキテクチャ

<p align="center">
  <img src="docs/assets/architecture.svg" alt="アーキテクチャ図" width="100%">
</p>

`session/event` → キャプチャ/抽出 → `memories.jsonl`（+ インデックス）→ 要約注入 / ツール / HTTP → 他のアプリ。
バックアップは store の外に保存（24 時間ごと、最大 14 件、復元前に `before-restore` も作成）。詳細は [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md)。

## テストと CI

```bash
node test/host-smoke.mjs
node test/mcp-smoke.mjs
node test/standalone-smoke.mjs
node test/search-bench.mjs
npm run doctor
```

GitHub Actions で ubuntu / macos / windows × Node 20/22 のマトリクスを実行しています。

## リポジトリ構成

```text
index.js                 # ホストプラグイン
cordis.patch.yml         # bundle 宣言 + 既定設定
standalone/server.mjs    # スタンドアロン Hub
ui/index.html            # 単一ファイル Web UI
mcp/server.mjs           # 依存ゼロ MCP stdio ブリッジ
skills/shared-memory/    # Agent Skill（WorkBuddy など）
scripts/                 # install-apps · autostart · doctor
docs/                    # API · HOW-IT-WORKS · CONNECT-APPS · assets
test/                    # host · mcp · standalone · bench
```

## FAQ

<details>
<summary><b>設定変更後にアプリの再起動が必要なのはなぜ？</b></summary>

MCP 設定はアプリ起動時にしか読み込まれず、ホットリロードの仕組みがありません。`Cmd+Q` で完全終了してから再度開いてください。
</details>

<details>
<summary><b>生メッセージは永久に残りますか？</b></summary>

いいえ。既定では 30 日で失効します（`messageRetentionDays`）。長期記憶（profile/preference/project など）は削除するまで残ります。永久に残したい場合は「覚えて：…」と伝えてください。
</details>

<details>
<summary><b>DSH を閉じても他のアプリは使えますか？</b></summary>

いいえ。サービスは DSH 上で動いています。`npm run autostart` でログイン時に起動するか、スタンドアロン Hub を使ってください。
</details>

## ライセンス

[MIT](LICENSE)
