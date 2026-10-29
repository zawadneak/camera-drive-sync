# Immich Camera Importer

A Windows camera-to-Immich importer. It recognizes one configured USB mass-storage camera, copies its media into a local inbox, verifies SHA-1 checksums, and uploads new files to a private Immich album. It runs hidden at Windows sign-in and needs no WSL, GPU, or additional container.

The current implementation was developed against Immich 3.3.5 and a Sony ZV-1 in USB mass-storage mode. This is a small PowerShell project; it has not been validated against every camera or server version.

## How it works

1. Identify the configured camera by its USB disk PNPDeviceID, so changing drive letters does not matter.
2. Scan DCIM and common Sony video directories. Unrelated USB drives and Sony's PMHOME volume are ignored.
3. Copy media to the inbox through a partial file, flush it, and verify its checksum before making it available to the uploader. Files on the camera are never deleted or changed.
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

This removes the scheduled task and preserves all local photos/configuration. Revoke the service key in Immich if it is no longer needed.

## Development

No API keys, source photos, local state, logs, or real device identifiers belong in Git. All user data and machine configuration live outside the project. Installation scripts are the source; the installed watcher is a copy. Re-run the installer after changing the watcher.

Before publishing, choose a license, review the source and supported-version claims, and exercise actual connect/disconnect and interrupted-transfer scenarios on the target camera. Repository creation does not publish anything to GitHub.
