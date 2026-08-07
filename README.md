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




