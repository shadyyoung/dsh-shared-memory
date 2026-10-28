<p align="center">
  <a href="README.md">中文</a> ·
  <a href="README.en.md">English</a> ·
  <a href="README.ja.md">日本語</a> ·
  <b>한국어</b> ·
  <a href="README.es.md">Español</a>
</p>

<p align="center">
  <a href="https://github.com/shadyyoung/dsh-shared-memory/releases">
    <img src="docs/assets/banner.intl.svg" alt="AI 크로스 플랫폼 기억 강화 · Shared Memory" width="100%">
  </a>
</p>

<h1 align="center">Shared Memory · AI 크로스 플랫폼 기억 강화</h1>

<p align="center">
  <b>하나의 기억을 모든 AI 앱이 공유합니다.</b><br>
  선호도, 프로젝트, "지금 하고 있는 일"을 세션·워크스페이스·앱을 넘어 기억합니다.
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
  <a href="docs/HOW-IT-WORKS.md">동작 원리</a> ·
  <a href="docs/CONNECT-APPS.md">앱 연결</a> ·
  <a href="CHANGELOG.md">변경 기록</a>
</p>

> [!NOTE]
> 이것은 Agent Skill이 아닙니다. Skill은 WorkBuddy 같은 클라이언트용 어댑터일 뿐이고, 실제 서비스는 DSH 플러그인(또는 독립 Hub)이며 다른 앱은 MCP 또는 HTTP로 접속합니다.

> [!IMPORTANT]
> **단일 작성자**: 같은 store 디렉터리에서 "DSH 플러그인"과 "독립 Hub"를 동시에 실행하지 마세요.

## 무엇인가

로컬 우선(local-first) 공유 기억 계층입니다. **DeepSeek Harness 플러그인**으로 동작하며 **MCP stdio 브리지**와 **HTTP API**를 제공합니다. Cursor, Claude Desktop, ChatGPT 데스크톱(Codex), WorkBuddy, 임의의 스크립트가 같은 기억을 읽고 씁니다.

| | 기능 | 내용 |
|---|---|---|
| 🎯 | **자동 수집** | 각 세션의 사용자 메시지, 현재 포커스, 세션 현황을 자동 저장 |
| 🧠 | **자동 추출** | 선호·정체성·목표·프로젝트를 추출해 "승인 대기"로 보관, 승인한 것만 기억이 됨 |
| 🔍 | **BM25 검색** | 중국어 bigram + 영단어 + 태그 역색인, 관련도 정렬 |
| 💉 | **관련 기억 주입** | 매 요청 전 요약(최대 1200자) + 현재 주제 관련 기억 주입 |

## UI

<p align="center">
  <img src="docs/assets/ui.png" alt="웹 UI: 포커스, 백업, 기억 목록, 승인 대기, 휴지통" width="100%">
</p>

브라우저에서 `/dsh-memory/ui`를 엽니다(포트는 Harness 재시작마다 바뀝니다. `~/.dsh/shared-memory/runtime.json`에서 읽거나 `~/.dsh/shared-memory/open-ui.sh` 실행).

- 기억 / 휴지통 / 승인 대기 3개 뷰, 검색 하이라이트 + 관련도/최신 정렬
- 편집, 논리 삭제, 복원, 완전 삭제, 편집 이력 복원
- 포커스 편집, JSONL 내보내기
- 백업/복원, ChatGPT/Claude 기록 가져오기
- 통계: 기억 수, 원문 수, 휴지통 수, 세션 수, 사용 횟수

## 빠른 시작

### A. DeepSeek Harness에 설치(권장)

필수: DeepSeek Harness Desktop, Node.js ≥ 18.

```bash
git clone https://github.com/shadyyoung/dsh-shared-memory.git
```

DSH의 `plugin_manager`로 bundle을 설치합니다(절대 경로):

```text
plugin_manager: install_bundle  target=/절대경로/dsh-shared-memory
cordis_inspect_query: Tool.listTools   # memory_remember / memory_search … 가 보여야 함
```

> [!TIP]
> 플러그인 소스를 수정하면 Harness를 재시작하세요. HMR로 등록된 schema는 실제 환경과 다를 수 있습니다.

### B. 다른 AI 앱을 "실행 즉시 사용" 상태로

```bash
cd dsh-shared-memory
npm run install-apps    # Cursor / Claude Desktop / Codex / Claude Code / WorkBuddy 감지 후 설정
npm run autostart       # 선택(macOS): 로그인 시 DSH 실행, 서비스 상주
npm run doctor          # 서비스·MCP 핸드셰이크·각 앱 설정 검증
```

- `install-apps`는 기존 설정을 **백업한 뒤** 기록합니다.
- 실행 중인 앱은 MCP 설정을 다시 읽지 않으므로 **`Cmd+Q`로 완전히 종료 후 재실행**해야 합니다.
- `npm run autostart:uninstall`로 로그인 항목을 제거할 수 있습니다.

### C. 독립 Hub(DSH 불필요, 크로스 플랫폼)

```bash
node standalone/server.mjs                       # http://127.0.0.1:7400/dsh-memory
node standalone/server.mjs --port 7400 --store ~/.dsh/shared-memory
```

저장·검색·HTTP·MCP를 제공하지만 자동 수집과 프롬프트 주입은 없습니다.

## 연동 매트릭스

| 앱 | 방식 | 읽기/쓰기 | 설정 |
|---|---|---|---|
| DeepSeek Harness | 내장 플러그인 | ✅ | 자동 수집 + 주입 + 도구 6개 |
| Cursor | MCP stdio | ✅ | `~/.cursor/mcp.json` |
| Claude Desktop | MCP stdio | ✅ | `claude_desktop_config.json` |
| Claude Code | MCP stdio | ✅ | `~/.claude.json` |
| ChatGPT 데스크톱(Codex) | MCP stdio | ✅ | `~/.codex/config.toml` |
| WorkBuddy | MCP stdio + skill | ✅ | `~/.workbuddy/mcp.json`(로컬 MCP 1회 신뢰) |
| 임의 스크립트 / 브라우저 | HTTP | ✅ | `/dsh-memory/api/*` |
| ChatGPT 웹 | ❌ | — | 원격 Connector만 지원 |

## 도구

**DSH 도구(6개)**: `memory_remember` · `memory_search` · `memory_forget` · `memory_update` · `memory_restore` · `memory_current`

**MCP 도구(7개)**: 위 6개 + `memory_digest` · `memory_status`

`memory_forget`은 기본적으로 휴지통으로 이동(`purge: true`면 완전 삭제), `memory_update`는 편집 이력을 남기고, `memory_restore`는 복원합니다.

## HTTP API(요약)

자세한 내용은 [docs/API.md](docs/API.md). 접두사는 `/dsh-memory`:

`/health` · `/api/digest` · `/api/search` · `/api/items` · `/api/current` · `/api/remember` · `/api/forget` · `/api/restore` · `/api/purge-trash` · `/api/update` · `/api/candidates/*` · `/api/import` · `/api/backups` · `/api/backup` · `/api/restore-backup` · `/api/export` · `/ui`

## 설정

[cordis.patch.yml](cordis.patch.yml)을 수정하고 bundle을 다시 로드합니다.

| 키 | 기본값 | 설명 |
|---|---|---|
| `storeDir` | `~/.dsh/shared-memory` | 데이터 디렉터리 |
| `captureUserMessages` | `true` | 루트 세션 사용자 메시지 수집 |
| `messageRetentionDays` | `30` | 원문 보관 일수(0 = 영구) |
| `maxStoredMessages` | `3000` | 원문 최대 개수 |
| `promptDigest` | `true` | 매 단계 요약 주입 |
| `maxDigestChars` | `1200` | 요약 상한 |
| `maxRelevantMemories` | `4` | "관련 기억" 줄 수(0 = 끄기) |
| `autoFocusMinutes` | `90` | 자동 포커스 갱신 주기(0 = 끄기) |
| `trashRetentionDays` | `30` | 휴지통 보관 일수 |
| `maxRevisions` | `20` | 편집 이력 보관 수 |
| `backupDir` | `~/.dsh/shared-memory-backups` | 백업 위치(store 밖, iCloud/Dropbox 가능) |
| `backupKeep` | `14` | 보관 백업 수 |
| `autoBackupHours` | `24` | 자동 백업 간격 |
| `autoExtract` | `rules` | `off` / `rules`(무료) / `llm` |
| `extractModel` | 빈 값 | LLM 추출용 provider/model(빈 값 = 기본 모델) |
| `maxExtractPerDay` | `30` | 일일 LLM 추출 횟수 상한 |
| `piiPolicy` | `redact` | `off` / `warn` / `redact` |
| `apiEnabled` | `true` | HTTP 라우트 활성화 |
| `apiPath` | `/dsh-memory` | 라우트 접두사 |
| `apiToken` | `""` | 비어 있지 않으면 `Authorization: Bearer <token>` 요구 |

## 아키텍처

<p align="center">
  <img src="docs/assets/architecture.svg" alt="아키텍처" width="100%">
</p>

`session/event` → 수집/추출 → `memories.jsonl`(+ 인덱스) → 요약 주입 / 도구 / HTTP → 다른 앱.
백업은 store 밖에 저장(24시간마다, 최대 14개, 복원 전 `before-restore`도 생성). 자세히는 [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

## 테스트와 CI

```bash
node test/host-smoke.mjs
node test/mcp-smoke.mjs
node test/standalone-smoke.mjs
node test/search-bench.mjs
npm run doctor
```

GitHub Actions가 ubuntu / macos / windows × Node 20/22 매트릭스를 실행합니다.

## 저장소 구조

```text
index.js                 # 호스트 플러그인
cordis.patch.yml         # bundle 선언 + 기본 설정
standalone/server.mjs    # 독립 Hub
ui/index.html            # 단일 파일 웹 UI
mcp/server.mjs           # 의존성 없는 MCP stdio 브리지
skills/shared-memory/    # Agent Skill(WorkBuddy 등)
scripts/                 # install-apps · autostart · doctor
docs/                    # API · HOW-IT-WORKS · CONNECT-APPS · assets
test/                    # host · mcp · standalone · bench
```

## FAQ

<details>
<summary><b>설정 변경 후 앱 재시작이 필요한 이유는?</b></summary>

MCP 설정은 앱 시작 시에만 읽히고 핫 리로드가 없습니다. `Cmd+Q`로 완전히 종료한 뒤 다시 여세요.
</details>

<details>
<summary><b>원문은 영구 보관되나요?</b></summary>

아니요. 기본 30일 후 만료됩니다(`messageRetentionDays`). 장기 기억(profile/preference/project 등)은 삭제할 때까지 유지됩니다. 영구 보관하려면 "기억해: …"라고 말하세요.
</details>

<details>
<summary><b>DSH를 닫아도 다른 앱을 쓸 수 있나요?</b></summary>

아니요. 서비스는 DSH에서 실행됩니다. `npm run autostart`로 로그인 시 실행하거나 독립 Hub를 사용하세요.
</details>

## 라이선스

[MIT](LICENSE)
