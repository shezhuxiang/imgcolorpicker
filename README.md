# Image Color Picker

A free, zero-build, fully client-side tool that extracts colors from any image.
Upload a photo, screenshot, or design and get accurate **HEX**, **RGB**, and **HSL**
color codes plus a generated palette. Click anywhere on the image to pick a specific
color. Runs entirely in the browser — no upload to any server, no install.

Live site: **https://imgcolorpicker.cc**

## Files

| File | Purpose |
|------|---------|
| `index.html` | Page markup + SEO head (meta, Open Graph, Twitter Card, JSON-LD). |
| `style.css` | Dark-theme styling. |
| `app.js` | UI logic: upload, preview, palette rendering, copy-to-clipboard, GA4 events. |
| `extractColor.js` | Color extraction core (OKLab + weighted K-Means++). Shared, self-contained. |

## Run locally

No build step required. Serve the folder over HTTP (the file:// protocol blocks some
browser APIs):

```bash
python3 -m http.server 8799
# then open http://localhost:8799/
```

## Deploy (Cloudflare Pages, Git method)

1. Push this repo to GitHub.
2. Cloudflare Dashboard → **Workers & Pages** → **Create** → **Pages** → connect the repo.
3. Build settings:
   - Framework preset: **None**
   - Build command: _(leave empty)_
   - **Build output directory: `.`**  (the static files are at the repo root)
4. Deploy. Then add the custom domain **`imgcolorpicker.cc`** under *Custom domains*
   (Cloudflare auto-creates the DNS record + SSL).

Every later `git push` to the production branch auto-deploys.

## Analytics

Google Analytics 4 is wired in (`index.html` head, Measurement ID `G-NTF9NJ6C1Z`).
Events: `upload_image`, `copy_color`, `pick_color`. The `session_uploads` parameter
must be registered as a **custom metric** in the GA4 dashboard to be collected.

## TODO before go-live

- [ ] Add `og-image.png` (1200×630) at the repo root — referenced by `og:image`.
- [ ] In GA4, set default URL to `https://imgcolorpicker.cc` and register `session_uploads`.
- [ ] Verify the site in Google Search Console (HTML tag in `<head>`).
