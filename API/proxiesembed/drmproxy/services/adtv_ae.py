import builtins
import json
import re
import time
from os.path import join
from urllib.parse import urlparse, urlunparse, parse_qs

import requests

from utils.constants.macros import USER_ERROR, ERR_MSG
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range


class adtv_ae(BaseService):
    DEMO_URLS = [
        "https://adtv.ae/en/shows?media=%D8%A7%D9%84%D8%AC%D8%A7%D8%B1-%D9%84%D9%84%D8%AC%D8%A7%D8%B1&video_external_id=228029_page&externalContentId=228029_page&externalSeriesId=228029&type=Series",
        "https://adtv.ae/en/shows?media=%D8%A7%D9%84%D8%A5%D8%AE%D8%AA%D9%8A%D8%A7%D8%B1&video_external_id=27799990&externalContentId=216885&externalSeriesId=216884&type=Series&externalSeasonId=216885",
        "https://adtv.ae/en/shows?media=%D8%A7%D9%84%D9%86%D9%85%D8%B1&video_external_id=220820_page&externalContentId=220820_page&externalSeriesId=220820&type=Series",
        "https://adtv.ae/en/sports?media=%D8%B9%D8%A7%D9%84%D9%85-%D8%A7%D9%84%D8%AC%D9%8A%D9%88%D8%AC%D9%8A%D8%AA%D8%B3%D9%88&video_external_id=%D8%B9%D8%A7%D9%84%D9%85+%D8%A7%D9%84%D8%AC%D9%8A%D9%88%D8%AC%D9%8A%D8%AA%D8%B3%D9%88&externalContentId=%D8%B9%D8%A7%D9%84%D9%85+%D8%A7%D9%84%D8%AC%D9%8A%D9%88%D8%AC%D9%8A%D8%AA%D8%B3%D9%88&externalSeriesId=229231&type=Series",
        "https://adtv.ae/en/shows/216884/Al%20Ekhteyar/season-2/episode-28",
        "https://adtv.ae/en/sports?media=%D8%A7%D9%84%D8%B3%D8%B9%D9%8A-%D9%84%D8%AA%D8%AD%D9%82%D9%8A%D9%82-%D8%A7%D9%84%D8%AD%D9%84%D9%85&video_external_id=229450_page&externalContentId=229450_page&externalSeriesId=229450&type=Series",
        "https://adtv.ae/en/shows/wasaya%20al%20sabbar-series/Wasaya%20Al-Sabbar/season-1/episode-2",
        "https://adtv.ae/ar/shows/216884/%D8%A7%D9%84%D8%A5%D8%AE%D8%AA%D9%8A%D8%A7%D8%B1/season-2/episode-26",
        "https://adtv.ae/ar/watch?video_external_id=LP00050096&assetExternalId=LP00050096&externalContentId=LP00050096&type=Movie&media=%D8%A3%D8%B7%D9%84%D8%A7%D9%84-%D9%88%D8%AD%D8%B6%D8%A7%D8%B1%D8%A9",
        "https://adtv.ae/en/watch?video_external_id=27884199&assetExternalId=27884199&externalContentId=27884199&type=Movie&media=%D8%B5%D8%B1%D8%A7%D8%B9-%D9%81%D9%89-%D8%A7%D9%84%D9%86%D9%8A%D9%84",
        "https://adtv.ae/en/shows/229775/follow%20the%20wind/season-1/episode-14777",
        "https://adtv.ae/en/shows/HeadCoachSeries/HeadCoachSeries/season-1/episode-11",
        "https://adtv.ae/en/sports/FinalScoreSeries/Final%20Score/season-1/episode-5",
    ]

    CONFIG_URL = 'https://adtv.ae/api/biz/config/v1/config'
    INFO_URL = 'https://adtv.ae/api/biz/video{path}/playinfo'
    DETAIL_URL = 'https://adtv.ae/api/biz/video/aggregate/detail'
    EPISODE_URL = '{base_url}/season-{season_index}/episode-{episode_index}'

    USER_AGENT = None
    LICENSE_RETRIES = 3

    @staticmethod
    def test_service():
        main_service.run_service(adtv_ae)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        if adtv_ae.USER_AGENT is None:
            adtv_ae.USER_AGENT = builtins.CONFIG["USER_AGENT"]
        return adtv_ae

    @staticmethod
    def get_keys(challenge, additional):
        licence = None
        for i in range(1, adtv_ae.LICENSE_RETRIES + 1):
            try:
                licence = requests.post(
                    additional["license_url"], data=challenge,
                    params={"token": additional["token"]},
                    headers={'User-Agent': adtv_ae.USER_AGENT}
                )
                licence.raise_for_status()
                break
            except Exception as e:
                response = e.response
                if response.status_code == 403:
                    if i < adtv_ae.LICENSE_RETRIES:
                        time.sleep(1)
                        continue
                raise e

        return licence.content

    @staticmethod
    def get_content_info(source_element):
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                adtv_ae.__name__
            )

        if "/shows/" in source_element.url or "/sports" in source_element.url:
            if "/shows" in source_element.url:
                ext_id = re.findall(r'/shows/([^/]*)/', source_element.url)[0]
            else:
                ext_id = re.findall(r'/sports/([^/]*)/', source_element.url)[0]
            season_id = re.findall(r'/season-(\d+)', source_element.url)[0]

            response = json.loads(requests.get(
                adtv_ae.DETAIL_URL, headers={'User-Agent': adtv_ae.USER_AGENT},
                params={
                    'type': 'Series', 'client': 'json',
                    'externalSeriesId': ext_id
                }
            ).content.decode())["response"]["tvShowSeasons"]

            for season in response:
                if season["seasonNumber"] == int(season_id):
                    ext_id = season["externalId"]

            ep_id = re.findall(r'/episode-(\d+)', source_element.url)[0]
            path, url_params = "/episode", {
                'season_external_id': ext_id,
                'episode_number': ep_id,
                'client': 'json'
            }

            if source_element.element is None:
                name = ext_id
                if not name.isnumeric():
                    name = "".join([str(ord(c)) for c in name])[0:10]
                source_element.element = f"SeasonId_{name}_Episode_{ep_id}"
        elif "/watch?" in source_element.url:
            query_params = parse_qs(urlparse(source_element.url).query)
            for p in ["assetExternalId", "externalContentId"]:
                ext_id = query_params.get(p, [])
                if len(ext_id) > 0:
                    ext_id = ext_id[0]
                    break
            path, url_params = "", {'asset_external_id': ext_id}
            if source_element.element is None:
                source_element.element = f"VideoId_{ext_id}"
        else:
            raise
        return path, url_params

    @staticmethod
    def get_video_data(source_element):
        try:
            app_locale = [re.findall(r'/([a-zA-Z]{2})/', source_element.url)[0]]
        except:
            app_locale = ["en", "ae"]

        license_url = json.loads(requests.get(
            adtv_ae.CONFIG_URL, headers={'User-Agent': adtv_ae.USER_AGENT}
        ).content.decode())["response"]["widevine_licenser_vod"]
        license_url = urlparse(license_url)
        license_url = urlunparse((
            license_url.scheme, license_url.netloc,
            license_url.path, '', '', ''
        ))

        path, url_params = adtv_ae.get_content_info(source_element)
        manifest, token = None, None

        for locale in app_locale:
            try:
                response = json.loads(requests.get(
                    adtv_ae.INFO_URL.format(path=path), headers={
                        'User-Agent': adtv_ae.USER_AGENT,
                        'App-Locale': locale
                    },
                    params=url_params
                ).content.decode())["response"]
                manifest, token = response["url"], response["token"]
                break
            except:
                continue

        if manifest is None:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        try:
            pssh_value = str(min(re.findall(
                r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                requests.get(manifest).content.decode()
            ), key=len))
        except:
            return manifest, None, {}
        return manifest, pssh_value, {
            "token": token, "license_url": license_url
        }

    @staticmethod
    def get_collection_elements(collection_url):
        if (("/shows/" in collection_url or "/sports" in collection_url)
                and "/season-" in collection_url and "/episode-" in collection_url):
            return [BaseElement(url=collection_url)]
        if "/watch?" in collection_url:
            return [BaseElement(url=collection_url)]

        if ("/shows?" in collection_url or "/sports?" in collection_url) and "externalSeriesId=" in collection_url:
            collection = []
            external_series_id = parse_qs(urlparse(collection_url).query)["externalSeriesId"][0]

            seasons = json.loads(requests.get(
                adtv_ae.DETAIL_URL, headers={'User-Agent': adtv_ae.USER_AGENT},
                params={
                    'type': 'Series', 'contentType': 'Series',
                    'client': 'json', 'externalSeriesId': external_series_id
                }
            ).content.decode())["response"]["tvShowSeasons"]

            seasons = sorted(seasons, key=lambda s: s["seasonNumber"])
            seasons = [s for s in seasons if s["seasonNumber"] > 0]

            for season in seasons:
                check = check_range(True, season["seasonNumber"], None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                for ep_index in range(1, season["numberOfEpisodes"] + 1):
                    check = check_range(False, season["seasonNumber"], ep_index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    collection.append(BaseElement(
                        url=adtv_ae.EPISODE_URL.format(
                            base_url=season["shareLink"],
                            season_index=str(season["seasonNumber"]),
                            episode_index=str(ep_index)
                        ),
                        collection=join(
                            join(
                                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                adtv_ae.__name__
                            ),
                            join(f"Series_{external_series_id}", f"Season_{season['seasonNumber']}")
                        ),
                        element=f"Episode_{ep_index}"
                    ))
            return collection
        return None
