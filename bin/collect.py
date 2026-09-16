#!/usr/bin/env python3
"""Claude Code のローカル transcript から「その日に人が打ったプロンプト」を集めて JSON にする。

使い方:
    python3 bin/collect.py --date 2026-09-16 --out out/2026-09-16.json

読むのは `~/.claude/projects/*/*.jsonl`（Claude Code が自分のマシンに残す会話ログ）だけ。
ネットワークへは一切出ない。

集計方針:
  - `type == "user"` のうち、**人が打ったもの**だけを human として残す。
    tool_result / isMeta / <system-reminder> だけの行 / <local-command-stdout> / Caveat は捨てる。
  - サブエージェント（isSidechain）は別セッション扱いにせず除外する。
  - 同じ会話が複数ファイルに写っていることがある（resume・ミラー）ので
    (時刻[秒], 本文先頭 80 字) で重複を除く。
  - エージェント間連携・task 通知・bash 入出力・継続サマリ・中断通知は human から外し、
    件数だけ summary.excluded に残す。
  - スラッシュコマンドは slash_commands に分ける。

セッション名の決め方（環境に依存しない順で落ちていく）:
  1. transcript の `agentName` / `customTitle`（Claude Code が持っている名前）
  2. --config で渡した JSON の `sessionLabel` ルール（正規表現で拾って名前に対応づける）
  3. セッション UUID の先頭 8 桁
ワークスペース名は transcript の `cwd` の末尾ディレクトリ名。config の `workspaceAlias` で短くできる。
"""
import argparse, glob, json, os, re, sys
from collections import Counter
from datetime import datetime, timezone, timedelta

DEFAULT_PROJECTS_DIR = "~/.claude/projects"


def parse_args(argv):
    p = argparse.ArgumentParser(description="Claude Code の transcript から当日のプロンプトを集める")
    p.add_argument("--date", help="対象日 YYYY-MM-DD（既定: 今日）")
    p.add_argument("--out", help="出力 JSON パス（既定: out/<date>.json）")
    p.add_argument("--projects-dir", default=DEFAULT_PROJECTS_DIR,
                   help=f"transcript の置き場（既定: {DEFAULT_PROJECTS_DIR}）")
    p.add_argument("--config", help="セッション名・色の設定 JSON（既定: config/agents.json があれば使う）")
    p.add_argument("--tz", type=float, help="表示タイムゾーンの UTC オフセット時間（既定: このマシンの設定）")
    p.add_argument("--include-text", dest="include_text", action="store_true", default=True,
                   help="プロンプト本文を出力に含める（既定）")
    p.add_argument("--no-text", dest="include_text", action="store_false",
                   help="本文を伏せて時刻・セッションだけ出す（人に見せる用）")
    p.add_argument("--drop-sdk", action="store_true",
                   help="promptSource が sdk/system のものも落とす（自動実行を強めに除く）")
    return p.parse_args(argv)


def load_config(path):
    """設定ファイルを読む。無ければ空（＝素のまま動く）。"""
    if not path:
        here = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "config", "agents.json")
        path = here if os.path.exists(here) else None
    if not path or not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh) or {}


def tzinfo_for(offset_hours):
    if offset_hours is None:
        return datetime.now().astimezone().tzinfo
    return timezone(timedelta(hours=offset_hours))


def classify(text):
    """人が打ったものか、機械が差し込んだものかを分ける。"""
    if "Another Claude session sent a message" in text or "<teammate-message" in text:
        return "teammate"
    if text.startswith("<task-notification>"):
        return "task_notif"
    if text.startswith(("<bash-input>", "<bash-stdout>", "<bash-stderr>")):
        return "bash_io"
    if text.startswith("This session is being continued"):
        return "continuation"
    if text.startswith("[Request interrupted"):
        return "interrupt"
    if "<command-name>" in text or "<command-message>" in text:
        return "slash"
    return "human"


def user_text(obj):
    """user レコードから人が打った本文を取り出す。対象外なら None。"""
    if obj.get("type") != "user" or obj.get("isMeta") or obj.get("isSidechain"):
        return None
    message = obj.get("message") or {}
    content = message.get("content")
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        # tool_result が 1 つでも混ざっていればツールの戻り値であって、人の発話ではない
        for item in content:
            if isinstance(item, dict) and item.get("type") == "tool_result":
                return None
        text = "\n".join(i.get("text", "") for i in content if isinstance(i, dict) and i.get("type") == "text")
    else:
        return None
    text = text.strip()
    if not text or "<local-command-stdout>" in text or text.startswith("Caveat:"):
        return None
    if text.startswith("<system-reminder>") and text.endswith("</system-reminder>"):
        return None
    return text


def scan_file(path, day, label_rules):
    """1 ファイルを読んで (レコード列, セッション名, ワークスペース名) を返す。"""
    rows, cwd, agent_name, session_id = [], None, None, None
    rule_hits = Counter()
    try:
        fh = open(path, encoding="utf-8")
    except OSError:
        return [], None, None
    with fh:
        for line in fh:
            # 当日分が 1 行も無いファイルでも、名前を決めるヘッダ行は拾いたいので
            # 安い文字列判定で本文パースを間引きつつ、メタ行だけは常に見る。
            cheap_skip = f'"{day}' not in line
            if cheap_skip and '"agent-name"' not in line and '"custom-title"' not in line:
                continue
            try:
                obj = json.loads(line)
            except ValueError:
                continue
            rtype = obj.get("type")
            session_id = session_id or obj.get("sessionId")
            if rtype == "agent-name" and obj.get("agentName"):
                agent_name = agent_name or obj["agentName"]
                continue
            if rtype == "custom-title" and obj.get("customTitle"):
                agent_name = agent_name or obj["customTitle"]
                continue
            if cheap_skip:
                continue
            ts = obj.get("timestamp", "")
            if not ts.startswith(day):
                continue
            cwd = cwd or obj.get("cwd")
            # 設定の正規表現ルール（例: 自分の運用で使っているエージェント番号を拾う）
            for name, pattern in label_rules:
                for m in pattern.findall(line):
                    rule_hits[(name, m if isinstance(m, str) else m[0])] += 1
            text = user_text(obj)
            if text is None:
                continue
            rows.append({
                "ts": ts,
                "text": text,
                "promptSource": obj.get("promptSource"),
                "gitBranch": obj.get("gitBranch"),
            })
    return rows, {"cwd": cwd, "agent_name": agent_name, "session_id": session_id,
                  "rule_hits": rule_hits, "path": path}, None


def session_label(meta, cfg):
    """セッションの表示名を決める。環境依存の推測はせず、取れたものから順に使う。"""
    if meta.get("agent_name"):
        return meta["agent_name"]
    rules = cfg.get("sessionLabel") or {}
    names = rules.get("names") or {}
    hits = meta.get("rule_hits") or Counter()
    if hits:
        (_, captured), _ = hits.most_common(1)[0]
        if captured in names:
            return names[captured]
        if captured:
            return str(captured)
    sid = meta.get("session_id") or os.path.basename(meta.get("path", ""))
    return sid[:8] if sid else "unknown"


def workspace_label(meta, cfg):
    cwd = meta.get("cwd")
    if not cwd:
        return ""
    base = os.path.basename(cwd.rstrip("/"))
    return (cfg.get("workspaceAlias") or {}).get(base, base)


def main(argv=None):
    args = parse_args(argv if argv is not None else sys.argv[1:])
    cfg = load_config(args.config)
    tz = tzinfo_for(args.tz)
    day = args.date or datetime.now(tz).strftime("%Y-%m-%d")
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", day):
        sys.exit(f"--date は YYYY-MM-DD 形式で: {day!r}")
    out = args.out or os.path.join("out", f"{day}.json")

    label_rules = []
    rules = (cfg.get("sessionLabel") or {}).get("pattern")
    if rules:
        label_rules.append(("pattern", re.compile(rules)))

    root = os.path.expanduser(args.projects_dir)
    files = [f for f in glob.glob(os.path.join(root, "*", "*.jsonl")) if "/subagents/" not in f]
    if not files:
        sys.exit(f"transcript が見つからない: {root}/*/*.jsonl")

    seen, counts = set(), Counter()
    human, slash = [], []
    for path in files:
        rows, meta, _ = scan_file(path, day, label_rules)
        if not rows:
            continue
        name = session_label(meta, cfg)
        ws = workspace_label(meta, cfg)
        session = f"{ws}.{name}" if ws else name
        for row in rows:
            try:
                local = datetime.fromisoformat(row["ts"].replace("Z", "+00:00")).astimezone(tz)
            except ValueError:
                continue
            hhmmss = local.strftime("%H:%M:%S")
            key = (hhmmss, row["text"][:80])
            if key in seen:
                continue
            seen.add(key)
            kind = classify(row["text"])
            counts[kind] += 1
            if args.drop_sdk and row.get("promptSource") in ("sdk", "system"):
                counts["sdk_filtered"] += 1
                continue
            if kind == "human":
                rec = {"time": hhmmss, "session": session, "workspace": ws, "agent": name}
                if args.include_text:
                    rec["text"] = row["text"]
                rec["chars"] = len(row["text"])
                if row.get("gitBranch"):
                    rec["branch"] = row["gitBranch"]
                human.append(rec)
            elif kind == "slash":
                m = re.search(r"<command-name>\s*([^<]+)", row["text"]) or \
                    re.search(r"<command-message>\s*([^<]+)", row["text"])
                slash.append({"time": hhmmss, "session": session, "workspace": ws, "agent": name,
                              "command": m.group(1).strip() if m else "?"})

    human.sort(key=lambda r: r["time"])
    slash.sort(key=lambda r: r["time"])
    doc = {
        "date": day,
        "generatedAt": datetime.now(tz).isoformat(timespec="seconds"),
        "note": "人が打ったプロンプトの記録。重複セッション除去・自動投入分は除外。session=<workspace>.<agent>。",
        "summary": {
            "human_prompts": len(human),
            "slash_commands": len(slash),
            "by_session": dict(Counter(r["session"] for r in human).most_common()),
            "excluded": {k: counts.get(k, 0) for k in
                         ("teammate", "task_notif", "bash_io", "continuation", "interrupt", "sdk_filtered")},
        },
        "agents": cfg.get("agents") or {},
        "human_prompts": human,
        "slash_commands": slash,
    }
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, ensure_ascii=False, indent=2)
    print(f"saved: {out}")
    print(f"human={len(human)} slash={len(slash)} sessions={len(doc['summary']['by_session'])}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
