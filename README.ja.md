# prompt-timeline

その日に自分が Claude Code へ打ったプロンプトを、**縦 = 時刻 / 横 = セッション**の
タイムラインにする。丸 1 個がプロンプト 1 通。カーソルを重ねると本文、押すと全文が出る。

[English README](README.md)

![ホバーでプロンプトが出ているところ](docs/screenshot.png)

点を押すと、下に全文とブランチ名が開く:

![点を押すと全文が開く](docs/screenshot-detail.png)

> どちらも実際にこのツールが [`sample/sample-day.json`](sample/sample-day.json) を描いたもの。
> 中身は作り物のサンプルで、誰かの実際のプロンプトではない。

## 何を読むのか

`~/.claude/projects/<プロジェクト>/<セッション>.jsonl` — Claude Code が**自分のマシンに**
残している会話ログだけ。**ネットワークへは出ない**し、出来上がる HTML も
表示時にどこかを読みに行かない。

## つかいかた

Node 18 以上。インストールする依存パッケージはない。

```bash
git clone https://github.com/atsushiootani/prompt-timeline.git
cd prompt-timeline

node bin/prompt-timeline.mjs build          # 今日の分
open out/2026-09-16.html                    # Linux は xdg-open
```

`build` は収集と生成をまとめてやって、置き場所を教えてくれる:

```
saved: out/2026-09-16.json
saved: out/2026-09-16.html
open:  file:///…/out/2026-09-16.html
human=96 slash=1 sessions=16
```

日付や出力先を変えるなら:

```bash
node bin/prompt-timeline.mjs build --date 2026-09-15 --out-dir ~/timelines
```

自分のデータを触らずに試すなら:

```bash
npm run demo && open out/demo.html
```

## Claude Code のスキルとして使う

[`.claude/skills/prompt-timeline.build/`](.claude/skills/prompt-timeline.build/SKILL.md) を同梱してある。
このリポジトリを開いた Claude Code にこう頼めばいい:

> 今日のプロンプトのタイムラインを作って

日付の解釈から生成まで通してやって、件数とパスを返す。
ほかのリポジトリからも呼びたいなら、スキルのディレクトリを `~/.claude/skills/` に置いて、
中のコマンドを clone 先の絶対パスに直す。

## コマンド

```
prompt-timeline build   [オプション]              収集 + 生成（普段はこれ）
prompt-timeline collect [オプション] --out FILE   transcript → JSON
prompt-timeline render  --in FILE [--out FILE]   JSON → 単体 HTML
```

| オプション | |
|---|---|
| `--date YYYY-MM-DD` | 対象日（既定: 今日） |
| `--out FILE` / `--out-dir DIR` | 出力先（既定: `out/`） |
| `--no-text` | プロンプト**本文**を落とす（セッション名・ブランチ名は残る） |
| `--drop-sdk` | SDK 経由・system 投入の分も落とす |
| `--projects-dir DIR` | transcript の置き場（既定: `~/.claude/projects`） |
| `--tz HOURS` | 表示タイムゾーンを UTC オフセットで固定する |
| `--title TEXT` | ページタイトル |
| `--config FILE` | セッション名・色の設定（既定: あれば `config/agents.json`） |

## 何を「人が打ったプロンプト」と見なすか

`type === "user"` のレコードから、機械が差し込んだものを落とした残り。
落とすもの: ツールの実行結果 / `isMeta` / `<system-reminder>` だけの行 /
`<local-command-stdout>` / エージェント間の連携メッセージ / タスク通知 / bash の入出力 /
会話の継続サマリ / 中断通知 / サブエージェントの発話。
スラッシュコマンドは残すが、別勘定にする（ひし形の点）。

resume すると同じ会話が複数の transcript に写ることがあるので、
`(時刻, 本文の先頭 80 字)` で重複を除いている。まったく同じ文を同じ秒に 2 回打つと
1 点に畳まれる。

**日付はローカル時刻で切る。** UTC 23:30 のレコードは、+09:00 の環境では翌日のもの。
タイムラインもそちら側に入れる。

## セッションの名前の決まり方

列の見出しは `<ワークスペース>.<セッション名>`。設定なしでどの環境でも動くよう、
取れたものから順に落ちていく:

1. transcript に記録された `agentName` / `customTitle`
2. 設定ファイルの `sessionLabel` ルール
3. セッション UUID の先頭 8 桁

ワークスペースは transcript の `cwd` の末尾ディレクトリ名。列見出しで長すぎるなら
`workspaceAlias` で短くする。

設定は任意。名前や色を自分で決めたいときだけ
[`config/agents.example.json`](config/agents.example.json) を `config/agents.json` に写して編集する
（`agents.json` は gitignore 済み）。

## ビューだけ使う

`view/timeline.js` と `view/timeline.css` は依存もビルドも要らない。
自分のダッシュボードに置いて呼ぶだけ:

```js
PromptTimeline.mount(document.getElementById("timeline"), data);
```

`data` は収集側が出す JSON そのまま。列幅は与えられた幅に合わせて広がるし、
ダークモードは `prefers-color-scheme` に追従する。

## ファイル

| | |
|---|---|
| `bin/prompt-timeline.mjs` | CLI |
| `src/collect.mjs` | transcript → JSON |
| `src/render.mjs` | JSON → 単体 HTML |
| `view/` | タイムライン本体（`timeline.js` / `timeline.css` / `template.html`） |
| `sample/sample-day.json` | デモとスクショ用の作り物データ |
| `test/` | `npm test` で走る |
| `.claude/skills/prompt-timeline.build/` | Claude Code スキル |

## 気をつけること

- **出来た HTML には打った本文がそのまま入る。** 人に渡すときは中身を確認するか
  `--no-text` で焼き直す。`out/` と `*.html` は gitignore 済み。
- `--no-text` が落とすのは本文だけ。セッション名・ワークスペース名・ブランチ名は残るので、
  それも見せたくなければ `workspaceAlias` で伏せるか、JSON から手で削る。

## ライセンス

MIT
