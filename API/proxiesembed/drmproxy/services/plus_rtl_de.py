import base64
import builtins
import json
import os
import re
from os.path import join
from urllib.parse import urlparse, parse_qs

import requests
from bs4 import BeautifulSoup

from utils.constants.macros import ERR_MSG, USER_ERROR, CACHE_DIR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, dict_to_file, file_to_dict


class plus_rtl_de(BaseService):
    DEMO_URLS = [
        "https://plus.rtl.de/video-tv/shows/ich-bin-ein-star-showdown-der-dschungel-legenden-989299/staffel-1-989300/episode-9-tag-9-989309",
        "https://plus.rtl.de/podcast/toni-kroos-the-underrated-one-zwqyvph7kq6n6",
        "https://plus.rtl.de/podcast/skandal-skandal-l57kf1b0tfhj9",
        "https://plus.rtl.de/podcast/geschichten-aus-der-geschichte-ibf6ymv2kicvq/gag461-das-laengste-autorennen-der-welt-pokffmsrgtd0o",
        "https://plus.rtl.de/podcast/dont-worry-be-haenni-k4na6aep6529j/17-nippelklappe-offen-tsmc6mdrqb82k",
        "https://plus.rtl.de/video-tv/live-tv/bauer-sucht-frau-62",
        "https://plus.rtl.de/video-tv/live-tv/rtl-shine-67",
        "https://plus.rtl.de/video-tv/serien/barbara-salesch-das-strafgericht-940586",
        "https://plus.rtl.de/video-tv/shows/goodbye-deutschland-die-auswanderer-771084",
        "https://plus.rtl.de/video-tv/serien/alarm-fuer-cobra-11-die-autobahnpolizei-41906",
        "https://plus.rtl.de/video-tv/serien/pretty-little-liars-summer-school-946099",
        "https://plus.rtl.de/video-tv/serien/bushido-anna-maria-alle-auf-tour-992554",
        "https://plus.rtl.de/video-tv/shows/princess-charming-883086",
        "https://plus.rtl.de/video-tv/serien/medical-detectives-geheimnisse-der-gerichtsmedizin-241410",
        "https://plus.rtl.de/video-tv/serien/disko-76-914295/staffel-1-914296/episode-1-folge-1-914297",
        "https://plus.rtl.de/video-tv/shows/hilfe-die-camper-kommen-861468/2023-4-971471/episode-6-die-verbleibenden-paare-erreichen-ihr-ziel-in-spanien-861475",
        "https://plus.rtl.de/video-tv/filme/soziale-brennpunkte-was-passiert-mit-unseren-staedten-844861",
        "https://plus.rtl.de/video-tv/shows/jamies-5-zutaten-kueche-798218/staffel-1-798219/episode-4-von-spaghetti-mit-ricotta-bis-apple-crumble-cookies-798223",
    ]

    GRAPHQL_URL = 'https://cdn.gateway.now-plus-prod.aws-cbc.cloud/graphql'
    TOKEN_URL = 'https://auth.rtl.de/auth/realms/rtlplus/protocol/openid-connect/token'
    AUTH_URL = 'https://auth.rtl.de/auth/realms/rtlplus/protocol/openid-connect/auth'
    BASE_URL = "https://plus.rtl.de"

    AUTH_TOKEN = None
    RES_PRIORITY = {"sd": 0, "hd": 1, "free": 2}
    EMAIL = ""
    PASSWORD = "YOUR_PASSWORD (leave at least one field empty if you don't want to use an account)"
    CACHE_FILE = None
    ACCOUNT_QUALITY = None
    CLIENT_ID = 'rci:rtlplus:web'
    CLIENT_VERSION = 'rtlplus-client-Version'
    PAGE_LIMIT = 50

    @staticmethod
    def test_service():
        main_service.run_service(plus_rtl_de)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/live-tv/" in content

    @staticmethod
    def credentials_needed():
        return {
            "OPTIONAL": True,
            "EMAIL": plus_rtl_de.EMAIL,
            "PASSWORD": plus_rtl_de.PASSWORD
        }

    @staticmethod
    def get_public_access_token():
        main_js = plus_rtl_de.BASE_URL + "/" + re.search(
            r'src="(main.*?\.js)"',
            requests.get(plus_rtl_de.BASE_URL).content.decode()
        ).group(1)
        client_secret = re.search(
            r'client_secret:"([^"]+)"', requests.get(main_js).content.decode()
        ).group(1)

        return json.loads(requests.post(
            plus_rtl_de.TOKEN_URL, data={
                'grant_type': 'client_credentials',
                'client_id': 'anonymous-user',
                'client_secret': client_secret
            }
        ).content.decode())["access_token"]

    @staticmethod
    def get_access_token():
        class_name = plus_rtl_de.__name__.replace("_", ".")
        credentials = builtins.CONFIG["SERVICE_CREDENTIALS"][class_name]
        try:
            assert type(credentials["EMAIL"]) is str
            assert type(credentials["PASSWORD"]) is str
        except:
            return None
        if credentials["EMAIL"].strip() == "" or credentials["PASSWORD"].strip() == "":
            return plus_rtl_de.get_public_access_token()

        try:
            tokens_dict = file_to_dict(plus_rtl_de.CACHE_FILE)
            assert len(tokens_dict.keys()) == 2
            for k in ["access_token", "refresh_token"]:
                assert (len(tokens_dict[k])) > 0

            response = requests.post(
                plus_rtl_de.TOKEN_URL, data={
                    'grant_type': 'refresh_token', 'client_id': 'rtlplus-web',
                    'refresh_token': tokens_dict["refresh_token"]
                }
            )
            response = json.loads(response.content.decode())

            tokens_dict = {
                "access_token": response["access_token"],
                "refresh_token": response["refresh_token"]
            }
            dict_to_file(plus_rtl_de.CACHE_FILE, tokens_dict)
            return tokens_dict["access_token"]
        except:
            pass

        response = requests.get(
            plus_rtl_de.AUTH_URL, allow_redirects=False,
            params={
                'redirect_uri': plus_rtl_de.BASE_URL,
                'client_id': 'rtlplus-web',
                'response_mode': 'query',
                'response_type': 'code'
            }
        )

        login_form_cookies = {}
        for s1 in dict(response.headers)["set-cookie"].split(";"):
            for s2 in s1.split(","):
                if "=" not in s2:
                    continue

                index = s2.find("=")
                login_form_cookies[s2[0:index]] = s2[index + 1:]

        response_soup = BeautifulSoup(response.content.decode(), 'html5lib')
        form_login = response_soup.find('form', attrs={'id': 'rtlplus-form-login'})
        response = requests.post(
            form_login["action"], cookies=login_form_cookies,
            allow_redirects=False, data={
                'credentialId': '', 'rememberMe': 'on',
                'username': credentials["EMAIL"],
                'password': credentials["PASSWORD"]
            }
        )
        if response.headers.get("location", None) is None:
            return None

        location_params = parse_qs(urlparse(response.headers["location"]).query)
        response = requests.post(
            plus_rtl_de.TOKEN_URL,
            data={
                'code': location_params["code"][0],
                'redirect_uri': plus_rtl_de.BASE_URL,
                'grant_type': 'authorization_code',
                'client_id': 'rtlplus-web'
            }
        )
        response = json.loads(response.content.decode())

        tokens_dict = {
            "access_token": response["access_token"],
            "refresh_token": response["refresh_token"]
        }
        dict_to_file(plus_rtl_de.CACHE_FILE, tokens_dict)
        return tokens_dict["access_token"]

    @staticmethod
    def get_account_quality():
        try:
            auth_token = plus_rtl_de.AUTH_TOKEN.split(".")[1]
            auth_token = base64.b64decode(auth_token + "==")
            auth_token = json.loads(auth_token.decode())

            qualities = auth_token["permissions"]["streaming"]
            return {
                "vod": qualities["vodQuality"].lower(),
                "live": qualities["liveQuality"].lower(),
                "fast": qualities["fastQuality"].lower()
            }
        except:
            return {}

    @staticmethod
    def initialize_service():
        if plus_rtl_de.CACHE_FILE is None:
            plus_rtl_de.CACHE_FILE = join(CACHE_DIR, f'{plus_rtl_de.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(plus_rtl_de.CACHE_FILE, {})

        if plus_rtl_de.AUTH_TOKEN is None:
            plus_rtl_de.AUTH_TOKEN = plus_rtl_de.get_access_token()
            if plus_rtl_de.AUTH_TOKEN is None:
                return None

        if plus_rtl_de.ACCOUNT_QUALITY is None:
            plus_rtl_de.ACCOUNT_QUALITY = plus_rtl_de.get_account_quality()
        return plus_rtl_de

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            additional["license_url"], data=challenge,
            headers={'x-auth-token': plus_rtl_de.AUTH_TOKEN}
        )
        try:
            licence.raise_for_status()
        except Exception as e:
            response = e.response
            if response.status_code == 403:
                response = response.content.decode()
                for m in ["proxy", "location"]:
                    if m in response:
                        raise CustomException(ERR_MSG.format(
                            type=f'{USER_ERROR}',
                            url=additional["URL"],
                            reason="Need German IP to make the license call",
                            solution="Use a VPN (a good one that is not detected)"
                        ))
                if "free" in response or "premium.package" in response:
                    raise CustomException(ERR_MSG.format(
                        type=f'{USER_ERROR}',
                        url=additional["URL"],
                        reason="Cannot download paid content",
                        solution="Do not attempt to download paid content"
                    ))
            raise e
        return licence.content

    @staticmethod
    def replace_vod_manifest_digits(manifest, mpd_name, digit_index, digit_value):
        try:
            digits_pattern = fr'/(\d+[-\d+\w*]*)\.ism/{mpd_name}\.mpd'
            digits = re.findall(digits_pattern, manifest)
            if len(digits) == 0:
                return manifest

            digits = digits[0].split("-")
            if len(digits) <= 1:
                return manifest

            digits[digit_index] = digit_value
            digits = "/" + "-".join(digits) + f".ism/{mpd_name}.mpd"
            manifest = re.sub(digits_pattern, digits, manifest)
            return manifest
        except:
            return manifest

    @staticmethod
    def adjust_manifest(manifest, content_type):
        if content_type == "vod" and plus_rtl_de.ACCOUNT_QUALITY.get(content_type, "") not in ["hd", "high"]:
            if manifest.endswith(".ism/rtlplus.mpd"):
                return plus_rtl_de.replace_vod_manifest_digits(manifest, "rtlplus", 1, "10000")

            elif manifest.endswith(".ism/v1.mpd"):
                try:
                    i = -1
                    for f in manifest.split(".ism/v1.mpd")[0].split("/")[-1].split("-"):
                        i += 1
                        if re.search(r'[a-zA-Z]+', f):
                            return plus_rtl_de.replace_vod_manifest_digits(manifest, "v1", i + 1, "1")
                except:
                    pass
                return plus_rtl_de.replace_vod_manifest_digits(manifest, "v1", -2, "1")
        return manifest

    @staticmethod
    def generate_audio_m3u8(output_path, manifest, content_info):
        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"
        m3u8_content += f'#EXTINF:{content_info.get("duration", 1)},\n'
        m3u8_content += f'{manifest}\n'

        m3u8_content += "#EXT-X-ENDLIST\n"
        with open(output_path, "w") as f:
            f.write(m3u8_content)

    @staticmethod
    def generate_master_m3u8(source_element, manifest, content_info):
        output_path = str(join(source_element.collection, source_element.element))
        if not os.path.exists(output_path):
            os.makedirs(output_path)
        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"

        title = f'audio.m3u8'
        extension = manifest.split(".")[-1]
        plus_rtl_de.generate_audio_m3u8(join(output_path, title), manifest, content_info)
        m3u8_content += f"#EXT-X-STREAM-INF:BANDWIDTH=1000,TYPE=AUDIO,MIME-TYPE=\"audio/{extension}\"\n"
        m3u8_content += f'{title}\n'

        output_path = join(output_path, "master.m3u8")
        with open(output_path, "w") as f:
            f.write(m3u8_content)
        return output_path

    @staticmethod
    def get_video_data_podcast(source_element):
        content_id = source_element.url.split("-")[-1].split("/")[0]
        response = requests.get(
            plus_rtl_de.GRAPHQL_URL, headers={
                'rtlplus-client-Id': plus_rtl_de.CLIENT_ID,
                'rtlplus-client-Version': plus_rtl_de.CLIENT_VERSION,
                'Authorization': f'Bearer {plus_rtl_de.AUTH_TOKEN}'
            },
            params={
                'operationName': 'PodcastEpisode',
                'variables': json.dumps({
                    'id': content_id,
                    'take': 1
                }),
                'extensions': json.dumps({'persistedQuery': {
                    'version': 1,
                    'sha256Hash': '2693e24ad538a69c8698cf1fcbf984cfa49c7592cf5404cb4369167eab694ee0'
                }})
            }
        )

        response = json.loads(response.content.decode())
        data = response.get("data", {})
        if type(data) is not dict or len(data.keys()) == 0:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="This content isn't available",
                solution='Do not attempt to download it'
            ))

        response = response["data"]["podcastEpisode"]
        if source_element.element is None:
            source_element.element = response.get("title", response.get("seo", {}).get("title", None))

            if source_element.element is None:
                source_element.element = f'Podcast_{content_id}'
            source_element.element = get_valid_filename(source_element.element)

        manifest = response["url"]
        try:
            redirect = requests.get(manifest, allow_redirects=False)
            manifest = redirect.headers["Location"]
        except:
            pass

        manifest = plus_rtl_de.generate_master_m3u8(source_element, manifest, response)
        return manifest, None, {}

    @staticmethod
    def get_video_data(source_element):
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                plus_rtl_de.__name__
            )
        if "/podcast/" in source_element.url:
            return plus_rtl_de.get_video_data_podcast(source_element)

        content_id = source_element.url.split("-")[-1].split("/")[0]
        if "/filme/" in source_element.url:
            content_type = "movie"
            graphql_hash = "b1c360212cc518ddca2b8377813a54fa918ca424c08086204b7bf7d6ef626ac4"
            graphql_operation = "MovieDetail"
            graphql_variable = "id"
            response_field = "movie"
            graphql_id = f"rrn:watch:videohub:{content_type}:{content_id}"

        elif "/live-tv/" in source_element.url:
            response = requests.get(
                plus_rtl_de.GRAPHQL_URL, headers={
                    'rtlplus-client-Id': plus_rtl_de.CLIENT_ID,
                    'rtlplus-client-Version': plus_rtl_de.CLIENT_VERSION,
                    'Authorization': f'Bearer {plus_rtl_de.AUTH_TOKEN}'
                },
                params={
                    'operationName': 'LiveTvStations',
                    'variables': json.dumps({
                        'epgCount': 1,
                        'filter': {'channelTypes': ['BROADCAST', 'FAST']}
                    }),
                    'extensions': json.dumps({'persistedQuery': {
                        'version': 1,
                        'sha256Hash': '845cf56a2a78110a0f978c1a2af2bc7f9a1c937d0f324ffaf852a9a4414c8485'
                    }})
                }
            )
            response = json.loads(response.content.decode())
            response = response["data"]["liveTvStations"]

            graphql_id, content_type = None, None
            for station in response:
                if source_element.url.endswith(station["urlData"]["watchPath"]):
                    graphql_id = station["id"]
                    content_type = graphql_id.split(":")[-2]

            assert graphql_id is not None and content_type is not None
            graphql_hash = "14368ab2020057ac3bb29ac3e3a903bcdff44f3a232dd76692f3c96ff97f51a5"
            graphql_operation = "LiveTvStationV2"
            graphql_variable = "rrn"
            response_field = "liveTvStationV2"

        else:
            content_type = "episode"
            graphql_hash = "04e2f59b9c750df1137f9946258c17686cd4447511383ef05fcf699183f449b8"
            graphql_operation = "EpisodeDetail"
            graphql_variable = "episodeId"
            response_field = "episode"
            graphql_id = f"rrn:watch:videohub:{content_type}:{content_id}"

        if source_element.element is None:
            is_movie = content_type == "movie"
            response = json.loads(requests.get(
                plus_rtl_de.GRAPHQL_URL, headers={
                    'rtlplus-client-Id': plus_rtl_de.CLIENT_ID,
                    'rtlplus-client-Version': plus_rtl_de.CLIENT_VERSION,
                    'Authorization': f'Bearer {plus_rtl_de.AUTH_TOKEN}'
                }, params={
                    'operationName': graphql_operation,
                    'variables': json.dumps({
                        graphql_variable: graphql_id
                    }), 'extensions': json.dumps({
                        "persistedQuery": {
                            "version": 1,
                            "sha256Hash": graphql_hash
                        }
                    })
                }
            ).content.decode())["data"][response_field]

            if "/live-tv/" not in source_element.url:
                element_name = f'{response.get("title", "")}'
                if not is_movie:
                    element_name = f'{response.get("format", {}).get("title", "")}_{element_name}'
            else:
                element_name = response.get("name", "")

            element_name = get_valid_filename(element_name)
            if element_name is None or len(element_name) == 1:
                element_name = content_id
            source_element.element = element_name

        response = next(iter(json.loads(requests.get(
            plus_rtl_de.GRAPHQL_URL, headers={
                'rtlplus-client-Id': plus_rtl_de.CLIENT_ID,
                'rtlplus-client-Version': plus_rtl_de.CLIENT_VERSION,
                'Authorization': f'Bearer {plus_rtl_de.AUTH_TOKEN}'
            }, params={
                'operationName': 'WatchPlayerConfigV3',
                'variables': json.dumps({
                    "platform": "WEB",
                    "id": graphql_id
                }), 'extensions': json.dumps({
                    "persistedQuery": {
                        "version": 1,
                        "sha256Hash": "fea0311fb572b6fded60c5a1a9d652f97f55d182bc4cedbdad676354a8d2797c"
                    }
                })
            }
        ).content.decode())["data"].values()))["playoutVariants"]

        video_contents = []
        for variant in response:
            license_url = None
            for licence in variant["licenses"]:
                if "widevine" not in licence["type"].lower():
                    continue
                license_url = licence["licenseUrl"]
                break
            if license_url is None:
                continue

            manifest = None
            for source in variant["sources"]:
                if "main" not in source["priority"].lower():
                    continue
                if ".mpd" not in source["url"]:
                    continue
                manifest = source["url"]
                break
            if manifest is None:
                continue

            quality = variant["type"].lower().replace("dash", "")
            video_contents.append((manifest, license_url, quality))

        video_contents = sorted(
            video_contents, key=lambda vc: plus_rtl_de.RES_PRIORITY[vc[2]], reverse=True
        )[0]
        manifest, license_url = video_contents[0:2]

        additional = {}
        try:
            pssh_value = str(min(re.findall(
                r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                requests.get(manifest).content.decode()
            ), key=len))

            additional = {
                "license_url": license_url,
                "URL": source_element.url
            }
        except:
            pssh_value = None

        additional["USE_SHAKA"] = False
        manifest = plus_rtl_de.adjust_manifest(manifest, "vod")
        return manifest, pssh_value, additional

    @staticmethod
    def get_season_index(season):
        season_type = season["seasonType"].lower()

        if season_type == "ordinal":
            return season["ordinal"]

        if season_type == "annual":
            month = str(season["month"])
            if len(month) == 1:
                month = f'0{month}'
            return float(f'{season["year"]}.{month}')
        return None

    @staticmethod
    def get_collection_elements_podcast(collection_url):
        content_id = collection_url.split("-")[-1].split("/")[0]
        episode_index = 0
        offset = -plus_rtl_de.PAGE_LIMIT
        collection = []
        collection_title = None

        while True:
            offset += plus_rtl_de.PAGE_LIMIT

            response = requests.get(
                plus_rtl_de.GRAPHQL_URL, headers={
                    'rtlplus-client-Id': plus_rtl_de.CLIENT_ID,
                    'rtlplus-client-Version': plus_rtl_de.CLIENT_VERSION,
                    'Authorization': f'Bearer {plus_rtl_de.AUTH_TOKEN}'
                },
                params={
                    'operationName': 'PodcastDetail',
                    'variables': json.dumps({
                        'offset': offset, 'id': content_id,
                        'take': plus_rtl_de.PAGE_LIMIT,
                        'sort': {'direction': 'DEFAULT'}
                    }),
                    'extensions': json.dumps({'persistedQuery': {
                        'version': 1,
                        'sha256Hash': 'efc69a7094e1c4d7195afd7d9e2597a052d45a2c134304e01a386a089be93334'
                    }})
                }
            )
            response = json.loads(response.content.decode())
            data = response.get("data", {})
            if type(data) is not dict or len(data.keys()) == 0:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=collection_url,
                    reason="This content isn't available",
                    solution='Do not attempt to download it'
                ))

            response = response["data"]["podcast"]
            if collection_title is None:
                collection_title = response.get("title", None)
                if collection_title is None:
                    collection_title = response.get("seo", {}).get("title", None)
                if collection_title is None:
                    collection_title = f"Podcast_{content_id}"

                collection_title = join(
                    join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        plus_rtl_de.__name__
                    ),
                    get_valid_filename(collection_title)
                )

            response = response.get("episodes", {})
            episodes = response.get("items", [])

            if len(episodes) == 0:
                break

            for episode in response.get("items", []):
                episode_index += 1
                check = check_range(False, None, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                episode_title = episode.get("title", None)
                if episode_title is None:
                    episode_title = episode.get("seo", {}).get("title", None)
                if episode_title is None:
                    episode_title = episode["id"].split(":")[-1]
                episode_title = f'Podcast_{episode_index}_{episode_title}'
                episode_title = get_valid_filename(episode_title)

                episode_url = episode.get("canonicalUrl", None)
                if episode_url is None:
                    episode_url = plus_rtl_de.BASE_URL + episode["canonicalPath"]

                collection.append(BaseElement(
                    url=episode_url,
                    collection=collection_title,
                    element=episode_title
                ))

            if response.get("pageInfo", {}).get("hasNextPage", True) is False:
                break

        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        if "/video-tv/" in collection_url and collection_url.split("/video-tv/")[1].count("/") >= 3:
            return [BaseElement(url=collection_url)]
        if "/filme/" in collection_url:
            return [BaseElement(url=collection_url)]
        if "/video-tv/live/" in collection_url:
            return None

        collection_url = collection_url.split("?")[0].split("#")[0].rstrip("/")
        if "/podcast/" in collection_url:
            if collection_url.split("/podcast/")[1].count("/") >= 1:
                return [BaseElement(url=collection_url)]
            return plus_rtl_de.get_collection_elements_podcast(collection_url)

        if "/video-tv/live-tv/" in collection_url:
            return [BaseElement(url=collection_url)]
        content_id = collection_url.split("-")[-1].split("/")[0]
        collection = []

        response = requests.get(
            plus_rtl_de.GRAPHQL_URL, headers={
                'rtlplus-client-Id': plus_rtl_de.CLIENT_ID,
                'rtlplus-client-Version': plus_rtl_de.CLIENT_VERSION,
                'Authorization': f'Bearer {plus_rtl_de.AUTH_TOKEN}'
            },
            params={
                'operationName': 'Format',
                'variables': json.dumps({'id': f'rrn:watch:videohub:format:{content_id}'}),
                'extensions': json.dumps({'persistedQuery': {
                    'version': 1,
                    'sha256Hash': '1da243e1180ae67a43514c6a52bc756acefcb70c6250498c9e8fb04b3d9e7720'
                }})
            }
        )
        response = json.loads(response.content.decode())
        data = response.get("data", {})
        if type(data) is not dict or len(data.keys()) == 0:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=collection_url,
                reason="This content isn't available",
                solution='Do not attempt to download it'
            ))

        collection_title = data.get("format", {}).get("title", None)
        if collection_title is None:
            collection_title = collection_url.split(plus_rtl_de.BASE_URL)[-1]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                plus_rtl_de.__name__
            ),
            get_valid_filename(collection_title)
        )

        seasons = data.get("format", {}).get("seasons", [])
        if len(seasons) == 0:
            return []

        extras = list(filter(
            lambda s: not s["urlData"]["watchPath"].split("/")[-1].startswith("staffel-"),
            seasons
        ))
        seasons = list(filter(
            lambda s: s["urlData"]["watchPath"].split("/")[-1].startswith("staffel-"),
            seasons
        ))
        seasons.extend(list(filter(lambda e: e.get("titleOverride", None) is None, extras)))
        extras = list(filter(lambda e: e.get("titleOverride", None) is not None, extras))

        extras = sorted(extras, key=lambda e: str(e["titleOverride"].lower()))
        seasons_type = data["format"]["seasonsType"].lower()
        if seasons_type == "annual":
            seasons = sorted(seasons, key=lambda s: (s["year"], s["month"]))
        elif seasons_type == "ordinal":
            seasons = sorted(seasons, key=lambda s: s["ordinal"])
        else:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=collection_url,
                reason=f"Unknown season type encountered: {seasons_type}",
                solution=f"Extend the {plus_rtl_de.__name__} service"
            ))

        if len(extras) > 0:
            if len(seasons) == 0:
                season_index = 0
            else:
                season_index = seasons[-1]["ordinal"]

            for extra in extras:
                season_index += 1
                extra["ordinal"] = season_index
            seasons.extend(extras)

        for season in seasons:
            season_type = season["seasonType"].lower()
            season_index = plus_rtl_de.get_season_index(season)
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            if season_type == "ordinal":
                season_title = f'Season_{season["ordinal"]}'
                if season.get("titleOverride", None) is not None:
                    season_title += f"_{season['titleOverride']}"
            else:  # if season_type == "annual":
                season_title = f'Year_{season["year"]}_Month_{season["month"]}'
            season_title = get_valid_filename(season_title)
            season_id = season["id"]

            page_offset = -plus_rtl_de.PAGE_LIMIT
            while True:
                page_offset += plus_rtl_de.PAGE_LIMIT
                response = requests.get(
                    plus_rtl_de.GRAPHQL_URL, headers={
                        'rtlplus-client-Id': plus_rtl_de.CLIENT_ID,
                        'rtlplus-client-Version': plus_rtl_de.CLIENT_VERSION,
                        'Authorization': f'Bearer {plus_rtl_de.AUTH_TOKEN}'
                    },
                    params={
                        'operationName': 'SeasonWithFormatAndEpisodes',
                        'variables': json.dumps({
                            'seasonId': season_id, 'offset': page_offset,
                            'limit': plus_rtl_de.PAGE_LIMIT
                        }),
                        'extensions': json.dumps({'persistedQuery': {
                            'version': 1,
                            'sha256Hash': 'de1ae6550a2bbb069e00cf253bd1e08658dcf6afa9db93240343d2f8ea641823'
                        }})
                    }
                )

                response = json.loads(response.content.decode())
                data = response.get("data", {})
                if type(data) is not dict:
                    data = {}
                episodes = data.get("season", {}).get("episodes", [])
                if len(episodes) == 0:
                    break

                for episode in episodes:
                    check = check_range(False, season_index, episode["number"])
                    if check in [True, False]:
                        continue

                    episode_url = plus_rtl_de.BASE_URL + episode["urlData"]["watchPath"]
                    episode_title = episode.get("title", episode["id"].split(":")[-1])

                    collection.append(BaseElement(
                        url=episode_url,
                        collection=join(collection_title, season_title),
                        element=get_valid_filename(f"Episode_{episode['number']}_{episode_title}")
                    ))

        return collection
