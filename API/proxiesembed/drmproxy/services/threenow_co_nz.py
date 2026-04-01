import builtins
import json
import re
import urllib.parse
from os.path import join

import requests
from bs4 import BeautifulSoup

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename


class threenow_co_nz(BaseService):
    DEMO_URLS = [
        "https://www.threenow.co.nz/shows/below-deck/S1647-006",
        "https://www.threenow.co.nz/shows/7-days/61183",
        "https://www.threenow.co.nz/shows/high-country/1712093997956",
        "https://www.threenow.co.nz/shows/toke/S2279-908",
        "https://www.threenow.co.nz/shows/the-hui-post-election-special/the-hui-post-election-special-/1695160987788/M78388-748",
        "https://www.threenow.co.nz/shows/a-winter-song/a-winter-song/S4271-793/M66384-367",
        "https://www.threenow.co.nz/shows/25-siblings-and-me/25-siblings-and-me/S3922-434/M60237-576",
    ]

    SHOWS_URL = 'https://now-api.fullscreen.nz/v5/shows/{show_id}'
    PLAYBACK_URL = 'https://edge.api.brightcove.com/playback/v1/accounts/{account_id}/videos/{video_id}'
    BASE_URL = 'https://www.threenow.co.nz'
    VIDEO_URL = BASE_URL + '/shows/-/-/{show_id}/{video_id}'

    ACCOUNT_ID = None
    POLICY_KEY = None

    @staticmethod
    def test_service():
        main_service.run_service(threenow_co_nz)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_site_info():
        response = requests.get('https://www.threenow.co.nz/').content.decode()
        soup = BeautifulSoup(response, 'html5lib')
        meta = soup.find_all('meta')
        meta = [m for m in meta if 'config/environment' in m.get('name', '')]

        if len(meta) == 0:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=f'from {threenow_co_nz.__name__}',
                reason="Need New Zealander IP to access content",
                solution="Use a VPN"
            ))

        meta = json.loads(urllib.parse.unquote(meta[0]["content"]))
        account_id = meta["brightcoveAccountId"]
        policy_key = meta["brightcovePolicyKey"]
        return account_id, policy_key

    @staticmethod
    def initialize_service():
        if threenow_co_nz.ACCOUNT_ID is None or threenow_co_nz.POLICY_KEY is None:
            threenow_co_nz.ACCOUNT_ID, threenow_co_nz.POLICY_KEY = threenow_co_nz.get_site_info()
        return threenow_co_nz

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(additional["license_url"], data=challenge)
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_full_seasons(response):
        seasons = response.get("seasons", [])
        if len(response.get("episodes", [])) > 0:
            season_number = 0
            if len(seasons) > 0:
                season_number = int(seasons[-1]["seasonNumber"])

            seasons.append({
                "seasonNumber": season_number + 1,
                "episodes": response["episodes"]
            })

        seasons = sorted(seasons, key=lambda s: int(s["seasonNumber"]))
        if len(response.get("extras", [])) > 0:
            season_number = 0
            if len(seasons) > 0:
                season_number = int(seasons[-1]["seasonNumber"])

            index = 0
            for e in response["extras"]:
                index += 1
                e["episode"] = index
            seasons.append({
                "seasonNumber": season_number + 1,
                "episodes": response["extras"]
            })
        return seasons

    @staticmethod
    def get_video_data(source_element):
        video_id = source_element.url.split("/")[-1]
        show_id = source_element.url.split("/")[-2]

        response = json.loads(requests.get(
            threenow_co_nz.SHOWS_URL.format(show_id=show_id)
        ).content.decode())

        content = None
        seasons = threenow_co_nz.get_full_seasons(response)

        for season in seasons:
            episodes = season.get("episodes", [])
            episodes = sorted(episodes, key=lambda e: int(e["episode"]))

            for episode in episodes:
                if episode["videoId"] == video_id:
                    content = episode
                    break

            if content is not None:
                break

        if content is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        if source_element.element is None:
            source_element.element = get_valid_filename(content.get("name", video_id))
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                threenow_co_nz.__name__
            )

        video_id = content["externalMediaId"]
        response = json.loads(requests.get(
            threenow_co_nz.PLAYBACK_URL.format(
                account_id=threenow_co_nz.ACCOUNT_ID,
                video_id=video_id
            ),
            headers={'Accept': f'pk={threenow_co_nz.POLICY_KEY}'}
        ).content.decode())

        message = str(response).lower()
        if "client_geo" in message and "access_denied" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need New Zealander IP to access content",
                solution="Use a VPN"
            ))

        license_url = None
        manifest = None
        for source in response.get("sources", []):
            key_systems = source.get("key_systems", {})
            if len(key_systems.items()) > 0:
                if "widevine" not in str(source).lower():
                    continue

                for k, v in key_systems.items():
                    if "widevine" not in k.lower():
                        continue
                    license_url = v.get("license_url", None)

                if license_url is None:
                    continue
            manifest = source.get("src", None)
            if manifest is not None:
                break

        try:
            if license_url is None:
                raise

            pssh_value = str(min(
                re.findall(
                    r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                    requests.get(manifest).content.decode()
                ), key=len
            ))
        except:
            pssh_value = None

        if license_url is not None and pssh_value is None:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Manifest format not supported: {manifest}. Can't extract pssh",
                solution=f"Extend the {threenow_co_nz.__name__} service"
            ))

        return manifest, pssh_value, {"license_url": license_url}

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.rstrip("/")
        if "/shows/" not in collection_url:
            return None
        if collection_url.split("/shows/")[1].count("/") >= 3:
            return [BaseElement(url=collection_url)]

        if collection_url.split("/shows/")[1].count("/") < 3:
            collection = []
            show_id = collection_url.split("/")[-1]

            response = json.loads(requests.get(
                threenow_co_nz.SHOWS_URL.format(show_id=show_id)
            ).content.decode())

            collection_name = response.get("name", response.get("showAdName", collection_url.split("/")[-2]))
            collection_name = get_valid_filename(collection_name)
            collection_name = join(join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                threenow_co_nz.__name__
            ), collection_name)

            seasons = threenow_co_nz.get_full_seasons(response)
            for season in seasons:
                check = check_range(True, int(season["seasonNumber"]), None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                episodes = season.get("episodes", [])
                episodes = sorted(episodes, key=lambda e: int(e["episode"]))

                for episode in episodes:
                    check = check_range(False, int(season["seasonNumber"]), int(episode['episode']))
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    collection.append(BaseElement(
                        url=threenow_co_nz.VIDEO_URL.format(
                            show_id=response["showId"],
                            video_id=episode["videoId"]
                        ),
                        collection=join(collection_name, f'Season_{season["seasonNumber"]}'),
                        element=f"Episode_{episode['episode']}"
                                f"_"
                                f"{get_valid_filename(episode['name'])}"
                    ))

            return collection
        return None
