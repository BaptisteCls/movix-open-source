import builtins
import json
import os
import re
import time
from os.path import join

import requests
from bs4 import BeautifulSoup

from utils.constants.macros import USER_ERROR, ERR_MSG, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh
from utils.tools.common import get_valid_filename, clean_url, get_country_code, has_only_roman_chars, \
    get_width_res_from_height, get_ext_from_url


class viu_com(BaseService):
    DEMO_URLS = [
        "https://www.viu.com/ott/hk/zh/vod/102327/Viu-Beauty",
        "https://www.viu.com/ott/za/en/vod/2379047/Skeem-Saam-S13",
        "https://www.viu.com/ott/sg/en/vod/318741/Running-Man-2020",
        "https://www.viu.com/ott/sg/en/vod/2552615/aespa-WORLD-TOUR-in-cinemas",
        "https://www.viu.com/ott/sg/en/vod/2404949/Love-My-Scent",
        "https://www.viu.com/ott/th/th/vod/2573027/Trailer-FWB-%E0%B8%AB%E0%B9%89%E0%B8%B2%E0%B8%A1%E0%B8%A3%E0%B8%B1%E0%B8%81-%E0%B8%AB%E0%B9%89%E0%B8%B2%E0%B8%A1%E0%B8%A3%E0%B8%B9%E0%B9%89%E0%B8%AA%E0%B8%B6%E0%B8%81",
    ]

    PLAYBACK_URL = 'https://api-gateway-global.viu.com/api/playback/distribute'
    TOKEN_URL = 'https://api-gateway-global.viu.com/api/auth/token'
    MOBILE_URL = 'https://api-gateway-global.viu.com/api/mobile'

    COUNTRY_CODE = None
    BEARER_TOKEN = None
    REGIONS = [
        "MY", "ID", "IN", "AE", "BH", "EG", "IQ", "JO", "KW", "OM", "QA",
        "SA", "MM", "ZA", "YE", "LS", "SZ", "ZM", "BW", "NA", "MW", "KE",
        "RW", "UG", "TZ", "GH", "NG", "ET", "DZ", "LY", "MR", "MA", "TN",
        "LB", "IL", "PS", "SD", "HK", "SG", "TH", "PH", "AU", "NZ"
    ]
    PAGE_SIZE = 50
    LICENSE_RETRIES = 4
    PLATFORM = 'web'

    @staticmethod
    def test_service():
        main_service.run_service(viu_com)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_bearer_token():
        response = requests.post(
            viu_com.TOKEN_URL,
            params={'platformFlagLabel': viu_com.PLATFORM, 'countryCode': viu_com.COUNTRY_CODE},
            json={'language': 'en', 'platform': 'browser', 'uuid': 'uuid'}
        )
        status_code = response.status_code
        response = response.content.decode()

        if (400 <= status_code < 500
                and
                ("error.general.out_of_region" in response or "country code must be" in response)
        ):
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=f'from the {viu_com.__name__} service',
                reason="Need specific region IP to access content",
                solution=f"Use a VPN with one of the following regions: {viu_com.REGIONS}"
            ))

        response = json.loads(response)
        bearer_token = response.get("token", None)
        if bearer_token is None:
            raise CustomException(ERR_MSG.format(
                type=f'{APP_ERROR}',
                url=f'from the {viu_com.__name__} service',
                reason=f"Failed to get bearer token: {str(response)}",
                solution="Debug the service"
            ))
        return bearer_token

    @staticmethod
    def initialize_service():
        if viu_com.COUNTRY_CODE is None:
            viu_com.COUNTRY_CODE = get_country_code()

            if viu_com.COUNTRY_CODE is None:
                raise CustomException(ERR_MSG.format(
                    type=f'{APP_ERROR}',
                    url=f'from the {viu_com.__name__} service',
                    reason="Failed to obtain the country code",
                    solution="Fix the code responsible for obtaining the country code"
                ))
            else:
                viu_com.COUNTRY_CODE = viu_com.COUNTRY_CODE.upper()

        if viu_com.BEARER_TOKEN is None:
            viu_com.BEARER_TOKEN = viu_com.get_bearer_token()
        return viu_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = None
        for i in range(1, viu_com.LICENSE_RETRIES + 1):
            try:
                licence = requests.post(
                    additional["license_url"], data=challenge,
                    headers={
                        "authorization": additional["license_token"],
                        "x-client": viu_com.PLATFORM
                    }
                )
                licence.raise_for_status()
                break
            except Exception as e:
                response = e.response
                if response.status_code >= 300 or response.status_code < 200:
                    if i < viu_com.LICENSE_RETRIES:
                        time.sleep(3)
                        continue
                raise e
        return licence.content

    @staticmethod
    def merge_manifest_dict(manifest_dict, source_element):
        m3u8s = []
        for m_res, m_src in manifest_dict.items():
            temp_url = clean_url(m_src)

            if not temp_url.endswith(".m3u8"):
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format can't be merged: {temp_url}",
                    solution=f"Extend the {viu_com.__name__} service"
                ))
            try:
                res = int(re.findall(r"\d+", m_res)[0])
                m3u8s.append((int(res), m_src))
            except:
                pass

        status_code = requests.head(m3u8s[-1][1]).status_code
        if status_code < 200 or status_code >= 300:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't download paid content or your VPN was detected",
                solution='Do not attempt to download it or change your VPN IP'
            ))

        output_path = join(source_element.collection, source_element.element)
        if not os.path.exists(output_path):
            os.makedirs(output_path)

        m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n"
        for m_res, m_src in m3u8s:
            resolution = f'{get_width_res_from_height(m_res)}x{m_res}'
            m3u8_content += f"#EXT-X-STREAM-INF:BANDWIDTH={int(m_res) * 100000},RESOLUTION={resolution}\n"
            m3u8_content += f"{m_src}\n"
        m3u8_content += "#EXT-X-ENDLIST\n"

        output_path = join(str(output_path), "master.m3u8")
        with open(output_path, "w") as f:
            f.write(m3u8_content)
        return output_path

    @staticmethod
    def get_video_data(source_element):
        if source_element.additional is None:
            source_element.additional = {}
        product_id = source_element.additional.get("product_id", None)
        if product_id in ["", None]:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't download paid content",
                solution='Do not attempt to download it'
            ))

        content_region = source_element.additional.get("content_region", "")
        content_id = source_element.additional.get("content_id", "")
        content_params = source_element.additional.get("content_params", None)
        subtitles = source_element.additional.get("subtitles", None)
        if subtitles is None:
            _, _, subtitles, content_params = viu_com.analyse_page(source_element.url, content_id, content_region)

        additional = {}
        resolutions = []
        is_drm = None
        for duration in [None, '180']:
            params = content_params
            params['ccs_product_id'] = product_id
            is_preview = duration is not None
            if is_preview:
                params['duration'] = duration

            manifest_dict = {}
            try:
                response = requests.get(
                    viu_com.PLAYBACK_URL, params=params,
                    headers={'Authorization': f'Bearer {viu_com.BEARER_TOKEN}'}
                )
                response = response.content.decode()
                response = json.loads(response)["data"]["stream"]
                assert type(response) is dict

                is_drm = response.get("is_drm", "")
                if is_drm is None:
                    is_drm = ""
                is_drm = is_drm.lower() in ["y", "yes"]
                if is_drm:
                    drm_dict = response["drm"]
                    additional["license_url"] = drm_dict["license_url"]
                    additional["license_token"] = drm_dict["token"]["authorization"]

                resolutions = list(response["size"].keys())
                for stream_k, stream_v in response.items():
                    if type(stream_v) is not dict:
                        continue

                    is_valid = True
                    for source_k, source_v in stream_v.items():
                        if source_k not in resolutions or type(source_v) is not str:
                            is_valid = False
                            break
                        temp_str = clean_url(source_v).split("/")[-1]
                        if is_drm:
                            if not temp_str.endswith(".mpd"):
                                is_valid = False
                                break

                        if is_preview:
                            if "_var_" not in temp_str and "_var." not in temp_str:
                                is_valid = False
                                break
                            source_v = re.sub(
                                fr"/{temp_str}\?",
                                f'/{temp_str.replace("_var_", "_").replace("_var.", ".")}?',
                                source_v
                            )
                        manifest_dict[source_k] = source_v

                    if not is_valid:
                        manifest_dict = {}
                        continue
                    break

                assert len(manifest_dict.keys()) > 0
                assert len(resolutions) > 0
                break
            except:
                manifest_dict = {}
                continue

        if len(manifest_dict.keys()) == 0:
            if is_drm:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason=f"DRM not supported. Widevine DASH/MPD wasn't found",
                    solution="Do not attempt to download it"
                ))
            if is_preview:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason="Can't download paid content",
                    solution='Do not attempt to download it'
                ))
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason=f"The content isn't available, or you need {content_region} IP",
                solution=f"Do not attempt to download it or use a VPN (that is not detected)"
            ))

        pssh_value = None
        if is_drm:
            manifest_url = manifest_dict[resolutions[-1]]
            is_free = True
            try:
                manifest_content = requests.get(manifest_url)
                is_free = 200 <= manifest_content.status_code < 300
                pssh_value = get_pssh_from_cenc_pssh(manifest_content.text)
            except:
                pssh_value = None

            if not is_free:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason="Can't download paid content or your VPN was detected",
                    solution='Do not attempt to download it or change your VPN IP'
                ))

            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {clean_url(manifest_url)}",
                    solution=f"Extend the {viu_com.__name__} service"
                ))

        else:
            manifest_url = viu_com.merge_manifest_dict(manifest_dict, source_element)

        srt_index = 0
        srts = []
        srt_path = join(source_element.collection, source_element.element)
        for subtitle in subtitles:
            for u in ['url', 'second_subtitle_url']:
                try:
                    srt_url = subtitle[u]
                    assert srt_url.startswith("http")
                    srt_index += 1

                    srt_title = subtitle.get("code", "")
                    srt_title = f'subtitle_{srt_index} {srt_title}'
                    srt_ext = get_ext_from_url(srt_url)
                    if srt_ext in ["", None]:
                        srt_ext = ".srt"

                    srts.append((False, BaseElement(
                        url=srt_url,
                        collection=srt_path,
                        element=f'{get_valid_filename(srt_title)}{srt_ext}'
                    )))
                except:
                    pass

        additional["SUBTITLES"] = srts
        return manifest_url, pssh_value, additional

    @staticmethod
    def analyse_page(page_url, content_id, content_region):
        series_id = None
        collection_title = None
        current_subtitles = []
        distribute_params = {
            'platform_flag_label': viu_com.PLATFORM,
            'platformFlagLabel': viu_com.PLATFORM, 'ut': '0'
        }

        try:
            response = requests.get(page_url).text
            soup = BeautifulSoup(response, 'html5lib')
            script = soup.find_all('script', {'type': 'application/json'})
            script = [s for s in script if s.get("id", None) == "__NEXT_DATA__"]

            assert len(script) > 0
            for s in script:
                s_text = s.string.lower()
                if "product_detail" in s_text and content_id in s_text:
                    script = json.loads(s.string)
                    break
            assert type(script) is dict

            script = script["props"]["pageProps"]["fallback"]
            for script_key, script_val in script.items():
                script_key = script_key.lower()
                if "product_detail" not in script_key or content_id not in script_key:
                    continue

                try:
                    series_id = script_val['data']["series"]["series_id"]
                    assert len(series_id) > 0
                except:
                    series_id = None
                    continue

                try:
                    current_subtitles = script_val['data']['current_product']['subtitle']
                    assert len(current_subtitles) > 0
                except:
                    current_subtitles = []

                try:
                    d_params = script_val['server']['area']
                    assert type(d_params) is dict
                except:
                    d_params = {}

                try:
                    area_id = d_params['area_id']
                    assert type(area_id) in [str, int] and area_id != ''
                    area_id = str(area_id)
                    distribute_params['area_id'] = area_id
                    distribute_params['areaId'] = area_id
                except:
                    pass
                try:
                    country = d_params['country']['code']
                    assert len(country) > 0 and type(country) is str
                    distribute_params['countryCode'] = country
                except:
                    pass

                try:
                    langs = d_params['language']
                    if type(langs) is not list:
                        langs = [langs]

                    def_lang = [lg for lg in langs if lg.get('is_default', None) == '1']
                    if len(def_lang) > 0:
                        lang_id = def_lang[0]['language_flag_id']
                    else:
                        lang_id = langs[0]['language_flag_id']

                    assert len(lang_id) > 0 and type(lang_id) is str
                    distribute_params['language_flag_id'] = lang_id
                    distribute_params['languageFlagId'] = lang_id
                except:
                    pass

                try:
                    collection_title = script_val['data']["series"]["name"]
                    assert len(collection_title) > 0
                    assert has_only_roman_chars(collection_title)
                except:
                    collection_title = f'Series {content_id}'
                break

            assert len(series_id) > 0
        except:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=page_url,
                reason=f"The content isn't available or need {content_region} IP to access content",
                solution=f"Do not attempt to download it or use a VPN"
            ))
        return series_id, collection_title, current_subtitles, distribute_params

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/vod/" not in collection_url or "/ott/" not in collection_url:
            return None

        content_id = re.findall(r"/vod/([^/]+)/", collection_url)[0]
        content_region = collection_url.split("/")[4]
        series_id, collection_title, current_subtitles, dist_params = viu_com.analyse_page(
            collection_url, content_id, content_region
        )

        try:
            assert len(collection_title) > 0
            assert has_only_roman_chars(collection_title)
        except:
            collection_title = f'Series {content_id}'
        collection_title = join(join(
            str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
            viu_com.__name__
        ), get_valid_filename(collection_title))

        page = 0
        collection = []
        while True:
            page += 1
            response = requests.get(
                viu_com.MOBILE_URL,
                params={
                    'countryCode': viu_com.COUNTRY_CODE, 'series_id': series_id,
                    'size': viu_com.PAGE_SIZE, 'page': page,
                    'platformFlagLabel': viu_com.PLATFORM,
                    'r': '/vod/product-list', 'sort': 'asc'
                }
            )
            response = response.content.decode()
            response = json.loads(response)

            try:
                products = response["data"]["product_list"]
                assert type(products) is list and len(products) > 0
            except:
                products = []
            if len(products) == 0:
                break

            for product in products:
                try:
                    product_index = int(product["number"])
                    assert len(product["product_id"]) > 0
                    assert len(product["ccs_product_id"]) > 0
                except:
                    continue

                check = check_range(False, None, product_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                try:
                    episode_title = product.get("synopsis", "")
                    assert len(episode_title) > 0
                    assert has_only_roman_chars(episode_title)
                except:
                    episode_title = product['product_id']

                content_subtitles = current_subtitles if product["product_id"] == content_id else None
                content_params = dist_params if product["product_id"] == content_id else None
                collection.append(BaseElement(
                    url=re.sub(
                        r"/vod/[^/]+/", f"/vod/{product['product_id']}/",
                        collection_url
                    ),
                    collection=collection_title,
                    element=get_valid_filename(f'Episode_{product_index} {episode_title}'),
                    additional={
                        "product_id": product["ccs_product_id"],
                        "content_region": content_region,
                        "content_id": product['product_id'],
                        'subtitles': content_subtitles,
                        "content_params": content_params
                    }
                ))
        return collection
