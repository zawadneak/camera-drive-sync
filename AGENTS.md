# Project instructions

- Keep originals, API keys, personal photos, source manifests, device identifiers, live configuration and runtime logs outside this repository.
- Never delete, modify or format camera/card files. Only read the explicitly configured camera disk. Never auto-import every attached removable drive.
- Support Windows PowerShell 5.1 and later. Preserve the checksum-verified partial-copy process and upload-state atomic replacement.
- Duplicate detection is based on file content. Never replace or delete existing Immich assets to resolve duplicates.
- Preserve embedded metadata. Apply clock corrections only for explicitly confirmed, checksum-specific inputs, using sidecars.
- Service credentials use Windows DPAPI and restricted ACLs. Keep the dedicated key's permissions minimal. Never log or commit secrets.
- Verify real uploads, album membership, capture dates and previews before claiming an integration works. A successful HTTP upload alone is insufficient.
- Creating this local project does not authorize publishing to GitHub. Publish only when the user requests it.
