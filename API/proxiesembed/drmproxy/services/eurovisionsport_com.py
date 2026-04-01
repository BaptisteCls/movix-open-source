import builtins
import json
import re
from datetime import datetime
from os.path import join
from urllib.parse import parse_qs, urlparse, quote

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, clean_url


class eurovisionsport_com(BaseService):
    DEMO_URLS = [
        "https://eurovisionsport.com/explore/competition?id=Generic-Schedule-Landing-Page&cId=20240614ECASzeged",
        "https://eurovisionsport.com/explore/competition?id=Generic-Schedule-Landing-Page&cId=20240601IFMAPatras",
        "https://eurovisionsport.com/explore/sport?id=EBU-Home-Racket",
        "https://eurovisionsport.com/explore/sport?id=EBU-Home-Football",
        "https://eurovisionsport.com/explore/federation?id=LandingPage-ESF",
        "https://eurovisionsport.com/explore/federation?id=LandingPage-FIG",
        "https://eurovisionsport.com/mediacard/EVS_OBE_240308_M_24-10262",
        "https://eurovisionsport.com/mediacard/EVS_XEJ_240217_MX_24-3261A",
        "https://eurovisionsport.com/mediacard/EVS_2023-10-08_FEED_FIG_1_DEF_F_TIME_12_50_ID_23-7614",
        "https://eurovisionsport.com/mediacard/EVS_240204_EDD_25128_",
    ]

    LOGIN_URL = "https://api.evsports.opentv.com/ias/v2/token?grant_type=password&username={email}&password={password}"
    EDITORIALS_URL = 'https://api.evsports.opentv.com/metadata/delivery/v2/GLOBAL/vod/editorials'
    TEMPLATE_URl = 'https://api.evsports.opentv.com/contentdelivery/v2/templateviews/{content_id}'
    TOKEN_URL = 'https://api.evsports.opentv.com/ias/v2/content_token'
    VIDEO_URL = "https://eurovisionsport.com/mediacard/{content_id}"
    LICENSE_URL = "https://evsp4wab.anycast.nagra.com/EVSP4WAB/wvls/contentlicenseservice/v1/licenses"

    EMAIL = "YOUR_EMAIL"
    PASSWORD = "YOUR_PASSWORD"
    BEARER_TOKEN = None
    PAGE_LIMIT = 9999

    @staticmethod
    def test_service():
        main_service.run_service(eurovisionsport_com)

    @staticmethod
    def get_additional_params(additional):
        params = []
        if builtins.CONFIG.get("BASIC", False) is True:
            params.append(("ARGUMENT", lambda s: s.format(value="--check-segments-count false")))
        return params + BaseService.get_additional_params(additional)

    @staticmethod
    def credentials_needed():
        return {
            "EMAIL": eurovisionsport_com.EMAIL,
            "PASSWORD": eurovisionsport_com.PASSWORD
        }

    @staticmethod
    def get_bearer_token():
        class_name = eurovisionsport_com.__name__.replace("_", ".")
        credentials = builtins.CONFIG["SERVICE_CREDENTIALS"][class_name]
        try:
            assert type(credentials["EMAIL"]) is str
            assert type(credentials["PASSWORD"]) is str
        except:
            return None, None

        response = json.loads(requests.post(
            eurovisionsport_com.LOGIN_URL.format(
                email=quote(credentials["EMAIL"]),
                password=quote(credentials["PASSWORD"])
            ), json={}, headers={
                'host': 'api.evsports.opentv.com',
                'tenantid': 'nagra'
            }
        ).content.decode())

        message = response.get("message", "").lower()
        if response.get("access_token", None) is None and len(message) > 0:
            if "unauthorized" in message:
                return None
            raise CustomException(ERR_MSG.format(
                type=f'{APP_ERROR}',
                url=f"from the {eurovisionsport_com.__name__} service",
                reason=f"Unknown error encountered: {str(response)}",
                solution="Debug the service"
            ))
        return response["access_token"]

    @staticmethod
    def initialize_service():
        if eurovisionsport_com.BEARER_TOKEN is None:
            eurovisionsport_com.BEARER_TOKEN = eurovisionsport_com.get_bearer_token()
            if eurovisionsport_com.BEARER_TOKEN is None:
                return None

        return eurovisionsport_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            eurovisionsport_com.LICENSE_URL, data=challenge,
            headers={'nv-authorizations': additional["content_token"]}
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        video_id = source_element.url.split("/")[-1]
        response = json.loads(requests.get(
            eurovisionsport_com.EDITORIALS_URL,
            headers={'Authorization': f'Bearer {eurovisionsport_com.BEARER_TOKEN}'},
            params={
                "filter": json.dumps({
                    "editorial.id": {"$in": [video_id]},
                    "locale": "en_US", "isValid": True,
                    "isVisible": True
                }),
                "limit": 9999,
                "sort": json.dumps([["Title", 1]])
            }
        ).content.decode())

        video_data = []
        video_name = video_id
        for e in response.get("editorials", []):
            if e["id"] != video_id:
                continue

            video_name = e["title"]
            for t in e["technicals"]:
                av = t["media"]["AV_PlaylistName"]
                video_data += [(av["uri"], av["drmId"])]

        content = [v for v in video_data if ".mpd" in v[0]]
        if len(content) == 0:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        if source_element.element is None:
            source_element.element = get_valid_filename(video_name)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                eurovisionsport_com.__name__
            )

        manifest, drm_id = content[0]
        response = requests.get(manifest).content.decode()
        try:
            pssh_value = re.search(r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>', response).group(1)
        except:
            return manifest, None, {}

        response = json.loads(requests.post(
            eurovisionsport_com.TOKEN_URL,
            params={'content_id': drm_id, 'type': 'device'},
            headers={
                'Nv-Tenant-Id': 'nagra',
                'Authorization': f'Bearer {eurovisionsport_com.BEARER_TOKEN}'
            }
        ).content.decode())
        return manifest, pssh_value, {"content_token": response["content_token"]}

    @staticmethod
    def get_valid_contents(section):
        return [
            c for c in section.get("contents", [])
            if c is not None and type(c) is dict and
               c.get("title", c.get("Title", None)) is not None and
               c.get("id", None) is not None
        ]

    @staticmethod
    def get_template_content(content_id):
        return json.loads(requests.get(
            eurovisionsport_com.TEMPLATE_URl.format(content_id=content_id),
            headers={
                'Authorization': f'Bearer {eurovisionsport_com.BEARER_TOKEN}',
                'Accept-Language': 'en_US',
                'Nagra-Device-Type': 'Android,IOS',
                'Nagra-Target': 'everything'
            }
        ).content.decode())

    @staticmethod
    def get_competition_handler(collection_url):
        params_dict = parse_qs(urlparse(collection_url).query)
        competition_id = params_dict["cId"][0]
        collection_name = None

        page = 0
        season_index = 0
        episode_index = 1
        current_date = None
        collection = []

        while True:
            page += 1
            videos = json.loads(requests.get(
                eurovisionsport_com.EDITORIALS_URL,
                headers={'Authorization': f'Bearer {eurovisionsport_com.BEARER_TOKEN}'},
                params={
                    "filter": json.dumps({
                        "editorial.isLive": "true", "locale": "en_US",
                        "isValid": True, "isVisible": True,
                        "technical.deviceType": {"$in": ["Android"]},
                        "technical.media": {"$exists": True},
                        "editorial.tournament_name": competition_id
                    }),
                    "limit": eurovisionsport_com.PAGE_LIMIT,
                    "page": page,
                    "sort": json.dumps([["technical.ProgrammeStartDate", 1]])
                }
            ).content.decode()).get("editorials", [])

            if len(videos) == 0:
                break
            if collection_name is None:
                for category in videos[0].get("Categories", []):
                    if category.startswith("Competition"):
                        collection_name = category.split(":")[-1]
                if collection_name is None:
                    collection_name = "Competition_" + competition_id
                collection_name = join(
                    join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        eurovisionsport_com.__name__
                    ),
                    get_valid_filename(collection_name)
                )

            for video in videos:
                technicals = [t for t in video.get("technicals", []) if t.get("tournament_name", "") == competition_id]
                if len(technicals) == 0:
                    start_date = datetime.fromtimestamp(video["CUStartDate"]).strftime("%d-%m-%Y")
                else:
                    start_date = datetime.strptime(
                        technicals[0]["ProgrammeStartDate"],
                        "%Y-%m-%dT%H:%M:%SZ"
                    ).strftime("%d-%m-%Y")

                if current_date != start_date:
                    season_index += 1
                    episode_index = 1
                    current_date = start_date
                else:
                    episode_index += 1

                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                collection.append(BaseElement(
                    url=eurovisionsport_com.VIDEO_URL.format(content_id=video["id"]),
                    collection=join(collection_name, f"Schedule_{season_index}_{current_date}"),
                    element=f'Video_{episode_index}'
                            f'_'
                            f'{get_valid_filename(video.get("title", video["Title"]))}'
                ))

        return collection

    @staticmethod
    def get_collection_elements(collection_url):
        if "/mediacard/" in collection_url:
            return [BaseElement(url=clean_url(collection_url))]

        if "/explore/competition" in collection_url and "cId=" in collection_url:
            return eurovisionsport_com.get_competition_handler(collection_url)

        if "/explore/" in collection_url and "id=" in collection_url:
            if "/sport" not in collection_url and "/federation" not in collection_url:
                return None

            content_id = parse_qs(urlparse(collection_url).query)["id"][0]
            collection = []

            response = eurovisionsport_com.get_template_content(content_id)
            if "/federation" in collection_url:
                content_id = None
                for rail in response.get("rails", []):
                    if rail["name"] != "RenderTemplate":
                        continue

                    for section in rail.get("sections", []):
                        properties = section.get("properties", {})
                        content_id = properties.get(
                            "userSignedOnTemplate",
                            properties.get("anonymousSignedOnTemplate", None)
                        )
                        if content_id is not None:
                            break

                    if content_id is not None:
                        break

                assert content_id is not None
                response = eurovisionsport_com.get_template_content(content_id)
            content_id = get_valid_filename(content_id)

            rail_index = 0
            for rail in response.get("rails", []):
                if rail["title"].lower() == "carrousel":
                    continue
                if len(rail.get("sections", [])) == 0:
                    continue
                if 0 in [len(eurovisionsport_com.get_valid_contents(s)) for s in rail["sections"]]:
                    continue

                rail_index += 1
                check = check_range(True, rail_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                video_index = 0
                rail_title = get_valid_filename(rail['title'])
                for section in rail["sections"]:
                    for content in eurovisionsport_com.get_valid_contents(section):
                        video_index += 1
                        check = check_range(False, rail_index, video_index)
                        if check is True:
                            continue
                        elif check is False:
                            return collection

                        collection.append(BaseElement(
                            url=eurovisionsport_com.VIDEO_URL.format(content_id=content["id"]),
                            collection=join(
                                join(
                                    str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                    eurovisionsport_com.__name__
                                ),
                                join(content_id, f"Rail_{rail_index}_{rail_title}")
                            ),
                            element=f'Video_{video_index}'
                                    f'_'
                                    f'{get_valid_filename(content.get("title", content["Title"]))}'
                        ))

            return collection
        return None
