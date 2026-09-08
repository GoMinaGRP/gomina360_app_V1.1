GOMINA 360 — CURRENT VERSION TRANSFER PACKAGE
==============================================

WHAT THIS IS: A complete, self-contained git bundle of the CURRENT GoMina 360
version, encoded as Base64 and split into 8 small JSON part files so
Arena can upload and process them reliably (application/json is an allowed type).

FILES TO DOWNLOAD AND ATTACH TO THE NEW ARENA SESSION (all 10):
  gomina360-transfer-part-01.json  (512217 bytes)
  gomina360-transfer-part-02.json  (512217 bytes)
  gomina360-transfer-part-03.json  (512217 bytes)
  gomina360-transfer-part-04.json  (512217 bytes)
  gomina360-transfer-part-05.json  (512217 bytes)
  gomina360-transfer-part-06.json  (512217 bytes)
  gomina360-transfer-part-07.json  (512217 bytes)
  gomina360-transfer-part-08.json  (261357 bytes)
  gomina360-transfer-manifest.json  (per-part hashes = source of truth)
  README-FOR-NEW-SESSION.txt  (this file)

CANONICAL FINGERPRINTS
  snapshot commit : f7f12e32c9d3fb0508adc3bcffd8ba4ed48ddce7
  bundle ref      : refs/heads/snapshot-import
  bundle sha256   : 839b69fb93459768ac3b1899c64b6a314b41c15d20cb23c22f40100e78208f8c
  bundle bytes    : 2883854
  base64 chars    : 3845140
  EXPECTED TREE   : 54e09279218129d391b6117b5027f3fbc2c9bf62   <-- decisive check
  EXPECTED FILES  : 228
  marker files    : src/lib/scenarioEngine.ts, src/lib/push.ts, public/sw.js, drizzle.config.ts, dev-tooling/verify-az-app-audit.mjs

PER-PART dataSha256 (sender-verified; full list also in the manifest):
  part undefined  20baef682d780b2d4a9d58306d2b08b4fd65a43da25b56ebaeeb9adc0a2463ac
  part undefined  fc0004aac2485e490f237060abfe427d778a83a3bcefc1c6dd4e2f7dca42eb45
  part undefined  cb37566ce5604ed13a5edda3779d0e5724a4dade96d044dbb219c5d31ec3e0ae
  part undefined  6da80a4ec64a02a4ded0b3acb9f8d5af94ff6173dec792dd4fc6265b8a86e7a3
  part undefined  5f0f29046a2ab9237c00910d5313120f9ef352bf1fc14c42a1aa7aae6ebb2821
  part undefined  a1878ee2e8d21769b2ecc87b54390205ae4bcdf62a0e61cd2e8c728344867c94
  part undefined  694ea3ee6ea9f6dcf005fb3ce8e6c4d125cacb616712b0c4033f123ded10a45a
  part undefined  dee26f422b6220417f28275e2891e78ac4ea624676a332c2c8721b4234369c76

VERIFIED BY SENDER: the parts were reassembled -> sha256 matched -> git bundle
verify OK -> fetched into an EMPTY repo (no prerequisites needed) -> tree 54e09279218129d391b6117b5027f3fbc2c9bf62
, 228 files, all marker files present.

----------------------------------------------
PASTE THIS PROMPT INTO THE NEW ARENA SESSION (after attaching all files):
----------------------------------------------

I have attached 8 JSON part files plus a manifest. Together they are a
self-contained git bundle of the CURRENT GoMina 360 version (Base64, split for
reliable upload). This session's branch holds an OLDER partial tree that must be
replaced by the bundle content. Do not recreate files manually; everything comes
from the attached parts. Do NOT push until every gate passes. Process the files
only with shell/node scripts - never print the data fields.

Fingerprints (also in gomina360-transfer-manifest.json):
  bundle sha256 : 839b69fb93459768ac3b1899c64b6a314b41c15d20cb23c22f40100e78208f8c
  bundle ref    : refs/heads/snapshot-import  at commit f7f12e32c9d3fb0508adc3bcffd8ba4ed48ddce7
  expected tree : 54e09279218129d391b6117b5027f3fbc2c9bf62
  expected files: 228

STEP 1 - Locate the attached files in the workspace (uploads dir). If any part or
the manifest is missing, STOP and tell me to re-attach it.

STEP 2 - Reassemble: read the manifest, then concatenate the data field of all
parts in part order into one string, base64-decode to rebuilt.bundle. Its sha256
MUST equal: 839b69fb93459768ac3b1899c64b6a314b41c15d20cb23c22f40100e78208f8c
Each part has a dataSha256 in the manifest - if the total mismatches, check each
part and tell me which one is corrupt. STOP and report on any mismatch.

STEP 3 - Verify: inside the repo run: git bundle verify rebuilt.bundle
It must say: is okay / records a complete history / ref refs/heads/snapshot-import
at f7f12e32c9d3fb0508adc3bcffd8ba4ed48ddce7.

STEP 4 - Import: git fetch rebuilt.bundle refs/heads/snapshot-import:refs/gomina360/current-import
(the bundle is fully self-contained; no prerequisites needed).

STEP 5 - Gates (ALL must pass, else STOP and report):
  a) git rev-parse refs/gomina360/current-import^{tree}  ==  54e09279218129d391b6117b5027f3fbc2c9bf62
  b) git ls-tree -r --name-only refs/gomina360/current-import | wc -l  ==  228
  c) the tree contains these files: src/lib/scenarioEngine.ts, src/lib/push.ts, public/sw.js, drizzle.config.ts, dev-tooling/verify-az-app-audit.mjs

STEP 6 - My branch must be clean (git status --porcelain empty). Lay the imported
tree onto my current branch WITHOUT moving HEAD:
  git read-tree --reset -u refs/gomina360/current-import

STEP 7 - Proof: git write-tree MUST print EXACTLY 54e09279218129d391b6117b5027f3fbc2c9bf62
If a stale tracked file (e.g. drizzle.config.json) causes a mismatch, git rm it
and repeat until the hash matches exactly.

STEP 8 - Commit on top of my branch (no force-push):
  git commit -m "Import complete current GoMina 360 version (tree 54e0927) from verified git bundle"

STEP 9 - Validate: npm ci --no-audit --no-fund && npm run typecheck && npm run build
All must succeed; else STOP and report the error. Do not push on failure.

STEP 10 - Push ONLY my session branch and return the branch URL and commit URL:
  git push origin arena/01a07dc5-gomina360-app-v1

Do not start servers, run seeds/restores, or touch any other branch.
