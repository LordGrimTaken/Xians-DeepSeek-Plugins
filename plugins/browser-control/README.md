# Browser control

A local, host-only DSH plugin that gives an agent a **headless Chromium it can
drive against the authenticated DSH Web UI**. It exists so UI work (Game Lab,
plugins, pages) can be verified by loading the real page, reading its DOM,
taking screenshots, clicking and typing instead of guessing.

It never opens a visible window and never touches the user's browser profile:
it launches a bundled Chrome/Edge (or Playwright headless shell) with a
throw-away `--user-data-dir` under the system temp directory. The authenticated
URL is obtained from the Host `connection` service; the token is not printed by
the plugin.

## Install

```text
plugin_manager install_bundle target: C:\Users\Austin\dsh-plugins\browser-control
```

The row id is `browser-control`. No client half and no page are added; this is
a Host-only bundle with HTTP routes.

## Routes

Mounted on the existing DSH origin under `/_dsh/browser-control`:

| method | path | purpose |
|---|---|---|
| GET | `/probe` | Chromium path, process, current URL/title, default authenticated URL |
| POST | `/open` | open the app (or a loopback `{url}`); 1600x1000 viewport |
| GET | `/screenshot` | capture the viewport to a PNG, return its path |
| GET | `/dom?selector=` | element summaries (text, aria, rect, style) |
| GET | `/console` | recent console/exception/log events |
| POST | `/eval` | `{code}` — run JavaScript, return its JSON value |
| POST | `/click` | `{selector}` or `{text}` or `{aria}` |
| POST | `/type` | `{text, selector?}` — focus then insert text |
| POST | `/key` | `{key}` — dispatch a key |
| POST | `/close` | stop the browser and delete the temporary profile |

Every request must come from a loopback peer with a loopback `Host`. POSTs also
need an `Origin` header equal to the origin (CSRF fence); GETs do not.

## Agent usage

PowerShell helper used by the lead session:

```powershell
$base = 'http://127.0.0.1:<dsh-port>/_dsh/browser-control'
$origin = 'http://127.0.0.1:<dsh-port>'
function PostJson($path, $obj) {
  (Invoke-WebRequest -Uri "$base/$path" -Method Post -ContentType 'application/json' `
    -Body ($obj | ConvertTo-Json -Compress) -Headers @{ Origin = $origin } `
    -UseBasicParsing -TimeoutSec 60).Content
}

PostJson 'open' @{}
PostJson 'click' @{ text = 'Game Lab' }
$shot = PostJson 'screenshot' @{} | ConvertFrom-Json
# then read_image the $shot.path
PostJson 'eval' @{ code = 'document.body.innerText.slice(0, 400)' }
```

Order matters: `/open` returns only after the DSH boot page reaches
`document.readyState === 'complete'`; give the client another second or two
before clicking a sidebar entry. Screenshots are written to
`%TEMP%\dsh-browser-control\shot-*.png`.

### Example: inspect Game Lab

```powershell
PostJson 'open' @{}
Start-Sleep 2
PostJson 'click' @{ text = 'Game Lab' } | Out-Null
PostJson 'dom' @{ selector = '.gl-root' }   # -> via GET /dom?selector=.gl-root
$c = PostJson 'eval' @{ code = '`${innerWidth}x${innerHeight}`' }
$shot = PostJson 'screenshot' @{}
```

Use `read_image` on the returned path when the model supports image input; the
DOM endpoint gives layout/text/rect data when it does not.

## Finding the browser

Resolution order:

1. `DSH_BROWSER_CHROME` (absolute path — set it before launching DSH);
2. installed Google Chrome;
3. installed Microsoft Edge;
4. Playwright `chromium_headless_shell-*` / `chromium-*` under
   `%LOCALAPPDATA%\ms-playwright`.

Full Chrome/Edge is preferred because its build includes H.264/WebCodecs media
codecs that the Playwright headless shell lacks. All are launched with
`--headless=new` except the headless shell, which is already headless.

## Security and cleanup

- Loopback peer and loopback `Host` required; POST same-origin `Origin`
  required; bodies capped at 256 KiB; JS input capped at 200k chars.
- Navigation is restricted to loopback URLs; this is not an external web proxy
  (use `web_fetch` for that).
- A temporary Chrome profile is created per browser start and removed on
  `/close` or plugin dispose; the plugin never reads the user's browser data.
- The browser has a 15-minute idle timeout and closes itself.
- `POST /close` when finished; the plugin also closes it on unload.

## Limitations

- One page/browser instance; `/open` replaces the page URL.
- No file pickers, downloads, or native dialogs.
- Headless Chromium may differ from the user's Electron renderer in GPU/media
  support (e.g. Playwright's shell has no H.264); prefer system Edge/Chrome.
- This is a diagnostic/verification tool, not a production automation API.
