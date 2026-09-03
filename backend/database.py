"""
backend/database.py
Database layer supporting Supabase (PostgreSQL) with automatic SQLite local fallback.
Includes cryptographic encryption for refresh tokens at rest.
"""

import os
import sqlite3
import base64
import hashlib
from datetime import datetime, timezone
from typing import Optional, Dict, Any
from pathlib import Path

# Cryptography helpers using standard library / cryptography
def _get_derived_key() -> bytes:
    secret = (
        os.getenv("ENCRYPTION_SECRET")
        or os.getenv("GOOGLE_CLIENT_SECRET")
        or "expense-tracker-default-fallback-key-32-chars-min"
    )
    # Derive a 32-byte key using SHA-256
    return hashlib.sha256(secret.encode("utf-8")).digest()


def encrypt_token(plain_text: str) -> str:
    """Encrypts a string using AES-GCM or XOR/Fernet."""
    if not plain_text:
        return ""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        key = _get_derived_key()
        aesgcm = AESGCM(key)
        nonce = os.urandom(12)
        ciphertext = aesgcm.encrypt(nonce, plain_text.encode("utf-8"), None)
        combined = nonce + ciphertext
        return base64.urlsafe_b64encode(combined).decode("utf-8")
    except Exception as e:
        # Fallback basic XOR base64 encryption if cryptography library is not yet installed
        key = _get_derived_key()
        encrypted = bytes([b ^ key[i % len(key)] for i, b in enumerate(plain_text.encode("utf-8"))])
        return base64.urlsafe_b64encode(encrypted).decode("utf-8")


def decrypt_token(cipher_text: str) -> str:
    """Decrypts a base64 string back to plaintext."""
    if not cipher_text:
        return ""
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        key = _get_derived_key()
        data = base64.urlsafe_b64decode(cipher_text.encode("utf-8"))
        if len(data) > 12:
            nonce = data[:12]
            ciphertext = data[12:]
            aesgcm = AESGCM(key)
            decrypted = aesgcm.decrypt(nonce, ciphertext, None)
            return decrypted.decode("utf-8")
    except Exception:
        pass

    # Fallback XOR decrypt
    try:
        key = _get_derived_key()
        data = base64.urlsafe_b64decode(cipher_text.encode("utf-8"))
        decrypted = bytes([b ^ key[i % len(key)] for i, b in enumerate(data)])
        return decrypted.decode("utf-8")
    except Exception:
        return cipher_text


class Database:
    def __init__(self):
        self.supabase_url = os.getenv("SUPABASE_URL", "").strip()
        self.supabase_key = os.getenv("SUPABASE_KEY", "").strip()
        self.is_supabase = bool(self.supabase_url and self.supabase_key)
        self.supabase_client = None

        if self.is_supabase:
            try:
                from supabase import create_client
                self.supabase_client = create_client(self.supabase_url, self.supabase_key)
                print(f"[Database] Connected to Supabase at {self.supabase_url}")
            except Exception as err:
                print(f"[Database] Warning: Could not initialize Supabase client ({err}). Falling back to local SQLite.")
                self.is_supabase = False

        if not self.is_supabase:
            self._init_sqlite()

    def _init_sqlite(self):
        db_dir = Path(__file__).parent
        self.sqlite_path = db_dir / "users.db"
        print(f"[Database] Using local SQLite database at {self.sqlite_path}")

        conn = sqlite3.connect(self.sqlite_path)
        cursor = conn.cursor()
        cursor.execute("""
            CREATE TABLE IF NOT EXISTS users (
                id TEXT PRIMARY KEY,
                google_id TEXT UNIQUE NOT NULL,
                email TEXT UNIQUE NOT NULL,
                name TEXT,
                picture TEXT,
                encrypted_refresh_token TEXT NOT NULL,
                spreadsheet_id TEXT,
                created_at TEXT,
                last_login_at TEXT
            )
        """)
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_users_google_id ON users(google_id)")
        cursor.execute("CREATE INDEX IF NOT EXISTS idx_users_email ON users(email)")
        conn.commit()
        conn.close()

    def upsert_user(
        self,
        google_id: str,
        email: str,
        name: str,
        picture: str,
        refresh_token: str,
        spreadsheet_id: Optional[str] = None,
    ) -> Dict[str, Any]:
        """
        Create or update user record with encrypted refresh token.
        """
        now_iso = datetime.now(timezone.utc).isoformat()
        encrypted_token = encrypt_token(refresh_token) if refresh_token else ""

        if self.is_supabase and self.supabase_client:
            try:
                # Check existing user
                res = self.supabase_client.table("users").select("*").eq("google_id", google_id).execute()
                existing = res.data[0] if res.data else None

                payload = {
                    "google_id": google_id,
                    "email": email,
                    "name": name,
                    "picture": picture,
                    "last_login_at": now_iso,
                }
                if encrypted_token:
                    payload["encrypted_refresh_token"] = encrypted_token
                if spreadsheet_id:
                    payload["spreadsheet_id"] = spreadsheet_id

                if existing:
                    # Update existing record
                    update_res = (
                        self.supabase_client.table("users")
                        .update(payload)
                        .eq("google_id", google_id)
                        .execute()
                    )
                    return update_res.data[0] if update_res.data else {**existing, **payload}
                else:
                    payload["created_at"] = now_iso
                    insert_res = self.supabase_client.table("users").insert(payload).execute()
                    return insert_res.data[0] if insert_res.data else payload
            except Exception as e:
                print(f"[Database] Supabase upsert error ({e}), falling back to SQLite for this operation.")

        # Local SQLite operation
        conn = sqlite3.connect(self.sqlite_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        cursor.execute("SELECT * FROM users WHERE google_id = ?", (google_id,))
        existing = cursor.fetchone()

        if existing:
            token_to_save = encrypted_token if encrypted_token else existing["encrypted_refresh_token"]
            cursor.execute(
                """
                UPDATE users 
                SET email = ?, name = ?, picture = ?, encrypted_refresh_token = ?, last_login_at = ?
                WHERE google_id = ?
                """,
                (email, name, picture, token_to_save, now_iso, google_id),
            )
            user_id = existing["id"]
        else:
            import uuid
            user_id = str(uuid.uuid4())
            cursor.execute(
                """
                INSERT INTO users (id, google_id, email, name, picture, encrypted_refresh_token, spreadsheet_id, created_at, last_login_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (user_id, google_id, email, name, picture, encrypted_token, spreadsheet_id or "", now_iso, now_iso),
            )

        conn.commit()
        cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        user_row = dict(cursor.fetchone())
        conn.close()
        return user_row

    def get_user_by_id(self, user_id: str) -> Optional[Dict[str, Any]]:
        """Fetch user record by internal user ID."""
        if self.is_supabase and self.supabase_client:
            try:
                res = self.supabase_client.table("users").select("*").eq("id", user_id).execute()
                if res.data:
                    return res.data[0]
            except Exception as e:
                print(f"[Database] Supabase query error: {e}")

        conn = sqlite3.connect(self.sqlite_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE id = ?", (user_id,))
        row = cursor.fetchone()
        conn.close()
        return dict(row) if row else None

    def get_user_by_google_id(self, google_id: str) -> Optional[Dict[str, Any]]:
        """Fetch user record by Google ID."""
        if self.is_supabase and self.supabase_client:
            try:
                res = self.supabase_client.table("users").select("*").eq("google_id", google_id).execute()
                if res.data:
                    return res.data[0]
            except Exception as e:
                print(f"[Database] Supabase query error: {e}")

        conn = sqlite3.connect(self.sqlite_path)
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute("SELECT * FROM users WHERE google_id = ?", (google_id,))
        row = cursor.fetchone()
        conn.close()
        return dict(row) if row else None


# Global database instance
db = Database()
