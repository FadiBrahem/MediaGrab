# Media Grab v3

Chrome extension (Manifest V3) that captures images and videos on Twitter/X, Instagram,
Facebook, YouTube and any other website, lists them, and downloads the ones you select.

## Install

1. `chrome://extensions` -> Developer mode -> Load unpacked -> pick this folder
   (if you had an older version, remove it first or press the reload icon).
2. **Reload the social-site tab** (content scripts attach at page load).
3. Scroll a bit, open the popup, press **Scan** (one pass) or toggle **Auto**.

## What's new in v3

- **Downloaded history.** Items are recorded when a download *completes*, then hidden from
  every later scan (also after Clear). Tick "Show downloaded" to see them (marked with a check).
  Menu (...): "Mark listed items as downloaded" (a baseline: show only what's new from now on)
  and "Reset downloaded history". Failed or cancelled downloads stay listed.
- **Facebook reels.** Reads the newer delivery fields (`progressive_urls`), merges HD/SD from
  several places, has a schema-agnostic fallback (any fbcdn .mp4 URL), and lists DASH-only
  reels as stream-only so "Copy yt-dlp" works.
- **Other sites tab.** Works on any website. The scanner is only injected when you press
  Scan/Auto (activeTab), so the extension needs no access to all sites. It reads images
  (incl. lazy-load attributes), videos, links to media files (full-size behind thumbnails),
  og:/twitter: meta, CSS backgrounds and media the page loaded. HLS/DASH and blob videos
  are flagged stream-only. Files go to `Downloads/MediaGrab/other/<site>/`.
- **New UI.** Tabs with new-item counts, list or grid view, All/Images/Videos filter,
  shift-click range select, progress bar, per-item "open", light/dark mode.

## How capture works (platform tabs)

`inject.js` runs inside the page and reads the JSON the site already fetches. Items are
de-duplicated by media ID and by asset path (the largest version wins). A strict DOM fallback
only looks inside posts and ignores emoji/flags/avatars. Downloads run through a throttled
background queue into `Downloads/MediaGrab/<platform>/`.

## If something is not detected

Open the popup on that page, menu (...) -> **Copy diagnostics**, and paste the result.
It lists which API responses were seen and where video-looking fields were found.

## Known limits

- Internal API shapes change; expect occasional maintenance (Facebook most of all).
- Stream-only video (HLS/DASH/blob) can't be saved directly: use **yt-dlp** (button copies commands).
- YouTube direct URLs often return 403; yt-dlp is the reliable route.
- On Other sites, some CDNs reject hotlinked downloads (they check the Referer).
- Only content loaded after the page started is seen: reload, then scroll. On Other sites,
  press Scan *after* the video/images have loaded (Resource Timing keeps a limited buffer).
- Respect each site's Terms of Service and copyright; download only what you have rights to.

## Files

`manifest.json`, `inject.js` (page hook + parsers), `core.js` (dedupe/storage/commands),
`content.js` (platform sites), `generic.js` (any site), `background.js` (download queue + history),
`popup.html/css/js` (UI).
