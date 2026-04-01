import builtins
import json
import os
import re
from os.path import join
from urllib.parse import urlparse, parse_qs

import requests
import xmltodict

import utils.tools.common as common_tools
from utils.constants.macros import USER_ERROR, ERR_MSG
from utils.main_service import main_service
from utils.structs import BaseElement, BaseService, CustomException
from utils.tools.args import check_range


class plus_fifa_com(BaseService):
    DEMO_URLS = [
        "https://www.plus.fifa.com/en/archive?filters=season%3Afifa-club-world-cup-saudi-arabia-2023tm%2Cstage%3Aopening-rounds",
        "https://www.plus.fifa.com/en/showcase/fifa-world-cup-2022/845fdca5-6741-4ab7-a1aa-af01871843cd",
        "https://www.plus.fifa.com/en/showcase/fifa-women-s-world-cup-germany-2011/19e87433-19ba-4f88-b3d3-c6904b7d5a1e",
        "https://www.plus.fifa.com/en/content/when-the-world-watched/3f3a5286-32e7-4587-a094-0edb473d3ed2",
        "https://www.plus.fifa.com/en/content/the-long-walk/627a8255-ec5f-4b0c-a6d0-0fbae421d699",
        "https://www.plus.fifa.com/en/player/580e692e-e8fc-4ad1-a649-5ec0af83f94d?catalogId=5f24e303-ff42-499f-9d7a-b4f8e0eff2ce",
        "https://www.plus.fifa.com/en/player/dd457324-057e-4f17-8457-527f6a8c115d?catalogId=bcf168c3-813c-4882-9878-84a1074fa03a",
        "https://www.plus.fifa.com/en/player/cd472e9a-21ae-49de-91f4-17da7494e56b?catalogId=bb25cc85-30b2-47e8-b721-a419b961ca19",
        "https://www.plus.fifa.com/en/player/d15f15f2-49ce-41b3-a1d8-8fbd8db61cfe?catalogId=3d2612ff-c06f-4a7e-a2d7-ec73504515b5",
        "https://www.plus.fifa.com/en/player/8bfee684-8857-4de9-b530-20358eab1c70?catalogId=7e3e3ac2-0d41-49a0-843a-3029456c6572",
        "https://www.plus.fifa.com/en/player/6cc0c03f-44d9-4e75-8064-31f5ba8ddc70?catalogId=61b1e4dc-0b9c-4018-bb5f-a89d5746f7cb&entryPoint=CTA",
    ]

    DEVICES_URL = 'https://www.plus.fifa.com/gatekeeper/api/v1/devices/'
    CONTENTS_URL = 'https://www.plus.fifa.com/entertainment/api/v1/contents/{catalog_id}/child'
    SHOWCASES_URL = 'https://www.plus.fifa.com/entertainment/api/v1/showcases/{content_id}/child?orderBy=EDITORIAL'
    ASSET_URL = 'https://www.plus.fifa.com/flux-capacitor/api/v1/videoasset?catalog={catalog_id}'
    SESSION_URL = 'https://www.plus.fifa.com/flux-capacitor/api/v1/streaming/session'
    STREAMING_URL = 'https://www.plus.fifa.com/flux-capacitor/api/v1/streaming/urls'
    SEARCH_URL = 'https://www.plus.fifa.com/api/v2/search'
    VIDEO_URL = 'https://www.plus.fifa.com/en/player/{video_id}?catalogId={catalog_id}'
    LICENSE_URL = "https://www.plus.fifa.com/flux-capacitor/api/v1/licensing/widevine/modular?sessionId={session_id}"

    DEVICE_ID = None
    RES_PRIORITY = {"SDP": 0, "SD": 1, "HD": 2, "HDP": 3}
    PAGE_LIMIT = 50
    LANGUAGE = None

    @staticmethod
    def get_device_id():
        return json.loads(requests.post(
            plus_fifa_com.DEVICES_URL,
            json={
                'model': 'model', 'manufacturer': 'manufacturer',
                'profile': 'WEB', 'store': 'CHILI'
            }
        ).content.decode())["id"]

    @staticmethod
    def test_service():
        main_service.run_service(plus_fifa_com)

    @staticmethod
    def get_additional_params(additional):
        return [("MUXER", lambda s: s.format(args="mkv:muxer=mkvmerge"))]

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        if builtins.CONFIG.get("BASIC", False) is True:
            plus_fifa_com.LANGUAGE = 'eng'
            plus_fifa_com.LANGUAGE = plus_fifa_com.LANGUAGE.lower()

        if plus_fifa_com.DEVICE_ID is None:
            plus_fifa_com.DEVICE_ID = plus_fifa_com.get_device_id()
        return plus_fifa_com

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(plus_fifa_com.LICENSE_URL.format(
            session_id=additional["session_id"]
        ), data=challenge)
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def generate_master_mpd(source_element, manifests):
        manifests_contents = []
        for mpd_url in manifests:
            mpd_content = requests.get(mpd_url).content.decode()
            mpd_content = xmltodict.parse(mpd_content)
            manifests_contents.append((mpd_url, mpd_content))

        audio_set = []
        index = -1
        for mpd_url, mpd_content in manifests_contents:
            index += 1
            manifest_content = mpd_content["MPD"]["Period"]["AdaptationSet"]
            if type(manifest_content) is not list:
                manifest_content = [manifest_content]

            for ad_set in manifest_content:
                if index > 0:
                    if "audio/" not in ad_set["@mimeType"]:
                        continue

                ad_set["BaseURL"] = mpd_url

                if index > 0:
                    audio_set.append(ad_set)

        manifests_contents = [manifests_contents[0][1]]
        manifest_content = manifests_contents[0]["MPD"]["Period"]["AdaptationSet"]
        manifest_content += audio_set
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
    def get_video_data(source_element):
        if "/player/" in source_element.url:
            catalog_id = parse_qs(urlparse(source_element.url).query)["catalogId"][0]
            video_id = re.search(r"/player/([^/?]*)", source_element.url).group(1)
        elif "/content/" in source_element.url:
            catalog_id = source_element.url.split("/")[-1]
            video_id = None
            assets = json.loads(requests.get(
                plus_fifa_com.ASSET_URL.format(catalog_id=catalog_id),
                headers={'x-chili-device-id': plus_fifa_com.DEVICE_ID}
            ).content.decode())
            for asset in assets:
                if asset['type'].lower() != 'main':
                    continue

                video_id = asset['id']
                break

            assert video_id is not None
        else:
            raise

        if source_element.element is None:
            title = common_tools.get_valid_filename(json.loads(requests.get(
                plus_fifa_com.CONTENTS_URL.format(catalog_id=catalog_id).split("/child")[0],
                headers={'x-chili-device-id': plus_fifa_com.DEVICE_ID}
            ).content.decode())['title'])
            if title is None:
                title = f"PlayerId_{video_id}"

            source_element.element = title
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                plus_fifa_com.__name__
            )

        response = json.loads(requests.post(
            plus_fifa_com.SESSION_URL,
            headers={
                'x-chili-device-id': plus_fifa_com.DEVICE_ID,
                'x-chili-avod-compatibility': 'free,free-ads',
                'x-chili-accept-stream': 'mpd/cenc+h264;mpd/clear+h264;mp4/',
                'x-chili-accept-stream-mode': 'multi/codec-compatibility;mono/strict',
                'x-chili-manifest-properties': 'subtitles'
            },
            json={'videoAssetId': video_id}
        ).content.decode())

        if response.get("id", None) is None:
            if response.get("code", "") not in ["", None]:
                if "not_playable" in response["code"].lower():
                    raise CustomException(ERR_MSG.format(
                        type=USER_ERROR,
                        url=source_element.url,
                        reason="URL doesn't contain a video",
                        solution="Do not attempt to download it"
                    ))

        session_id = response["id"]
        manifest = sorted(json.loads(requests.get(
            plus_fifa_com.STREAMING_URL, headers={'x-chili-streaming-session': session_id}
        ).content.decode()), key=lambda m: plus_fifa_com.RES_PRIORITY[m["quality"]], reverse=True)

        manifest = [m for m in manifest if m["quality"] == manifest[0]["quality"]]
        if plus_fifa_com.LANGUAGE is not None:
            temp_man = [
                m for m in manifest
                if m["language"].lower().startswith(plus_fifa_com.LANGUAGE)
                   or plus_fifa_com.LANGUAGE.startswith(m["language"].lower())
            ]
            if len(temp_man) > 0:
                manifest = [temp_man[0]]
            else:
                manifest = [manifest[0]]

        manifest = [m["url"] for m in manifest]
        pssh_values = []
        additional = {"PLUS_SERVICE": True}

        for m in manifest:
            try:
                pssh_value = str(min(
                    re.findall(
                        r'<cenc:pssh\b[^>]*>(.*?)</cenc:pssh>',
                        requests.get(m).content.decode()
                    ), key=len
                ))
            except:
                pssh_value = None

            if pssh_value is not None:
                if pssh_value not in pssh_values:
                    pssh_values.append(pssh_value)
                    additional[pssh_value] = {
                        "session_id": session_id,
                        "PLUS_SERVICE": True
                    }

        if len(manifest) > 1:
            manifest = plus_fifa_com.generate_master_mpd(source_element, manifest)
        else:
            manifest = manifest[0]
        return manifest, pssh_values, additional

    @staticmethod
    def get_filters_name(filters):
        filters = [f.split(":")[1] for f in filters.split(",")]
        filters = sorted(filters, key=len)

        filters_name = "Filters_" + str(filters[0])
        filters_name = common_tools.get_valid_filename(filters_name)
        return filters_name

    @staticmethod
    def get_collection_elements(collection_url):
        if "/player/" in collection_url and "catalogId=" in collection_url:
            return [BaseElement(url=collection_url)]

        collection = []
        if "/archive" in collection_url and "filters=" in collection_url:
            params_dict = parse_qs(urlparse(collection_url).query)
            filters = params_dict.get("filters", [None])[0]
            if filters is None:
                return None

            collection_name = plus_fifa_com.get_filters_name(filters)
            collection_name = join(join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                plus_fifa_com.__name__
            ), collection_name)

            if "fifa-plus:archive-project-fifa-plus" not in filters:
                filters += ",fifa-plus:archive-project-fifa-plus"
            response = requests.get(
                plus_fifa_com.SEARCH_URL,
                headers={'x-chili-device-id': plus_fifa_com.DEVICE_ID},
                params={
                    'filters': filters,
                    'limit': plus_fifa_com.PAGE_LIMIT,
                    'after': '0',
                    'orderBy': 'TIMESTAMP_DESC'
                }
            )

            index = 0
            while True:
                response = json.loads(response.content.decode())

                for result in response.get("results", []):
                    index += 1
                    check = check_range(False, None, index)
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    c_id = result["id"]
                    assets = json.loads(requests.get(
                        plus_fifa_com.ASSET_URL.format(catalog_id=c_id),
                        headers={'x-chili-device-id': plus_fifa_com.DEVICE_ID}
                    ).content.decode())

                    video_id = element_title = None
                    for asset in assets:
                        if asset['type'].lower() != 'main':
                            continue

                        video_id = asset['id']
                        element_title = asset['title']
                        break

                    if video_id is None:
                        continue

                    collection.append(BaseElement(
                        url=plus_fifa_com.VIDEO_URL.format(video_id=video_id, catalog_id=c_id),
                        collection=collection_name,
                        element=f'{index}'
                                f'_'
                                f'{common_tools.get_valid_filename(element_title)}'
                    ))

                response = response["pagination"].get("next", None)
                if response is None or type(response) is not dict:
                    break
                if response.get("url", None) is None:
                    break
                response = requests.get(
                    response["url"],
                    headers={'x-chili-device-id': plus_fifa_com.DEVICE_ID}
                )

            return collection

        if "/showcase/" in collection_url:
            content_id = re.search(r'/showcase/[^/]+/([^?/]+)', collection_url).group(1)
            content_title = common_tools.get_valid_filename(json.loads(requests.get(
                plus_fifa_com.SHOWCASES_URL.format(content_id=content_id).split("/child?")[0],
                headers={'x-chili-device-id': plus_fifa_com.DEVICE_ID}
            ).content.decode())['title'])
            if content_title is None:
                content_title = f'ShowcaseId_{content_id}'

            response = json.loads(requests.get(
                plus_fifa_com.SHOWCASES_URL.format(content_id=content_id),
                headers={'x-chili-device-id': plus_fifa_com.DEVICE_ID}
            ).content.decode())

            index = 0
            for content in response:
                index += 1
                check = check_range(False, None, index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                c_id = content["id"]
                assets = json.loads(requests.get(
                    plus_fifa_com.ASSET_URL.format(catalog_id=c_id),
                    headers={'x-chili-device-id': plus_fifa_com.DEVICE_ID}
                ).content.decode())

                video_id = element_title = None
                for asset in assets:
                    if asset['type'].lower() != 'main':
                        continue

                    video_id = asset['id']
                    element_title = asset['title']
                    break

                if video_id is None:
                    continue

                collection.append(BaseElement(
                    url=plus_fifa_com.VIDEO_URL.format(video_id=video_id, catalog_id=c_id),
                    collection=join(join(
                        str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                        plus_fifa_com.__name__
                    ), content_title),
                    element=f'{index}'
                            f'_'
                            f'{common_tools.get_valid_filename(element_title)}'
                ))

            return collection

        if "/content/" in collection_url:
            try:
                content_id = re.search(r'/content/[^/]+/([^/]+)', collection_url).group(1)
            except:
                content_id = re.search(r'/content/([^/]+)', collection_url).group(1)

            content_title = common_tools.get_valid_filename(json.loads(requests.get(
                plus_fifa_com.CONTENTS_URL.format(catalog_id=content_id).split("/child")[0],
                headers={'x-chili-device-id': plus_fifa_com.DEVICE_ID}
            ).content.decode())['title'])
            if content_title is None:
                content_title = f'ContentId_{content_id}'

            response = json.loads(requests.get(
                plus_fifa_com.CONTENTS_URL.format(catalog_id=content_id),
                headers={'x-chili-device-id': plus_fifa_com.DEVICE_ID}
            ).content.decode())

            for content in response:
                check = check_range(True, content["orderIndex"], None)
                if check is True:
                    continue
                elif check is False:
                    return collection

                season = json.loads(requests.get(
                    plus_fifa_com.CONTENTS_URL.format(catalog_id=content["id"]),
                    headers={'x-chili-device-id': plus_fifa_com.DEVICE_ID}
                ).content.decode())

                for episode in season:
                    check = check_range(False, content["orderIndex"], episode['orderIndex'])
                    if check is True:
                        continue
                    elif check is False:
                        return collection

                    assets = json.loads(requests.get(
                        plus_fifa_com.ASSET_URL.format(catalog_id=episode["id"]),
                        headers={'x-chili-device-id': plus_fifa_com.DEVICE_ID}
                    ).content.decode())

                    video_id = None
                    for asset in assets:
                        if asset['type'].lower() != 'main':
                            continue

                        video_id = asset['id']
                        break

                    collection.append(BaseElement(
                        url=plus_fifa_com.VIDEO_URL.format(video_id=video_id, catalog_id=episode["id"]),
                        collection=join(
                            join(
                                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                                plus_fifa_com.__name__
                            ),
                            join(content_title, f'Season_{content["orderIndex"]}')
                        ),
                        element=f"Episode_{episode['orderIndex']}"
                                f'_'
                                f"{common_tools.get_valid_filename(episode['title'])}"
                    ))

            return collection
        return None
