"""
backend/server.py
FastAPI backend service for Google OAuth 2.0 Authorization Code Flow & Long-term Refresh Tokens.
Works with Supabase (PostgreSQL) and local SQLite.
"""

import os
import secrets
import json
import httpx
from pathlib import Path
from typing import Optional
from dotenv import load_dotenv

# Load .env file from backend directory or project root
load_dotenv(Path(__file__).parent / ".env")
load_dotenv(Path(__file__).parent.parent / ".env")

from fastapi import FastAPI, Request, Response, HTTPException, status
from fastapi.responses import RedirectResponse, JSONResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware

from database import db, encrypt_token, decrypt_token

app = FastAPI(title="Expense & Split Tracker OAuth Backend")

# CORS setup
origins = [
    "http://localhost:8000",
    "http://127.0.0.1:8000",
    "http://localhost:5500",
    "http://127.0.0.1:5500",
    "http://localhost:3000",
    "https://serene-frangipane-551005.netlify.app",
]
frontend_url = os.getenv("FRONTEND_URL", "").strip()
if frontend_url and frontend_url not in origins:
    origins.append(frontend_url)

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

GOOGLE_CLIENT_ID = os.getenv("GOOGLE_CLIENT_ID", "264456296680-kagklpicnp77fb32j89kc6uh1djassv6.apps.googleusercontent.com").strip()
GOOGLE_CLIENT_SECRET = os.getenv("GOOGLE_CLIENT_SECRET", "").strip()

SCOPES = " ".join([
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/spreadsheets",
    "https://www.googleapis.com/auth/userinfo.profile",
    "https://www.googleapis.com/auth/userinfo.email",
    "openid",
])


def get_base_url(request: Request) -> str:
    app_url = os.getenv("APP_URL", "").strip()
    if app_url:
        return app_url.rstrip("/")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host", request.headers.get("host", "localhost:8000"))
    return f"{proto}://{host}"


# ─────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────

@app.get("/auth/login")
async def auth_login(request: Request):
    """
    Step 1: Redirect user to Google OAuth with offline access and consent prompt.
    """
    if not GOOGLE_CLIENT_ID:
        raise HTTPException(status_code=500, detail="GOOGLE_CLIENT_ID is not configured.")

    base_url = get_base_url(request)
    redirect_uri = f"{base_url}/auth/callback"
    state = secrets.token_urlsafe(24)

    google_auth_url = (
        f"https://accounts.google.com/o/oauth2/v2/auth?"
        f"client_id={GOOGLE_CLIENT_ID}&"
        f"redirect_uri={redirect_uri}&"
        f"response_type=code&"
        f"scope={httpx.URL('', params={'s': SCOPES}).params['s']}&"
        f"access_type=offline&"
        f"prompt=consent&"
        f"state={state}&"
        f"include_granted_scopes=true"
    )

    response = RedirectResponse(url=google_auth_url, status_code=302)
    response.set_cookie(
        key="oauth_state",
        value=state,
        max_age=600,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
    )
    return response


@app.get("/auth/callback")
async def auth_callback(request: Request, code: Optional[str] = None, state: Optional[str] = None, error: Optional[str] = None):
    """
    Step 2: Handle OAuth redirect, exchange code for tokens, save user in Supabase/SQLite, set session.
    """
    base_url = get_base_url(request)
    frontend = os.getenv("FRONTEND_URL") or base_url

    if error:
        print(f"[OAuth Callback] Error from Google: {error}")
        return RedirectResponse(url=f"{frontend}/?auth_error={error}", status_code=302)

    if not code:
        raise HTTPException(status_code=400, detail="Missing authorization code.")

    if not GOOGLE_CLIENT_SECRET:
        raise HTTPException(
            status_code=500,
            detail="GOOGLE_CLIENT_SECRET is missing. Please set it in backend/.env or environment variables."
        )

    redirect_uri = f"{base_url}/auth/callback"

    # Exchange code for tokens
    async with httpx.AsyncClient() as client:
        token_res = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "code": code,
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )
        token_data = token_res.json()

        if token_res.status_code != 200 or "error" in token_data:
            err_msg = token_data.get("error_description", token_data.get("error", "token_exchange_failed"))
            print(f"[OAuth Callback] Token exchange failed: {err_msg}")
            return RedirectResponse(url=f"{frontend}/?auth_error={err_msg}", status_code=302)

        access_token = token_data.get("access_token", "")
        refresh_token = token_data.get("refresh_token", "")

        # Fetch user profile
        user_info = {}
        if access_token:
            profile_res = await client.get(
                "https://www.googleapis.com/oauth2/v3/userinfo",
                headers={"Authorization": f"Bearer {access_token}"},
            )
            if profile_res.status_code == 200:
                user_info = profile_res.json()

    google_id = user_info.get("sub", "")
    email = user_info.get("email", "")
    name = user_info.get("name") or user_info.get("given_name", "Friend")
    picture = user_info.get("picture", "")

    if not google_id or not email:
        raise HTTPException(status_code=500, detail="Could not retrieve Google profile.")

    # Save/Upsert in Supabase / SQLite
    user_record = db.upsert_user(
        google_id=google_id,
        email=email,
        name=name,
        picture=picture,
        refresh_token=refresh_token,
    )

    user_id = user_record.get("id") or google_id
    session_payload = json.dumps({"user_id": user_id, "google_id": google_id})
    encrypted_session = encrypt_token(session_payload)

    response = RedirectResponse(url=f"{frontend}/?auth=success", status_code=302)
    response.set_cookie(
        key="app_session",
        value=encrypted_session,
        max_age=60 * 60 * 24 * 90,  # 90 days
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
    )
    response.delete_cookie("oauth_state")
    return response


@app.get("/api/get-access-token")
async def get_access_token(request: Request):
    """
    Step 3: Mint fresh access token using stored refresh token from Supabase/SQLite.
    """
    session_cookie = request.cookies.get("app_session")
    if not session_cookie:
        return JSONResponse(
            status_code=401,
            content={"error": "UNAUTHORIZED", "message": "No active session cookie found."},
        )

    try:
        session_json = decrypt_token(session_cookie)
        session_data = json.loads(session_json)
        user_id = session_data.get("user_id")
        google_id = session_data.get("google_id")
    except Exception:
        return JSONResponse(
            status_code=401,
            content={"error": "UNAUTHORIZED", "message": "Invalid session."},
        )

    user = None
    if user_id:
        user = db.get_user_by_id(user_id)
    if not user and google_id:
        user = db.get_user_by_google_id(google_id)

    if not user:
        return JSONResponse(
            status_code=401,
            content={"error": "TOKEN_REQUIRED", "message": "User not found. Please log in."},
        )

    encrypted_refresh = user.get("encrypted_refresh_token", "")
    refresh_token = decrypt_token(encrypted_refresh) if encrypted_refresh else ""

    if not refresh_token:
        return JSONResponse(
            status_code=401,
            content={"error": "TOKEN_REQUIRED", "message": "No refresh token available. Please sign in again."},
        )

    if not GOOGLE_CLIENT_SECRET:
        raise HTTPException(status_code=500, detail="GOOGLE_CLIENT_SECRET is not configured.")

    # Call Google token endpoint with refresh_token
    async with httpx.AsyncClient() as client:
        res = await client.post(
            "https://oauth2.googleapis.com/token",
            data={
                "client_id": GOOGLE_CLIENT_ID,
                "client_secret": GOOGLE_CLIENT_SECRET,
                "refresh_token": refresh_token,
                "grant_type": "refresh_token",
            },
        )
        data = res.json()

        if res.status_code != 200 or "error" in data:
            is_revoked = data.get("error") == "invalid_grant"
            return JSONResponse(
                status_code=401,
                content={
                    "error": "TOKEN_REVOKED" if is_revoked else "REFRESH_FAILED",
                    "message": "Google refresh token was revoked or is invalid. Please sign in." if is_revoked else data.get("error_description", "Refresh error"),
                },
            )

        new_access_token = data.get("access_token")
        expires_in = data.get("expires_in", 3600)

        return {
            "accessToken": new_access_token,
            "expiresIn": expires_in,
            "userProfile": {
                "userId": user.get("id"),
                "email": user.get("email"),
                "name": user.get("name"),
                "picture": user.get("picture"),
            },
        }


@app.post("/api/logout")
async def logout():
    """
    Step 4: Clear session cookie.
    """
    response = JSONResponse(content={"success": True, "message": "Logged out."})
    response.delete_cookie("app_session")
    return response


# ─────────────────────────────────────────────────────────────
# Static Frontend Serving
# ─────────────────────────────────────────────────────────────
project_root = Path(__file__).parent.parent

if (project_root / "css").exists():
    app.mount("/css", StaticFiles(directory=project_root / "css"), name="css")
if (project_root / "js").exists():
    app.mount("/js", StaticFiles(directory=project_root / "js"), name="js")


@app.get("/")
async def serve_index():
    index_path = project_root / "index.html"
    if index_path.exists():
        return FileResponse(index_path)
    return {"message": "Expense & Split Tracker API Backend Running."}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("PORT", 8000))
    host = os.getenv("HOST", "0.0.0.0")
    print(f"Starting Expense Tracker Backend on http://localhost:{port}")
    uvicorn.run("server:app", host=host, port=port, reload=True)

