import builtins
import json
from os.path import join
from urllib.parse import unquote

import requests
import xmltodict

import utils.tools.cdm as cdm_tools
from utils.constants.macros import ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, get_ext_from_url, update_url_params, rand_str, clean_url


class _35mm_online(BaseService):
    DEMO_URLS = [
        "https://35mm.online/search?page=3&search_tag.2=tag_3441&__NodeTypeAlias.2=asset%2Cseries&__productionYear.4=1972%2C2001",
        "https://35mm.online/search?page=1&searchPhrase.3=test&__NodeTypeAlias.2=asset%2Cseries&__productionYear.4=1940%2C2024",
        "https://35mm.online/vod/animacja/fobia",
        "https://35mm.online/vod/dla-dzieci/reksio/reksio/reksio-reksio-czyscioch",
        "https://35mm.online/vod/dokument/prom",
        "https://35mm.online/vod/fabula/zycie-raz-jeszcze",
        "https://35mm.online/fonoteka/muzyka/muzyka-ludowa/karnawalowa-polka",
        "https://35mm.online/vod/dla-dzieci/reksio",
        "https://35mm.online/vod/dla-dzieci/pampalini",
    ]

    CONTENT_URL = 'https://cms.35mm.online/umbraco/api/content'
    PLAYLIST_URL = 'https://cms.35mm.online/umbraco/api/products/{content_id}/videos/playlist'
    SEARCH_URL = 'https://cms.35mm.online/umbraco/api/search'
    BASE_URL = "https://35mm.online"

    PAGE_SIZE = 48
    LANGUAGE = 'pl-pl'

    @staticmethod
    def test_service():
        main_service.run_service(_35mm_online)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        return _35mm_online

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(additional["license_url"], data=challenge)
        if licence.status_code == 500:
            message = json.loads(licence.content.decode()).get("message", "").lower()
            if "error" in message:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=additional["URL"],
                    reason="Cannot download paid content",
                    solution="Do not attempt to download paid content"
                ))

        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_init_from_mpd(mpd_url):
        mpd_content = requests.get(mpd_url).content.decode()
        mpd_content = xmltodict.parse(mpd_content)["MPD"]
        base_url = mpd_content["BaseURL"]
        mpd_content = mpd_content["Period"]

        if type(mpd_content["AdaptationSet"]) is not list:
            mpd_content["AdaptationSet"] = [mpd_content["AdaptationSet"]]

        best_content = None
        best_height = None
        best_bandwidth = None
        for content in mpd_content["AdaptationSet"]:
            if content["@contentType"] != "video":
                continue
            update_content = False

            height = content.get("@maxHeight", content.get("@height", None))
            if height is None:
                continue
            height = int(height)
            bandwidth = content.get("@maxBandwidth", content.get("@bandwidth", None))

            if best_content is None:
                update_content = True
            else:
                if height > best_height:
                    update_content = True
                elif height == best_height:
                    if bandwidth is not None:
                        if best_bandwidth is None:
                            update_content = True
                        elif int(bandwidth) > int(best_bandwidth):
                            update_content = True

            if update_content:
                best_content = content
                best_height = height
                best_bandwidth = bandwidth

        mpd_content = best_content
        init_url = mpd_content["SegmentTemplate"]["@initialization"]
        if type(mpd_content["Representation"]) is not list:
            mpd_content["Representation"] = [mpd_content["Representation"]]

        best_content = None
        for content in mpd_content["Representation"]:
            if best_content is None:
                best_content = content
                continue
            if int(content["@height"]) > int(best_content["@height"]):
                best_content = content
                continue
            elif int(content["@height"]) == int(best_content["@height"]):
                if int(content["@bandwidth"]) > int(best_content["@bandwidth"]):
                    best_content = content
                    continue

        init_url = init_url.replace("$RepresentationID$", best_content["@id"])
        init_url = init_url.replace("$Bandwidth$", best_content["@bandwidth"])
        init_url = base_url + init_url
        return init_url

    @staticmethod
    def get_pssh_from_manifest(manifest):
        return cdm_tools.get_pssh_from_init(_35mm_online.get_init_from_mpd(manifest))

    @staticmethod
    def get_video_data(source_element):
        if source_element.additional is None:
            source_element.additional = {}
        if source_element.additional.get("CACHE_RESULT", None) is not None:
            return source_element.additional["CACHE_RESULT"]

        response = json.loads(requests.get(_35mm_online.CONTENT_URL, headers={
            'x-origin-url': source_element.url,
            'x-language': 'x-language'
        }).content.decode())
        content = response["content"]
        content_id = content.get("atdId", None)

        if content_id is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        if source_element.element is None:
            element_name = content.get("title", None)
            if element_name is None:
                element_name = source_element.url.split(_35mm_online.BASE_URL)[1]
            source_element.element = get_valid_filename(element_name)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                _35mm_online.__name__[1:]
            )

        response = requests.get(
            _35mm_online.PLAYLIST_URL.format(content_id=content_id),
            params={'platform': 'BROWSER', 'videoType': 'MOVIE'}
        )
        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)

        err_msg = response.get("code", "").lower()
        if status_code == 404 and "not_exists" in err_msg:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        additional = {"URL": source_element.url}
        for d in response["drm"]:
            if "widevine" not in d.lower():
                continue
            additional["license_url"] = response["drm"][d]["src"]
            break

        manifest = None
        for s in response["sources"]:
            if "dash" not in s.lower():
                continue
            manifest = response["sources"][s][0]["src"]
            if "https:" not in manifest:
                manifest = manifest.replace("//", "https://")
            break

        subtitles = []
        index = 0
        for subtitle in response.get("subtitles", []):
            index += 1
            url = subtitle["url"]
            if "https:" not in url:
                url = url.replace("//", "https://")
            srt_ext = get_ext_from_url(url)

            subtitles.append((False, BaseElement(
                url=url,
                collection=join(source_element.collection, source_element.element),
                element=f'subtitle_{index}_{subtitle["language"]}{srt_ext}'
            )))
        additional["SUBTITLES"] = subtitles

        pssh_value = _35mm_online.get_pssh_from_manifest(manifest)
        return manifest, pssh_value, additional

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.rstrip("#").rstrip("/")
        if "/vod/" in collection_url or "/fonoteka/" in collection_url:
            collection_url = clean_url(collection_url)
            response = requests.get(
                _35mm_online.CONTENT_URL,
                headers={
                    'x-origin-url': collection_url,
                    'x-language': _35mm_online.LANGUAGE
                }
            )

            response = response.content.decode()
            response = json.loads(response)
            response = response.get("content", None)
            if response in ["", None, {}]:
                return [BaseElement(url=collection_url)]

            try:
                seasons = response["seasonsModel"]["seasons"]
                assert type(seasons) is list and len(seasons) > 0
            except:
                seasons = []
            if len(seasons) == 0:
                return [BaseElement(url=collection_url)]

            try:
                check_element = BaseElement(url=collection_url)
                check_result = _35mm_online.get_video_data(check_element)
                check_element.additional = {"CACHE_RESULT": check_result}
                return [check_element]
            except CustomException as e:
                if "Reason: The content isn't available" not in str(e):
                    raise e

            collection_title = response.get("title", None)
            if collection_title in ["", None]:
                collection_title = collection_url.split("/")[-1]
            collection_title = join(
                join(
                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                    _35mm_online.__name__[1:]
                ),
                get_valid_filename(collection_title)
            )

            season_index = 0
            collection = []
            for season in seasons:
                season_index += 1
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                season_title = season.get("title", "")
                season_title = get_valid_filename(f'Rail {season_index} {season_title}')
                episode_index = 0

                for episode in season.get("episodes", []):
                    episode_index += 1
                    check = check_range(False, season_index, episode_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    episode_title = episode.get("title", "")
                    episode_title = get_valid_filename(f'Episode_{episode_index} {episode_title}')
                    episode_url = _35mm_online.BASE_URL + episode["url"]

                    collection.append(BaseElement(
                        url=episode_url,
                        collection=join(collection_title, season_title),
                        element=get_valid_filename(episode_title)
                    ))

            return collection

        if "/search?" in collection_url:
            collection_title = unquote(collection_url).split("?")[1]
            collection_title = get_valid_filename(collection_title)
            collection_title = "Filters_" + collection_title[0:40] + "_" + rand_str(5)
            collection_title = join(join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                _35mm_online.__name__[1:]), collection_title
            )

            collection = []
            param_url = collection_url
            page = 0

            while True:
                page += 1
                check = check_range(True, page, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                param_url = update_url_params(param_url, {
                    "page": page, "limit": _35mm_online.PAGE_SIZE
                })
                page_url = _35mm_online.SEARCH_URL + "?" + param_url.split("?")[1]
                page_url = unquote(page_url)

                response = json.loads(requests.get(
                    page_url, headers={
                        'x-origin-url': collection_url,
                        'x-language': _35mm_online.LANGUAGE
                    }
                ).content.decode())
                if len(response.get("records", [])) == 0:
                    break

                record_index = 0
                for record in response["records"]:
                    record_index += 1
                    check = check_range(False, page, record_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    record_url = record["url"]
                    record_title = get_valid_filename(record["title"])

                    if not record_url.startswith(_35mm_online.BASE_URL):
                        record_url = _35mm_online.BASE_URL + record_url

                    collection.append(BaseElement(
                        url=record_url,
                        collection=join(collection_title, f'Page_{page}'),
                        element=f"Video_{record_index}_{record_title}"
                    ))

            return collection
        return None
