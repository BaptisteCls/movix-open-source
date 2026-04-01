import base64
import builtins
import json
import os
import re
import threading
from os.path import join
from urllib.parse import quote, parse_qs, urlparse

import isodate
import requests
import xmltodict
from pywidevine import PSSH

from utils.constants.macros import USER_ERROR, ERR_MSG
from utils.main_service import main_service
from utils.pssh_box.pssh_box import _parse_boxes, _generate_widevine_data, widevine_pssh_data_pb2
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename


class fifa_com(BaseService):
    DEMO_URLS = [
        "https://www.fifa.com/en/search?q=football+future&source=FIFA&ftype=video%2CvideoEpisode%2Cmovie&fdateFrom=2023-8-13&fsortBy=dateDesc&fpage=2",
        "https://www.fifa.com/en/watch/series/1Iu4eLzBYq5IB3Vmo0p1Iv/2IRouvwslVX67tzEWkKKQO/4yqqJewWMqxizXYpuRu7ER",
        "https://www.fifa.com/en/watch/series/3to1B8QAwfphSKO7TO5fz/243cTtTU0bNJcnRzHXhWuu/p4cFrSmlPcV2Eq9QHEHTH",
        "https://www.fifa.com/en/watch/movie/3lFf41pUt0hft8FPnqGgxf",
        "https://www.fifa.com/en/watch/movie/5U5nbmAEMkCR2NsL3yeKkM",
        "https://www.fifa.com/en/watch/1lCxgqjZaH0CNHkVzpl0za",
        "https://www.fifa.com/en/watch/f4fca463-7321-4019-b0ca-96a221608c28",
        "https://www.fifa.com/en/watch/7wST4MTAbpXRAAmufEpCbx",
        "https://www.fifa.com/en/watch/2PPgztGTe9gXubqGkHaDoT",
        "https://www.fifa.com/en/watch/1mTRUzxa860cV3SUfs2xXC",
    ]

    VIDEO_PLAYER_URL = 'https://cxm-api.fifa.com/fifaplusweb/api/videoPlayerData/{video_id}'
    PREPLAY_URL = 'https://content.uplynk.com/preplay/{content_id}/multiple.json'
    LICENSE_URL = 'https://content-aeui1.uplynk.com/wv'
    EPISODES_URL = 'https://cxm-api.fifa.com/fifaplusweb/api/sections/videoEpisodeDetails'
    MOVIE_URL = 'https://cxm-api.fifa.com/fifaplusweb/api/sections/movieDetails/{movie_id}'
    SEARCH_URL = 'https://cxm-api.fifa.com/fifacxmsearch/api/results'
    REDIRECT_URL = 'https://cxm-api.fifa.com/fifaplusweb/api/pages/{page}'
    BASE_URL = "https://www.fifa.com"

    SEARCH_KEY = None
    PAGE_SIZE = 25
    USER_AGENT = None
    PLUS_SERVICE = None
    LOCALE = 'en'
    INTRO_DURATION = 5
    LOCK = None
    IS_VALID_MANIFEST = None

    @staticmethod
    def test_service():
        main_service.run_service(fifa_com)

    @staticmethod
    def get_additional_params(additional):
        if additional.get("PLUS_SERVICE", False) is True and fifa_com.PLUS_SERVICE is not None:
            return fifa_com.PLUS_SERVICE.get_additional_params(additional)
        return []

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_search_key():
        return re.search(
            r'"SEARCH_KEY":"(.+?)"',
            requests.get(
                fifa_com.BASE_URL,
                headers={'User-Agent': fifa_com.USER_AGENT}
            ).content.decode()
        ).group(1)

    @staticmethod
    def initialize_service():
        if fifa_com.USER_AGENT is None:
            fifa_com.USER_AGENT = builtins.CONFIG["USER_AGENT"]

        try:
            # raise
            from services.plus_fifa_com import plus_fifa_com
            fifa_com.PLUS_SERVICE = plus_fifa_com.initialize_service()
        except:
            fifa_com.PLUS_SERVICE = None

        if fifa_com.LOCK is None:
            fifa_com.LOCK = threading.Lock()
        if fifa_com.SEARCH_KEY is None:
            fifa_com.SEARCH_KEY = fifa_com.get_search_key()
        return fifa_com

    @staticmethod
    def get_keys(challenge, additional):
        if additional.get("PLUS_SERVICE", False) is True:
            if fifa_com.PLUS_SERVICE is None:
                raise Exception(
                    f'{BaseService.get_keys.__name__} must not be called '
                    f'for the {fifa_com.__name__} service'
                )
            return fifa_com.PLUS_SERVICE.get_keys(challenge, additional)

        licence = requests.post(additional["license_url"], data=challenge)
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def search_m3u8(m3u8):
        try:
            response = requests.get(m3u8).content.decode()
            response = re.findall(r'https://[^\s]+', response)

            for u in response:
                if ".ts?" in u:
                    response = requests.get(u).status_code
                    return 200 <= response < 300
            return None
        except:
            pass
        return False

    @staticmethod
    def is_valid_manifest(manifest):
        # return False
        try:
            response = requests.get(manifest).content.decode()
            response = re.findall(r'https://[^\s]+', response)

            for u in response:
                if ".m3u8?" in u:
                    is_valid = fifa_com.search_m3u8(u)
                    if is_valid is not None:
                        return is_valid

        except:
            pass
        return False

    @staticmethod
    def get_mpd_video_data(manifest, source_element):
        manifest = manifest.replace(".m3u8?", ".mpd?")
        response = requests.get(manifest).content.decode()
        response = xmltodict.parse(response)

        kids_psshs = []
        periods = response["MPD"].get("Period", [])
        if type(periods) is not list:
            periods = [periods]

        filtered_periods = []
        for period in periods:
            if period.get("@duration", None) is None:
                continue
            duration = isodate.parse_duration(period["@duration"])
            duration = duration.total_seconds()
            if duration < fifa_com.INTRO_DURATION:
                continue

            filtered_periods.append(period)
            adaptations = period.get("AdaptationSet", [])
            if type(adaptations) is not list:
                adaptations = [adaptations]

            for adaptation in adaptations:
                protections = adaptation.get("ContentProtection", [])
                if type(protections) is not list:
                    protections = [protections]

                current_kid, current_pssh, license_url = None, None, None
                for protection in protections:
                    if protection.get("@cenc:default_KID", None) is not None:
                        current_kid = protection["@cenc:default_KID"]
                    if PSSH.SystemId.Widevine.__str__() in protection.get("@schemeIdUri", ""):
                        current_pssh = protection["cenc:pssh"]["#text"]
                        license_url = protection.get("ms:laurl", {}).get("@licenseUrl", None)

                    if current_kid is not None and current_pssh is not None:
                        break

                if current_kid is None or current_pssh is None:
                    continue
                kids_psshs.append((current_kid.replace("-", ""), current_pssh, license_url))

        content_id_dict = {}
        pssh_data_dict = {}
        for k, p, l in kids_psshs:
            pssh_box = _parse_boxes(base64.b64decode(p))[0]
            pssh_data = widevine_pssh_data_pb2.WidevinePsshData()
            pssh_data.ParseFromString(pssh_box.pssh_data)

            if not pssh_data.HasField('content_id'):
                continue
            content_id = str(base64.b16encode(pssh_data.content_id).decode())

            if l is None:
                try:
                    license_args = pssh_data.content_id.decode().split("_")
                    l = (
                        f'https://content-{license_args[1]}.uplynk.com/wv'
                        f'?b={license_args[0]}'
                        f'&v={license_args[0]}'
                        f'&pbs={license_args[2]}'
                    )
                except:
                    l = fifa_com.LICENSE_URL

            provider = None
            if pssh_data.HasField('provider'):
                provider = pssh_data.provider
            protection_scheme = None
            if pssh_data.HasField('protection_scheme'):
                protection_scheme = pssh_data.protection_scheme

            content_id_dict[content_id] = content_id_dict.get(content_id, []) + [(k, l)]
            if pssh_data_dict.get(content_id, None) is None:
                pssh_data_dict[content_id] = (provider, protection_scheme, pssh_data.content_id)

        merged_psshs = []
        for cid, kid_license in content_id_dict.items():
            kids = [kid.encode() for kid, _ in kid_license]
            provider, protection_scheme, raw_cid = pssh_data_dict[cid]

            pssh_data = _generate_widevine_data(
                key_ids=kids,
                content_id=raw_cid,
                provider=provider,
                protection_scheme=protection_scheme
            )
            merged_pssh = PSSH.new(init_data=pssh_data, system_id=PSSH.SystemId.Widevine)
            merged_psshs.append((merged_pssh.__str__(), kid_license[0][1]))

        additional = {}
        psshs = []
        for pssh, license_url in merged_psshs:
            psshs.append(pssh)
            additional[pssh] = {"license_url": license_url}

        response["MPD"]["Period"] = filtered_periods
        manifest = xmltodict.unparse(response, pretty=True)

        output_path = join(source_element.collection, source_element.element)
        if not os.path.exists(output_path):
            os.makedirs(output_path)
        output_path = join(str(output_path), "master.mpd")

        with open(output_path, "w") as f:
            f.write(manifest)
        return output_path, psshs, additional

    @staticmethod
    def get_video_data(source_element):
        if fifa_com.PLUS_SERVICE is not None and "/watch/series/" not in source_element.url:
            response = requests.get(
                source_element.url, allow_redirects=False,
                headers={"User-Agent": fifa_com.USER_AGENT}
            )
            if response.headers.get("Location", None) is not None:
                temp_element = BaseElement()
                temp_element.copy(source_element)
                source_element.url = response.headers["Location"].rstrip("/")

                try:
                    return fifa_com.PLUS_SERVICE.get_video_data(source_element)
                except Exception as e:
                    source_element.copy(temp_element)
                    if type(e) is not CustomException:
                        raise e

        video_id = re.search(r"/watch/([^/?]*)", source_element.url).group(1)
        category_type = video_id
        if category_type == "series":
            video_id = source_element.url.split("/watch/")[1].split("/")[1:]

            response = requests.get(
                fifa_com.EPISODES_URL, params={
                    'locale': fifa_com.LOCALE, 'seriesId': video_id[0],
                    'seasonId': video_id[1], 'episodeId': video_id[2]
                }
            )

            if response.status_code == 404:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason="This content isn't available",
                    solution='Do not attempt to download it'
                ))

            response = json.loads(response.content.decode())
            if source_element.element is None:
                for f in ["title", "internalTitle", "episodeInternalTitle"]:
                    if response.get(f, None) in ["", None]:
                        continue

                    source_element.element = get_valid_filename(response[f])
                    break

            if source_element.element is None:
                source_element.element = get_valid_filename(f"Episode_{video_id[2]}")
            video_id = response["videoEntryId"]

        elif category_type == "movie":
            video_id = re.search(r"/watch/[^/]*/([^/?]*)", source_element.url).group(1)

            response = requests.get(
                fifa_com.MOVIE_URL.format(movie_id=video_id),
                params={'locale': fifa_com.LOCALE}
            )

            if response.status_code == 404:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason="This content isn't available",
                    solution='Do not attempt to download it'
                ))

            response = json.loads(response.content.decode())
            metadata = response.get("video", {})
            if source_element.element is None:

                for f in ["title", "internalTitle"]:
                    if metadata.get(f, None) in ["", None]:
                        continue

                    source_element.element = get_valid_filename(metadata[f])
                    break

            if source_element.element is None:
                source_element.element = get_valid_filename(f"Movie_{video_id}")
            video_id = metadata["videoEntryId"]

        response = requests.get(
            fifa_com.VIDEO_PLAYER_URL.format(video_id=video_id),
            params={'locale': fifa_com.LOCALE}
        )

        status_code = response.status_code
        if status_code == 404:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="This content isn't available",
                solution='Do not attempt to download it'
            ))

        response = json.loads(response.content.decode())
        if source_element.element is None:
            source_element.element = get_valid_filename(response.get('title', video_id))
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                fifa_com.__name__
            )

        response = response["preplayParameters"]
        preplay_url = fifa_com.PREPLAY_URL.format(content_id=response["contentId"])
        if response.get("queryStr", None) is not None:
            preplay_url += "?" + response["queryStr"]
        if response.get("signature", None) is not None:
            if "?" not in preplay_url:
                preplay_url += "?"
            else:
                preplay_url += "&"
            preplay_url += "sig=" + quote(response["signature"])

        response = json.loads(requests.get(preplay_url).content.decode())
        manifest = response["playURL"]

        if fifa_com.IS_VALID_MANIFEST is None:
            with fifa_com.LOCK:
                if fifa_com.IS_VALID_MANIFEST is None:
                    fifa_com.IS_VALID_MANIFEST = fifa_com.is_valid_manifest(manifest)

        if fifa_com.IS_VALID_MANIFEST:
            return manifest, None, {}
        return fifa_com.get_mpd_video_data(manifest, source_element)

    @staticmethod
    def get_collection_elements(collection_url):
        if "/watch/" in collection_url and "/series/" not in collection_url:
            return [BaseElement(url=collection_url)]

        if "/watch/series/" in collection_url:
            if fifa_com.PLUS_SERVICE is not None:
                redirect_url = fifa_com.REDIRECT_URL.format(
                    page=collection_url.split(fifa_com.BASE_URL)[1][1:]
                )
                response = requests.get(redirect_url, headers={"User-Agent": fifa_com.USER_AGENT})
                response = json.loads(response.content.decode()).get("redirectUrl", None)

                if response is not None:
                    temp_url = str(collection_url)
                    collection_url = response

                    try:
                        return fifa_com.PLUS_SERVICE.get_collection_elements(collection_url)
                    except Exception as e:
                        collection_url = temp_url
                        if type(e) is not CustomException:
                            raise e

            video_id = collection_url.split("/watch/series/")[1].split("/")
            if len(video_id) < 3:
                return None

            series_season_id = video_id[1]
            series_episode_id = video_id[2]
            response = requests.get(
                fifa_com.EPISODES_URL, params={
                    'locale': fifa_com.LOCALE, 'seriesId': video_id[0],
                    'seasonId': series_season_id, 'episodeId': series_episode_id
                }
            )
            if response.status_code == 404:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=collection_url,
                    reason="This content isn't available",
                    solution='Do not attempt to download it'
                ))
            response = json.loads(response.content.decode())

            collection_title = None
            for f in ["seriesTitle", "seriesInternalTitle"]:
                if response.get(f, None) in ["", None]:
                    continue

                collection_title = response[f]
                break
            if collection_title is None:
                collection_title = f'Series_{video_id[0]}'
            collection_title = join(
                join(
                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                    fifa_com.__name__
                ),
                get_valid_filename(collection_title)
            )

            collection = []
            seasons = response.get("seasons", [])
            seasons = sorted(seasons, key=lambda s: int(s["seasonNumber"]))
            for season in seasons:
                check = check_range(True, season["seasonNumber"], None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                episodes = season.get("episodes", [])
                episodes = sorted(episodes, key=lambda e: int(e["episodeNumber"]))
                for episode in episodes:
                    check = check_range(False, season["seasonNumber"], episode["episodeNumber"])
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    episode_title = None
                    for f1 in [None, "video", "videoPlayerdata"]:
                        if f1 is None:
                            metadata = episode
                        else:
                            metadata = episode.get(f1, {})
                        if metadata in [{}, None, ""]:
                            continue
                        if type(metadata) is not dict:
                            continue

                        for f2 in ["title", "internalTitle", "slug"]:
                            if metadata.get(f2, None) in ["", None]:
                                continue

                            episode_title = metadata[f2]
                            break

                        if episode_title is not None:
                            break

                    if episode_title is None:
                        episode_title = episode["episodeId"]
                    episode_title = get_valid_filename(f'Episode_{episode["episodeNumber"]}_{episode_title}')

                    collection.append(BaseElement(
                        url=collection_url.replace(
                            series_episode_id, episode["episodeId"]
                        ).replace(series_season_id, season["seasonId"]),
                        collection=join(collection_title, f'Season_{season["seasonNumber"]}'),
                        element=episode_title
                    ))
            return collection

        if "/search?" in collection_url and "source=" in collection_url:
            params_dict = parse_qs(urlparse(collection_url).query)
            if params_dict["source"][0].lower() not in ["fifa"]:
                return None
            for k, v in params_dict.items():
                params_dict[k] = v[0]

            collection_name = f'Filters_{collection_url.split("?")[1]}'
            collection_name = join(
                join(
                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                    fifa_com.__name__
                ),
                get_valid_filename(collection_name)[0:50]
            )

            search_query = {
                'locale': fifa_com.LOCALE, 'clientType': 'fifaplus',
                'type': 'search', 'context': 'default',
                'size': fifa_com.PAGE_SIZE, 'dateFrom': '1900-01-01'
            }
            for k, v in params_dict.items():
                if k == 'q':
                    search_query['searchString'] = v
                    continue
                if k == 'ftype':
                    if v == 'all':
                        v = 'article,document,video,movie,videoEpisode'
                    search_query["contentType"] = v
                    continue
                if k == 'fsortBy':
                    search_query["sort"] = v
                    continue
                if k == 'fdateFrom':
                    search_query['dateFrom'] = v
                    continue
                if k in ["source", "fpage"]:
                    continue
                search_query[k] = v
            collection = []

            content_index = -fifa_com.PAGE_SIZE
            page_index = 0
            while True:
                page_index += 1
                content_index += fifa_com.PAGE_SIZE

                check = check_range(True, page_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                search_query['from'] = content_index
                response = json.loads(requests.get(
                    fifa_com.SEARCH_URL,
                    headers={'X-Functions-Key': fifa_com.SEARCH_KEY},
                    params=search_query
                ).content.decode())

                hit_index = 0
                hits = response.get("hits", {}).get("hits", [])
                if len(hits) == 0:
                    break

                for hit in hits:
                    hit_index += 1
                    check = check_range(False, page_index, hit_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    information = json.loads(hit["_source"]["additionalInformation"])
                    if information["ArticleId"] is not None:
                        continue
                    content_id = None
                    for f in ["VideoEntryId", "MovieId", "VideoEpisodeId", "VideoSeasonId", "VideoSeriesId"]:
                        if information[f] is not None:
                            content_id = information[f]
                            break
                    if content_id is None:
                        continue

                    hit_title = hit.get("title", None)
                    if hit_title is None:
                        hit_title = information.get("InternalTitle", None)
                    if hit_title is None:
                        hit_title = content_id
                    hit_title = get_valid_filename(f'V{hit_index}_{hit_title}')
                    hit_url = hit["_source"]["url"]

                    collection.append(BaseElement(
                        url=hit_url,
                        collection=join(collection_name, f'Page_{page_index}'),
                        element=hit_title
                    ))

            return collection
        return None
