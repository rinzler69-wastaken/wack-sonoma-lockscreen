#!/usr/bin/env python3
"""Generate all .po files and compile them to .mo for wack-lockscreen-clock."""

import os, subprocess

DOMAIN = "wack-lockscreen-clock@rinzler69-wastaken.github.com"
EXT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PO_DIR  = os.path.join(EXT_DIR, "po")
LOC_DIR = os.path.join(EXT_DIR, "locale")

MORE = {
    "es": "más",         "fr": "plus",        "de": "mehr",
    "it": "altro",       "pt": "mais",        "ru": "ещё",
    "zh": "更多",         "ja": "さらに",       "ko": "더 보기",
    "ar": "المزيد",      "hi": "अधिक",         "tr": "daha fazla",
    "nl": "meer",        "pl": "więcej",      "sv": "mer",
    "da": "mere",        "no": "mer",         "fi": "lisää",
    "el": "περισσότερα", "he": "עוד",         "id": "lagi",
    "th": "เพิ่มเติม",    "vi": "thêm",
}

TOGGLE = {
    "es": "Presiona Shift + N para ver notificaciones",
    "fr": "Appuyez sur Maj+N pour voir les notifications",
    "de": "Shift + N drücken, um Benachrichtigungen anzuzeigen",
    "it": "Premi Maiusc + N per visualizzare le notifiche",
    "pt": "Pressione Shift + N para ver as notificações",
    "ru": "Нажмите Shift + N для просмотра уведомлений",
    "zh": "按 Shift + N 查看通知",
    "ja": "Shift + N で通知を表示",
    "ko": "Shift + N을 눌러 알림 보기",
    "ar": "اضغط Shift + N لعرض الإشعارات",
    "hi": "सूचनाएं देखने के लिए Shift + N दबाएं",
    "tr": "Bildirimleri görmek için Shift + N'ye basın",
    "nl": "Druk op Shift + N om meldingen te bekijken",
    "pl": "Naciśnij Shift + N, aby wyświetlić powiadomienia",
    "sv": "Tryck på Shift + N för att visa aviseringar",
    "da": "Tryk på Shift + N for at se notifikationer",
    "no": "Trykk Shift + N for å se varsler",
    "fi": "Paina Shift + N nähdäksesi ilmoitukset",
    "el": "Πατήστε Shift + N για προβολή ειδοποιήσεων",
    "he": "הקש Shift + N כדי לראות התראות",
    "id": "Tekan Shift + N untuk melihat notifikasi",
    "th": "กด Shift + N เพื่อดูการแจ้งเตือน",
    "vi": "Nhấn Shift + N để xem thông báo",
}

PO_HEADER = '''\
# WACK - Sonoma Lockscreen
# Copyright (C) 2026 rinzler69-wastaken
msgid ""
msgstr ""
"Project-Id-Version: {domain}\\n"
"MIME-Version: 1.0\\n"
"Content-Type: text/plain; charset=UTF-8\\n"
"Content-Transfer-Encoding: 8bit\\n"
"Language: {lang}\\n"

'''

for lang in MORE:
    po_path = os.path.join(PO_DIR, f"{lang}.po")
    mo_dir  = os.path.join(LOC_DIR, lang, "LC_MESSAGES")
    mo_path = os.path.join(mo_dir, f"{DOMAIN}.mo")

    # Write .po
    content = PO_HEADER.format(domain=DOMAIN, lang=lang)
    content += f'msgid "more"\nmsgstr "{MORE[lang]}"\n\n'
    content += f'msgid "Press Shift + N to view notifications"\nmsgstr "{TOGGLE[lang]}"\n'
    with open(po_path, "w", encoding="utf-8") as f:
        f.write(content)

    # Compile .mo
    os.makedirs(mo_dir, exist_ok=True)
    subprocess.run(["msgfmt", po_path, "-o", mo_path], check=True)
    print(f"  [{lang}] OK")

print("Done.")
