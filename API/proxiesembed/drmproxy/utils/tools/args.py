import builtins
import json
import os
import re
import shutil

import browser_cookie3

from utils.constants.configuration import TOOL_PARAMS, TOOL_PARAMS_BASIC, DEFAULT_CONFIG
from utils.constants.macros import APP_NAME, DEFAULT_INPUT_FILE, WARN_MSG, CONFIG_FILE, EXTERNAL_TOOLS, TERMINAL_DIR, \
    INF_MSG, DEFAULT_WVD_PATH, APP_VERSION
from utils.constants.portable import IS_SUPPORTED_SYSTEM, CURRENT_OS, SUPPORTED_OS, SUPPORTED_ARCHITECTURES, \
    CURRENT_ARCHITECTURE, \
    EnvironmentConstants, IS_SUPPORTED_OS, CMD_SCRIPT_EXT, IS_FILE_EXECUTABLE
from utils.tools.cdm import search_cdm_wvd
from utils.tools.common import file_to_list, dict_to_file, is_http_url
from utils.tools.service import get_all_services, get_all_services_classes


def check_query_args(args):
    try:
        # raise
        query_str = []
        for a in args:
            if "--query=" in a:
                query_str = a.split("=")[1].split(":")
                break
    except:
        return {
            "MIN": {"COLLECTION": None, "ELEMENT": None},
            "MAX": {"COLLECTION": None, "ELEMENT": None}
        }

    query = {}
    for m in [(0, "MIN"), (2, "MAX")]:
        query[m[1]] = {}
        for i in [(0, "COLLECTION"), (1, "ELEMENT")]:
            try:
                query[m[1]][i[1]] = float(query_str[m[0] + i[0]])
            except:
                query[m[1]][i[1]] = None

    if 1 <= len(query_str) <= 2:
        query["MAX"]["COLLECTION"] = query["MIN"]["COLLECTION"]
    if len(query_str) == 2:
        query["MAX"]["ELEMENT"] = query["MIN"]["ELEMENT"]
    return query


def check_help_args(args):
    if "--help" in args:
        return (
            "--help\nShows help\n\n"
            "--usage\nShows usage examples\n\n"
            "--config\nExplains the config properties.\n\n"
            "--version\nDisplays the current app version.\n\n"
            "--services\nDisplays all available services\n\n"
            "--format=SERVICE_NAME\nDisplays example URLs for a service\n\n"
            "--query=collection1_index:element1_index:collection2_index:element2_index\nDownloads only an interval from a content collection\n\n"
            "--debug\nDisplays the exact error and where it happened so you can properly debug the app\n\n"
            "--basic\nNo downloads are launched and only basic shareable commands are generated (*won't work for all services because of URL parameters)\n\n"
            "--fresh\nDeletes the cache and gets new information for relevant services\n\n"
            f"Make sure you edit the {CONFIG_FILE} file according to your needs."
        )

    if "--config" in args:
        return (
            "Config properties:\n"
            "CDM_WVD_FILE_PATH: the path to your local cdm in wvd format (can be set as relative or absolute)\n"
            "USER_AGENT: the user agent of your browser (some services need a real user agent)\n"
            "NUMBER_OF_THREADS: the properties related to the number of threads used by the program\n"
            "\tDATA_SCRAPER: during the data scraping stage (for high values, some services will temporarily block you)\n"
            "\tMEDIA_DOWNLOADER: during the download stage (the number of terminals that will be opened)\n\n"

            "DOWNLOAD_COMMANDS: the properties related to the downloading stage\n"
            "\tOUTPUT_MEDIA_PATH: the path to your media download directory (can be set as relative or absolute)\n"
            "\tWAIT_BEFORE_DOWNLOADING: boolean flag that is used to pause between the data scraping and the downloading stages "
            "(if set to null then the downloading stage is skipped and only basic unshareable commands are generated). It "
            "is recommended to be set to true if using a VPN or if you want to edit the generated commands\n"
            "\tADDITIONAL_SUBS: boolean flag that is used to download subtitles that aren't part of the manifest\n"
            "\tTOOL_PARAMETERS: additional parameters for N_m3u8DL-RE\n"
            "\t\tVOD: parameters used for all types of content (vod/livestream)\n"
            "\t\tLIVESTREAM: parameters used only for livestreams\n\n"

            "SERVICE_CREDENTIALS: the credentials used by the services\n"
            "\tOPTIONAL: the service uses credentials but those are optional (some content won't be downloaded however)\n"
            "\tFIREFOX_COOKIES: the service uses existing cookies provided by Firefox\n\n"

            "WARN_EXTERNAL_TOOLS: boolean flag that is used to warn the user if any external tools are not properly installed. It "
            "is recommended to be left as it is and to be not changed manually"
        )

    if "--usage" in args:
        return (
            "Usage examples:\n"
            f'python {APP_NAME}.py "CONTENT_URL"\n'
            "Downloads from URL.\n\n"
            f'python {APP_NAME}.py "LOCAL_FILE_PATH"\n'
            "Downloads from a local file that contains a list of URLs. Each URL is on a newline.\n\n"
            f'python {APP_NAME}.py "CONTENT" --query=1:2:3:4\n'
            "Downloads the content found in the interval, collection 1, element 2, collection 3, element 4.\n\n"
            f'python {APP_NAME}.py "CONTENT" --query=1:2::\n'
            "Downloads the content starting from collection 1 element 2.\n\n"
            f'python {APP_NAME}.py "CONTENT" --query=::3:4\n'
            "Downloads the content up to collection 3, element 4.\n\n"
            f'python {APP_NAME}.py "CONTENT" --query=1:2\n'
            "Downloads the content collection 1, element 2 only.\n\n"
            f'python {APP_NAME}.py "CONTENT" --query=1\n'
            "Downloads the content collection 1 only.\n\n"
            f'python {APP_NAME}.py "CONTENT" --query=:2::4\n'
            "Downloads the content found in the interval, element 2, element 4 (useful when the collection isn't ordered).\n\n"
            f'python {APP_NAME}.py "CONTENT" --query=1::3:\n'
            "Downloads the content found in the interval, collection 1, collection 3.\n\n"
            f'python {APP_NAME}.py --format=aloula.sa\n'
            "Displays example URLs for the aloula.sa service.\n\n"
            f'python {APP_NAME}.py --format=all\n'
            "Displays example URLs for all services.\n\n"
        )

    if "--version" in args:
        return f"Current app version: {APP_VERSION}"

    if "--services" in args:
        all_services = list(get_all_services().keys())
        all_services = sorted(all_services)
        return (
                "Available services:\n" + "\n".join(all_services) + "\n\n" +
                "Number of available services: " + str(len(all_services))
        )

    try:
        for a in args:
            if "--format=" in a:
                service = a.split("=")[1]
                if service == "all":
                    message = ""
                    for s in get_all_services_classes():
                        service_name = s.__name__.replace('_', '.')
                        if service_name.startswith("."):
                            service_name = service_name[1:]

                        message += (
                                f"Allowed format for {service_name}:\n" +
                                "\n".join(s.DEMO_URLS) + "\n\n"
                        )
                    return message

                return "Allowed format:\n" + "\n".join(get_all_services()[service].DEMO_URLS)
    except:
        return "The requested service is not available"
    return None


def check_input_args(args):
    try:
        for a in args:
            if a.startswith("--"):
                continue
            if is_http_url(a):
                return [a]
            return file_to_list(a)
        return file_to_list(DEFAULT_INPUT_FILE)
    except:
        return []


def check_tool_args(tool_args):
    try:
        bad_args = re.findall(r'--\S+', tool_args["BASE"]) + [
            "-M ", "--mux-after-done", "--append-url-params"
        ]
        for arg in bad_args:
            if arg in tool_args["VOD"] or arg in tool_args["LIVESTREAM"]:
                return bad_args
    except:
        pass
    return []


def check_config_basic(config, arguments):
    if not IS_SUPPORTED_SYSTEM or "--basic" in arguments:
        if "--basic" in arguments:
            config["BASIC"] = True
        elif not IS_SUPPORTED_OS:
            detected_os = CURRENT_OS
            if 'ANDROID_ARGUMENT' in os.environ:
                detected_os = 'Android'

            print(WARN_MSG.format(
                msg=f"OS is not supported for launching the download commands. "
                    f"Detected OS: {detected_os}. "
                    f"Allowed OS: {SUPPORTED_OS}."
            ))
        elif CURRENT_ARCHITECTURE not in SUPPORTED_ARCHITECTURES:
            print(WARN_MSG.format(
                msg=f"OS architecture is not supported for launching the download commands. "
                    f"Detected architecture: {CURRENT_ARCHITECTURE}. "
                    f"Allowed architectures: {SUPPORTED_ARCHITECTURES}."
            ))

        config["DOWNLOAD_COMMANDS"]["WAIT_BEFORE_DOWNLOADING"] = None

    elif not EnvironmentConstants.IS_SUPPORTED:
        if config["NUMBER_OF_THREADS"]["MEDIA_DOWNLOADER"] != 1:
            config["NUMBER_OF_THREADS"]["MEDIA_DOWNLOADER"] = 1

            print(WARN_MSG.format(
                msg=f"Environment is not supported for launching multiple terminal windows. "
                    f"{EnvironmentConstants.ERROR_MESSAGE} "
                    f"Lowering the number of threads for MEDIA_DOWNLOADER to 1..."
            ))
            dict_to_file(CONFIG_FILE, config)

    if config["NUMBER_OF_THREADS"]["MEDIA_DOWNLOADER"] > 1:
        if len(EnvironmentConstants.INFO_MESSAGE) > 0:
            print(INF_MSG.format(msg=EnvironmentConstants.INFO_MESSAGE))

    if config["DOWNLOAD_COMMANDS"].get("WAIT_BEFORE_DOWNLOADING", None) is None:
        config["DOWNLOAD_COMMANDS"]["TOOL_PARAMETERS"] = TOOL_PARAMS_BASIC
    else:
        if config["WARN_EXTERNAL_TOOLS"] is True:
            config["WARN_EXTERNAL_TOOLS"] = not check_external_tools(config)
            if not config["WARN_EXTERNAL_TOOLS"]:
                dict_to_file(CONFIG_FILE, config)

        config["DOWNLOAD_COMMANDS"]["TOOL_PARAMETERS"] = TOOL_PARAMS
    return config


def get_config(arguments):
    try:
        file_opened = False
        with open(CONFIG_FILE, 'r') as json_file:
            file_opened = True
            config = json.load(json_file)

        for k in ["VOD", "LIVESTREAM"]:
            v = config["DOWNLOAD_COMMANDS"]["TOOL_PARAMETERS"][k]
            assert type(v) is str
            TOOL_PARAMS[k] = v

        assert type(config["CDM_WVD_FILE_PATH"]) is str
        assert type(config["USER_AGENT"]) is str
        assert type(config["NUMBER_OF_THREADS"]["DATA_SCRAPER"]) is int
        assert type(config["NUMBER_OF_THREADS"]["MEDIA_DOWNLOADER"]) is int
        assert type(config["WARN_EXTERNAL_TOOLS"]) is bool
        assert type(config["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]) is str

        config = check_config_basic(config, arguments)
        return config
    except Exception as e:
        if file_opened:
            print(WARN_MSG.format(
                msg=f"Failed to load {CONFIG_FILE}. Reason (not a valid JSON file): {str(e)}. Resetting file..."
            ))

    DEFAULT_CONFIG["CDM_WVD_FILE_PATH"] = search_cdm_wvd()
    config = DEFAULT_CONFIG

    for py_file in get_all_services_classes():
        credentials = getattr(py_file, "credentials_needed")()
        if credentials.get("NONE_NEEDED", False) is True:
            continue

        name = py_file.__name__.replace("_", ".")
        if name[0] == ".":
            name = name[1:]
        config["SERVICE_CREDENTIALS"][name] = credentials

    dict_to_file(CONFIG_FILE, config)
    config = check_config_basic(config, arguments)
    return config


def check_range(is_collection, collection_index, element_index, is_asc=True):
    config_query = builtins.CONFIG["QUERY"]

    if is_collection:
        if type(config_query["MIN"]["COLLECTION"]) in [int, float]:
            if collection_index < config_query["MIN"]["COLLECTION"]:
                return is_asc
        if type(config_query["MAX"]["COLLECTION"]) in [int, float]:
            if collection_index > config_query["MAX"]["COLLECTION"]:
                return not is_asc
    else:
        if collection_index is not None:
            if type(config_query["MIN"]["COLLECTION"]) in [int, float]:
                if type(config_query["MIN"]["ELEMENT"]) in [int, float]:
                    if config_query["MIN"]["COLLECTION"] == collection_index:
                        if element_index < config_query["MIN"]["ELEMENT"]:
                            return is_asc
            if type(config_query["MAX"]["COLLECTION"]) in [int, float]:
                if type(config_query["MAX"]["ELEMENT"]) in [int, float]:
                    if config_query["MAX"]["COLLECTION"] == collection_index:
                        if element_index > config_query["MAX"]["ELEMENT"]:
                            return not is_asc
        else:
            if type(config_query["MIN"]["ELEMENT"]) in [int, float]:
                if element_index < config_query["MIN"]["ELEMENT"]:
                    return is_asc
            if type(config_query["MAX"]["ELEMENT"]) in [int, float]:
                if element_index > config_query["MAX"]["ELEMENT"]:
                    return not is_asc
    return None


def check_external_tools(config):
    try:
        for tool in EXTERNAL_TOOLS:
            tool_path = shutil.which(tool)

            if tool_path is None:
                print(WARN_MSG.format(
                    msg=f"External tool is not installed: {tool}. "
                        f"Download commands may not be launched properly."
                ))
                return False
            if not IS_FILE_EXECUTABLE(tool_path):
                print(WARN_MSG.format(
                    msg=f"External tool can't be executed: {tool}. Insufficient privileges. "
                        f"Download commands may not be launched properly."
                ))
                return False

        ext = CMD_SCRIPT_EXT
        if not ext.startswith('.'):
            ext = '.' + ext

        try:
            scripts = [script for script in [
                os.path.join(TERMINAL_DIR, script) for script in os.listdir(TERMINAL_DIR)
            ] if os.path.isfile(script) and script.endswith(ext)]
        except FileNotFoundError:
            print(WARN_MSG.format(
                msg=f"The folder {TERMINAL_DIR} is missing. "
                    f"Download commands won't be launched properly."
            ))
            return False

        if len(scripts) == 0:
            print(WARN_MSG.format(
                msg=f"The folder {TERMINAL_DIR} doesn't contain the necessary scripts. "
                    f"Download commands won't be launched properly."
            ))
            return False

        for script in scripts:
            if not IS_FILE_EXECUTABLE(script):
                print(WARN_MSG.format(
                    msg=f"Terminal script can't be executed: {script}. Insufficient privileges. "
                        f"Download commands won't be launched properly."
                ))
                return False

        try:
            if config["CDM_WVD_FILE_PATH"] in [DEFAULT_WVD_PATH, ""]:
                raise FileNotFoundError

            with open(config["CDM_WVD_FILE_PATH"], 'r') as _:
                pass
        except FileNotFoundError:
            print(WARN_MSG.format(
                msg=f"The CDM WVD file path is not configured correctly. "
                    f"Services that require a CDM won't work."
            ))
            return False

        try:
            browser_cookie3.firefox(domain_name='')
        except browser_cookie3.BrowserCookieError:
            print(WARN_MSG.format(
                msg=f"Firefox browser is not installed. "
                    f"Services that require browser cookies won't work as intended."
            ))
            return False
        return True

    except Exception as e:
        print(WARN_MSG.format(
            msg=f"Can't check if the external tools are installed. Reason: {str(e)}. "
                f"Download commands may not be launched properly."
        ))
        return False
