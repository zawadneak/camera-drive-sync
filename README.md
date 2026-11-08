# Immich Camera Importer

A Windows camera-to-Immich importer with a local management dashboard. It recognizes one configured USB mass-storage camera, copies its media into a local inbox, verifies SHA-1 checksums, and uploads new files to a private Immich album. It runs hidden at Windows sign-in and needs no WSL, GPU, or additional container.

The current implementation was developed against Immich 3.3.5 and a Sony ZV-1 in USB mass-storage mode. This is a small PowerShell project; it has not been validated against every camera or server version.

## How it works

1. Identify the configured camera by its USB disk PNPDeviceID, so changing drive letters does not matter.
2. Scan DCIM and common Sony video directories. Unrelated USB drives and Sony's PMHOME volume are ignored.
3. Copy media to the inbox through a partial file, flush it, and verify its checksum before making it available to the uploader. Automatic importing never changes or removes camera files.
4. Ask Immich whether the checksum already exists. Upload new originals; add existing duplicates to the album without replacing them. Trashed duplicates stay trashed.
5. Persist import state after album membership succeeds. Interrupted copies/imports retry on later scans. An already completed file is skipped unless its size or modification time changes.

The inbox retains an additional local copy; Immich also keeps its managed library original. Plan storage accordingly. Reconnecting the same camera does not duplicate completed files. The process runs while the Windows user is signed in and the PC is awake. Immich itself starts independently.

## Install

Use Windows PowerShell 5.1 or later, with a running local Immich server at `http://127.0.0.1:2283`. Connect the camera, turn it on and select USB mass storage.

List camera disks:

```powershell
.\scripts\Install-CameraImporter.ps1 -ListCameras
```

Install using the exact PNPDeviceID reported for the media disk, not the PMHOME volume:

```powershell
.\scripts\Install-CameraImporter.ps1 `
  -CameraPnpId 'USBSTOR\DISK&VEN_VENDOR&PROD_CAMERA\DEVICE_SERIAL&0' `
  -CameraName 'My Camera' `
  -AlbumName 'My Camera' `
  -InstallRoot 'D:\CameraSync'
```

The installer prompts securely for an existing Immich management API key. It creates the private album if necessary, creates a dedicated limited service key, encrypts that key with Windows DPAPI, and registers the **Immich Camera Importer** logon task with automatic restart on process failure. The management key is not stored.

The service key needs `asset.upload`, `asset.read`, `asset.view`, `asset.share`, `album.read`, and `albumAsset.create`. It cannot delete originals, manage users, or administer the server. Immich keys have account-wide permissions rather than being restricted to a single album. The encrypted key is protected by the current Windows user account, and the private directory ACL allows that user and SYSTEM. Reinstall credentials after moving the installation to a different Windows account or machine.

Keep the generated live configuration, encrypted key, state, logs, and media outside this repository. They default to `D:\CameraSync`. `config.example.json` contains no personal device identifier or credentials.

## Local dashboard

Windows starts both tasks 30 seconds after sign-in. A repeating two-minute recovery trigger starts a stopped task while the user is signed in; `IgnoreNew` prevents duplicate processes. Disable or uninstall the tasks to intentionally keep them stopped. `scripts/Repair-CameraStartup.ps1` repairs these triggers on an existing installation without rotating credentials.

The overall progress panel shows imported/remaining files, verified PC copies, transferred copy bytes and the current file/stage. Importer status is written during work rather than only after a scan. Inventory scans are cached for ten seconds; the visible page polls lightweight status every five seconds without overlapping requests. The gallery renders twelve files per page and uses content-versioned private image caching. Deletion verification uses up to three concurrent checks, with camera reads and final camera removals kept sequential; all selected files must pass fresh checks before removal starts.

The dashboard is a buildless HTML/CSS/JavaScript frontend and a Node.js server using built-in modules only. It runs at `http://127.0.0.1:18474`, bound to IPv4 loopback. It is intended for trusted users on this PC, not LAN or Internet exposure. No new firewall rule is required. Host/origin validation and a session CSRF token protect against browser-based cross-origin requests and DNS rebinding. The dashboard never sends the Immich API key to the browser.

Install after the importer, with an existing trusted Node.js 22+ executable:

```powershell
.\scripts\Install-CameraDashboard.ps1 -NodeExePath 'C:\Program Files\nodejs\node.exe'
```

The installer copies the runtime into the installation directory and creates the **Immich Camera Dashboard** Windows logon task. A Windows job-object supervisor keeps Node and its helper processes attached to that task; stopping/restarting the task closes the HTTP listener and children instead of leaving an orphan server. Node waits for the supervisor handshake before loading credentials or listening. The installer adds only `asset.download` to the existing service key, using the management key prompt, so original copies can be verified before camera deletion. It does not grant permission to delete anything in Immich.

The interface shows device connection, imported and pending files, image/video previews, search, type filters, and recent activity. A camera storage meter shows the whole card's used percentage, used/total bytes and free space, including files outside the import folders. Disconnected or unavailable capacity is shown as unknown. **Sync now** signals the existing importer without interrupting a transfer.

**On camera** is the default view and shows only files currently on the connected card. Confirmed camera deletions disappear from this view. **PC archive** shows saved local copies, including pending imports, and retains them after camera deletion or disconnection. When disconnected, the camera view reports unknown contents instead of claiming the card is empty.

Imported files are hidden by default. **Show imported** restores them in either view;
the dashboard remembers this preference in the current browser. Pending files come
first, with newest capture dates first within pending and imported groups.

### Python image previews

The optional Python/Pillow worker resizes saved JPEGs (including Sony MPO-in-JPEG)
and PNGs outside the Node.js event loop. It makes 640px gallery previews and 1600px
date-review previews, applies EXIF orientation, and preserves the originals. One
low-priority worker processes a bounded queue; simultaneous requests for the same
preview share one operation. No additional HTTP service or open port is needed.

With an installed Python 3.11+ runtime:

```powershell
.\scripts\Install-ImageWorker.ps1 -PythonExePath 'C:\path\to\python.exe'
```

This creates `D:\CameraSync\runtime\image-python`, installs Pillow 13.0.0, and
records the runtime in the private live dashboard settings. Keep the base Python
installation available. Deploy the dashboard with `Install-CameraDashboard.ps1`
and restart its task after configuring the worker. It starts automatically as a
child of the supervised dashboard; no separate startup task is needed.

Generated JPEGs live in `private\preview-cache`, outside source control. Their
keys include the expected checksum, file size, modification/creation times and
preview profile. Originals are hashed on cache misses; subsequent requests use
the disk cache. Cache eviction only removes generated previews, with a 512MB
limit. Videos and other formats use Immich's thumbnails. Without a configured
worker, the original local-preview fallback remains available. Failed image loads
retry at most twice rather than reloading indefinitely.

Test with `python tests/test_image_worker.py`. Set `CAMERA_TEST_PYTHON` to the
worker Python executable when running `node --test tests/image-worker.test.mjs`
to exercise the real Node/Python connection and cache persistence across worker
restarts. Synthetic fixtures never touch camera media.

Each photo/video has a sync badge and explanation: queued, waiting for a file to finish, reading/copying/verifying the camera original, saved on PC, checking Immich, uploading, adding to the album, imported, or already in Immich. Date review, a matching original in Immich trash, failed attempts and a server outage have distinct states. Stage transitions come from the importer rather than a simulated progress percentage; the dashboard checks every three seconds while visible. A stopped or restarted worker cannot leave an old file claiming to be actively uploading. Status records are bound to the file path and size/mtime fingerprint; same-named photos do not share status. Private runtime state lives in `private/file-status.json`. Status changes update cards in place, preserving loaded previews.

For an unset camera clock, choose **Review date** on a held card or **Review all N dates** in the banner. Enter the actual recording time for the earliest selected photo in the displayed time zone. The preview lists each proposed date. Keep the original time gaps, or explicitly apply the same timestamp to the selection. **Save dates & import** verifies the saved originals, atomically records checksum-specific corrections and wakes the importer. The importer reloads date approvals on each scan. This flow is restricted to saved, unimported originals that still need date review; it does not edit camera files or original EXIF.

Saved JPEG/PNG photos can be viewed before import, including files held for date review. Cards and the review dialog read the verified PC copies when no Immich preview is available. The dialog shows the full photo without cropping; select a small photo to inspect another, or use **Open photo larger**. Local previews require an inventoried copy inside the configured inbox with matching size, SHA-1 and image signature. They do not upload or alter the original. RAW/HEIC and video previews still depend on Immich processing.

### Confirmed camera-file removal

Choose **Select all imported** for every imported file still on the camera, or filter/search and choose **Select shown**. **Clear** resets the selection; Shift-clicking checkboxes selects a range. Pending imports and archived files no longer on the camera are excluded. The selection count includes files hidden by the current filter, with a notice when applicable. Up to 10,000 files can be selected per batch; larger selections show an explicit message instead of silently truncating. A sticky deletion bar shows the selected count and space to free while scrolling.

Choose **Delete N from camera…** to review the batch. The server rechecks the local archive and streams the Immich original to compute matching SHA-1 checksums. The confirmation lists the actual filenames and space to free, and requires typing `DELETE` once for the entire batch. Its one-use token expires after two minutes and binds the selection to the specific camera/card and file fingerprints. Files and original downloads are checked again on execution. Large batches can take time to verify, especially videos.

The result reports the size of successfully removed camera files, excludes failed removals and keeps the result visible below the deletion bar. The storage meter refreshes from Windows after deletion; card free-space changes can differ slightly from file sizes because of filesystem allocation.

The Windows helper re-identifies the configured disk/card, confines paths to media folders, rejects reparse paths, and holds the archive open without delete/write sharing. It opens the exact camera file with exclusive read/delete access, rehashes it, and marks that handle for deletion only after verification. That avoids a close-and-delete-by-path race. Reference: Microsoft's [FILE_DISPOSITION_INFO](https://learn.microsoft.com/en-us/windows/win32/api/winbase/ns-winbase-file_disposition_info).

Only explicitly confirmed camera files can be deleted. The PC archive and Immich originals are kept. Camera deletion is permanent and is not propagated to Immich. The archive and Immich library may share one physical disk; a separate backup is needed for protection against failure of that disk. The dashboard blocks removal of new/unimported files, mismatched copies, trashed Immich assets, changed cards and expired confirmations. Per-file results are reported, so an interrupted batch is not claimed as fully completed.

Deletion audit events are written outside the repository to `dashboard-deletions.jsonl`. Do not expose this local control panel to other hosts without adding real user authentication and transport security.

## Camera clock correction

Original media and their embedded EXIF are preserved. For a specifically confirmed batch with an unset camera clock, an operator can supply `-InitialManifest` during installation. The manifest contains source checksums and explicitly confirmed ISO-8601 `CorrectedTimestamp` values. Each correction is bound to an exact source checksum and uploaded as an XMP sidecar, so later metadata extraction retains it without editing the original.

The optional initial manifest fields are `SourceRelative`, `FileName`, `Bytes`, `Sha1`, `Destination`, `OriginalTimestamp`, and `CorrectedTimestamp`. Do not commit manifests containing personal information. The installer does not guess corrected dates. New files dated before 2021 without a checksum-specific override are retained locally and flagged for review. Set the camera's clock before taking further photos.

## Status and troubleshooting

Read `D:\CameraSync\status.json` and `D:\CameraSync\events.jsonl`. Inspect the task with:

```powershell
Get-ScheduledTask -TaskName 'Immich Camera Importer'
Get-Content 'D:\CameraSync\status.json'
```

The status includes pending files, completed files, errors, and the last scan time. A folder can also be imported by placing supported media under the inbox. Files still being written or younger than the settling interval are deferred.

For a one-time scan, stop the scheduled task before running `Watch-CameraInbox.ps1 -Once`. `-DryRun -Once` reads/checks media without copying or uploading. `-VerifyFile <path>` performs a read-only checksum/preflight check against Immich. Neither mode changes album membership. A named mutex prevents concurrent importers.

Preview and capture-metadata generation are normal Immich background jobs. A successful original upload does not imply those jobs have finished. The importer leaves their settings and concurrency unchanged.

USB disconnects, an offline server and incomplete transfers are retried. Files are not removed from the inbox automatically. If the camera is reformatted or files are renamed, checksum matching still prevents duplicate originals in Immich. A card used in a separate reader needs that reader's device ID configured; MTP/PTP, Wi-Fi transfer, and headless operation before Windows sign-in are not implemented.

## Disable

```powershell
.\scripts\Uninstall-CameraImporter.ps1
```

This removes both scheduled tasks and preserves all local photos/configuration. Revoke the service key in Immich if it is no longer needed.

## Development

No API keys, source photos, local state, logs, or real device identifiers belong in Git. All user data and machine configuration live outside the project. Installation scripts are the source; the installed watcher is a copy. Re-run the installer after changing the watcher.

Run the deletion/HTTP guard tests with `node --test tests/*.test.mjs`. On Windows, run `tests\Test-WindowsDelete.ps1` to test the native handle-based deletion routine against temporary fixtures. These tests do not remove real camera media. Also verify actual uploads, dates, previews, and repeated scans on the target setup. Never use real camera deletion as an automated UI test without the user's action-time confirmation.

Run `tests\Test-SyncSnapshot.ps1` in Windows PowerShell 5.1 to check pending archive rows, same-name file isolation, date holds, worker lifetime and fingerprint binding using disposable local fixtures with no Immich uploads.

Before publishing, choose a license, review the source and supported-version claims, and exercise actual connect/disconnect and interrupted-transfer scenarios on the target camera. Repository creation does not publish anything to GitHub.
