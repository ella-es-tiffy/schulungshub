#!/usr/bin/env python3
import hashlib
import hmac
import json
import os
import secrets
import sqlite3
from datetime import datetime, timedelta, timezone
from http import HTTPStatus
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Dict, List, Optional, Tuple
from urllib.parse import parse_qs, urlparse

ROOT_DIR = Path(__file__).resolve().parent.parent
DB_PATH = ROOT_DIR / "data" / "fi_teach.db"
WEB_DIR = ROOT_DIR / "web"
SCHEMA_PATH = ROOT_DIR / "app" / "schema.sql"

SESSION_COOKIE = "fi_session"
SESSION_TTL_HOURS = 12
PBKDF2_ITERATIONS = 240_000

SEED_SECTIONS = [
    {
        "code": "1",
        "title": "Kurzbeschreibung der Schulungsmaßnahme",
        "content_md": """
## Ziel der Maßnahme
Dieses Modul erklärt den Ablauf der Einarbeitung und welche Fähigkeiten am Ende sicher beherrscht werden müssen.

## Rahmen
Die Schulung ist praxisnah aufgebaut. Jeder Abschnitt enthält konkrete Ziele, die durch Trainer bestätigt werden.
        """.strip(),
        "goals": [
            ("1.1", "Sicherheits- und Prozessrahmen verstanden", "Sicherheitsregeln und Eskalationswege werden korrekt wiedergegeben."),
            ("1.2", "Definitionen sicher zuordnen", "Interne Fachbegriffe werden sicher und konsistent verwendet."),
        ],
    },
    {
        "code": "2",
        "title": "Übersicht über Arbeitsstationen",
        "content_md": """
## Arbeitsbereich
Die Lernenden erhalten einen Überblick über Stationen, Materialfluss und Verantwortlichkeiten.

## Praxisteil
An jeder Station wird eine Mini-Aufgabe durchgeführt und dokumentiert.
        """.strip(),
        "goals": [
            ("2.1", "Stationen identifiziert", "Alle relevanten Stationen wurden im Rundgang korrekt benannt."),
            ("2.2", "Materialfluss erklärt", "Eingang, Verarbeitung und Ausgabe können nachvollziehbar erklärt werden."),
            ("2.3", "Grundbedienung demonstriert", "Mindestens ein Prozessschritt wurde selbstständig ausgeführt."),
        ],
    },
    {
        "code": "3",
        "title": "Qualität und Fehlervermeidung",
        "content_md": """
## Qualitätskriterien
Hier wird festgelegt, woran gute Arbeitsergebnisse messbar sind.

## Typische Fehler
Häufige Fehlerbilder werden gezeigt und die korrekte Gegenmaßnahme geübt.
        """.strip(),
        "goals": [
            ("3.1", "Qualitätskriterien angewandt", "Prüfkriterien wurden auf ein echtes Werkstück angewendet."),
            ("3.2", "Fehler erkannt und korrigiert", "Ein Fehlerbild wurde erkannt, dokumentiert und korrigiert."),
        ],
    },
    {
        "code": "4",
        "title": "Abschluss und Bewertung",
        "content_md": """
## Abschlussgespräch
Bewertungsgespräch mit Trainer inkl. Stärken, Risiken und nächster Lernschritte.

## Ergebnis
Eine Gesamtbewertung wird automatisch aus den bestätigten Zielen erzeugt.
        """.strip(),
        "goals": [
            ("4.1", "Selbstständige Durchführung", "Der Ablauf wurde unter Beobachtung vollständig und korrekt durchgeführt."),
            ("4.2", "Transfer in den Arbeitsalltag", "Lernender kann die Aufgaben ohne permanente Hilfe umsetzen."),
        ],
    },
]


def utc_now() -> datetime:
    return datetime.now(timezone.utc)


def utc_iso(dt: datetime) -> str:
    return dt.replace(microsecond=0).isoformat().replace("+00:00", "Z")


def parse_utc(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def db_connect() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def hash_password(password: str) -> str:
    salt = os.urandom(16)
    digest = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        PBKDF2_ITERATIONS,
    )
    return f"pbkdf2_sha256${PBKDF2_ITERATIONS}${salt.hex()}${digest.hex()}"


def verify_password(password: str, stored_hash: str) -> bool:
    try:
        algorithm, iter_str, salt_hex, digest_hex = stored_hash.split("$", 3)
        if algorithm != "pbkdf2_sha256":
            return False
        iterations = int(iter_str)
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(digest_hex)
    except (ValueError, TypeError):
        return False

    actual = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, iterations)
    return hmac.compare_digest(actual, expected)


def run_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))


def ensure_seed_users(conn: sqlite3.Connection) -> None:
    count = conn.execute("SELECT COUNT(*) FROM users").fetchone()[0]
    if count > 0:
        return

    users = [
        ("admin", "Admin", "admin123!", "admin"),
        ("trainer", "Trainer", "trainer123!", "trainer"),
        ("schueler-a", "Schüler A", "lernen123!", "trainee"),
        ("schueler-b", "Schüler B", "lernen123!", "trainee"),
    ]
    for username, display_name, password, role in users:
        conn.execute(
            """
            INSERT INTO users(username, display_name, password_hash, role)
            VALUES (?, ?, ?, ?)
            """,
            (username, display_name, hash_password(password), role),
        )

    trainees = conn.execute(
        "SELECT id, username FROM users WHERE role = 'trainee' ORDER BY id"
    ).fetchall()
    for trainee in trainees:
        tag_hash = hashlib.sha256(f"rfid:{trainee['username']}".encode("utf-8")).hexdigest()
        conn.execute(
            """
            INSERT INTO auth_tags(user_id, tag_hash, label)
            VALUES (?, ?, ?)
            """,
            (trainee["id"], tag_hash, "Demo-RFID"),
        )


def ensure_seed_content(conn: sqlite3.Connection) -> None:
    count = conn.execute("SELECT COUNT(*) FROM sections").fetchone()[0]
    if count > 0:
        return

    for section_pos, section in enumerate(SEED_SECTIONS, start=1):
        cursor = conn.execute(
            """
            INSERT INTO sections(code, title, content_md, position)
            VALUES (?, ?, ?, ?)
            """,
            (section["code"], section["title"], section["content_md"], section_pos),
        )
        section_id = cursor.lastrowid

        for goal_pos, (goal_code, goal_title, goal_desc) in enumerate(section["goals"], start=1):
            conn.execute(
                """
                INSERT INTO goals(section_id, code, title, description, weight, position)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (section_id, goal_code, goal_title, goal_desc, 1.0, goal_pos),
            )


def init_database() -> None:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with db_connect() as conn:
        run_schema(conn)
        ensure_seed_users(conn)
        ensure_seed_content(conn)


def parse_cookie(header_value: str) -> Dict[str, str]:
    cookie = SimpleCookie()
    cookie.load(header_value)
    return {k: morsel.value for k, morsel in cookie.items()}


def get_current_user(conn: sqlite3.Connection, handler: BaseHTTPRequestHandler) -> Optional[sqlite3.Row]:
    cookie_header = handler.headers.get("Cookie")
    if not cookie_header:
        return None

    cookies = parse_cookie(cookie_header)
    token = cookies.get(SESSION_COOKIE)
    if not token:
        return None

    row = conn.execute(
        """
        SELECT u.*
        FROM sessions s
        JOIN users u ON u.id = s.user_id
        WHERE s.token = ? AND datetime(s.expires_at) > datetime('now') AND u.active = 1
        """,
        (token,),
    ).fetchone()

    if row is None:
        conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
    return row


def create_session(conn: sqlite3.Connection, user_id: int) -> Tuple[str, str]:
    token = secrets.token_urlsafe(36)
    expires_at = utc_now() + timedelta(hours=SESSION_TTL_HOURS)
    conn.execute(
        "INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)",
        (token, utc_user_id(user_id), utc_iso(expires_at)),
    )
    return token, utc_iso(expires_at)


def utc_user_id(user_id: int) -> int:
    return int(user_id)


def cleanup_sessions(conn: sqlite3.Connection) -> None:
    conn.execute("DELETE FROM sessions WHERE datetime(expires_at) <= datetime('now')")


def build_toc(conn: sqlite3.Connection) -> List[dict]:
    sections = conn.execute(
        "SELECT id, code, title, content_md, position FROM sections ORDER BY position, id"
    ).fetchall()
    goals = conn.execute(
        "SELECT id, section_id, code, title, description, weight, position FROM goals ORDER BY section_id, position, id"
    ).fetchall()

    by_section: Dict[int, List[dict]] = {}
    for goal in goals:
        by_section.setdefault(goal["section_id"], []).append(
            {
                "id": goal["id"],
                "code": goal["code"],
                "title": goal["title"],
                "description": goal["description"],
                "weight": goal["weight"],
            }
        )

    result = []
    for section in sections:
        result.append(
            {
                "id": section["id"],
                "code": section["code"],
                "title": section["title"],
                "content": section["content_md"],
                "goals": by_section.get(section["id"], []),
            }
        )
    return result


def latest_goal_states(conn: sqlite3.Connection, trainee_id: int) -> Dict[int, dict]:
    rows = conn.execute(
        """
        SELECT gc.goal_id,
               gc.achieved,
               gc.note,
               gc.checked_at,
               checker.display_name AS checked_by
        FROM goal_checks gc
        JOIN (
            SELECT goal_id, MAX(id) AS max_id
            FROM goal_checks
            WHERE user_id = ?
            GROUP BY goal_id
        ) latest ON latest.max_id = gc.id
        JOIN users checker ON checker.id = gc.checked_by
        ORDER BY gc.goal_id
        """,
        (trainee_id,),
    ).fetchall()

    return {
        row["goal_id"]: {
            "achieved": bool(row["achieved"]),
            "note": row["note"],
            "checked_at": row["checked_at"],
            "checked_by": row["checked_by"],
        }
        for row in rows
    }


def compute_report(conn: sqlite3.Connection, trainee_id: int) -> dict:
    section_rows = conn.execute(
        "SELECT id, code, title FROM sections ORDER BY position, id"
    ).fetchall()
    goal_rows = conn.execute(
        """
        SELECT g.id, g.section_id, g.weight
        FROM goals g
        ORDER BY g.section_id, g.position, g.id
        """
    ).fetchall()

    states = latest_goal_states(conn, trainee_id)

    total_goals = len(goal_rows)
    done_goals = 0
    total_weight = 0.0
    done_weight = 0.0

    section_summary: Dict[int, dict] = {
        s["id"]: {
            "section_id": s["id"],
            "code": s["code"],
            "title": s["title"],
            "done": 0,
            "total": 0,
        }
        for s in section_rows
    }

    for goal in goal_rows:
        weight = float(goal["weight"])
        total_weight += weight
        section_summary[goal["section_id"]]["total"] += 1

        state = states.get(goal["id"])
        if state and state["achieved"]:
            done_goals += 1
            done_weight += weight
            section_summary[goal["section_id"]]["done"] += 1

    completion_pct = round((done_weight / total_weight) * 100.0, 2) if total_weight else 0.0

    pace_row = conn.execute(
        """
        SELECT MIN(checked_at) AS first_check,
               MAX(checked_at) AS last_check,
               SUM(CASE WHEN achieved = 1 THEN 1 ELSE 0 END) AS achieved_events
        FROM goal_checks
        WHERE user_id = ?
        """,
        (trainee_id,),
    ).fetchone()

    eta_date = None
    if pace_row and pace_row["first_check"] and done_goals > 0 and total_goals > done_goals:
        first_check = parse_utc(pace_row["first_check"])
        elapsed_days = max((utc_now() - first_check).days, 1)
        pace_per_day = done_goals / elapsed_days
        if pace_per_day > 0:
            remaining = total_goals - done_goals
            eta_days = int((remaining / pace_per_day) + 0.999)
            eta_date = utc_iso(utc_now() + timedelta(days=eta_days))

    recent_checks = conn.execute(
        """
        SELECT gc.checked_at,
               gc.achieved,
               gc.note,
               g.code AS goal_code,
               g.title AS goal_title,
               checker.display_name AS checked_by
        FROM goal_checks gc
        JOIN goals g ON g.id = gc.goal_id
        JOIN users checker ON checker.id = gc.checked_by
        WHERE gc.user_id = ?
        ORDER BY gc.id DESC
        LIMIT 25
        """,
        (trainee_id,),
    ).fetchall()

    history = [
        {
            "checked_at": row["checked_at"],
            "achieved": bool(row["achieved"]),
            "note": row["note"],
            "goal_code": row["goal_code"],
            "goal_title": row["goal_title"],
            "checked_by": row["checked_by"],
        }
        for row in recent_checks
    ]

    return {
        "total_goals": total_goals,
        "done_goals": done_goals,
        "completion_pct": completion_pct,
        "eta_date": eta_date,
        "sections": list(section_summary.values()),
        "history": history,
    }


def require_role(user: sqlite3.Row, allowed: Tuple[str, ...]) -> bool:
    return user["role"] in allowed


class AppHandler(BaseHTTPRequestHandler):
    server_version = "FiTeach/0.1"

    def log_message(self, fmt: str, *args) -> None:
        return

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path in {"/", "/index.html"}:
            self._serve_static("index.html", "text/html; charset=utf-8")
            return
        if path == "/app.js":
            self._serve_static("app.js", "application/javascript; charset=utf-8")
            return
        if path == "/styles.css":
            self._serve_static("styles.css", "text/css; charset=utf-8")
            return

        if path == "/api/auth/me":
            return self._get_me()
        if path == "/api/toc":
            return self._get_toc()
        if path == "/api/trainees":
            return self._get_trainees()
        if path == "/api/progress":
            return self._get_progress(parsed.query)
        if path == "/api/report":
            return self._get_report(parsed.query)
        if path == "/api/users":
            return self._get_users()

        self._json(HTTPStatus.NOT_FOUND, {"error": "Not Found"})

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/auth/login":
            return self._post_login()
        if path == "/api/auth/logout":
            return self._post_logout()
        if path == "/api/progress/check":
            return self._post_progress_check()
        if path == "/api/users":
            return self._post_users()

        self._json(HTTPStatus.NOT_FOUND, {"error": "Not Found"})

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.send_header("Allow", "GET, POST, OPTIONS")
        self.end_headers()

    def _read_json(self) -> Optional[dict]:
        length = self.headers.get("Content-Length")
        if not length:
            return {}
        try:
            size = int(length)
        except ValueError:
            return None
        raw = self.rfile.read(size)
        try:
            return json.loads(raw.decode("utf-8"))
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def _serve_static(self, relative_path: str, content_type: str) -> None:
        target = (WEB_DIR / relative_path).resolve()
        if not str(target).startswith(str(WEB_DIR.resolve())):
            self._json(HTTPStatus.FORBIDDEN, {"error": "forbidden"})
            return
        if not target.exists():
            self._json(HTTPStatus.NOT_FOUND, {"error": "missing static file"})
            return

        content = target.read_bytes()
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)

    def _json(self, status: HTTPStatus, payload: dict, cookie_header: Optional[str] = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if cookie_header:
            self.send_header("Set-Cookie", cookie_header)
        self.end_headers()
        self.wfile.write(body)

    def _auth_user(self, conn: sqlite3.Connection) -> Optional[sqlite3.Row]:
        cleanup_sessions(conn)
        return get_current_user(conn, self)

    def _get_me(self) -> None:
        with db_connect() as conn:
            user = self._auth_user(conn)
            if not user:
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "not authenticated"})
                return

            self._json(
                HTTPStatus.OK,
                {
                    "user": {
                        "id": user["id"],
                        "username": user["username"],
                        "display_name": user["display_name"],
                        "role": user["role"],
                    }
                },
            )

    def _get_toc(self) -> None:
        with db_connect() as conn:
            user = self._auth_user(conn)
            if not user:
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "not authenticated"})
                return

            toc = build_toc(conn)
            self._json(HTTPStatus.OK, {"sections": toc})

    def _resolve_target_trainee(
        self,
        conn: sqlite3.Connection,
        user: sqlite3.Row,
        query: str,
    ) -> Optional[sqlite3.Row]:
        params = parse_qs(query)
        target_id = params.get("trainee_id", [None])[0]

        if user["role"] == "trainee":
            return conn.execute(
                "SELECT id, username, display_name, role FROM users WHERE id = ?",
                (user["id"],),
            ).fetchone()

        if target_id is None:
            return conn.execute(
                """
                SELECT id, username, display_name, role
                FROM users
                WHERE role = 'trainee' AND active = 1
                ORDER BY id
                LIMIT 1
                """
            ).fetchone()

        try:
            target_int = int(target_id)
        except ValueError:
            return None

        return conn.execute(
            """
            SELECT id, username, display_name, role
            FROM users
            WHERE id = ? AND role = 'trainee' AND active = 1
            """,
            (target_int,),
        ).fetchone()

    def _get_trainees(self) -> None:
        with db_connect() as conn:
            user = self._auth_user(conn)
            if not user:
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "not authenticated"})
                return

            if not require_role(user, ("admin", "trainer")):
                self._json(HTTPStatus.FORBIDDEN, {"error": "insufficient role"})
                return

            trainees = conn.execute(
                """
                SELECT id, username, display_name
                FROM users
                WHERE role = 'trainee' AND active = 1
                ORDER BY display_name, id
                """
            ).fetchall()

            self._json(
                HTTPStatus.OK,
                {
                    "trainees": [
                        {
                            "id": row["id"],
                            "username": row["username"],
                            "display_name": row["display_name"],
                        }
                        for row in trainees
                    ]
                },
            )

    def _get_progress(self, query: str) -> None:
        with db_connect() as conn:
            user = self._auth_user(conn)
            if not user:
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "not authenticated"})
                return

            target = self._resolve_target_trainee(conn, user, query)
            if not target:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid trainee"})
                return

            states = latest_goal_states(conn, int(target["id"]))
            self._json(
                HTTPStatus.OK,
                {
                    "trainee": {
                        "id": target["id"],
                        "username": target["username"],
                        "display_name": target["display_name"],
                    },
                    "states": states,
                },
            )

    def _get_report(self, query: str) -> None:
        with db_connect() as conn:
            user = self._auth_user(conn)
            if not user:
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "not authenticated"})
                return

            target = self._resolve_target_trainee(conn, user, query)
            if not target:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid trainee"})
                return

            report = compute_report(conn, int(target["id"]))
            self._json(
                HTTPStatus.OK,
                {
                    "trainee": {
                        "id": target["id"],
                        "username": target["username"],
                        "display_name": target["display_name"],
                    },
                    "report": report,
                },
            )

    def _post_login(self) -> None:
        body = self._read_json()
        if body is None:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid json"})
            return

        mode = body.get("mode")
        with db_connect() as conn:
            if mode == "password":
                username = str(body.get("username", "")).strip().lower()
                password = str(body.get("password", ""))

                if not username or not password:
                    self._json(HTTPStatus.BAD_REQUEST, {"error": "missing credentials"})
                    return

                user = conn.execute(
                    """
                    SELECT id, username, display_name, role, password_hash
                    FROM users
                    WHERE username = ? AND active = 1
                    """,
                    (username,),
                ).fetchone()

                if not user or not verify_password(password, user["password_hash"]):
                    self._json(HTTPStatus.UNAUTHORIZED, {"error": "invalid login"})
                    return

            elif mode == "rfid":
                tag_hash = str(body.get("tag_hash", "")).strip().lower()
                if not tag_hash:
                    self._json(HTTPStatus.BAD_REQUEST, {"error": "missing tag hash"})
                    return

                user = conn.execute(
                    """
                    SELECT u.id, u.username, u.display_name, u.role
                    FROM auth_tags t
                    JOIN users u ON u.id = t.user_id
                    WHERE t.tag_hash = ? AND t.active = 1 AND u.active = 1
                    """,
                    (tag_hash,),
                ).fetchone()

                if not user:
                    self._json(HTTPStatus.UNAUTHORIZED, {"error": "invalid login"})
                    return
            else:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid mode"})
                return

            token, expires_at = create_session(conn, int(user["id"]))
            cookie = (
                f"{SESSION_COOKIE}={token}; Path=/; HttpOnly; SameSite=Lax; "
                f"Max-Age={SESSION_TTL_HOURS * 3600}"
            )

            self._json(
                HTTPStatus.OK,
                {
                    "user": {
                        "id": user["id"],
                        "username": user["username"],
                        "display_name": user["display_name"],
                        "role": user["role"],
                    },
                    "expires_at": expires_at,
                },
                cookie_header=cookie,
            )

    def _post_logout(self) -> None:
        cookie_header = self.headers.get("Cookie", "")
        cookies = parse_cookie(cookie_header) if cookie_header else {}
        token = cookies.get(SESSION_COOKIE)

        with db_connect() as conn:
            if token:
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))

        self._json(
            HTTPStatus.OK,
            {"ok": True},
            cookie_header=f"{SESSION_COOKIE}=; Path=/; HttpOnly; Max-Age=0; SameSite=Lax",
        )

    def _post_progress_check(self) -> None:
        body = self._read_json()
        if body is None:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid json"})
            return

        with db_connect() as conn:
            user = self._auth_user(conn)
            if not user:
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "not authenticated"})
                return
            if not require_role(user, ("admin", "trainer")):
                self._json(HTTPStatus.FORBIDDEN, {"error": "insufficient role"})
                return

            try:
                trainee_id = int(body.get("trainee_id"))
                goal_id = int(body.get("goal_id"))
                achieved = 1 if bool(body.get("achieved")) else 0
            except (TypeError, ValueError):
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid payload"})
                return

            note = str(body.get("note", "")).strip()
            if len(note) > 1000:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "note too long"})
                return

            trainee = conn.execute(
                "SELECT id FROM users WHERE id = ? AND role = 'trainee' AND active = 1",
                (trainee_id,),
            ).fetchone()
            goal = conn.execute("SELECT id FROM goals WHERE id = ?", (goal_id,)).fetchone()
            if not trainee or not goal:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "unknown goal or trainee"})
                return

            conn.execute(
                """
                INSERT INTO goal_checks(user_id, goal_id, achieved, note, checked_by, checked_at)
                VALUES (?, ?, ?, ?, ?, ?)
                """,
                (trainee_id, goal_id, achieved, note, int(user["id"]), utc_iso(utc_now())),
            )

            states = latest_goal_states(conn, trainee_id)
            self._json(HTTPStatus.OK, {"ok": True, "state": states.get(goal_id)})

    def _get_users(self) -> None:
        with db_connect() as conn:
            user = self._auth_user(conn)
            if not user:
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "not authenticated"})
                return
            if not require_role(user, ("admin", "trainer")):
                self._json(HTTPStatus.FORBIDDEN, {"error": "insufficient role"})
                return

            users = conn.execute(
                """
                SELECT u.id,
                       u.username,
                       u.display_name,
                       u.role,
                       u.active,
                       t.tag_hash
                FROM users u
                LEFT JOIN auth_tags t ON t.user_id = u.id AND t.active = 1
                ORDER BY u.role, u.display_name
                """
            ).fetchall()
            self._json(
                HTTPStatus.OK,
                {
                    "users": [
                        {
                            "id": row["id"],
                            "username": row["username"],
                            "display_name": row["display_name"],
                            "role": row["role"],
                            "active": bool(row["active"]),
                            "tag_hash": row["tag_hash"],
                        }
                        for row in users
                    ]
                },
            )

    def _post_users(self) -> None:
        body = self._read_json()
        if body is None:
            self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid json"})
            return

        with db_connect() as conn:
            user = self._auth_user(conn)
            if not user:
                self._json(HTTPStatus.UNAUTHORIZED, {"error": "not authenticated"})
                return
            if not require_role(user, ("admin",)):
                self._json(HTTPStatus.FORBIDDEN, {"error": "admin only"})
                return

            username = str(body.get("username", "")).strip().lower()
            display_name = str(body.get("display_name", "")).strip()
            password = str(body.get("password", ""))
            role = str(body.get("role", "trainee")).strip().lower()
            tag_hash = str(body.get("tag_hash", "")).strip().lower()

            if role not in {"admin", "trainer", "trainee"}:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "invalid role"})
                return
            if not username or not display_name or not password:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "missing fields"})
                return

            if len(password) < 8:
                self._json(HTTPStatus.BAD_REQUEST, {"error": "password too short"})
                return

            try:
                cur = conn.execute(
                    """
                    INSERT INTO users(username, display_name, password_hash, role)
                    VALUES (?, ?, ?, ?)
                    """,
                    (username, display_name, hash_password(password), role),
                )
                user_id = cur.lastrowid
                if tag_hash:
                    conn.execute(
                        "INSERT INTO auth_tags(user_id, tag_hash, label) VALUES (?, ?, ?)",
                        (user_id, tag_hash, "Manuell gesetzt"),
                    )
            except sqlite3.IntegrityError as exc:
                self._json(HTTPStatus.CONFLICT, {"error": f"integrity error: {exc}"})
                return

            self._json(HTTPStatus.CREATED, {"ok": True, "user_id": user_id})


def run_server(host: str = "127.0.0.1", port: int = 8080) -> None:
    init_database()
    server = ThreadingHTTPServer((host, port), AppHandler)
    print(f"FiTeach server läuft auf http://{host}:{port}")
    print("Demo-Logins: admin/admin123! | trainer/trainer123! | schueler-a/lernen123!")
    print("RFID Demo-Tag-Hash siehe README.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    host = os.environ.get("FI_TEACH_HOST", "127.0.0.1")
    port = int(os.environ.get("FI_TEACH_PORT", "8080"))
    run_server(host=host, port=port)
