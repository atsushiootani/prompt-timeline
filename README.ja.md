# prompt-timeline

その日に自分が Claude Code へ打ったプロンプトを、**縦 = 時刻 / 横 = セッション**の
タイムラインにする。丸 1 個がプロンプト 1 通、その下に伸びる線が、
エージェントがその返事に費やした時間。カーソルを重ねると本文、押すと全文が出る。

[English README](README.md)

![ホバーでプロンプトが出ているところ](docs/screenshot.png)

線で埋まっている列は一日中回していたセッション、すかすかの列はつついただけのセッション。
点を押すと、下に全文とブランチ名、かかった時間が開く:

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
| `--busy-gap-cap MIN` | 無音がこれを超えたらビジー線を切る（既定: 30 分） |
| `--title TEXT` | ページタイトル |
| `--config FILE` | セッション名・色の設定（既定: あれば `config/agents.json`） |

## ビジー線

点の下に伸びる色付きの線は、**エージェントが返事を抱えていた時間**。
プロンプトで始まり、`end_turn`（エージェントが制御を返す瞬間）で終わる。

ツールが走っている間の沈黙も、意図してこの線の**内側**に入れてある。
20 分のポーリングは 20 分待たされた時間で、そこで線を切ったら「暇だった」と報告することになる。

`end_turn` の後にまた動き出したら（バックグラウンドのタスクが報告してきた等）別の線になるので、
あいだの本当の待ち時間は塗り潰されない。ただし `--busy-gap-cap`（既定 30 分）より長い無音が
1 回でもあれば、transcript が途切れたところで線を止める。それ以上になると、
長い仕事とツール実行中に見捨てられたセッションを区別できず、素直に読むと何日分もの棒が出てしまう。

transcript から切り分けられない唯一のものが、**ツールの承認待ちでこちらが席を外していた時間**。
これはビジー側に入る。

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

コードは MIT（[`LICENSE`](LICENSE)）。

### マスコットについて

`assets/concier-chan.png` は **MIT の対象外**。Google Gemini で生成したもので、
Google の利用規約（生成物の所有権を Google は主張しない）のもとで使っている。
純粋に AI が生成した画像には著作権が認められない可能性があるため
（米国著作権局 *Copyright and Artificial Intelligence, Part 2: Copyrightability*, 2025年1月）、
**著作権は主張しない**。仮に何らかの権利が生じる場合も
[CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) とする。好きに使ってほしい。

ファイルは生成されたままバイト単位で同梱してあり、Google の不可視ウォーターマーク
SynthID と C2PA の来歴情報が入っている可能性がある。剥がさないでほしい。
