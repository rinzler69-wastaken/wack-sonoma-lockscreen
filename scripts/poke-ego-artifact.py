#!/usr/bin/env python3
"""
EGO Artifact Integrity & GDM Contamination Verifier

Inspects a packaged GNOME Shell extension ZIP artifact intended for EGO
(extensions.gnome.org) and verifies that no GDM-only source files, packaging
exclusion markers (<GDM_EXCLUDE>), or GDM runtime implementation leaked into the archive.
"""

import sys
import os
import zipfile
import json
import re

FORBIDDEN_FILE_PATTERNS = [
    re.compile(r'^src/pro(/|$)'),
    re.compile(r'^pro(/|$)'),
    re.compile(r'^pro\.js$'),
    re.compile(r'^crossSessionManager\.js$'),
    re.compile(r'^scripts/'),
    re.compile(r'\.bak$'),
    re.compile(r'checkthisthingblyat'),
]

FORBIDDEN_MARKERS = [
    '<GDM_EXCLUDE>',
    '</GDM_EXCLUDE>',
]

FORBIDDEN_CODE_PATTERNS = [
    (re.compile(r'\bCrossSessionManager\b'), 'CrossSessionManager reference'),
    (re.compile(r'\bGdmManager\b'), 'GdmManager reference'),
    (re.compile(r'\bGdmThemePipeline\b'), 'GdmThemePipeline reference'),
    (re.compile(r"currentMode\s*===\s*['\"]gdm['\"]"), "GDM sessionMode check (currentMode === 'gdm')"),
    (re.compile(r'install-gdm-dlc\.sh'), 'GDM installer script reference'),
    (re.compile(r'uninstall-gdm-dlc\.sh'), 'GDM uninstaller script reference'),
]

def poke_artifact(zip_path):
    print(f"Poking EGO artifact ({os.path.basename(zip_path)})...")

    errors = []

    # 1. ZIP integrity
    if not os.path.exists(zip_path):
        print(f"  ✗ ZIP file not found: {zip_path}")
        print("\nEGO ARTIFACT REJECTED — FILE NOT FOUND\n")
        return 1

    if not zipfile.is_zipfile(zip_path):
        print(f"  ✗ Invalid ZIP archive: {zip_path}")
        print("\nEGO ARTIFACT REJECTED — CORRUPT ZIP ARCHIVE\n")
        return 1

    try:
        zf = zipfile.ZipFile(zip_path, 'r')
        namelist = zf.namelist()
    except Exception as e:
        print(f"  ✗ Failed to read ZIP archive: {e}")
        print("\nEGO ARTIFACT REJECTED — UNREADABLE ZIP ARCHIVE\n")
        return 1

    print("  ✓ ZIP is readable")

    # 2. Structure & Metadata Check
    structure_errors = []
    if 'metadata.json' not in namelist:
        structure_errors.append("Missing metadata.json")
    if 'extension.js' not in namelist:
        structure_errors.append("Missing extension.js")
    if 'stylesheet.css' not in namelist:
        structure_errors.append("Missing stylesheet.css")
    if not any(name.startswith('schemas/') and name.endswith('.gschema.xml') for name in namelist):
        structure_errors.append("Missing gschema.xml in schemas/")

    metadata_errors = []
    if 'metadata.json' in namelist:
        try:
            meta = json.loads(zf.read('metadata.json').decode('utf-8'))
            session_modes = meta.get('session-modes', [])
            if 'gdm' in session_modes:
                metadata_errors.append("metadata.json contains 'gdm' in session-modes")
            version_name = str(meta.get('version-name', ''))
            if 'PRO' in version_name:
                metadata_errors.append("metadata.json contains 'PRO' in version-name")
        except Exception as e:
            metadata_errors.append(f"Failed to parse metadata.json: {e}")

    if structure_errors or metadata_errors:
        errors.extend(structure_errors + metadata_errors)
        print("  ✗ Invalid EGO package structure or metadata")
    else:
        print("  ✓ metadata.json present and valid")

    # 3. GDM-only Files Check
    forbidden_files = []
    for name in namelist:
        for pat in FORBIDDEN_FILE_PATTERNS:
            if pat.search(name):
                forbidden_files.append(name)
                break

    if forbidden_files:
        errors.append(f"GDM-only files found in ZIP: {', '.join(forbidden_files)}")
        print("  ✗ GDM-only source files found")
    else:
        print("  ✓ no GDM-only source files")

    # 4. Packaging Exclusion Markers Check
    marker_leaks = []
    for name in namelist:
        if name.endswith('/'):
            continue
        try:
            content = zf.read(name).decode('utf-8')
        except UnicodeDecodeError:
            continue
        for marker in FORBIDDEN_MARKERS:
            if marker in content:
                marker_leaks.append(f"{name} ({marker})")

    if marker_leaks:
        errors.append(f"Packaging exclusion markers leaked in: {', '.join(marker_leaks)}")
        print("  ✗ GDM exclusion markers found")
    else:
        print("  ✓ no GDM exclusion markers")

    # 5. GDM Implementation & Code Leaks Check
    code_leaks = []
    cross_session_leaks = []
    gdm_entrypoints = []

    for name in namelist:
        if not name.endswith('.js'):
            continue
        try:
            content = zf.read(name).decode('utf-8')
        except UnicodeDecodeError:
            continue

        for pattern, description in FORBIDDEN_CODE_PATTERNS:
            if pattern.search(content):
                leak_desc = f"{name}: {description}"
                if 'CrossSessionManager' in description:
                    cross_session_leaks.append(leak_desc)
                elif 'sessionMode' in description or 'GdmManager' in description:
                    gdm_entrypoints.append(leak_desc)
                else:
                    code_leaks.append(leak_desc)

    if cross_session_leaks:
        errors.extend(cross_session_leaks)
        print("  ✗ CrossSessionManager references found")
    else:
        print("  ✓ no CrossSessionManager references")

    if gdm_entrypoints:
        errors.extend(gdm_entrypoints)
        print("  ✗ GDM runtime entrypoints found")
    else:
        print("  ✓ no GDM runtime entrypoints")

    if code_leaks:
        errors.extend(code_leaks)
        print("  ✗ GDM integration code found")
    else:
        print("  ✓ no GDM integration imports")

    # Final Verdict
    print()
    if errors:
        print("EGO ARTIFACT REJECTED — GDM CONTENT SURVIVED PACKAGING:\n")
        for err in errors:
            print(f"  • {err}")
        print()
        return 1

    print("EGO ARTIFACT CLEAN — GDM EXCLUSION VERIFIED\n")
    return 0

if __name__ == '__main__':
    target_zip = sys.argv[1] if len(sys.argv) > 1 else 'wack-lockscreen-clock@rinzler69-wastaken.github.com.zip'
    sys.exit(poke_artifact(target_zip))
