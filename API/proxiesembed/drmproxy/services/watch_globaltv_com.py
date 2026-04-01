import base64
import builtins
import json
import re
from os.path import join

import requests
import xmltodict

import utils.tools.cdm as cdm_tools
from utils.constants.macros import ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, get_ext_from_url


class watch_globaltv_com(BaseService):
    DEMO_URLS = [
        "https://watch.globaltv.com/series/f7a04c78-c1ff-11ee-ac50-0242ac110005/collection/4f809a02-caa1-11ee-abe3-0242ac110004/",
        "https://watch.globaltv.com/series/411617347723/collection/650085443998/",
        "https://watch.globaltv.com/series/820ad6e2-b6fe-11ee-bea3-0242ac110003/collection/1440eb0a-b6ff-11ee-8cba-0242ac110005/",
        "https://watch.globaltv.com/series/32666602/collection/1054443075512/",
        "https://watch.globaltv.com/series/a0bc9542-4e3d-11ed-9b84-0242ac110005/collection/0d98f950-4fae-11ed-a560-0242ac110002/",
        "https://watch.globaltv.com/video/1467928131832",
        "https://watch.globaltv.com/video/f3c5743c-c13e-11ee-8217-0242ac110002",
        "https://watch.globaltv.com/video/23f22e48-5499-11ed-98d3-0242ac110004",
        "https://watch.globaltv.com/movie/LIFE0056486710000000",
        "https://watch.globaltv.com/movie/WNET0056532040000500",
        "https://watch.globaltv.com/movie/LIFE0055278970000000",
        "https://watch.globaltv.com/series/32666562/episode/GLOB0053686160000000",
        "https://watch.globaltv.com/series/852506179691/episode/HGTV0054879080000000",
        "https://watch.globaltv.com/series/759427139648/episode/HGTV0055596150000100",
        "https://watch.globaltv.com/channel/215422c9-d1b9-4009-aaca-32e403f22b01",
        "https://watch.globaltv.com/channel/6bfb7f13-9d9d-4211-9c50-fb56330e4ccd",
        "https://watch.globaltv.com/channel/8970c668-40cd-4ca9-8c4d-25fd04f619b5",
    ]

    SIGN_URL = 'https://global.corusappservices.com/authorization/untrusted/sign'
    AUTHENTICATE_URL = 'https://global.corusappservices.com/authentication/authenticate'
    AUTHORIZE_RESOURCE_URL = 'https://global.corusappservices.com/authorization/authorizeresource'
    GET_STREAM_URL = 'https://global.corusappservices.com/media/getstream'
    CONTAINER_URL = 'https://globalcontent.corusappservices.com/api/container/v1/'
    BASE_URL = "https://watch.globaltv.com/"
    VIDEO_URL = BASE_URL + 'video/{guid}'
    EPISODE_URL = BASE_URL + 'series/{series_guid}/episode/{episode_guid}'
    LICENSE_URL = "https://global.corusappservices.com/authorization/widevine/getresourcekey"

    USER_AGENT = None
    SESSION_DATA = None
    APP_ID = None
    PAGE_LIMIT = 100

    @staticmethod
    def test_service():
        main_service.run_service(watch_globaltv_com)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/channel/" in content

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_session_data():
        response = requests.post(
            watch_globaltv_com.SIGN_URL,
            headers={'User-Agent': watch_globaltv_com.USER_AGENT},
            json={
                'path': '/authentication/authenticate',
                'data': {
                    'transaction_type': 'authenticate',
                    'authenticator_id': 'anonymous',
                    'application_id': watch_globaltv_com.APP_ID,
                    'platform_id': 'web_widevine'
                }
            }
        )
        response = json.loads(response.content.decode())["data"]["session_data"]

        response = json.loads(base64.b64decode(json.loads(requests.post(
            watch_globaltv_com.AUTHENTICATE_URL,
            headers={'User-Agent': watch_globaltv_com.USER_AGENT},
            json={'session_data': response}
        ).content.decode())["session_data"].split(".")[1] + "==").decode())
        return response

    @staticmethod
    def get_application_id():
        main_js = re.findall(
            r'src="(/static/js/main.*?\.js)"',
            requests.get(watch_globaltv_com.BASE_URL).content.decode()
        )[0]
        return re.findall(
            r'application_id:"(.*?)"',
            requests.get(f'{watch_globaltv_com.BASE_URL}{main_js}').content.decode()
        )[0]

    @staticmethod
    def initialize_service():
        if watch_globaltv_com.USER_AGENT is None:
            watch_globaltv_com.USER_AGENT = builtins.CONFIG["USER_AGENT"]
        if watch_globaltv_com.APP_ID is None:
            watch_globaltv_com.APP_ID = watch_globaltv_com.get_application_id()
        if watch_globaltv_com.SESSION_DATA is None:
            watch_globaltv_com.SESSION_DATA = watch_globaltv_com.get_session_data()
        return watch_globaltv_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            watch_globaltv_com.LICENSE_URL, json={
                'license_request_data': list(challenge),
                'authorization_token': additional["auth_token"]
            }
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_init_from_mpd(mpd_url):
        mpd_content = requests.get(mpd_url).content.decode()
        mpd_content = xmltodict.parse(mpd_content)["MPD"]["Period"]
        base_url = mpd_content["BaseURL"]
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
        init_url = '/'.join(mpd_url.split('/')[:-1]) + "/" + base_url + init_url
        return init_url

    @staticmethod
    def get_pssh_from_manifest(manifest):
        return cdm_tools.get_pssh_from_init(watch_globaltv_com.get_init_from_mpd(manifest))

    @staticmethod
    def get_manifest(source_url, content_id):
        response = json.loads(requests.post(
            watch_globaltv_com.SIGN_URL,
            headers={'User-Agent': watch_globaltv_com.USER_AGENT},
            json={
                'path': '/authorization/authorizeresource',
                'data': {
                    'duid': watch_globaltv_com.SESSION_DATA['duid'],
                    'puid': watch_globaltv_com.SESSION_DATA['puid'],
                    'resource_id': content_id
                }
            }
        ).content.decode())["data"]["session_data"]

        response = json.loads(base64.b64decode(json.loads(requests.post(
            watch_globaltv_com.AUTHORIZE_RESOURCE_URL,
            headers={'User-Agent': watch_globaltv_com.USER_AGENT},
            json={'session_data': response}
        ).content.decode())["session_data"].split(".")[1] + "==").decode())
        if response["status"] == '401':
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_url,
                reason="Need Canadian IP to access content",
                solution="Use a VPN"
            ))

        if response["status"] == "413":
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_url,
                reason="The content isn't available without a TV provider account",
                solution="Do not attempt to download it"
            ))
        response = response["data"]["authorization_token"]

        auth_token = response
        response = json.loads(base64.b64decode(json.loads(requests.post(
            watch_globaltv_com.GET_STREAM_URL,
            json={
                'authorization_token': response,
                'platform': 'web_widevine'
            }
        ).content.decode())["session_data"].split(".")[1] + "==").decode())
        return response["resources"]["streaming_url"], auth_token

    @staticmethod
    def get_video_data(source_element):
        content_id = None
        for p in ["/episode/", "/channel/", "/movie/", "/video/"]:
            try:
                if p in source_element.url:
                    content_id = re.search(fr"{p}([^/]+)", source_element.url).group(1)
                    break
            except:
                pass

        response = json.loads(requests.get(
            watch_globaltv_com.CONTAINER_URL,
            params={"guid": content_id, "limit": '1'},
            headers={'User-Agent': watch_globaltv_com.USER_AGENT}
        ).content.decode())

        if response.get("count", None) == 0:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available anymore",
                solution="Do not attempt to download it"
            ))

        response = [r for r in response["results"] if r.get("guid", "") == content_id][0]
        resources = response.get("resources", [])
        response = response["data"]

        if source_element.element is None:
            element_name = (
                f'{response.get("show_title", "")}'
                f'_'
                f'{response.get("title", "")}'
            )
            element_name = get_valid_filename(element_name)

            if element_name is None or len(element_name) == 1:
                element_name = content_id
            source_element.element = element_name
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                watch_globaltv_com.__name__
            )

        manifest, auth_token = watch_globaltv_com.get_manifest(source_element.url, content_id)
        pssh_value = watch_globaltv_com.get_pssh_from_manifest(manifest)

        subtitles = []
        index = 0
        for resource in resources:
            resource_type = resource.get("type", "").lower()
            if "subtitle" in resource_type or "caption" in resource_type:
                if "http" in resource.get("uri", "").lower():
                    index += 1
                    srt_url = resource["uri"]
                    srt_ext = get_ext_from_url(srt_url)

                    subtitles.append((False, BaseElement(
                        url=srt_url,
                        collection=join(source_element.collection, source_element.element),
                        element=f'subtitle_{index}{srt_ext}'
                    )))
        return manifest, pssh_value, {
            "auth_token": auth_token,
            "SUBTITLES": subtitles
        }

    @staticmethod
    def get_collection_elements(collection_url):
        if "/channel/" in collection_url or ("/series/" in collection_url and "/episode/" in collection_url):
            return [BaseElement(url=collection_url)]
        if "/movie/" in collection_url or "/video/" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/series/" in collection_url and "/collection/" in collection_url:
            collection = []
            series_id = re.search(r"/series/([^/]+)", collection_url).group(1)
            collection_id = re.search(r"/collection/([^/]+)", collection_url).group(1)

            season_response = json.loads(requests.get(
                watch_globaltv_com.CONTAINER_URL,
                params={"guid": series_id, "limit": '1'},
                headers={'User-Agent': watch_globaltv_com.USER_AGENT}
            ).content.decode())

            if season_response.get("count", None) == 0:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=collection_url,
                    reason="The series isn't available anymore",
                    solution="Do not attempt to download it"
                ))

            season_response = [r for r in season_response["results"] if r.get("guid", "") == series_id][0]
            collection_name = season_response.get("label", None)
            if collection_name is None:
                collection_name = series_id

            season_response = json.loads(requests.get(
                watch_globaltv_com.CONTAINER_URL,
                params={
                    "parent": series_id, "type": "collection",
                    "limit": watch_globaltv_com.PAGE_LIMIT
                },
                headers={'User-Agent': watch_globaltv_com.USER_AGENT}
            ).content.decode())

            is_series = False
            found = False
            default_ordering = "reference_date"
            while True:
                for season_result in season_response.get("results", []):
                    if season_result.get("guid", "") != collection_id:
                        continue

                    season_data = season_result.get('data', {})
                    season_name = season_result.get('label', season_data.get('title', ''))
                    if "episodes" == season_name.lower():
                        is_series = True
                    if len(season_name) == 0:
                        season_name = collection_id

                    default_ordering = season_data.get("default_ordering", default_ordering)
                    collection_name += f'_{season_name}'
                    found = True
                    break

                if found:
                    break
                season_next = season_response.get('next', None)
                if season_next is None:
                    break
                season_response = json.loads(requests.get(
                    season_next, headers={'User-Agent': watch_globaltv_com.USER_AGENT}
                ).content.decode())

            if not found:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=collection_url,
                    reason="The collection isn't available or isn't supported",
                    solution=f"Make sure you wrote a valid URL or extend the {watch_globaltv_com.__name__} service"
                ))
            collection_name = get_valid_filename(collection_name)

            for t in ["season", "media", "episode"]:
                if not is_series and t == "season":
                    continue
                if is_series and t != "season":
                    continue

                season_response = json.loads(requests.get(
                    watch_globaltv_com.CONTAINER_URL,
                    params={
                        "parent": collection_id,
                        "limit": watch_globaltv_com.PAGE_LIMIT,
                        "type": t,
                        # "ordering": f'{"reference_date" if is_series else "order"}'
                        "ordering": f'{default_ordering if is_series else "order"}'
                    },
                    headers={'User-Agent': watch_globaltv_com.USER_AGENT}
                ).content.decode())

                if season_response["count"] > 0:
                    break

            content_index = 0
            if is_series:
                if season_response["count"] == 0:
                    season_response = json.loads(requests.get(
                        watch_globaltv_com.CONTAINER_URL,
                        params={
                            "parent": collection_id,
                            "limit": watch_globaltv_com.PAGE_LIMIT,
                            "ordering": default_ordering
                        },
                        headers={'User-Agent': watch_globaltv_com.USER_AGENT}
                    ).content.decode())
                    is_series = False

            while True:
                for content_result in season_response.get("results", []):
                    if content_result.get("guid", None) is None:
                        continue
                    if not is_series:
                        if content_result.get("type", "").lower() not in ["media", "episode"]:
                            continue

                        content_index += 1
                        check = check_range(False, None, content_index)
                        if check is True:
                            continue
                        elif check is False:
                            return collection

                        content_guid = content_result["guid"]
                        content_data = content_result.get('data', {})
                        content_name = content_data.get("title", None)
                        if content_name is None:
                            content_name = content_result.get("label", None)
                        if content_name is None:
                            content_name = content_guid
                        content_name = get_valid_filename(content_name)

                        collection.append(BaseElement(
                            url=watch_globaltv_com.VIDEO_URL.format(guid=content_guid),
                            collection=join(
                                join(
                                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                    watch_globaltv_com.__name__
                                ),
                                collection_name
                            ),
                            element=f'{content_index}_{content_name}'
                        ))
                        continue

                    if content_result.get("type", "").lower() != "season":
                        continue
                    season_result = content_result
                    season_guid = season_result["guid"]

                    season_data = season_result.get('data', {})
                    if season_data.get("season_number", None) is None:
                        continue
                    season_index = season_data["season_number"]
                    check = check_range(True, int(season_index), None)
                    if check in [True, False]:
                        continue

                    episode_response = json.loads(requests.get(
                        watch_globaltv_com.CONTAINER_URL,
                        params={
                            "parent": season_guid, "type": "episode",
                            "limit": watch_globaltv_com.PAGE_LIMIT,
                            "ordering": 'reference_date'
                        },
                        headers={'User-Agent': watch_globaltv_com.USER_AGENT}
                    ).content.decode())

                    while True:
                        for episode_result in episode_response.get("results", []):
                            if episode_result.get("guid", None) is None:
                                continue
                            episode_guid = episode_result["guid"]

                            episode_data = episode_result.get('data', {})
                            if episode_data.get("episode_number", None) is None:
                                continue
                            episode_index = episode_data["episode_number"]
                            check = check_range(False, int(season_index), int(episode_index))
                            if check in [True, False]:
                                continue

                            collection.append(BaseElement(
                                url=watch_globaltv_com.EPISODE_URL.format(
                                    series_guid=series_id,
                                    episode_guid=episode_guid
                                ),
                                collection=join(
                                    join(
                                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                        watch_globaltv_com.__name__
                                    ),
                                    join(str(collection_name), "Season_" + season_index)
                                ),
                                element=f'Episode_{episode_index}'
                                        f'_'
                                        f'{get_valid_filename(episode_data.get("title", episode_guid))}'
                            ))

                        episode_next = episode_response.get('next', None)
                        if episode_next is None:
                            break
                        episode_response = json.loads(requests.get(
                            episode_next, headers={'User-Agent': watch_globaltv_com.USER_AGENT}
                        ).content.decode())

                season_next = season_response.get('next', None)
                if season_next is None:
                    break
                season_response = json.loads(requests.get(
                    season_next, headers={'User-Agent': watch_globaltv_com.USER_AGENT}
                ).content.decode())

            return collection
        return None
