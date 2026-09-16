#!/usr/bin/env python3
"""collect.py が作った JSON を、1 枚で完結する HTML に焼く。

使い方:
    python3 bin/render.py --in out/2026-09-16.json --out out/2026-09-16.html

CSS も JS もデータも埋め込むので、出来た HTML は**ダブルクリックで開ける**。
サーバも通信も要らない（外部 CDN を読みに行かない）。
"""
import argparse, json, os, re, sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
VIEW = os.path.join(HERE, "view")


def parse_args(argv):
    p = argparse.ArgumentParser(description="プロンプト記録 JSON を単体 HTML にする")
    p.add_argument("--in", dest="src", required=True, help="collect.py が出した JSON")
    p.add_argument("--out", help="出力 HTML（既定: 入力と同じ名前の .html）")
    p.add_argument("--title", help="ページタイトル（既定: プロンプト・タイムライン <日付>）")
    p.add_argument("--view-dir", default=VIEW, help=f"テンプレート一式の置き場（既定: {VIEW}）")
    return p.parse_args(argv)


def read(path):
    with open(path, encoding="utf-8") as fh:
        return fh.read()


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    if not os.path.exists(args.src):
        sys.exit(f"入力が無い: {args.src}")
    with open(args.src, encoding="utf-8") as fh:
        data = json.load(fh)

    out = args.out or os.path.splitext(args.src)[0] + ".html"
    title = args.title or f"プロンプト・タイムライン {data.get('date', '')}".strip()

    template = read(os.path.join(args.view_dir, "template.html"))
    css = read(os.path.join(args.view_dir, "timeline.css"))
    js = read(os.path.join(args.view_dir, "timeline.js"))

    # データは <script> の中に置くので、</script> と行区切り文字だけ無害化する。
    payload = (json.dumps(data, ensure_ascii=False)
               .replace("</", "<\\/")
               .replace(" ", "\\u2028")
               .replace(" ", "\\u2029"))

    # 差し込みは **1 パスで**行う。順番に replace すると、先に入れた中身（プロンプト本文など）に
    # たまたま後続のトークン文字列が含まれていたとき、そこまで置換されて壊れる。
    slots = {"__TITLE__": title, "__CSS__": css, "__DATA__": payload, "__JS__": js}
    html = re.sub(r"__(?:TITLE|CSS|DATA|JS)__", lambda m: slots[m.group(0)], template)

    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        fh.write(html)
    print(f"saved: {out}")
    print(f"open:  file://{os.path.abspath(out)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
