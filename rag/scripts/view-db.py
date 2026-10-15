"""用 Python 内置 sqlite3 浏览知识库数据库。

不依赖任何第三方包，直接可运行：
    python scripts/view-db.py            # 概览
    python scripts/view-db.py tables     # 列出所有表
    python scripts/view-db.py feedback   # 查看反馈与未解决问题
    python scripts/view-db.py sql "SELECT * FROM kb_document LIMIT 5"
"""

import sqlite3
import sys
from pathlib import Path

# Windows 终端默认用 GBK，输出中文会乱码；强制切到 UTF-8。
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DB = Path(__file__).resolve().parent.parent / "data" / "kb.db"


def connect() -> sqlite3.Connection:
    if not DB.exists():
        sys.exit(f"数据库不存在：{DB}")
    # 只读打开，避免误改数据
    conn = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    return conn


def show_overview(conn: sqlite3.Connection) -> None:
    print(f"数据库：{DB}")
    print(f"大小：{DB.stat().st_size / 1024:.0f} KB\n")

    tables = [
        r["name"]
        for r in conn.execute(
            "SELECT name FROM sqlite_master WHERE type='table' "
            "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'kb_%_fts%' ORDER BY name"
        )
    ]
    print("各表记录数：")
    for name in tables:
        try:
            n = conn.execute(f'SELECT COUNT(*) AS n FROM "{name}"').fetchone()["n"]
        except sqlite3.Error:
            n = "?"
        print(f"  {name:<24} {n}")


def show_tables(conn: sqlite3.Connection) -> None:
    rows = conn.execute(
        "SELECT name, sql FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall()
    for row in rows:
        print(f"\n{'=' * 70}\n{row['name']}\n{'=' * 70}")
        print(row["sql"])


def show_feedback(conn: sqlite3.Connection) -> None:
    print("=== 反馈记录 kb_feedback ===")
    for row in conn.execute(
        "SELECT * FROM kb_feedback ORDER BY created_at DESC"
    ):
        icon = "👍" if row["rating"] == "up" else "👎"
        print(f"\n{icon} [{row['status']}] {row['created_at']}")
        if row["reason"]:
            print(f"   原因：{row['reason']}")
        if row["comment"]:
            print(f"   说明：{row['comment']}")
        print(f"   messageId={row['message_id']}")

    print("\n\n=== 未解决问题 kb_unresolved_issue ===")
    for row in conn.execute(
        "SELECT * FROM kb_unresolved_issue WHERE status='open' ORDER BY created_at DESC LIMIT 20"
    ):
        print(f"\n[{row['id']}] {row['reason']}  {row['created_at']}")
        print(f"  问题：{row['query']}")

    print("\n\n原因分布：")
    for row in conn.execute(
        "SELECT reason, COUNT(*) AS n FROM kb_unresolved_issue "
        "WHERE status='open' GROUP BY reason ORDER BY n DESC"
    ):
        print(f"  {row['reason']:<18} {row['n']}")


def show_sql(conn: sqlite3.Connection, sql: str) -> None:
    try:
        cursor = conn.execute(sql)
    except sqlite3.Error as error:
        # 直接抛出会打印整段堆栈，对使用者不友好；这里只提示 SQL 错误本身
        sys.exit(f"SQL 执行失败：{error}\n提示：用 `python scripts/view-db.py tables` 查看表结构")

    rows = cursor.fetchall()
    if not rows:
        print("(无结果)")
        return

    headers = rows[0].keys()
    print(" | ".join(headers))
    print("-" * 70)
    for row in rows:
        values = []
        for h in headers:
            v = row[h]
            text = str(v) if v is not None else "NULL"
            values.append(text[:38] + "…" if len(text) > 40 else text)
        print(" | ".join(values))
    print(f"\n共 {len(rows)} 行")


def main() -> None:
    conn = connect()
    try:
        args = sys.argv[1:]
        if not args:
            show_overview(conn)
        elif args[0] == "tables":
            show_tables(conn)
        elif args[0] == "feedback":
            show_feedback(conn)
        elif args[0] == "sql" and len(args) > 1:
            show_sql(conn, " ".join(args[1:]))
        else:
            print(__doc__)
    finally:
        conn.close()


if __name__ == "__main__":
    main()
