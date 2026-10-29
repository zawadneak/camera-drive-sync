# Project instructions

- Keep originals, API keys, personal photos, source manifests, device identifiers, live configuration and runtime logs outside this repository.
- Never modify or format camera/card files. Camera-file deletion is allowed only through the user-requested dashboard's explicit per-batch confirmation, after fresh verification of the local archive and Immich original. Never auto-delete files or remove unverified files. Restrict operations to the explicitly configured camera disk; never import every attached removable drive.
- Support Windows PowerShell 5.1 and later. Preserve the checksum-verified partial-copy process and upload-state atomic replacement.
- Duplicate detection is based on file content. Never replace or delete existing Immich assets to resolve duplicates.
- Preserve embedded metadata. Apply clock corrections only for explicitly confirmed, checksum-specific inputs, using sidecars.
- Service credentials use Windows DPAPI and restricted ACLs. Keep the dedicated key's permissions minimal. Never log or commit secrets.
- Verify real uploads, album membership, capture dates and previews before claiming an integration works. A successful HTTP upload alone is insufficient.
- Creating this local project does not authorize publishing to GitHub. Publish only when the user requests it.
