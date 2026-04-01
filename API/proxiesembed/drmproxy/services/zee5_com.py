import builtins
import json
import re
import time
from os.path import join

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename, get_country_code


class zee5_com(BaseService):
    DEMO_URLS = [
        "https://www.zee5.com/global/tv-shows/details/sa-re-ga-ma-pa-2023/0-6-4z5416889",
        "https://www.zee5.com/global/web-series/details/united-kacche/0-6-4z5327133",
        "https://www.zee5.com/global/kids/kids-shows/sa-re-ga-ma-pa-lil-champs-2020/0-6-2526",
        "https://www.zee5.com/global/kids/kids-shows/sa-re-ga-ma-pa-lil-champs-2019/0-6-1317/sa-re-ga-ma-pa-lil-champs-2019-episode-5-february-23-2019-full-episode/0-1-179578",
        "https://www.zee5.com/global/kids/kids-shows/sa-re-ga-ma-pa-lil-champs-2020/0-6-2526/musician-pyarelal-sharma-graces-the-show-sa-re-ga-ma-pa-lil-champs-2020/0-1-manual_6g16vpetmim0",
        "https://www.zee5.com/global/tv-shows/details/pyar-ka-pehla-naam-radha-mohan/0-6-4z5130241/latest",
        "https://www.zee5.com/global/tv-shows/details/navri-mile-hitlerla/0-6-4z5521328/latest",
        "https://www.zee5.com/global/tv-shows/details/pavitra-rishta/0-6-133/episode-1189-pavitra-rishta/0-1-manual_1ej5qfm3eg8g",
        "https://www.zee5.com/global/tv-shows/details/veera/0-6-4z5521331/ramachandran-disbelieves-raghavan/0-1-6z5536732",
        "https://www.zee5.com/global/web-series/details/maya-bazaar-for-sale/0-6-4z5387149/who-let-the-cow-out/0-1-6z5395324",
        "https://www.zee5.com/global/web-series/details/united-kacche/0-6-4z5327133/pehli-job-dusra-pyaar/0-1-6z5335305",
        "https://www.zee5.com/global/movies/details/the-long-drive/0-0-1z520799",
        "https://www.zee5.com/global/movies/details/kaagaz/0-0-1z536625",
    ]

    CONTENT_URL = 'https://spapi.zee5.com/singlePlayback/getDetails/secure?content_id={content_id}&show_id={show_id}&device_id=device_id&platform_name=desktop_web&country={country_code}&check_parental_control=false'
    CONTENT_SHOW_URL = 'https://gwapi.zee5.com/content/tvshow/{content_id}'
    LICENSE_URL = "https://spapi.zee5.com/widevine/getLicense"
    BASE_URL = "https://www.zee5.com/global"

    COUNTRY_CODE = None
    PAGE_LIMIT = 100
    ACCESS_TOKEN = None
    LICENSE_RETRIES = 3

    @staticmethod
    def test_service():
        main_service.run_service(zee5_com)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        if zee5_com.ACCESS_TOKEN is None:
            zee5_com.ACCESS_TOKEN = zee5_com.get_access_token()
        if zee5_com.COUNTRY_CODE is None:
            zee5_com.COUNTRY_CODE = get_country_code()

            if zee5_com.COUNTRY_CODE is None:
                raise CustomException(ERR_MSG.format(
                    type=f'{APP_ERROR}',
                    url=f'from the {zee5_com.__name__} service',
                    reason="Failed to obtain the country code",
                    solution="Fix the code responsible for obtaining the country code"
                ))
            else:
                zee5_com.COUNTRY_CODE = zee5_com.COUNTRY_CODE.upper()
        return zee5_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = None
        for i in range(1, zee5_com.LICENSE_RETRIES + 1):
            try:
                licence = requests.post(
                    zee5_com.LICENSE_URL, data=challenge, headers={
                        'nl': additional["nl"],
                        'customdata': additional["custom_data"],
                    }
                )
                licence.raise_for_status()
                break
            except Exception as e:
                response = e.response
                if response.status_code == 403:
                    if i < zee5_com.LICENSE_RETRIES:
                        time.sleep(1)
                        continue
                raise e
        return licence.content

    @staticmethod
    def get_access_token():
        for s in ['"platform_token":{"token":', '"platformToken":']:
            try:
                return re.search(
                    rf'{s}"(.*?)"',
                    requests.get(zee5_com.BASE_URL).content.decode()
                ).group(1)
            except:
                pass
        return None

    @staticmethod
    def get_video_data(source_element):
        if "/movies/" in source_element.url:
            show_id = None
            content_id = re.search(r'/global/[^/]+/[^/]+/[^/]+/([^/]+)', source_element.url).group(1)
            content_url = zee5_com.CONTENT_URL.replace("&show_id={show_id}", "")
        else:
            show_id = re.search(r'/global/[^/]+/[^/]+/[^/]+/([^/]+)/', source_element.url).group(1)

            if "latest" in source_element.url.split("/")[-1]:
                content_id = show_id
                content_url = zee5_com.CONTENT_URL.replace("&show_id={show_id}", "&is_latest=1")
            else:
                content_id = re.search(r'/global/[^/]+/[^/]+/[^/]+/[^/]+/[^/]+/([^/]+)$', source_element.url).group(1)
                content_url = zee5_com.CONTENT_URL

        manifest, response = None, {}
        try:
            response = json.loads(requests.post(
                content_url.format(content_id=content_id, show_id=show_id, country_code=zee5_com.COUNTRY_CODE),
                json={
                    'x-access-token': zee5_com.ACCESS_TOKEN,
                    'X-Z5-Guest-Token': '00000000-0000-0000-0000-00000000'
                }
            ).content.decode())

            manifest = None
            is_hls = False
            for details in response:
                try:
                    manifest = response[details]["video_url"]["mpd"]
                except:
                    pass

                if manifest is None:
                    try:
                        manifest = response[details]["hls_token"]
                        is_hls = True
                    except:
                        pass

            if not is_hls:
                manifest = manifest.split("?")[0]
                manifest = re.sub(r'-\w+\.mpd', '.mpd', manifest)
        except:
            pass

        if manifest is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't found, needs account, or isn't available in your region",
                solution="Do not attempt to download it or use a VPN with a different country"
            ))

        if source_element.element is None:
            element_name = response.get("assetDetails", {}).get("title", None)
            if element_name is None:
                element_name = response.get("assetDetails", {}).get("original_title", None)
            if element_name is None:
                element_name = content_id
            source_element.element = get_valid_filename(element_name)
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                zee5_com.__name__
            )

        try:
            pssh_value = str(min(re.findall(
                r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                requests.get(manifest).content.decode()
            ), key=len))
        except:
            return manifest, None, {}
        return manifest, pssh_value, {
            "nl": response["keyOsDetails"]["nl"],
            "custom_data": response["keyOsDetails"]["sdrm"]
        }

    @staticmethod
    def get_collection_elements(collection_url):
        if "/cricket" in collection_url:
            return None
        if "/latest" in collection_url:
            return [BaseElement(url=collection_url)]

        try:
            section = re.search(r'(/global/[^/]+/[^/]+/)', collection_url).group(1)
        except:
            return None
        if "movies" in section:
            is_series = False
        else:
            rest_url = collection_url.split(section)[1]
            if rest_url.count("/") > 1:
                is_series = False
            else:
                is_series = True

        if not is_series:
            return [BaseElement(url=collection_url)]
        else:
            collection = []
            content_id = re.search(r'/global/[^/]+/[^/]+/[^/]+/([^/]+)', collection_url).group(1)
            response = requests.get(
                zee5_com.CONTENT_SHOW_URL.format(content_id=content_id),
                headers={'x-access-token': zee5_com.ACCESS_TOKEN}
            ).content.decode()

            if ">access denied<" in response.lower():
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=collection_url,
                    reason='You requested too much content recently',
                    solution='Wait 10 minutes'
                ))

            response = json.loads(response)
            season_id = response["season_details"]["id"]

            season_title = response.get("title", None)
            if season_title is None:
                season_title = season_id
            season_title = get_valid_filename(season_title)

            content_url = zee5_com.CONTENT_SHOW_URL.replace("{content_id}", "")
            page = 1
            is_asc = None
            compare = []

            while True:
                current_page = json.loads(requests.get(
                    content_url, headers={'x-access-token': zee5_com.ACCESS_TOKEN},
                    params={
                        'type': 'episode', 'translation': 'en',
                        'season_id': season_id, 'page': str(page),
                        'limit': f'{zee5_com.PAGE_LIMIT}'
                    }
                ).content.decode())

                for episode in current_page["episode"]:
                    episode_index = episode["episode_number"]
                    if len(compare) < 2:
                        compare.append(int(episode_index))
                    elif is_asc is None and len(compare) >= 2:
                        is_asc = compare[0] < compare[1]

                    if is_asc is None:
                        check = check_range(False, None, episode_index)
                        if check in [True, False]:
                            continue
                    else:
                        check = check_range(False, None, episode_index, is_asc)
                        if check is True:
                            continue
                        elif check is False:
                            return collection

                    episode_id = episode["id"]
                    episode_title = episode.get("title", None)
                    if episode_title is None:
                        episode_title = episode.get("original_title", None)
                    if episode_title is None:
                        episode_title = episode_id
                    episode_title = get_valid_filename(episode_title)

                    collection.append(BaseElement(
                        url=f'{zee5_com.BASE_URL}/{episode["web_url"]}',
                        collection=join(
                            join(
                                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                zee5_com.__name__
                            ),
                            f"Series_{season_title}"
                        ),
                        element=f"Episode_{episode_index}_{episode_title}"
                    ))

                page += 1
                if current_page.get("next_episode_api", None) is None:
                    break
            return collection
