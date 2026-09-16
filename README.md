# prompt-timeline

その日に自分が Claude Code へ打ったプロンプトを、**縦 = 時刻 / 横 = セッション**の
タイムラインにして 1 枚の HTML に焼くツール。

丸 1 個がプロンプト 1 通、ひし形がスラッシュコマンド。点に触れると本文が出る。
「今日どこに時間を使ったか」「どのセッションを引きずり回したか」が一目で分かる。

```
       main      docs   review  …        ← セッション（横）
 09 ─────●──────────────●──────
 10 ─────●───●──────────────────          ← 時刻（縦）
 11 ──────────●──────●───◆──────          ◆ = スラッシュコマンド
```

## 何を読むのか

`~/.claude/projects/*/*.jsonl` — Claude Code が**自分のマシンに**残している会話ログだけ。
ネットワークへは出ないし、どこにも送らない。出来上がる HTML も外部を読みに行かない。

## 使い方

Python 3 だけあればいい（標準ライブラリのみ・依存パッケージなし）。

```bash
git clone https://github.com/atsushiootani/prompt-timeline.git
cd prompt-timeline

# 今日の分を集めて
python3 bin/collect.py --out out/today.json

# HTML に焼いて
python3 bin/render.py --in out/today.json --out out/today.html

# 開く
open out/today.html          # Linux は xdg-open
```

日付を指定するなら `--date 2026-09-16`。

### Claude Code のスキルとして使う

`.claude/skills/prompt-timeline.build/` を同梱してある。このリポジトリを開いた
Claude Code に **「今日のプロンプトのタイムラインを作って」** と頼めば、
日付の解釈から生成・表示まで通してやってくれる。

ほかのリポジトリからも呼びたいなら、スキルのディレクトリを `~/.claude/skills/` に置く
（その場合は SKILL.md 中のコマンドを、このリポジトリの絶対パスに直す）。

## 何を「人が打ったプロンプト」と見なすか

`type == "user"` のレコードから、**機械が差し込んだもの**を落とした残り。

落とすもの: ツールの実行結果 / `isMeta` / `<system-reminder>` だけの行 /
`<local-command-stdout>` / エージェント間の連携メッセージ / タスク通知 /
bash の入出力 / 会話の継続サマリ / 中断通知 / サブエージェントの発話。

スラッシュコマンドは分けて数える。同じ会話が複数ファイルに写っていることがあるので
`(時刻, 本文の先頭 80 字)` で重複を除く。

## セッションの名前と色

列の見出しは `<ワークスペース>.<セッション名>`。名前は取れたものから順に使う。

1. transcript の `agentName` / `customTitle`（Claude Code が持っている名前）
2. `config/agents.json` の `sessionLabel` ルール（正規表現で拾って対応づける）
3. セッション UUID の先頭 8 桁

ワークスペースは transcript の `cwd` の末尾ディレクトリ名。
長くて読みにくければ `workspaceAlias` で短くできる。

設定は任意。要るときだけ `config/agents.example.json` を `config/agents.json` に写して編集する
（`agents.json` は gitignore してある）。

## オプション

| | |
|---|---|
| `collect.py --date YYYY-MM-DD` | 対象日（既定: 今日） |
| `collect.py --no-text` | プロンプト**本文**を落とす（時刻・セッション名・ブランチ名は残る） |
| `collect.py --drop-sdk` | SDK 経由・system 投入の分も落とす |
| `collect.py --projects-dir PATH` | transcript の置き場（既定: `~/.claude/projects`） |
| `collect.py --tz 9` | 表示タイムゾーンの UTC オフセット（既定: このマシンの設定） |
| `render.py --title "…"` | ページタイトル |

## ファイル

| | |
|---|---|
| `bin/collect.py` | transcript → プロンプト記録 JSON |
| `bin/render.py` | JSON → 単体 HTML（CSS・JS・データを全部埋め込む） |
| `view/timeline.js` | タイムライン本体（`PromptTimeline.mount(el, data)`・依存なし） |
| `view/timeline.css` | 見た目。ダークモード対応 |
| `view/template.html` | 焼き込み先のページ |
| `config/agents.example.json` | 設定の見本 |
| `.claude/skills/prompt-timeline.build/` | Claude Code スキル |

`view/` の 3 つは単体でも使える。自分のダッシュボードに埋めるなら、
`timeline.js` と `timeline.css` を読み込んで `PromptTimeline.mount(el, data)` を呼べばいい。
`data` は `collect.py` が出す JSON そのまま。

## 気をつけること

- **出来た HTML には打った本文がそのまま入る。** 人に渡すときは中身を確認するか
  `--no-text` で焼き直す。`out/` と `*.html` は gitignore 済み。
- `--no-text` が落とすのは**本文だけ**。セッション名・ワークスペース名・ブランチ名は残るので、
  それ自体を見せたくないなら `workspaceAlias` で伏せるか、出力 JSON から手で削る。
- 日付はローカル時刻で切る。日をまたいだ分は翌日側に入る。

## ライセンス

MIT
