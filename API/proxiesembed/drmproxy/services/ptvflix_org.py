import base64
import builtins
import json
import re
from os.path import join

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename


class ptvflix_org(BaseService):
    DEMO_URLS = [
        "https://ptvflix.org/category/646",
        "https://ptvflix.org/category/843",
        "https://ptvflix.org/player/4185",
        "https://ptvflix.org/player/7488",
    ]

    STREAM_URL = 'https://mw.hivesys.net/public/vod/getStreamUrlV3'
    CATEGORY_URL = 'https://mw.hivesys.net/public/RecommendationEngine/getCategory'
    LOGIN_URL = 'https://mw.hivesys.net/public/customer/login'
    BASE_URL = 'https://ptvflix.org'
    VIDEO_URL = BASE_URL + '/player/{video_id}'

    EMAIL = "YOUR_EMAIL"
    PASSWORD = "YOUR_PASSWORD"
    DEVICE_HASH = None
    DEVICE_TYPE = "d2ViIHBsYXllcg=="
    DEVICE_ID = "Win32"
    VENDOR_ID = 1
    BEARER_TOKEN = None
    PROFILE_ID = None

    @staticmethod
    def test_service():
        main_service.run_service(ptvflix_org)

    @staticmethod
    def credentials_needed():
        return {
            "EMAIL": ptvflix_org.EMAIL,
            "PASSWORD": ptvflix_org.PASSWORD
        }

    @staticmethod
    def get_devices_hash():
        response = requests.get(ptvflix_org.BASE_URL).content.decode()
        response = re.search(r'src="([^"]*?/index-[^"]*?\.js)"', response).group(1)
        if not response.startswith("/"):
            response = "/" + response
        response = f'{ptvflix_org.BASE_URL}{response}'

        response = requests.get(response).content.decode()
        response = re.search(r'"([^"]*?/CopyToClipboard-[^"]*?\.js)"', response).group(1)
        if not response.startswith("/"):
            response = "/" + response
        response = f'{ptvflix_org.BASE_URL}{response}'

        response = requests.get(response).content.decode()
        response = re.search(r'devices_hash="([^"]+)"', response).group(1)
        return response

    @staticmethod
    def get_account_info():
        class_name = ptvflix_org.__name__.replace("_", ".")
        credentials = builtins.CONFIG["SERVICE_CREDENTIALS"][class_name]
        try:
            assert type(credentials["EMAIL"]) is str
            assert type(credentials["PASSWORD"]) is str
        except:
            return None, None

        response = json.loads(requests.post(
            ptvflix_org.LOGIN_URL,
            json={
                'data': {
                    'login': credentials["EMAIL"],
                    'password': credentials["PASSWORD"],
                    'vendorsId': ptvflix_org.VENDOR_ID
                }
            }
        ).content.decode())
        if response.get("status", None) == 103 or len(response.get("response", [])) == 0:
            return None, None

        response = response["response"]
        bearer_token = None
        profile_id = None
        for profile in response["profiles"]:
            bearer_token = profile.get("customers_token", None)
            profile_id = base64.b64encode(str(profile["profiles_id"]).encode()).decode()
            break

        if bearer_token is None:
            bearer_token = response.get("customers_token", None)
        return bearer_token, profile_id

    @staticmethod
    def initialize_service():
        if ptvflix_org.DEVICE_HASH is None:
            ptvflix_org.DEVICE_HASH = ptvflix_org.get_devices_hash()

        if ptvflix_org.BEARER_TOKEN is None or ptvflix_org.PROFILE_ID is None:
            ptvflix_org.BEARER_TOKEN, ptvflix_org.PROFILE_ID = ptvflix_org.get_account_info()
            if ptvflix_org.BEARER_TOKEN is None or ptvflix_org.PROFILE_ID is None:
                return None

        return ptvflix_org

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            additional["license_url"],
            headers={
                'authorization': f'Bearer {ptvflix_org.BEARER_TOKEN}',
                'profilesid': ptvflix_org.PROFILE_ID,
                'devicestype': ptvflix_org.DEVICE_TYPE
            },
            data=json.dumps({
                "offset": additional["offset"],
                "edges_id": additional["edges_id"],
                "devices_identification": ptvflix_org.DEVICE_ID,
                "devices_hash": ptvflix_org.DEVICE_HASH,
                "rawLicense": base64.b64encode(challenge).decode()
            })
        )
        licence.raise_for_status()
        return json.loads(licence.content.decode())["rawLicense"]

    @staticmethod
    def get_video_data(source_element):
        vod_id = int(re.search(r"/player/([^/?]*)", source_element.url).group(1))

        response = json.loads(requests.post(
            ptvflix_org.STREAM_URL,
            headers={
                'Authorization': f'Bearer {ptvflix_org.BEARER_TOKEN}',
                'profilesId': ptvflix_org.PROFILE_ID,
                'devicesType': ptvflix_org.DEVICE_TYPE
            },
            json={'data': {'vodsId': vod_id, 'type': 'dash'}}
        ).content.decode())

        if response.get("status", None) == 1001 and len(response.get("response", [])) == 0:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason='You requested too much content recently or the content is not free',
                solution="Wait 10 minutes or don't attempt to download it"
            ))

        response = response["response"]
        manifest = response["url"]

        license_url = None
        for license_name in response["drms"]:
            if "widevine" in license_name.lower():
                license_url = response["drms"][license_name]
                break
        additional = {
            "offset": response["offset"],
            "edges_id": response["edgesId"],
            "license_url": license_url
        }

        if source_element.element is None:
            try:
                name = manifest.split("/")[-2]
            except:
                name = str(vod_id)
            source_element.element = get_valid_filename(name)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                ptvflix_org.__name__
            )

        try:
            pssh_value = str(min(re.findall(
                r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                requests.get(manifest).content.decode()
            ), key=len))
        except:
            return manifest, None, {}
        return manifest, pssh_value, additional

    @staticmethod
    def get_season_from_row(row):
        if "season" in row["title"].lower():
            return row["data"][0]["season_number"]

        if "other episodes" in row["title"].lower():
            return 0
        return None

    @staticmethod
    def get_collection_elements(collection_url):
        if "/player/" in collection_url:
            return [BaseElement(url=collection_url)]

        if "/category/" in collection_url:
            collection = []
            category_id = int(re.search(r"/category/([^/?]*)", collection_url).group(1))
            response = json.loads(requests.post(
                ptvflix_org.CATEGORY_URL,
                headers={
                    'Authorization': f'Bearer {ptvflix_org.BEARER_TOKEN}',
                    'profilesId': ptvflix_org.PROFILE_ID,
                    'devicesType': ptvflix_org.DEVICE_TYPE
                },
                json={'data': {'categoriesId': category_id}}
            ).content.decode())["response"]

            collection_name = response.get("category", {}).get(
                "categories_name", f"Content_{category_id}"
            )
            collection_name = get_valid_filename(collection_name)
            response = [(ptvflix_org.get_season_from_row(r), r) for r in response["rows"]]
            response = sorted(response, key=lambda r: r[0])

            for season_index, season in response:
                check = check_range(True, season_index, None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                index = 0
                for episode in season["data"]:
                    index += 1
                    episode_index = index if episode.get("episode_number", None) is None \
                        else episode["episode_number"]

                    check = check_range(False, season_index, episode_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    collection.append(BaseElement(
                        url=ptvflix_org.VIDEO_URL.format(video_id=episode["id"]),
                        collection=join(
                            join(
                                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                ptvflix_org.__name__
                            ),
                            join(collection_name, f'Season_{season_index}')
                        ),
                        element=f"Episode_{episode_index}"
                                f'_'
                                f"{get_valid_filename(episode['title'])}"
                    ))
            return collection

        return None
