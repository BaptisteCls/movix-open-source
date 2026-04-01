import builtins
import json
import os
import re
from os.path import join
from urllib.parse import parse_qs, urlparse

import requests
import xmltodict

from utils.constants.macros import ERR_MSG, APP_ERROR, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename


class rakuten_tv(BaseService):
    DEMO_URLS = [
        "https://www.rakuten.tv/GLOBAL?content_type=tv_shows&tv_show_id=discovering-canary-islands&content_id=discovering-canary-islands-1",
        "https://www.rakuten.tv/GLOBAL/gardens/avod-fast?content_type=tv_shows&tv_show_id=revenge-note&content_id=revenge-note-1",
        "https://www.rakuten.tv/GLOBAL/live_channels/lone-star",
        "https://www.rakuten.tv/GLOBAL/live_channels/bloomberg-tv-new",
        "https://www.rakuten.tv/GLOBAL/player/seasons/trailer/champions-1",
        "https://www.rakuten.tv/GLOBAL/player/movies/trailer/a-thousand-and-one",
        'https://www.rakuten.tv/GLOBAL/player/movies/stream/ride-your-dream',
        'https://www.rakuten.tv/GLOBAL/player/movies/stream/inside-kilian-jornet',
        "https://www.rakuten.tv/GLOBAL/player/episodes/stream/matchday-1/matchday-1-5",
        "https://www.rakuten.tv/GLOBAL/player/episodes/stream/discovering-canary-islands-2/discovering-canary-islands-2-2",
    ]

    START_URL = 'https://gizmo.rakuten.tv/v3/me/start'
    STREAM_URL = 'https://gizmo.rakuten.tv/v3/{category}/streamings'
    CONTENT_URL = 'https://gizmo.rakuten.tv/v3/{path_type}/{content_id}'
    BASE_URL = 'https://www.rakuten.tv'
    EPISODE_URL = BASE_URL + "/{country}/player/episodes/stream/{season_id}/{episode_id}"

    CLASSIFICATION_ID = None
    DEVICE_ID = "cast"
    DEVICE_IDS = [
        "atvui40", "atvui40_free", "atvui40_stb_free", "cast", "hisui40",
        "lgui40", "netgemui40", "panui40", "philui40", "ps4ui40",
        "samui40", "sonyui40", "tclui40", "vestelui40", "web"
    ]
    RES_PRIORITY = {"SD": 0, "HD": 1, "FHD": 2, "UHD": 3}
    LANGUAGE = None

    @staticmethod
    def test_service():
        main_service.run_service(rakuten_tv)

    @staticmethod
    def get_additional_params(additional):
        return [("MUXER", lambda s: s.format(args="mkv:muxer=mkvmerge"))]

    @staticmethod
    def is_content_livestream(content, additional):
        return "/live_channels/" in content

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_classification_id():
        response = json.loads(requests.post(
            rakuten_tv.START_URL,
            json={
                'device_identifier': rakuten_tv.DEVICE_ID,
                'device_metadata': {
                    'app_version': 'app_version',
                    'brand': 'brand', 'model': 'model',
                    'os': 'os', 'serial_number': 'serial_number',
                    'uid': 'uid', 'year': 0
                }
            }
        ).content.decode())

        if "forbidden_vpn" in str(response.get("errors", [])).lower():
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=f'from {rakuten_tv.__name__}',
                reason="The VPN was detected",
                solution="Get a better VPN or don't use one"
            ))
        if "forbidden_market" in str(response.get("errors", [])).lower():
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=f'from {rakuten_tv.__name__}',
                reason="Bad device id",
                solution=f"Change the device id in the service script file"
            ))

        classification_id = response["data"]["user"]["profile"]["classification"]["numerical_id"]
        return str(classification_id)

    @staticmethod
    def initialize_service():
        if builtins.CONFIG.get("BASIC", False) is True:
            rakuten_tv.LANGUAGE = 'eng'
            rakuten_tv.LANGUAGE = rakuten_tv.LANGUAGE.lower()

        if rakuten_tv.CLASSIFICATION_ID is None:
            rakuten_tv.CLASSIFICATION_ID = rakuten_tv.get_classification_id()
        return rakuten_tv

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(additional["license_url"], data=challenge)
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def generate_master_mpd(source_element, manifests):
        manifests_contents = []
        for mpd_url in manifests:
            mpd_content = requests.get(mpd_url).content.decode()
            mpd_content = xmltodict.parse(mpd_content)
            manifests_contents.append(mpd_content)

        audio_set = []
        index = -1
        for c in manifests_contents:
            index += 1
            base_url = c["MPD"]["BaseURL"]
            del c["MPD"]["BaseURL"]

            manifest_content = c["MPD"]["Period"]["AdaptationSet"]
            if type(manifest_content) is not list:
                manifest_content = [manifest_content]

            for ad_set in manifest_content:
                if index > 0:
                    if "audio/" not in ad_set["@mimeType"]:
                        continue

                ad_set_rep = ad_set["Representation"]
                if type(ad_set_rep) is not list:
                    ad_set_rep = [ad_set_rep]

                for ad_rep in ad_set_rep:
                    ad_rep["BaseURL"] = base_url + ad_rep["BaseURL"]
                if len(ad_set_rep) == 1:
                    ad_set_rep = ad_set_rep[0]
                ad_set["Representation"] = ad_set_rep

                if index > 0:
                    audio_set.append(ad_set)

        manifest_content = manifests_contents[0]["MPD"]["Period"]["AdaptationSet"]
        manifest_content += audio_set
        manifests_contents[0]["MPD"]["Period"]["AdaptationSet"] = manifest_content
        manifest_content = manifests_contents[0]
        manifest_content = xmltodict.unparse(manifest_content, pretty=True)

        output_path = join(source_element.collection, source_element.element)
        if not os.path.exists(output_path):
            os.makedirs(output_path)
        output_path = join(str(output_path), "master.mpd")

        with open(output_path, "w") as f:
            f.write(manifest_content)
        return output_path

    @staticmethod
    def get_video_data(source_element):
        if "/trailer/" in source_element.url:
            content_category = "trailer"
        elif "/live_channels/" in source_element.url:
            content_category = "live_channels"
        else:
            content_category = "stream"

        if "/live_channels/" in source_element.url:
            content_type = content_category
            content_id = re.search(fr"/{content_category}/(.+)", source_element.url).group(1).split("/")
        else:
            content_type = re.search(fr"/player/([^/?]*)/{content_category}/", source_element.url).group(1)
            content_id = re.search(fr"/player/[^/?]*/{content_category}/(.+)", source_element.url).group(1).split("/")

        path_type = "movies"
        if content_type in ["episodes", "seasons"]:
            path_type = "seasons"
        elif content_type in ["live_channels"]:
            path_type = "live_channels"

        response = json.loads(requests.get(
            rakuten_tv.CONTENT_URL.format(path_type=path_type, content_id=content_id[0]),
            params={
                'classification_id': rakuten_tv.CLASSIFICATION_ID,
                'device_identifier': rakuten_tv.DEVICE_ID
            }
        ).content.decode())

        content_title = content_id[0]
        if "not_found" in str(response.get("errors", [])).lower():
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        all_response = None
        if "/movies/" in source_element.url or "/seasons/" in source_element.url or "/live_channels/" in source_element.url:
            if "/seasons/" not in source_element.url:
                content_title = response["data"]["title"]
            else:
                content_title = response["data"]["tv_show"]["title"]
            response = response["data"]["view_options"]

            if content_category == "trailer":
                response = response["public"]["trailers"]
            else:
                response = response["private"]["streams"]

            all_response = response
            response = response[0]
        elif "/episodes/" in source_element.url:
            found = False
            content_title = content_id[1]

            for episode in response["data"]["episodes"]:
                if episode["id"] == content_id[1]:
                    content_title = episode["title"]
                    response = episode["view_options"]["private"]["streams"][0]
                    found = True
                    break

            if not found:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The content isn't available",
                    solution="Do not attempt to download it"
                ))

        if source_element.element is None:
            if "/trailer/" in source_element.url:
                content_title += " Trailer"
            source_element.element = get_valid_filename(content_title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                rakuten_tv.__name__
            )

        drm_types = response["streaming_drm_types"]
        manifest_type = None
        for drm_type in drm_types:
            if drm_type["id"].lower().startswith("dash-"):
                manifest_type = drm_type["id"]
                break
        if manifest_type is None:
            manifest_type = drm_types[0]["id"]

        audio_quality = response["audio_qualities"]
        audio_quality = sorted(audio_quality, key=lambda ad: ad["numerical_id"], reverse=True)
        audio_quality = f'{audio_quality[0]["numerical_id"]}.0'

        if all_response is None:
            audio_lang = response["audio_languages"]
        else:
            audio_lang = []
            for r in all_response:
                audio_lang.extend(r["audio_languages"])

        subtitle_language = response["subtitle_languages"][-1]["id"]
        video_quality = response["video_qualities"]
        video_quality = sorted(
            video_quality, reverse=True,
            key=lambda v: rakuten_tv.RES_PRIORITY[v["id"]]
        )
        video_quality = video_quality[0]["id"]

        json_content_id = content_id[0]
        if content_type == "episodes":
            json_content_id = content_id[1]

        manifest = []
        subtitles = []
        pssh_values = []
        additional = {}
        has_non_mpd = False

        if rakuten_tv.LANGUAGE is not None:
            temp_audio = [
                a for a in audio_lang
                if a["id"].lower().startswith(rakuten_tv.LANGUAGE)
                   or rakuten_tv.LANGUAGE.startswith(a["id"].lower())
            ]
            if len(temp_audio) > 0:
                audio_lang = [temp_audio[0]]
            else:
                audio_lang = [audio_lang[0]]

        for a in audio_lang:
            response = json.loads(requests.post(
                rakuten_tv.STREAM_URL.format(
                    category="avod" if content_category in ["stream", "live_channels"] else "me"
                ),
                params={"device_identifier": rakuten_tv.DEVICE_ID},
                json={
                    'audio_language': a["id"],
                    'audio_quality': audio_quality,
                    'classification_id': rakuten_tv.CLASSIFICATION_ID,
                    'content_id': json_content_id,
                    'content_type': content_type,
                    'device_serial': 'device_serial',
                    'device_stream_video_quality': video_quality,
                    'player': f'{rakuten_tv.DEVICE_ID}:{manifest_type}',
                    'subtitle_language': subtitle_language,
                    'support_closed_captions': True,
                    'video_type': "stream" if content_category in ["stream", "live_channels"] else content_category
                }
            ).content.decode())

            if "not_found" in str(response.get("errors", [])).lower():
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=source_element.url,
                    reason="The content isn't available because of bad device id or because it doesn't exist",
                    solution=f"Change the device id in the service script file or do not attempt to download it"
                ))

            streams = response["data"]["stream_infos"]
            streams = sorted(
                streams, reverse=True,
                key=lambda s: rakuten_tv.RES_PRIORITY[s["video_quality"]]
            )

            if len(subtitles) == 0:  # and "/live_channels/" not in source_element.url:
                output_path = join(source_element.collection, source_element.element)
                visited = []
                index = 0

                for subtitle in streams[0].get("all_subtitles", []):
                    if subtitle["url"] in visited:
                        continue

                    index += 1
                    subtitles.append((False, BaseElement(
                        url=subtitle["url"],
                        collection=output_path,
                        element=f'subtitle_{index}'
                                f'_'
                                f'{subtitle["language"].lower()}.{subtitle["format"].lower()}'
                    )))
                    visited.append(subtitle["url"])

            manifest_url = streams[0]["url"]
            if manifest_url in manifest:
                continue
            manifest.append(manifest_url)

            if has_non_mpd is False:
                has_non_mpd = manifest_type.lower().startswith("hls-")

            if len(manifest) > 1 and has_non_mpd:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {str(manifest)}. Can't merge multiple manifests",
                    solution=f"Extend the {rakuten_tv.__name__} service"
                ))

            license_url = streams[0].get("license_url", None)
            if license_url is not None and manifest_type.lower().startswith("hls-"):
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest_type}. Can't extract pssh",
                    solution=f"Extend the {rakuten_tv.__name__} service"
                ))

            try:
                if license_url is None:
                    raise

                pssh_value = str(min(re.findall(
                    r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                    requests.get(manifest_url).content.decode()
                ), key=len))
            except:
                pssh_value = None

            if pssh_value is not None:
                if pssh_value not in pssh_values:
                    pssh_values.append(pssh_value)
                    additional[pssh_value] = {"license_url": license_url}

            if pssh_value is None and license_url is not None:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason=f"DRM not supported. Widevine wasn't found",
                    solution="Do not attempt to download it"
                ))

        if len(manifest) > 1:
            manifest = rakuten_tv.generate_master_mpd(source_element, manifest)
        else:
            manifest = manifest[0]

        additional["SUBTITLES"] = subtitles
        return manifest, pssh_values, additional

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.rstrip("/")

        for p in ["movies", "episodes"]:
            if f'/player/{p}/stream/' in collection_url:
                return [BaseElement(url=collection_url)]
        for p in ["movies", "seasons"]:
            if f'/player/{p}/trailer/' in collection_url:
                return [BaseElement(url=collection_url)]
        if "/live_channels/" in collection_url:
            return [BaseElement(url=collection_url)]

        if "?" in collection_url and "content_type=" in collection_url and "content_id=" in collection_url:
            collection = []
            params_dict = parse_qs(urlparse(collection_url).query)

            content_type = params_dict["content_type"][0]
            if content_type not in ["tv_shows"]:
                return None
            content_id = params_dict["content_id"][0]
            if content_id is None:
                return None

            country = re.search(fr"{rakuten_tv.BASE_URL}/([^/?]*)[/?]", collection_url).group(1)
            response = json.loads(requests.get(
                rakuten_tv.CONTENT_URL.format(
                    path_type="seasons",
                    content_id=content_id
                ),
                params={
                    'classification_id': rakuten_tv.CLASSIFICATION_ID,
                    'device_identifier': rakuten_tv.DEVICE_ID
                }
            ).content.decode())

            if "not_found" in str(response.get("errors", [])).lower():
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}',
                    url=collection_url,
                    reason="The content isn't available",
                    solution="Do not attempt to download it"
                ))

            response = response["data"]
            init_episodes = response["episodes"]
            collection_name = join(
                join(
                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                    rakuten_tv.__name__
                ),
                get_valid_filename(response["tv_show"]["title"])
            )

            season_index = 0
            for season in response["tv_show"]["seasons"]:
                season_index += 1
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                if season["id"] == content_id:
                    episodes = init_episodes
                else:
                    episodes = json.loads(requests.get(
                        rakuten_tv.CONTENT_URL.format(
                            path_type="seasons",
                            content_id=season["id"]
                        ),
                        params={
                            'classification_id': rakuten_tv.CLASSIFICATION_ID,
                            'device_identifier': rakuten_tv.DEVICE_ID
                        }
                    ).content.decode())
                    episodes = episodes["data"]["episodes"]

                episodes = sorted(episodes, key=lambda ep: ep["number"])
                for e in episodes:
                    check = check_range(False, season_index, e['number'])
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    collection.append(BaseElement(
                        url=rakuten_tv.EPISODE_URL.format(
                            country=country,
                            season_id=season["id"],
                            episode_id=e["id"]
                        ),
                        collection=join(collection_name, f'Season_{season_index}'),
                        element=f"Episode_{e['number']}"
                                f"_"
                                f"{get_valid_filename(e['title'])}"
                    ))

            return collection
        return None
