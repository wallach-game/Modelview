# Modelview – PLY viewer for mobile browsers

A static, no-build web app that previews `.ply` point clouds and meshes, including files of 1 GB and more.

## How the 1 GB file works

GitHub Pages cannot host a 1 GB file (100 MB per-file limit, ~1 GB site limit), and it doesn't need to:
**the model is never uploaded.** You open the site and pick the file from your phone's storage. The browser
streams it in 32 MB slices inside a Web Worker, and keeps a subsample that fits a point budget
(2 M points by default on phones, adjustable). A 1 GB file is therefore never fully held in memory.

- Formats: `ascii`, `binary_little_endian`, `binary_big_endian`
- Point clouds: `x y z` plus `red/green/blue`, or Gaussian-splat `f_dc_*` colours. Without colour, points are coloured by height.
- Meshes: faces are triangulated; shown as a mesh when small enough (up to 4 M vertices), otherwise as points.
- Large coordinates (e.g. UTM) are re-centred in double precision before rendering.
- Touch: one finger rotates, two fingers pinch-zoom and pan.

Optional: `https://<you>.github.io/<repo>/?url=https://host/model.ply` loads a remote file, if that host
allows CORS and HTTP Range requests (S3/R2/Hugging Face do; GitHub Releases does not).

## Sharing a huge file

**Option A – small preview inside the repo** (served by GitHub Pages, no other host):
```sh
node tools/decimate.mjs /path/to/huge.ply site/models/preview.ply 2000000   # ~30 MB output
git add site/models/preview.ply && git commit -m "Add preview" && git push
```
Open `https://<you>.github.io/Modelview/?url=models/preview.ply`. Keep each file under 100 MB.

**Option B – full file on Hugging Face** (public dataset, free, multi-GB OK):
```sh
tools/upload-hf.sh /path/to/huge.ply HF_USER GITHUB_USER
```
It uploads the file and prints the viewer link.

## Deploy on GitHub Pages

1. Merge to `main`.
2. Repo **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` publishes the `site/` folder.

## Run locally

```sh
cd site && python3 -m http.server 8000
```
(ES modules and workers need http, not `file://`.)

Three.js r160 and OrbitControls are vendored in `site/vendor/` (MIT), so there are no CDN dependencies.
