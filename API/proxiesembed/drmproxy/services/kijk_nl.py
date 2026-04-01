import base64
import builtins
import json
import re
from os.path import join
from urllib.parse import parse_qs, urlparse

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import flatten_list, get_valid_filename, get_ext_from_url


class kijk_nl(BaseService):
    DEMO_URLS = [
        "https://www.kijk.nl/programmas/lang-leve-de-liefde",
        "https://www.kijk.nl/programmas/lingo",
        "https://www.kijk.nl/programmas/vrienden-van-lingo",
        "https://www.kijk.nl/programmas/het-jachtseizoen",
        "https://www.kijk.nl/programmas/camping-de-wildernis/QBhATP8rokD",
        "https://www.kijk.nl/programmas/10-voor-taal/BPSOLHDAwPp",
        "https://www.kijk.nl/films/lock-stock-and-two-smoking-barrels/qw9q3GjAQu7",
        "https://www.kijk.nl/films/venom/D3mFkhATspI",
        "https://www.kijk.nl/programmas/vrienden-van-lingo/krnoeBgBKQrCbl",
    ]

    GRAPHQL_URL = None
    BASE_URL = "https://www.kijk.nl"

    DRM_TOKEN = None
    MAN_PRIORITY = {"": 0, "m3u8": 1, "ism": 2, "dash": 3}
    PAGE_SIZE = 50

    @staticmethod
    def test_service():
        main_service.run_service(kijk_nl)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_site_info():
        graphql_url = json.loads(re.findall(
            r'type="application/json"[^<>]*>({.*?})</script>',
            requests.get(kijk_nl.BASE_URL).content.decode()
        )[0])["props"]["pageProps"]["videoApiUrl"]

        drm_token = json.loads(requests.get(
            graphql_url, params={'query': '{ drmToken { token } }'}
        ).content.decode())["data"]["drmToken"]["token"]
        return graphql_url, drm_token

    @staticmethod
    def initialize_service():
        if kijk_nl.GRAPHQL_URL is None or kijk_nl.DRM_TOKEN is None:
            kijk_nl.GRAPHQL_URL, kijk_nl.DRM_TOKEN = kijk_nl.get_site_info()
        return kijk_nl

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            additional["license_url"],
            headers={'authorization': f'Basic {kijk_nl.DRM_TOKEN}'},
            json={
                'getRawWidevineLicense': {
                    'releasePid': additional["release_pid"],
                    'widevineChallenge': base64.b64encode(challenge).decode()
                }
            }
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        guid = source_element.url.split("/")[-1]
        page_dict = json.loads(re.findall(
            r'type="application/json"[^<>]*>({.*?})</script>',
            requests.get(source_element.url).content.decode()
        )[0]).get("props", {})

        response = page_dict.get("pageProps", {}).get("formatDataInitial", {}).get("video", {})
        if response.get("guid", None) != guid:
            response = page_dict.get("apolloState", {})

            for k, v in response.items():
                if not k.startswith("Program:"):
                    continue
                if v.get("guid", None) != guid:
                    continue

                response = v
                break

        if source_element.element is None:
            title = response.get("title", None)
            if title in ["", None]:
                title = response.get("slug", None)
            title = get_valid_filename(title)
            if title is None:
                title = guid
            source_element.element = title
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                kijk_nl.__name__
            )

        subtitles = []
        index = 0
        output_path = join(source_element.collection, source_element.element)

        for track in response.get("tracks", []):
            if track.get("kind", "").lower() not in ["captions"]:
                continue
            index += 1

            srt_url = track["file"]
            srt_ext = get_ext_from_url(srt_url)
            srt_code = get_valid_filename(track["label"].lower())

            subtitles.append((False, BaseElement(
                url=srt_url,
                collection=output_path,
                element=f'subtitle_{index}_{srt_code}{srt_ext}'
            )))

        additional = {"SUBTITLES": subtitles}
        response = json.loads(requests.get(
            kijk_nl.GRAPHQL_URL,
            params={
                'operationName': 'sources', 'variables': json.dumps({"guid": guid}),
                'query': '''
                    query sources($guid:[String]) {
                        programs(guid:$guid) { items { guid sources { type file drm } } }
                    }
                '''
            }
        ).content.decode())["data"]["programs"]["items"]

        response = [r["sources"] for r in response if r["guid"] == guid]
        response = flatten_list(response)
        if len(response) == 0:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        response = list(filter(
            lambda r: len(parse_qs(urlparse(r["file"]).query).keys()) > 0,
            response
        ))
        if len(response) == 0:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need Dutch IP to access content",
                solution="Use a VPN"
            ))

        response = list(filter(
            lambda r: r.get("drm", {}) in [None, {}], response
        )) + list(filter(
            lambda r: len(list(filter(
                lambda d: "widevine" in d.lower(),
                list(r["drm"].keys())
            ))) > 0,
            list(filter(lambda r: r.get("drm", {}) not in [None, {}], response))
        ))
        if len(response) == 0:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason=f"DRM not supported. Widevine wasn't found",
                solution="Do not attempt to download it"
            ))

        response = sorted(
            response, reverse=True,
            key=lambda r: kijk_nl.MAN_PRIORITY.get(r["type"].lower(), "")
        )
        if response[0]["type"].lower() not in ["dash", "ism"] and response[0].get("drm", {}) not in [{}, None]:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Manifest format not supported: {str(response)}. Can't extract pssh",
                solution=f"Extend the {kijk_nl.__name__} service"
            ))

        response = response[0]
        manifest = response["file"]
        try:
            if response.get("drm", {}) in [None, {}]:
                raise
            for k, v in response["drm"].items():
                if "widevine" in k.lower():
                    additional["license_url"] = v["url"]
                    additional["release_pid"] = v["releasePid"]
                    break

            pssh_value = str(min(re.findall(
                r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                requests.get(manifest).content.decode()
            ), key=len))
        except:
            pssh_value = None

        return manifest, pssh_value, additional

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.rstrip("/")
        if "/programmas/" in collection_url or "/films/" in collection_url:
            if collection_url.split(kijk_nl.BASE_URL)[-1].count("/") > 2:
                return [BaseElement(url=collection_url)]
        if "/programmas/" not in collection_url:
            return None

        slug = collection_url.split("/")[-1]
        response = json.loads(re.findall(
            r'type="application/json"[^<>]*>({.*?})</script>',
            requests.get(collection_url).content.decode()
        )[0]).get("props", {}).get("pageProps", {}).get("formatDataInitial", {}).get("format", {})

        if slug != response.get("slug", ""):
            return []
        collection_name = get_valid_filename(response.get("title", slug))
        collection_name = join(join(
            str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
            kijk_nl.__name__
        ), collection_name)

        seasons = []
        for s1 in ["seasonList", "seriesTvSeasons"]:
            s2 = response.get(s1, [])
            if len(s2) == 0:
                continue

            for s3 in s2:
                season_id = s3.get("value", "")
                if len(season_id) == 0:
                    season_id = s3["id"].split("/")[-1]

                season_number = s3.get("seasonNumber", 0)
                season_title = s3["guid"]
                for st in ["title", 'label', 'ariaLabel']:
                    if s3.get(st, "") not in [None, ""]:
                        season_title = s3[st]
                        break

                season_title = get_valid_filename(f'Season_{season_number}_{season_title}')
                seasons.append((
                    season_id, season_number, season_title,
                    "tvSeasonId", "EPISODE"
                ))
            break

        seasons = sorted(seasons, key=lambda season: season[1])
        season_index = 0
        if len(seasons) > 0:
            season_index = seasons[-1][1]
        seasons.append((
            response["id"], season_index + 1,
            f'Season_{season_index + 1}_Clips',
            'seriesId', 'CLIP'
        ))

        content_query = """
            query programs(
                $tvSeasonId: String, $programTypes: [ProgramType], $seriesId: String,
                $skip: Int, $limit: Int, $sort: ProgramSortKey, $guid: [String]
            ) {
                programs(
                    tvSeasonId: $tvSeasonId, programTypes: $programTypes, seriesId: $seriesId,
                    skip: $skip, limit: $limit, sort: $sort, guid: $guid
                ) { totalResults items { guid slug title } }
            }
        """

        collection = []
        for season_id, season_number, season_title, id_type, program_type in seasons:
            check = check_range(True, season_number, None)
            if check is True:
                continue
            elif check is False:
                return collection

            skip = 0
            episode_index = 0

            while True:
                request_params = {
                    'query': content_query,
                    'operationName': 'programs',
                    'variables': {
                        "programTypes": program_type,
                        "skip": skip,
                        "limit": kijk_nl.PAGE_SIZE,
                        id_type: season_id
                    }
                }
                if program_type == "CLIP":
                    request_params["variables"]["sort"] = 'PUBLICATIONDATETIME'
                request_params["variables"] = json.dumps(request_params["variables"])

                response = json.loads(requests.get(
                    kijk_nl.GRAPHQL_URL, params=request_params
                ).content.decode())["data"]["programs"].get("items", [])

                if len(response) == 0:
                    break
                skip += kijk_nl.PAGE_SIZE

                for episode in response:
                    episode_index += 1
                    check = check_range(False, season_number, episode_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    episode_title = episode["guid"]
                    for et in ["title", 'slug']:
                        if episode.get(et, "") not in [None, ""]:
                            episode_title = episode[et]
                            break
                    episode_title = get_valid_filename(episode_title)

                    collection.append(BaseElement(
                        url=collection_url + "/" + episode["guid"],
                        collection=join(collection_name, season_title),
                        element=f"Episode_{episode_index}"
                                f"_"
                                f"{episode_title}"
                    ))

        return collection
