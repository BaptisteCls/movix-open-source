import builtins
import concurrent
import os
import platform
import re
import subprocess
from concurrent.futures import ThreadPoolExecutor
from os.path import join

import requests

import utils.tools.common as common_tools
import utils.tools.service as service_tools
from utils.constants.macros import INF_MSG, ERR_MSG, USER_ERROR, APP_ERROR, CMD_BATCH_SIZE, WARN_MSG, \
    DEFAULT_OUTPUT_CMD, DEFAULT_OUTPUT_CMD_FAIL, TMP_TOOLS_PATH, APP_VERSION
from utils.constants.portable import TERMINAL_CLOSE, CMD_JOIN_ADJUST, CMD_JOIN, TERMINAL_LAUNCH, CURRENT_OS, \
    CURRENT_ARCHITECTURE
from utils.structs import CustomException, BaseElement
from utils.tools.cdm import init_cdm, close_cdm


class main_service:
    CURRENT_TASK = 0
    TOTAL_TASKS = 0

    @staticmethod
    def update_task(incr=1):
        main_service.CURRENT_TASK += incr
        print(INF_MSG.format(
            msg=f"Current progress: [{main_service.CURRENT_TASK}/{main_service.TOTAL_TASKS}]")
        )

    @staticmethod
    def save_subtitles(subtitles):
        for is_manifest, subtitle in subtitles:
            if not is_manifest:
                if not os.path.exists(subtitle.collection):
                    os.makedirs(subtitle.collection)

                response = requests.get(subtitle.url)
                if response.status_code == 200:
                    with open(join(subtitle.collection, subtitle.element), 'wb') as file:
                        file.write(response.content)

    @staticmethod
    def get_keys(service, pssh, additional):
        cdm, cdm_session_id, challenge = init_cdm(pssh)
        if cdm is None:
            return []

        return close_cdm(
            cdm, cdm_session_id,
            service.get_keys(challenge, additional.get(pssh, additional))
        )

    @staticmethod
    def get_download_command(service, source_element):
        wait_flag = builtins.CONFIG["DOWNLOAD_COMMANDS"].get("WAIT_BEFORE_DOWNLOADING", None)
        is_basic = builtins.CONFIG.get("BASIC", False) is True
        use_adjust = False

        try:
            manifest, pssh, additional = service.get_video_data(source_element)
            if type(manifest) is not list:
                manifest = [(manifest, None)]
            if len(manifest) == 0:
                manifest = [(None, None)]
            if type(pssh) is not list:
                pssh = [pssh]
            if len(pssh) == 0:
                pssh = [None]

            if len([m for m in manifest if m[0] not in [None, ""]]) == 0:
                raise Exception("No manifest found")

            if wait_flag is not None and builtins.CONFIG["NUMBER_OF_THREADS"]["MEDIA_DOWNLOADER"] > 1:
                use_adjust = True
                temp_manifest = []
                for m in manifest:
                    temp_manifest.append((m[0].replace(CMD_JOIN, CMD_JOIN_ADJUST), m[1]))
                manifest = temp_manifest
        except CustomException as e:
            if builtins.CONFIG["DEBUG_MODE"]:
                raise e
            print(str(e))
            return None, None
        except Exception as e:
            if builtins.CONFIG["DEBUG_MODE"]:
                raise e
            print(ERR_MSG.format(
                type=f'{USER_ERROR}/{APP_ERROR}',
                url=source_element.url,
                reason="Failed to extract content data",
                solution=f"Make sure you can play the content. If you can, then debug the {service.__name__} service"
            ))
            return None, None

        is_hls_aes = additional.get("AES", None) is not None
        keys = []

        if not is_hls_aes:
            try:
                keys = []
                for p in pssh:
                    if p is None:
                        continue
                    keys += main_service.get_keys(service, p, additional)
                keys = list(set(keys))
            except CustomException as e:
                if builtins.CONFIG["DEBUG_MODE"]:
                    raise e
                print(str(e))
                return None, None
            except Exception as e:
                if builtins.CONFIG["DEBUG_MODE"]:
                    raise e
                print(ERR_MSG.format(
                    type=f'{USER_ERROR}/{APP_ERROR}',
                    url=source_element.url,
                    reason="Something went wrong with the license call",
                    solution=f"Make sure you can play the content and/or change your VPN IP. Additionally, wait a few minutes and/or replace your CDM with a fresh one. If the issue persists, then debug the {service.__name__} service"
                ))
                return None, None

        if builtins.CONFIG["DOWNLOAD_COMMANDS"].get("ADDITIONAL_SUBS", True) is True:
            main_service.save_subtitles(additional.get("SUBTITLES", []))

        if not is_hls_aes and len(keys) == 0 and len([p for p in pssh if p is not None]) > 0:
            print(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Need emulated L3 CDM (in WVD format)",
                solution=f"Search and read the forum"
            ))
            return None, None

        dwn_cmds = []
        for manifest_url, manifest_name in manifest:
            if manifest_name not in ["", None]:
                element_path = manifest_name
                collection_path = join(source_element.collection, source_element.element)
            else:
                element_path = source_element.element
                collection_path = source_element.collection

            template_cmd = None
            is_livestream = False
            try:
                template_cmd = builtins.CONFIG["DOWNLOAD_COMMANDS"]["TOOL_PARAMETERS"]
                dwn_cmd = template_cmd["BASE"]
                dwn_cmd += " " + common_tools.adjust_parameters(use_adjust, template_cmd["VOD"])

                is_livestream = service.is_content_livestream(source_element.url, additional)
                if is_livestream:
                    dwn_cmd += " " + common_tools.adjust_parameters(use_adjust, template_cmd["LIVESTREAM"])

                if not is_hls_aes and (wait_flag is not None or is_basic):
                    if template_cmd["OTHERS"].get("VIDEO_RES", None) is not None:
                        if template_cmd["OTHERS"]["VIDEO_RES"]["BEST"] in dwn_cmd or is_basic:
                            if keys is not None and len(keys) > 0:
                                try:
                                    best_res = service.get_best_decryptable_video(manifest_url, keys)
                                except Exception as e:
                                    if builtins.CONFIG["DEBUG_MODE"]:
                                        raise e
                                    print(ERR_MSG.format(
                                        type=APP_ERROR,
                                        url=source_element.url,
                                        reason=f"Failed to get the best decryptable video resolution for manifest: {manifest_url} and keys: {str(keys)}",
                                        solution=f"Debug the {service.__name__} service"
                                    ))
                                    return None, None

                                if best_res is not None:
                                    if is_basic:
                                        dwn_cmd += " " + template_cmd["OTHERS"]["VIDEO_RES"]["CUSTOM"].format(
                                            width=str(best_res[0]), height=str(best_res[1])
                                        )
                                    else:
                                        dwn_cmd = dwn_cmd.replace(
                                            template_cmd["OTHERS"]["VIDEO_RES"]["BEST"],
                                            template_cmd["OTHERS"]["VIDEO_RES"]["CUSTOM"].format(
                                                width=str(best_res[0]), height=str(best_res[1])
                                            )
                                        )

                dwn_cmd += " " + " ".join([
                    lmb(template_cmd['OTHERS'][name])
                    for (name, lmb) in service.get_additional_params(additional)
                ])
                dwn_cmd += " " + template_cmd["EXTRA_CMDS"]
            except Exception as e:
                if builtins.CONFIG["DEBUG_MODE"]:
                    raise e
                dwn_cmd = ""

            if dwn_cmd is None or len(dwn_cmd.strip()) == 0:
                print(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason="Need download tool parameters to be well defined",
                    solution=f"Define them"
                ))
                return None, None

            dwn_cmd = dwn_cmd.replace("[!manifest!]", manifest_url)
            if not is_hls_aes:
                use_shaka = len(keys) > 0 and is_livestream and additional.get("USE_SHAKA", True) is True
                if len(keys) > 0 and additional.get("FORCE_SHAKA", False) is True:
                    use_shaka = True

                dwn_cmd = dwn_cmd.replace("[!keys!]", " ".join([
                    template_cmd["OTHERS"]["KEY"]["PARAM"].format(value=k)
                    for k in keys
                ]) + (f' {template_cmd["OTHERS"]["KEY"]["EXTRA"]}' if use_shaka else ""))
            else:
                aes_params = []
                for param in ["KEY", "IV"]:
                    if additional["AES"].get(param, None) is not None:
                        aes_params.append(template_cmd["OTHERS"]["AES"][param].format(
                            value=additional["AES"][param]
                        ))
                dwn_cmd = dwn_cmd.replace("[!keys!]", " ".join(aes_params))

            dwn_cmd = dwn_cmd.replace("[!collection!]", collection_path)
            dwn_cmd = dwn_cmd.replace("[!element!]", element_path)
            dwn_cmd = dwn_cmd.replace("[!TMP_PATH!]", join(
                join(str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]), TMP_TOOLS_PATH),
                common_tools.rand_str()
            ))

            if wait_flag is None:
                dwn_cmd = re.sub(r'\s+', ' ', dwn_cmd)
            dwn_cmds.append(dwn_cmd)

        proc_cmds = []
        if len(dwn_cmds) > 1:
            try:
                proc_cmd = builtins.CONFIG["DOWNLOAD_COMMANDS"]["TOOL_PARAMETERS"]
                proc_cmd = proc_cmd["PROCESS_CMDS"].get("CONCAT", "")
                proc_cmd = proc_cmd.replace("[!collection!]", source_element.collection)
                proc_cmd = proc_cmd.replace("[!element!]", source_element.element)
                proc_cmds.append(proc_cmd)
            except Exception as e:
                if builtins.CONFIG["DEBUG_MODE"]:
                    raise e
        return dwn_cmds, proc_cmds

    @staticmethod
    def get_download_commands(source_elements):
        download_commands = []
        process_commands = []
        failures = []

        for source_element in source_elements:
            if not common_tools.is_http_url(source_element.url):
                download_commands.append(source_element.url)
                continue

            failures.append(source_element.url)
            service = service_tools.get_service(source_element.url)
            if service is None:
                continue

            try:
                dl_cmds, pr_cmds = main_service.get_download_command(service, source_element)
                if type(dl_cmds) is not list:
                    dl_cmds = [dl_cmds]
                if len([dw for dw in dl_cmds if dw not in ["", None]]) == 0:
                    continue
                if type(pr_cmds) is not list:
                    pr_cmds = [pr_cmds]
                pr_cmds = [prc for prc in pr_cmds if prc not in ["", None]]

                download_commands.extend(dl_cmds)
                failures.pop()
                process_commands.extend(pr_cmds)
                main_service.update_task()
            except Exception as e:
                if builtins.CONFIG["DEBUG_MODE"]:
                    raise e
                print(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason="Failed to extract content data",
                    solution=f"Debug the {service.__name__} service"
                ))
        return download_commands, failures, process_commands

    @staticmethod
    def get_collections_elements(collection_urls):
        collections_elements = []
        failures = []

        for collection_url in collection_urls:
            if not common_tools.is_http_url(collection_url):
                collections_elements.append(BaseElement(url=collection_url))
                continue

            failures.append(collection_url)
            service = service_tools.get_service(collection_url)
            if service is None:
                continue

            try:
                collection = service.get_collection_elements(collection_url)
                if collection is None:
                    print(ERR_MSG.format(
                        type=USER_ERROR,
                        url=collection_url,
                        reason="URL not supported",
                        solution=f"Extend the {service.__name__} service"
                    ))
                    continue

                collections_elements.append(collection)
                failures.pop()
                main_service.update_task()
            except CustomException as e:
                if builtins.CONFIG["DEBUG_MODE"]:
                    raise e
                print(str(e))
                continue
            except Exception as e:
                if builtins.CONFIG["DEBUG_MODE"]:
                    raise e
                print(ERR_MSG.format(
                    type=APP_ERROR,
                    url=collection_url,
                    reason="Failed to extract collection data",
                    solution=f"Debug the {service.__name__} service"
                ))
                continue
        return collections_elements, failures, []

    @staticmethod
    def initialize_services(source_urls):
        print(INF_MSG.format(msg="Starting the service initialization stage."))
        main_service.CURRENT_TASK = 0
        failures = []

        sites = []
        for source_url in source_urls:
            site = common_tools.get_base_url(source_url)
            if site not in sites:
                sites.append(site)
        main_service.TOTAL_TASKS = len(sites)

        valid_urls = []
        bad_urls = []
        for source_url in source_urls:
            if not common_tools.is_http_url(source_url):
                valid_urls.append(source_url)
                continue

            failures.append(source_url)
            site = common_tools.get_base_url(source_url)
            if site in bad_urls:
                continue

            if service_tools.get_service(source_url) is not None:
                valid_urls.append(source_url)
                failures.pop()
            else:
                bad_urls.append(site)

            if site in sites:
                sites.remove(site)
                main_service.update_task()
        return valid_urls, failures

    @staticmethod
    def get_download_commands_parallel(source_urls):
        source_urls, failures = main_service.initialize_services(source_urls)
        proc_commands = []

        lst = source_urls
        for job in [main_service.get_collections_elements, main_service.get_download_commands]:
            main_service.CURRENT_TASK = 0
            main_service.TOTAL_TASKS = len(lst)
            if job == main_service.get_collections_elements:
                print(INF_MSG.format(msg="Starting the collections extraction stage."))
            else:
                print(INF_MSG.format(msg="Starting the media data extraction stage."))

            nr_workers = builtins.CONFIG["NUMBER_OF_THREADS"]["DATA_SCRAPER"]
            chunks = common_tools.split_list_chunks(lst, nr_workers)
            with concurrent.futures.ThreadPoolExecutor(max_workers=nr_workers) as executor:
                futures = [executor.submit(job, batch) for batch in chunks]
                for _ in concurrent.futures.as_completed(futures):
                    pass

            results = ([], [], [])
            for future in futures:
                success, fail, proc = future.result()
                results[0].extend(success)
                results[1].extend(fail)
                results[2].extend(proc)

            lst = common_tools.flatten_list(results[0])
            failures.extend(results[1])
            proc_commands.extend(results[2])
        return results[0], failures, proc_commands

    @staticmethod
    def run_commands(commands, multiple_terminals):
        for i in range(0, len(commands), CMD_BATCH_SIZE):
            batch = commands[i:i + CMD_BATCH_SIZE]

            if multiple_terminals:
                command = f" {CMD_JOIN} ".join(batch + [TERMINAL_CLOSE])
                TERMINAL_LAUNCH(command)
                main_service.update_task(len(batch))

            else:
                for command in batch:
                    subprocess.run(command, shell=True)
                    main_service.update_task()

    @staticmethod
    def run_commands_parallel(commands):
        main_service.CURRENT_TASK = 0
        main_service.TOTAL_TASKS = len(commands)
        nr_workers = builtins.CONFIG["NUMBER_OF_THREADS"]["MEDIA_DOWNLOADER"]
        if nr_workers == 1:
            main_service.run_commands(commands, False)
            return

        chunks = common_tools.split_list_chunks(commands, nr_workers)
        with concurrent.futures.ThreadPoolExecutor(max_workers=nr_workers) as executor:
            futures = [executor.submit(main_service.run_commands, batch, True) for batch in chunks]
            for _ in concurrent.futures.as_completed(futures):
                pass

    @staticmethod
    def run_service(demo_urls):
        print(INF_MSG.format(msg=f"Current app version: {APP_VERSION}"))
        print(INF_MSG.format(msg=f"Running on: {CURRENT_OS}/{CURRENT_ARCHITECTURE}/python {platform.python_version()}"))
        if type(demo_urls) is not list:
            demo_urls = demo_urls.DEMO_URLS

        dwn_cmds, failed_cmds, proc_cmds = main_service.get_download_commands_parallel(demo_urls)
        print(INF_MSG.format(msg="Finished generating the download commands."))

        common_tools.list_to_file(DEFAULT_OUTPUT_CMD_FAIL, failed_cmds)
        if len(failed_cmds) > 0:
            print(WARN_MSG.format(
                msg=f'Saved the failed URLs to {DEFAULT_OUTPUT_CMD_FAIL}'
            ))
        if dwn_cmds is None or len(dwn_cmds) == 0:
            print(WARN_MSG.format(msg="No download commands have been generated."))
            return

        common_tools.list_to_file(DEFAULT_OUTPUT_CMD, dwn_cmds)
        print(INF_MSG.format(
            msg=f'Saved the generated download commands to {DEFAULT_OUTPUT_CMD}'
        ))

        wait_flag = builtins.CONFIG["DOWNLOAD_COMMANDS"].get("WAIT_BEFORE_DOWNLOADING", None)
        if wait_flag is None:
            print(INF_MSG.format(msg="Skipping the downloading stage."))
            if len(proc_cmds) > 0:
                print(INF_MSG.format(msg="Skipping the processing stage."))
            return

        if wait_flag is True:
            while True:
                answer = input(INF_MSG.format(
                    msg=f"If you used a VPN, turn it off to avoid wasting data "
                        f"for the downloading stage. Also you may edit the {DEFAULT_OUTPUT_CMD} "
                        f"file if necessary. Type yes when ready: "
                ))
                if answer is None:
                    continue

                answer = answer.lower().strip()
                answer = re.sub(r"\s+", "", answer)
                for c in "yes":
                    answer = re.sub(fr"{c}+", c, answer)

                if len(answer) == 0:
                    continue

                if answer != "yes":
                    print(INF_MSG.format(msg="Cancelling the downloading stage."))
                    return
                break

        dwn_cmds = common_tools.file_to_list(DEFAULT_OUTPUT_CMD)
        if dwn_cmds is None or len(dwn_cmds) == 0:
            print(WARN_MSG.format(msg="No download commands have been found."))
            return

        print(INF_MSG.format(msg="Starting the downloading stage."))
        main_service.run_commands_parallel(dwn_cmds)
        print(INF_MSG.format(msg="SUCCESS! Finished downloading."))

        if len(proc_cmds) > 0:
            print(INF_MSG.format(msg="Starting the processing stage."))
            main_service.run_commands_parallel(proc_cmds)
            print(INF_MSG.format(msg="SUCCESS! Finished processing."))
