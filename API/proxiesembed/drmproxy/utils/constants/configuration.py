from os.path import join

from utils.constants.macros import DEFAULT_OUTPUT_MEDIA, TERMINAL_DIR
from utils.constants.portable import CMD_JOIN, CMD_DELETE, CMD_SCRIPT_EXT

save_dir = join("[!collection!]", "[!element!]")
mkvmerge = join(TERMINAL_DIR, f"mkvmerge.{CMD_SCRIPT_EXT}")
ffmpeg = join(TERMINAL_DIR, f"ffmpeg.{CMD_SCRIPT_EXT}")
TOOL_PARAMS = {
    "BASE": f'N_m3u8DL-RE "[!manifest!]" [!keys!] --tmp-dir "[!TMP_PATH!]" --save-dir "{save_dir}" --save-name "content"',
    "VOD": '-sv best -sa best -da id=audio_div -ss all -mt --check-segments-count false --no-log',
    "LIVESTREAM": '--live-pipe-mux --live-record-limit 00:02:00',
    "OTHERS": {
        "HEADER": '--header "{key}:{value}"',
        "BASE_URL": '--base-url "{value}"',
        "KEY": {
            'PARAM': '--key {value}',
            'EXTRA': '--use-shaka-packager'
        },
        "AES": {
            "KEY": "--custom-hls-key {value}",
            "IV": "--custom-hls-iv {value}"
        },
        "MUXER": "-M format={args}",
        "VIDEO_RES": {
            "BEST": "-sv best",
            "CUSTOM": '-sv res="{width}x{height}"'
        },
        "ARGUMENT": "{value}"
    },
    "EXTRA_CMDS": f'{CMD_JOIN} "{mkvmerge}" "{save_dir}.mkv" "{save_dir}" true {CMD_JOIN} {CMD_DELETE} "[!TMP_PATH!]"',
    "PROCESS_CMDS": {
        "CONCAT": f'"{ffmpeg}" "{save_dir}.mkv" "{save_dir}" "{mkvmerge}" true'
    }
}

TOOL_PARAMS_BASIC = {
    "BASE": f'N_m3u8DL-RE "[!manifest!]" [!keys!] --save-dir "[!collection!]" --save-name "[!element!]"',
    "VOD": '',
    "LIVESTREAM": '',
    "OTHERS": TOOL_PARAMS["OTHERS"],
    "EXTRA_CMDS": "",
    "PROCESS_CMDS": {}
}

DEFAULT_CONFIG = {
    "CDM_WVD_FILE_PATH": None,
    "USER_AGENT": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
    "NUMBER_OF_THREADS": {
        "DATA_SCRAPER": 5,
        "MEDIA_DOWNLOADER": 3
    },
    "DOWNLOAD_COMMANDS": {
        "OUTPUT_MEDIA_PATH": DEFAULT_OUTPUT_MEDIA,
        "WAIT_BEFORE_DOWNLOADING": True,
        "ADDITIONAL_SUBS": True,
        "TOOL_PARAMETERS": {
            "VOD": TOOL_PARAMS["VOD"],
            "LIVESTREAM": TOOL_PARAMS["LIVESTREAM"]
        }
    },
    "SERVICE_CREDENTIALS": {},
    "WARN_EXTERNAL_TOOLS": True
}
