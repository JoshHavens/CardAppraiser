#!/usr/bin/env python3
"""
One-command release for the Whatnot Card Appraiser extension.

Does everything: bump version -> set update_url -> build zip -> sign via the
Mozilla (AMO) API -> download the signed .xpi -> update updates.json ->
git commit & push. Firefox then auto-installs the update from GitHub.

Usage:
    python scripts/publish.py            # bump patch (0.1.5 -> 0.1.6)
    python scripts/publish.py 0.2.0      # set an explicit version
    python scripts/publish.py --no-push  # do everything but the git push

One-time setup lives in SETUP-AUTOUPDATE.md. Needs scripts/config.json
(copied from scripts/config.example.json) with your GitHub + AMO API details.

Stdlib only — no pip installs required.
"""
import base64
import hashlib
import hmac
import io
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CONFIG_PATH = os.path.join(ROOT, "scripts", "config.json")
MANIFEST_PATH = os.path.join(ROOT, "manifest.json")
UPDATES_PATH = os.path.join(ROOT, "updates.json")
DIST_DIR = os.path.join(ROOT, "dist")
API_BASE = "https://addons.mozilla.org/api/v5"

# Files/dirs included in the packaged extension (manifest.json at zip root).
INCLUDE = ["manifest.json", "background", "content", "options", "icons"]


def die(msg):
    print("ERROR: " + msg)
    sys.exit(1)


def load_config():
    if not os.path.exists(CONFIG_PATH):
        die("scripts/config.json not found. Copy scripts/config.example.json to "
            "scripts/config.json and fill it in (see SETUP-AUTOUPDATE.md).")
    with open(CONFIG_PATH, encoding="utf-8") as f:
        cfg = json.load(f)
    for k in ("github_user", "github_repo", "amo_api_key", "amo_api_secret", "addon_id"):
        if not cfg.get(k) or str(cfg[k]).startswith("YOUR_"):
            die(f"config.json is missing '{k}'.")
    cfg.setdefault("github_branch", "main")
    return cfg


def read_manifest():
    with open(MANIFEST_PATH, encoding="utf-8") as f:
        return json.load(f)


def write_manifest(m):
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(m, f, indent=2, ensure_ascii=False)
        f.write("\n")


def bump_patch(version):
    parts = version.split(".")
    while len(parts) < 3:
        parts.append("0")
    parts[2] = str(int(parts[2]) + 1)
    return ".".join(parts[:3])


def build_zip(version):
    """Zip the extension with forward-slash paths and manifest.json at the root."""
    os.makedirs(DIST_DIR, exist_ok=True)
    zip_path = os.path.join(DIST_DIR, f"cardappraiser-{version}.zip")
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as z:
        for item in INCLUDE:
            full = os.path.join(ROOT, item)
            if os.path.isfile(full):
                z.write(full, item)
            else:
                for base, _dirs, files in os.walk(full):
                    for name in files:
                        fp = os.path.join(base, name)
                        rel = os.path.relpath(fp, ROOT).replace(os.sep, "/")
                        z.write(fp, rel)
    return zip_path


# ----------------------------------------------------------------- AMO API ---
def b64url(data: bytes) -> bytes:
    return base64.urlsafe_b64encode(data).rstrip(b"=")


def amo_token(cfg):
    header = {"alg": "HS256", "typ": "JWT"}
    now = int(time.time())
    payload = {"iss": cfg["amo_api_key"], "jti": str(uuid.uuid4()), "iat": now, "exp": now + 300}
    seg = b64url(json.dumps(header).encode()) + b"." + b64url(json.dumps(payload).encode())
    sig = hmac.new(cfg["amo_api_secret"].encode(), seg, hashlib.sha256).digest()
    return (seg + b"." + b64url(sig)).decode()


def api_request(method, url, cfg, data=None, headers=None, expect_json=True):
    hdrs = {"Authorization": "JWT " + amo_token(cfg)}
    if headers:
        hdrs.update(headers)
    req = urllib.request.Request(url, data=data, method=method, headers=hdrs)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = resp.read()
            return resp.status, (json.loads(body) if expect_json and body else body)
    except urllib.error.HTTPError as e:
        body = e.read()
        try:
            body = json.loads(body)
        except Exception:
            body = body.decode("utf-8", "replace")
        return e.code, body


def multipart_body(fields, file_field, filename, file_bytes):
    boundary = "----caboundary" + uuid.uuid4().hex
    out = io.BytesIO()

    def w(s):
        out.write(s.encode("utf-8"))

    for k, v in fields.items():
        w(f"--{boundary}\r\n")
        w(f'Content-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n')
    w(f"--{boundary}\r\n")
    w(f'Content-Disposition: form-data; name="{file_field}"; filename="{filename}"\r\n')
    w("Content-Type: application/zip\r\n\r\n")
    out.write(file_bytes)
    w(f"\r\n--{boundary}--\r\n")
    return out.getvalue(), f"multipart/form-data; boundary={boundary}"


def sign_via_amo(cfg, zip_path, version):
    with open(zip_path, "rb") as f:
        zip_bytes = f.read()

    # 1) Upload
    print("  uploading to AMO ...")
    body, ctype = multipart_body({"channel": "unlisted"}, "upload", os.path.basename(zip_path), zip_bytes)
    status, resp = api_request("POST", f"{API_BASE}/addons/upload/", cfg, data=body,
                               headers={"Content-Type": ctype})
    if status not in (200, 201):
        die(f"upload failed (HTTP {status}): {resp}")
    upload_uuid = resp["uuid"]

    # 2) Poll validation
    print("  validating ...")
    for _ in range(60):
        status, resp = api_request("GET", f"{API_BASE}/addons/upload/{upload_uuid}/", cfg)
        if resp.get("processed"):
            if not resp.get("valid"):
                die("validation failed: " + json.dumps(resp.get("validation", {}))[:1500])
            break
        time.sleep(3)
    else:
        die("validation timed out.")

    # 3) Create the version on the existing add-on
    print("  creating signed version ...")
    guid = urllib.parse.quote(cfg["addon_id"], safe="")
    payload = json.dumps({"upload": upload_uuid}).encode()
    status, resp = api_request("POST", f"{API_BASE}/addons/addon/{guid}/versions/", cfg,
                               data=payload, headers={"Content-Type": "application/json"})
    if status not in (200, 201):
        die(f"version create failed (HTTP {status}): {resp}")
    version_id = resp["id"]

    # 4) Poll for the signed file and download it
    print("  waiting for signature ...")
    ver_url = f"{API_BASE}/addons/addon/{guid}/versions/{version_id}/"
    for _ in range(60):
        status, resp = api_request("GET", ver_url, cfg)
        fileobj = resp.get("file") or {}
        dl = fileobj.get("url")
        if dl:
            # For unlisted add-ons the file at this URL is the signed one. Just
            # try it; a valid .xpi starts with the ZIP magic "PK".
            st, data = api_request("GET", dl, cfg, expect_json=False)
            if st == 200 and isinstance(data, (bytes, bytearray)) and data[:2] == b"PK":
                print("  downloading signed .xpi ...")
                xpi_path = os.path.join(DIST_DIR, f"cardappraiser-{version}.xpi")
                with open(xpi_path, "wb") as out:
                    out.write(data)
                return xpi_path
        time.sleep(4)
    die("timed out waiting for the signed file. The version may still be signing — "
        "re-run in a minute, or check the AMO developer hub.")


# ------------------------------------------------------------- updates.json ---
def raw_url(cfg, path):
    return (f"https://raw.githubusercontent.com/{cfg['github_user']}/"
            f"{cfg['github_repo']}/{cfg['github_branch']}/{path}")


def write_updates_json(cfg, version, xpi_rel):
    entry = {"version": version, "update_link": raw_url(cfg, xpi_rel)}
    data = {"addons": {cfg["addon_id"]: {"updates": [entry]}}}
    with open(UPDATES_PATH, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")


def git(*args):
    subprocess.run(["git", "-C", ROOT, *args], check=True)


def main():
    args = [a for a in sys.argv[1:]]
    no_push = "--no-push" in args
    explicit = next((a for a in args if not a.startswith("--")), None)

    cfg = load_config()
    manifest = read_manifest()
    version = explicit or bump_patch(manifest["version"])
    print(f"Releasing v{version}")

    # 1) manifest: version + update_url (must be baked in before signing)
    manifest["version"] = version
    manifest.setdefault("browser_specific_settings", {}).setdefault("gecko", {})[
        "update_url"] = raw_url(cfg, "updates.json")
    write_manifest(manifest)

    # 2) build + 3) sign
    zip_path = build_zip(version)
    xpi_path = sign_via_amo(cfg, zip_path, version)
    xpi_rel = os.path.relpath(xpi_path, ROOT).replace(os.sep, "/")
    print(f"  signed: {xpi_rel}")

    # 4) updates.json
    write_updates_json(cfg, version, xpi_rel)

    # 5) commit + push
    if no_push:
        print("Done (skipped git push). Commit dist/, updates.json, manifest.json yourself.")
        return
    git("add", "-A")  # include the source we just built from (config.json is gitignored)
    git("commit", "-m", f"Release v{version}")
    git("push", "origin", cfg["github_branch"])
    print(f"\nReleased v{version}. Firefox auto-updates within ~24h, or force it now:")
    print("  about:addons -> gear -> Check for Updates")


if __name__ == "__main__":
    main()
