# Auto-update setup (one time, ~10 minutes)

After this, every release is a single command — `python scripts/publish.py` —
and Firefox installs the update automatically. No more hunting for download
buttons or "Install from File".

## 1. Create a GitHub repo to host the updates

1. On GitHub, create a **public** repo (e.g. named `cardappraiser`).
   Public is required so Firefox can fetch the update files without a login.
2. Don't add a README/license (keeps the first push clean).

## 2. Get your AMO API credentials

1. Go to <https://addons.mozilla.org/developers/addon/api/key/> (sign in).
2. Click **Generate new credentials**.
3. Copy the **JWT issuer** (this is your *api key*, looks like `user:12345:678`)
   and the **JWT secret** (a long hex string). The secret is shown once.

## 3. Fill in the config

1. Copy `scripts/config.example.json` to **`scripts/config.json`**.
2. Fill in:
   - `github_user` — your GitHub username
   - `github_repo` — the repo name from step 1
   - `amo_api_key` — the JWT issuer
   - `amo_api_secret` — the JWT secret
   - `addon_id` — leave as `card-appraiser@joshhavens.local`

`scripts/config.json` is gitignored, so your secret never gets committed.

## 4. Connect the folder to your repo (one time)

Run these from the project folder (adjust the URL to your repo):

```bash
git init
git branch -M main
git remote add origin https://github.com/YOUR_USER/cardappraiser.git
git add -A
git commit -m "Initial commit"
git push -u origin main
```

## 5. First release

```bash
python scripts/publish.py
```

This bumps the version, bakes the `update_url` into the manifest, builds, signs
via AMO, downloads the signed `.xpi` into `dist/`, updates `updates.json`, and
pushes to GitHub.

## 6. Install that first signed build once

Because your *currently installed* copy doesn't know about auto-updates yet, you
install the new one **once**, by hand:

1. In `dist/`, the newly signed `cardappraiser-<version>.xpi` was created.
2. Firefox → `about:addons` → gear ⚙ → **Install Add-on From File** → pick it.
   (Remove the old copy first if Firefox complains.)

That installed build contains the `update_url`, so **from now on it updates
itself**.

## From then on — every future release

Just:

```bash
python scripts/publish.py
```

Firefox checks for updates a few times a day; to pull one immediately:
`about:addons` → gear ⚙ → **Check for Updates**.

- Bump to a specific version: `python scripts/publish.py 0.2.0`
- Build + sign but don't push: `python scripts/publish.py --no-push`
