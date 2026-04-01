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
from utils.tools.common import get_valid_filename


class play_tv3_lt(BaseService):
    DEMO_URLS = [
        "https://play.tv3.lt/series/cesapiko-krantai,serial-5649152",
        "https://play.tv3.lt/shows/tevai-paprastai,serial-4654553",
        "https://play.tv3.lt/news/dienos-pjuvis,serial-2941600",
        "https://play.tv3.lt/shows/entertainment,4197826",
        "https://play.tv3.lt/shows/sections/lietuvos-talentai,3983709",
        'https://play.tv3.lt/series/sections/nenugalima-meile,7491265',
        "https://play.tv3.lt/clips/sections/x-faktorius,3351498",
        "https://play.tv3.lt/news/tv3_zinios,4198085",
        "https://play.tv3.lt/news/sections/tv3-zinios-tiesiogiai-ir-archyvas,2871419",
        "https://play.tv3.lt/show/tv3-plus,live-4929289/kaip-ilgai-as-taves-laukiau,programme-7554014",
        "https://play.tv3.lt/lives/tv3-lt,live-2831094/tv3-orai,programme-7547397",
        "https://play.tv3.lt/clip/oziaragio-horoskopas-06100617,clip-7545830",
        "https://play.tv3.lt/series/nepaleisk-mano-rankos-,serial-5981793/serija-1,episode-5928727",
        "https://play.tv3.lt/kids_series/ar-zinai-kaip-as-tave-myliu,serial-1601493/serija-50,episode-1601571",
    ]

    PLAYLIST_URL = 'https://play.tv3.lt/api/products/{product_id}/videos/playlist'
    INFO_URL = 'https://play.tv3.lt/api/info'
    VOD_URL = 'https://play.tv3.lt/api/products/vods/{vod_id}'
    PROGRAM_URL = 'https://play.tv3.lt/api/products/lives/programmes/{content_id}'
    LIVE_URL = 'https://play.tv3.lt/api/products/lives/{content_id}'
    SECTION_URL = 'https://play.tv3.lt/api/products/sections/{section_id}'
    VODS_URL = 'https://play.tv3.lt/api/products/vods'
    CATALOG_URL = 'https://play.tv3.lt/api/products/lives/programmes/catalog'
    SERIAL_URL = 'https://play.tv3.lt/api/products/vods/serials/{serial_id}'
    SEASONS_URL = "https://play.tv3.lt/api/products/vods/serials/{serial_id}/seasons"
    EPISODES_URL = "https://play.tv3.lt/api/products/vods/serials/{serial_id}/seasons/{season_id}/episodes"
    RELATED_URL = 'https://play.tv3.lt/api/products/{product_id}/related/CLIP'
    BASE_URL = 'https://play.tv3.lt'

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
        main_service.run_service(play_tv3_lt)

    @staticmethod
    def is_content_livestream(content, additional):
        return "LIVE" in additional.get("video_type", "")

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_site_info():
        response = json.loads(requests.get(
            play_tv3_lt.INFO_URL,
            params={'platform': play_tv3_lt.PLATFORM}
        ).content.decode())
        return response["defaultLanguage"], response["defaultTenant"]

    @staticmethod
    def initialize_service():
        if builtins.CONFIG.get("BASIC", False) is True:
            play_tv3_lt.CODEC = 'DASH'

        if play_tv3_lt.LANGUAGE is None or play_tv3_lt.TENANT is None:
            play_tv3_lt.LANGUAGE, play_tv3_lt.TENANT = play_tv3_lt.get_site_info()
        return play_tv3_lt

    @staticmethod
    def get_keys(challenge, additional):
        licence = None
        for i in range(1, play_tv3_lt.RETRIES_COUNT + 1):
            try:
                licence = requests.post(additional["license_url"], data=challenge)
                licence.raise_for_status()
                break
            except Exception as e:
                response = e.response
                if response.status_code >= 300 or response.status_code < 200:
                    if i < play_tv3_lt.RETRIES_COUNT:
                        time.sleep(play_tv3_lt.RETRIES_TIMER)
                        continue
                raise e
        return licence.content

    @staticmethod
    def generate_master_mpd(source_element, manifests):
        manifests_contents = []
        for mpd_url in manifests:
            mpd_url = mpd_url.rstrip("/")
            mpd_content = play_tv3_lt.get_manifest_content(mpd_url)
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
    def get_manifest_content(mpd_url):
        for i in range(1, play_tv3_lt.RETRIES_COUNT + 1):
            try:
                mpd_content = requests.get(mpd_url)
                status_code = mpd_content.status_code
                mpd_content = mpd_content.content.decode()
                assert 200 <= status_code < 300
                assert "403 forbidden" not in mpd_content.lower()
                return mpd_content
            except:
                if i < play_tv3_lt.RETRIES_COUNT:
                    time.sleep(play_tv3_lt.RETRIES_TIMER)
        return None

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
        is_init, init = play_tv3_lt.get_init_from_mpd(mpd_url, mpd_content)
        if not is_init:
            return init
        return cdm_tools.get_pssh_from_init(init)

    @staticmethod
    def get_video_data(source_element):
        video_type = "MOVIE"
        product_id = source_element.url.split("-")[-1]
        response = None

        if ",live-" in source_element.url:
            video_type = "LIVE"
            nr_slash = source_element.url.split(play_tv3_lt.BASE_URL)[-1].count("/")
            lives_url = play_tv3_lt.LIVE_URL

            if ",programme-" in source_element.url or nr_slash >= 3:
                video_type = "CATCHUP"
                lives_url = play_tv3_lt.PROGRAM_URL

            response = json.loads(requests.get(
                lives_url.format(content_id=product_id),
                params={
                    'platform': play_tv3_lt.PLATFORM,
                    'lang': play_tv3_lt.LANGUAGE,
                    'tenant': play_tv3_lt.TENANT
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

            if video_type == "CATCHUP":
                product_id = response["programRecordingId"]
            else:
                product_id = response["id"]

        if source_element.element is None:
            if response is None:
                response = json.loads(requests.get(
                    play_tv3_lt.VOD_URL.format(vod_id=product_id),
                    params={
                        'platform': play_tv3_lt.PLATFORM,
                        'lang': play_tv3_lt.LANGUAGE,
                        'tenant': play_tv3_lt.TENANT
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
                play_tv3_lt.__name__
            )

        response = json.loads(requests.get(
            play_tv3_lt.PLAYLIST_URL.format(product_id=product_id),
            params={
                'platform': play_tv3_lt.PLATFORM,
                'videoType': video_type,
                'lang': play_tv3_lt.LANGUAGE,
                'tenant': play_tv3_lt.TENANT
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

        sources = [(play_tv3_lt.CODEC_PRIORITY.get(kv[0], 0), kv) for kv in sources.items()]
        sources = sorted(sources, key=lambda s: s[0], reverse=True)
        sources = list(filter(lambda s: s[0] > 0, sources))
        sources = [s[1] for s in sources]
        sources = list(filter(lambda s: len(s[1]) > 0, sources))

        if len(sources) == 0:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Manifest format not supported: {str(response.get('sources', []))}",
                solution=f"Extend the {play_tv3_lt.__name__} service"
            ))

        if play_tv3_lt.CODEC is not None:
            temp_src = [(codec, _) for codec, _ in sources if codec == play_tv3_lt.CODEC]
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
                mpd_content = play_tv3_lt.get_manifest_content(manifest)
                assert mpd_content is not None

                try:
                    pssh_value = play_tv3_lt.get_pssh_from_manifest(manifest, mpd_content)
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
            manifests = play_tv3_lt.generate_master_mpd(source_element, manifests)
        else:
            manifests = manifests[0]
        return manifests, pssh_values, additional

    @staticmethod
    def get_video_url(item):
        video_url = play_tv3_lt.BASE_URL
        item_type = item.get("type_", item["type"])

        if item_type == "EPISODE":
            season = item["season"]
            serial = season["serial"]

            video_url += "/" + serial["mainCategory"]["label"]
            video_url += "/" + serial["slug"]
            video_url += "," + serial["type_"].lower()
            video_url += "-" + str(serial["id"])

            video_url += "/" + item["slug"]
            video_url += "," + item_type.lower()
            video_url += "-" + str(item["id"])
            return video_url

        if item_type == "PROGRAMME":
            live = item["live"]

            video_url += "/" + item["mainCategory"]["label"]
            video_url += "/" + live["slug"]
            video_url += "," + live["type_"].lower()
            video_url += "-" + str(live["id"])

            video_url += "/" + item["slug"]
            video_url += "," + item_type.lower()
            video_url += "-" + str(item["id"])
            return video_url

        if item_type == "CLIP":
            video_url += "/" + item.get("mainCategory", {}).get("label", "clip")
            video_url += "/" + item["slug"]
            video_url += "," + item_type.lower()
            video_url += "-" + str(item["id"])
            return video_url

        if item_type == "VOD":
            video_url += "/" + item["mainCategory"]["label"]
            video_url += "/" + item["slug"]
            video_url += "," + item_type.lower()
            video_url += "-" + str(item["id"])
            return video_url

        if item_type == "SERIAL":
            return None
        raise Exception("Unknown Type: ", str(item))

    @staticmethod
    def sections_handler(collection_url):
        collection = []
        content_id = collection_url.split(",")[-1].split("-")[-1]
        collection_name = None

        episode_index = 0
        first_result = 0
        while True:

            if "/sections/" in collection_url:
                response = json.loads(requests.get(
                    play_tv3_lt.SECTION_URL.format(section_id=content_id),
                    params={
                        'platform': play_tv3_lt.PLATFORM,
                        'lang': play_tv3_lt.LANGUAGE,
                        'tenant': play_tv3_lt.TENANT,
                        "maxResults": play_tv3_lt.PAGE_SIZE,
                        "firstResult": first_result
                    }
                ).content.decode())
                episodes = [e["item"] for e in response.get("elements", [])]
            else:
                response = json.loads(requests.get(
                    play_tv3_lt.CATALOG_URL if "/lives/" in collection_url else play_tv3_lt.VODS_URL,
                    params={
                        'platform': play_tv3_lt.PLATFORM,
                        'lang': play_tv3_lt.LANGUAGE,
                        'tenant': play_tv3_lt.TENANT,
                        "maxResults": play_tv3_lt.PAGE_SIZE,
                        "firstResult": first_result,
                        "categoryId[]": content_id,
                        "sort": "createdAt",
                        "order": "desc"
                    }
                ).content.decode())
                episodes = response.get("items", [])

            first_result += play_tv3_lt.PAGE_SIZE
            if type(response) is list and len(response) == 0:
                return []

            if collection_name is None:
                collection_name = join(
                    join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        play_tv3_lt.__name__
                    ),
                    get_valid_filename(response.get(
                        "title",
                        response.get("slug", collection_url.split("/")[-1].split(",")[0])
                    ))
                )

            if len(episodes) == 0:
                break

            for episode in episodes:
                episode_index += 1

                check = check_range(False, None, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                episode_url = play_tv3_lt.get_video_url(episode)
                if episode_url is None:
                    continue

                episode_title = episode.get("title", episode.get("slug", episode["id"]))
                episode_title = get_valid_filename(episode_title)

                collection.append(BaseElement(
                    url=episode_url,
                    collection=collection_name,
                    element=f'{episode_index}_{episode_title}'
                ))

        return collection

    @staticmethod
    def series_handler(collection_url):
        collection = []
        content_id = collection_url.split(",")[-1].split("-")[-1]
        collection_name = collection_url.split("/")[-1].split(",")[0]

        response = json.loads(requests.get(
            play_tv3_lt.SERIAL_URL.format(serial_id=content_id),
            params={
                'platform': play_tv3_lt.PLATFORM,
                'lang': play_tv3_lt.LANGUAGE,
                'tenant': play_tv3_lt.TENANT
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
                play_tv3_lt.__name__
            ),
            collection_name
        )

        response = json.loads(requests.get(
            play_tv3_lt.SEASONS_URL.format(serial_id=content_id),
            params={
                'platform': play_tv3_lt.PLATFORM,
                'lang': play_tv3_lt.LANGUAGE,
                'tenant': play_tv3_lt.TENANT
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
                    play_tv3_lt.EPISODES_URL.format(
                        serial_id=content_id,
                        season_id=str(season["id"])
                    ),
                    params={
                        'platform': play_tv3_lt.PLATFORM,
                        'lang': play_tv3_lt.LANGUAGE,
                        'tenant': play_tv3_lt.TENANT
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
                    episode_url += "," + episode.get("type_", episode["type"]).lower()
                    episode_url += "-" + str(episode["id"])
                    episode_title = get_valid_filename(episode.get("title", episode["slug"]))

                    collection.append(BaseElement(
                        url=episode_url,
                        collection=join(collection_name, f'Season_{season["number"]}'),
                        element=f"Episode_{episode['episode']}_{episode_title}"
                    ))

            else:
                response = json.loads(requests.get(
                    play_tv3_lt.RELATED_URL.format(product_id=str(season["id"])),
                    params={
                        'platform': play_tv3_lt.PLATFORM,
                        'lang': play_tv3_lt.LANGUAGE,
                        'tenant': play_tv3_lt.TENANT,
                        "maxResults": 1000
                    }
                ).content.decode())
                if type(response) is not list:
                    response = []

                episodes = response
                episode_index = 0
                for episode in episodes:
                    episode_index += 1
                    check = check_range(False, season["number"], episode_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    episode_url = play_tv3_lt.get_video_url(episode)
                    episode_title = get_valid_filename(episode.get("title", episode["slug"]))

                    collection.append(BaseElement(
                        url=episode_url,
                        collection=join(collection_name, f'Season_{season["number"]}_Clips'),
                        element=f"Clip_{episode_index}_{episode_title}"
                    ))

        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.rstrip("/")
        for p in [",vod-", ",episode-", ",clip-", ",programme-", ",live-"]:
            if p in collection_url:
                return [BaseElement(url=collection_url)]

        if "/sections/" in collection_url or "/lives/" in collection_url:
            return play_tv3_lt.sections_handler(collection_url)

        nr_slash = collection_url.split(play_tv3_lt.BASE_URL)[-1].count("/")
        if "," in collection_url and "-" not in collection_url.split(",")[-1] and nr_slash == 2:
            return play_tv3_lt.sections_handler(collection_url)

        if ",serial-" in collection_url:
            return play_tv3_lt.series_handler(collection_url)
        return None
