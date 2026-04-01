import os
from os.path import join

DEFAULT_DEBUG_MODE = False

APP_NAME = "widefrog"
APP_VERSION = "3.2.0"
APP_DIR = f"app_files"
CACHE_DIR = join(APP_DIR, "services_cache")

CONFIG_FILE = join(APP_DIR, "config.json")
for d in [APP_DIR, CACHE_DIR]:
    if not os.path.exists(d):
        os.makedirs(d)

DEFAULT_OUTPUT_MEDIA = "media"
TERMINAL_DIR = "terminal"

TMP_TOOLS_PATH = "tmp"
TMP_RAND_LEN = 7
REQUESTS_TIMEOUT = 8

DEFAULT_INPUT_FILE = join(APP_DIR, "input.txt")
DEFAULT_OUTPUT_CMD = join(APP_DIR, "cmds.txt")
DEFAULT_OUTPUT_CMD_FAIL = join(APP_DIR, "cmds_failed.txt")
CMD_BATCH_SIZE = 3

DEFAULT_WVD_PATH = "YOUR_WVD_FILE_PATH"
APP_ERROR = "[APP_ERROR]"
USER_ERROR = "[USER_ERROR]"
ERR_MSG = "{type} Failed to download: {url}. Reason: {reason}. Solution: {solution}."
INF_MSG = "[INFO] {msg}"
WARN_MSG = "[WARNING] {msg}"

EXTERNAL_TOOLS = ["N_m3u8DL-RE", "mp4decrypt", "shaka-packager", "ffmpeg", "mkvmerge"]

WIDEVINE_SCHEME_ID = "EDEF8BA9-79D6-4ACE-A3C8-27DCD51D21ED"
PLAYREADY_SCHEME_ID = "9A04F079-9840-4286-AB92-E65BE0885F95"
