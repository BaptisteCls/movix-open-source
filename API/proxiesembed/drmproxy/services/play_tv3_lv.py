import builtins
import json
import os
import re
import time
from os.path import join

import requests
import xmltodict

import utils.tools.cdm as cdm_tools
from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, clean_url


class play_tv3_lv(BaseService):
    DEMO_URLS = [
        "https://play.tv3.lv/video/nba-7346592/nba-top-10-2702-2025-8997558/",
        "https://play.tv3.lv/video/kornelijs-un-berni-5554508/serija-52-5554562/",
        "https://play.tv3.lv/video/sefu-gaidijat-5069270/serija-11-8877550/",
        "https://play.tv3.lv/filmas/tornis-5523881/",
        "https://play.tv3.lv/video/nemiletie-svesie-1915103/",
        "https://play.tv3.lv/video/nebaidies-ne-no-ka-2441397/",
        "https://play.tv3.lv/video/misters-bins-8882922/",
        "https://play.tv3.lv/video/sefu-gaidijat-5069270/",
        "https://play.tv3.lv/video/ufc---jaukta-cinas-maksla-3428494/",
    ]

    PLAYLIST_URL = 'https://play.tv3.lv/api/products/{product_id}/videos/playlist'
    INFO_URL = 'https://play.tv3.lv/api/info'
    VOD_URL = 'https://play.tv3.lv/api/products/vods/{vod_id}'
    SERIAL_URL = 'https://play.tv3.lv/api/products/vods/serials/{serial_id}'
    SEASONS_URL = "https://play.tv3.lv/api/products/vods/serials/{serial_id}/seasons"
    EPISODES_URL = "https://play.tv3.lv/api/products/vods/serials/{serial_id}/seasons/{season_id}/episodes"
    RELATED_URL = 'https://play.tv3.lv/api/products/{product_id}/related/CLIP'

    TENANT = None
    LANGUAGE = None
    PLATFORM = "BROWSER"
    CODEC = None
    CODEC_PRIORITY = {"DASH": 1, "DASH_HEVC": 2}
    PAGE_SIZE = 50
    RETRIES_TIMER = 10
    RETRIES_COUNT = 10

    @staticmethod
    def test_service():
        main_service.run_service(play_tv3_lv)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_site_info():
        response = json.loads(requests.get(
            play_tv3_lv.INFO_URL,
            params={'platform': play_tv3_lv.PLATFORM}
        ).content.decode())
        return response["defaultLanguage"], response["defaultTenant"]

    @staticmethod
    def initialize_service():
        if builtins.CONFIG.get("BASIC", False) is True:
            play_tv3_lv.CODEC = 'DASH'

        if play_tv3_lv.LANGUAGE is None or play_tv3_lv.TENANT is None:
            play_tv3_lv.LANGUAGE, play_tv3_lv.TENANT = play_tv3_lv.get_site_info()
        return play_tv3_lv

    @staticmethod
    def get_keys(challenge, additional):
        licence = None
        for i in range(1, play_tv3_lv.RETRIES_COUNT + 1):
            try:
                licence = requests.post(additional["license_url"], data=challenge)
                licence.raise_for_status()
                break
            except Exception as e:
                response = e.response
                if response.status_code >= 300 or response.status_code < 200:
                    if i < play_tv3_lv.RETRIES_COUNT:
                        time.sleep(play_tv3_lv.RETRIES_TIMER)
                        continue
                raise e
        return licence.content

    @staticmethod
    def get_manifest_content(mpd_url):
        for i in range(1, play_tv3_lv.RETRIES_COUNT + 1):
            try:
                mpd_content = requests.get(mpd_url)
                status_code = mpd_content.status_code
                mpd_content = mpd_content.content.decode()
                assert 200 <= status_code < 300
                assert "403 forbidden" not in mpd_content.lower()
                return mpd_content
            except:
                if i < play_tv3_lv.RETRIES_COUNT:
                    time.sleep(play_tv3_lv.RETRIES_TIMER)
        return None

    @staticmethod
    def generate_master_mpd(source_element, manifests):
        manifests_contents = []
        for mpd_url in manifests:
            mpd_url = mpd_url.rstrip("/")
            mpd_content = play_tv3_lv.get_manifest_content(mpd_url)
            mpd_content = xmltodict.parse(mpd_content)
            manifests_contents.append((mpd_url, mpd_content))

        video_set = []
        index = -1
        for mpd_url, mpd_content in manifests_contents:
            index += 1

            base_url = mpd_content["MPD"]["Period"].get("BaseURL", "")
            dots_count = base_url.count("../")
            base_url = "/".join(mpd_url.split("/")[0:-(dots_count + 1)]) + "/" + base_url.split("../")[dots_count]
            mpd_content["MPD"]["Period"].pop("BaseURL", None)

            manifest_content = mpd_content["MPD"]["Period"]["AdaptationSet"]
            if type(manifest_content) is not list:
                manifest_content = [manifest_content]

            for ad_set in manifest_content:
                if index > 0:
                    if "video/" not in ad_set["@mimeType"]:
                        continue

                ad_set_rep = ad_set["Representation"]
                if type(ad_set_rep) is not list:
                    ad_set_rep = [ad_set_rep]

                for ad_rep in ad_set_rep:
                    ad_rep["BaseURL"] = base_url
                if len(ad_set_rep) == 1:
                    ad_set_rep = ad_set_rep[0]
                ad_set["Representation"] = ad_set_rep

                if index > 0:
                    video_set.append(ad_set)

        manifests_contents = [m[1] for m in manifests_contents]
        manifest_content = manifests_contents[0]["MPD"]["Period"]["AdaptationSet"]
        manifest_content += video_set
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
    def get_init_from_mpd(mpd_url, mpd_content):
        try:
            return False, str(min(
                re.findall(
                    r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                    mpd_content
                ), key=len
            ))
        except:
            pass

        mpd_content = xmltodict.parse(mpd_content)["MPD"]
        mpd_content = mpd_content["Period"]
        base_url = mpd_content.get("BaseURL", "")
        dots_count = base_url.count("../")
        base_url = "/".join(mpd_url.split("/")[0:-(dots_count + 1)]) + "/" + base_url.split("../")[dots_count]

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

            content_h = int(content.get("@height", mpd_content.get("@height", None)))
            best_content_h = int(best_content.get("@height", mpd_content.get("@height", None)))
            if content_h > best_content_h:
                best_content = content
                continue
            elif content_h == best_content_h:
                if int(content["@bandwidth"]) > int(best_content["@bandwidth"]):
                    best_content = content
                    continue

        init_url = init_url.replace("$RepresentationID$", best_content["@id"])
        init_url = init_url.replace("$Bandwidth$", best_content["@bandwidth"])
        init_url = base_url + init_url
        return True, init_url

    @staticmethod
    def get_pssh_from_manifest(mpd_url, mpd_content):
        is_init, init = play_tv3_lv.get_init_from_mpd(mpd_url, mpd_content)
        if not is_init:
            return init
        return cdm_tools.get_pssh_from_init(init)

    @staticmethod
    def get_video_data(source_element):
        video_type = "MOVIE"
        product_id = source_element.url.split("-")[-1]
        response = None

        if source_element.element is None:
            if response is None:
                response = json.loads(requests.get(
                    play_tv3_lv.VOD_URL.format(vod_id=product_id),
                    params={
                        'platform': play_tv3_lv.PLATFORM,
                        'lang': play_tv3_lv.LANGUAGE,
                        'tenant': play_tv3_lv.TENANT
                    }
                ).content.decode())

            status_code = response.get("codeNumber", None)
            if status_code == 404:
                title = product_id
            else:
                title = response.get("title", response.get("slug", product_id))

            serial = response.get("season", {})
            if serial.get("number", None) is not None:
                title = f"Season_{serial['number']}_" + title

            serial = serial.get("serial", {})
            serial = serial.get("title", serial.get("slug", None))
            if serial is not None:
                title = serial + " " + title

            source_element.element = get_valid_filename(title)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                play_tv3_lv.__name__
            )

        response = json.loads(requests.get(
            play_tv3_lv.PLAYLIST_URL.format(product_id=product_id),
            params={
                'platform': play_tv3_lv.PLATFORM,
                'videoType': video_type,
                'lang': play_tv3_lv.LANGUAGE,
                'tenant': play_tv3_lv.TENANT
            }
        ).content.decode())
        status_code = response.get("codeNumber", None)
        if status_code == 404:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        sources = response.get("sources", [])
        if len(sources) == 0:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="The content isn't available yet",
                solution="Wait until you can watch it on your browser"
            ))

        for k, v in sources.items():
            if type(v) is not list:
                v = [v]
            sources[k] = max(v, key=lambda s: s.get("aspectWidth", 0))

        sources = [(play_tv3_lv.CODEC_PRIORITY.get(kv[0], 0), kv) for kv in sources.items()]
        sources = sorted(sources, key=lambda s: s[0], reverse=True)
        sources = list(filter(lambda s: s[0] > 0, sources))
        sources = [s[1] for s in sources]
        sources = list(filter(lambda s: len(s[1]) > 0, sources))

        if len(sources) == 0:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Manifest format not supported: {str(response.get('sources', []))}",
                solution=f"Extend the {play_tv3_lv.__name__} service"
            ))

        if play_tv3_lv.CODEC is not None:
            temp_src = [(codec, _) for codec, _ in sources if codec == play_tv3_lv.CODEC]
            if len(temp_src) > 0:
                sources = [temp_src[0]]
            else:
                sources = [sources[0]]

        license_url = None
        has_drm = False
        if response.get("drm", {}) not in [None, {}] and len(response["drm"].keys()) > 0:
            has_drm = True
        if has_drm:
            for d, s in response["drm"].items():
                if "widevine" in d.lower():
                    license_url = s["src"]
                    break
        if has_drm and license_url is None:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason=f"DRM not supported. Widevine wasn't found",
                solution="Do not attempt to download it"
            ))

        manifests = []
        pssh_values = []
        additional = {"video_type": video_type}

        for _, source in sources:
            manifest = source["src"]
            if manifest.startswith("//"):
                manifest = manifest.replace("//", "https://")

            if manifest in manifests:
                continue
            manifests.append(manifest)

            pssh_value = None
            if license_url is not None:
                mpd_content = play_tv3_lv.get_manifest_content(manifest)
                assert mpd_content is not None

                try:
                    pssh_value = play_tv3_lv.get_pssh_from_manifest(manifest, mpd_content)
                except Exception as e:
                    if builtins.CONFIG["DEBUG_MODE"]:
                        raise e
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

        if len(manifests) > 1:
            manifests = play_tv3_lv.generate_master_mpd(source_element, manifests)
        else:
            manifests = manifests[0]
        return manifests, pssh_values, additional

    @staticmethod
    def get_video_url(collection_url, item):
        video_url = collection_url
        item_type = item.get("type_", item["type"])

        if item_type in ["EPISODE", "PROGRAMME", "SERIAL"]:
            return None

        if item_type in ["CLIP", "VOD"]:
            video_url += "/" + item["slug"]
            video_url += "-" + str(item["id"])
            return video_url

        raise Exception("Unknown Type: ", str(item))

    @staticmethod
    def series_handler(collection_url):
        collection = []
        content_id = collection_url.split(",")[-1].split("-")[-1]
        collection_name = collection_url.split("/")[-1].split(",")[0]

        response = json.loads(requests.get(
            play_tv3_lv.SERIAL_URL.format(serial_id=content_id),
            params={
                'platform': play_tv3_lv.PLATFORM,
                'lang': play_tv3_lv.LANGUAGE,
                'tenant': play_tv3_lv.TENANT
            }
        ).content.decode())
        status_code = response.get("codeNumber", None)
        if status_code == 404:
            return []

        collection_name = get_valid_filename(response.get(
            "title",
            response.get("slug", collection_name)
        ))
        collection_name = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                play_tv3_lv.__name__
            ),
            collection_name
        )

        response = json.loads(requests.get(
            play_tv3_lv.SEASONS_URL.format(serial_id=content_id),
            params={
                'platform': play_tv3_lv.PLATFORM,
                'lang': play_tv3_lv.LANGUAGE,
                'tenant': play_tv3_lv.TENANT
            }
        ).content.decode())
        if type(response) is not list:
            status_code = response.get("codeNumber", None)
            if status_code == 404:
                return []

        seasons = sorted(response, key=lambda s: s["number"])
        if len(seasons) == 0:
            return []

        season_index = seasons[-1]["number"]
        related = []
        for season in seasons:
            season_index += 1
            related.append({
                "RELATED": True,
                "id": season["id"],
                "number": season_index
            })
        seasons += related

        for season in seasons:
            check = check_range(True, season["number"], None)
            if check is True:
                continue
            elif check is False:
                return collection

            if season.get("RELATED", False) is False:
                response = json.loads(requests.get(
                    play_tv3_lv.EPISODES_URL.format(
                        serial_id=content_id,
                        season_id=str(season["id"])
                    ),
                    params={
                        'platform': play_tv3_lv.PLATFORM,
                        'lang': play_tv3_lv.LANGUAGE,
                        'tenant': play_tv3_lv.TENANT
                    }
                ).content.decode())
                if type(response) is not list:
                    continue

                episodes = sorted(response, key=lambda e: e["episode"])
                for episode in episodes:
                    check = check_range(False, season["number"], episode['episode'])
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    episode_url = collection_url + "/" + episode["slug"]
                    episode_url += "-" + str(episode["id"])
                    episode_title = get_valid_filename(episode.get("title", episode["slug"]))

                    collection.append(BaseElement(
                        url=episode_url,
                        collection=join(collection_name, f'Season_{season["number"]}'),
                        element=f"Episode_{episode['episode']}_{episode_title}"
                    ))

            else:
                response = json.loads(requests.get(
                    play_tv3_lv.RELATED_URL.format(product_id=str(season["id"])),
                    params={
                        'platform': play_tv3_lv.PLATFORM,
                        'lang': play_tv3_lv.LANGUAGE,
                        'tenant': play_tv3_lv.TENANT,
                        "maxResults": 1000
                    }
                ).content.decode())
                if type(response) is not list:
                    response = []

                episodes = response
                episode_index = 0
                for episode in episodes:
                    try:
                        episode_url = play_tv3_lv.get_video_url(collection_url, episode)
                    except:
                        continue

                    episode_index += 1
                    check = check_range(False, season["number"], episode_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    episode_title = get_valid_filename(episode.get("title", episode["slug"]))
                    collection.append(BaseElement(
                        url=episode_url,
                        collection=join(collection_name, f'Season_{season["number"]}_Clips'),
                        element=f"Clip_{episode_index}_{episode_title}"
                    ))

        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url).rstrip("/")
        if "/tiesraides/" in collection_url:
            return None
        if "/filmas/" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/video/" in collection_url:
            slash_count = collection_url.split("/video/")[1].count("/")
            if "/serija-" in collection_url or slash_count == 1:
                return [BaseElement(url=collection_url)]

            return play_tv3_lv.series_handler(collection_url)
        return None
