"""Resume a publish that uploaded+signed on AMO but failed to download/finalize.
Downloads the signed .xpi for the manifest's current version, writes updates.json,
then commits & pushes — the same tail end as publish.py."""
import os, sys, time, json, urllib.parse
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import publish as P

cfg = P.load_config()
version = P.read_manifest()["version"]
guid = urllib.parse.quote(cfg["addon_id"], safe="")
print(f"Resuming v{version}")

# Find the version id for this version string.
status, resp = P.api_request("GET", f"{P.API_BASE}/addons/addon/{guid}/versions/?filter=all_with_unlisted&page_size=10", cfg)
if status != 200:
    P.die(f"could not list versions (HTTP {status}): {str(resp)[:300]}")
vid = None
for v in resp.get("results", []):
    if v.get("version") == version:
        vid = v["id"]; break
if not vid:
    P.die(f"version {version} not found on AMO yet; try again shortly.")

ver_url = f"{P.API_BASE}/addons/addon/{guid}/versions/{vid}/"
os.makedirs(P.DIST_DIR, exist_ok=True)
xpi_path = os.path.join(P.DIST_DIR, f"cardappraiser-{version}.xpi")
print("  waiting for signed .xpi ...")
for _ in range(90):
    status, resp = P.api_request("GET", ver_url, cfg)
    dl = (resp.get("file") or {}).get("url")
    if dl:
        st, data = P.api_request("GET", dl, cfg, expect_json=False)
        if st == 200 and isinstance(data, (bytes, bytearray)) and data[:2] == b"PK" and P.is_signed_xpi(data):
            with open(xpi_path, "wb") as f:
                f.write(data)
            print("  downloaded signed .xpi")
            break
    time.sleep(4)
else:
    P.die("timed out waiting for the signed file; re-run in a minute.")

xpi_rel = os.path.relpath(xpi_path, P.ROOT).replace(os.sep, "/")
P.write_updates_json(cfg, version, xpi_rel)
P.git("add", "-A")
P.git("commit", "-m", f"Release v{version}")
P.git("push", "origin", cfg["github_branch"])
print(f"\nReleased v{version}.")
