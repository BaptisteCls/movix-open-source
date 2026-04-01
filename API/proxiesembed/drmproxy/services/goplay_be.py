import base64
import builtins
import json
import os
import re
from os.path import join

import browser_cookie3
import requests
import xmltodict

from utils.constants.macros import USER_ERROR, ERR_MSG, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh
from utils.tools.common import get_valid_filename, clean_url


class goplay_be(BaseService):
    DEMO_URLS = [
        "https://www.goplay.be/video/nonkels/de",
        "https://www.goplay.be/video/maxine/maxine/maxine-s1-aflevering-2",
        "https://www.goplay.be/video/left-for-dead-the-ashley-reeves-story",
        "https://www.goplay.be/video/jodi-arias-dirty-little-secret-1",
        "https://www.goplay.be/vermist",
        "https://www.goplay.be/de-spor",
        "https://www.goplay.be/de-expeditie",
    ]

    CONTENT_URL = "https://api.goplay.be/web/v1/videos/{content_type}/{uuid}"
    STREAM_URL = 'https://dai.google.com/ondemand/dash/content/{content_id}/vid/{video_id}/streams'
    LICENSE_URL = "https://widevine.keyos.com/api/v4/getLicense"
    BASE_URL = "https://www.goplay.be"

    BEARER_TOKEN = None
    AMZ_JSON = 'application/x-amz-json-1.1'

    @staticmethod
    def test_service():
        main_service.run_service(goplay_be)

    @staticmethod
    def get_additional_params(additional):
        additional_params = BaseService.get_additional_params(additional)
        manifest_url = additional.get("manifest_url", None)
        if manifest_url is not None:
            manifest_url = clean_url(manifest_url)
            additional_params = [(
                "BASE_URL", lambda s: s.format(value=manifest_url)
            )] + additional_params
        return additional_params

    @staticmethod
    def credentials_needed():
        return {"FIREFOX_COOKIES": True}

    @staticmethod
    def get_bearer():
        cookie_dict = {}
        check_cookies = {}
        check_list = ["accesstoken", "refreshtoken"]

        for c in browser_cookie3.firefox(domain_name='goplay.be'):
            cookie_dict[c.name] = c.value
            cookie_name = c.name.lower()
            for f in check_list:
                if f in cookie_name:
                    check_cookies[f] = True
        if len(cookie_dict.keys()) == 0 or len(check_cookies.keys()) != len(check_list):
            return None

        refresh_token = None
        client_id = None
        refresh_url = None
        for c, v in cookie_dict.items():
            c_name = c.lower()
            if "accesstoken" in c_name:
                refresh_url = json.loads(base64.b64decode(v.split(".")[1]  + "==").decode())["iss"]
                refresh_url = "/".join(refresh_url.split("/")[:-1]) + "/"

            if "refreshtoken" in c_name:
                refresh_token = v
                client_id = c.split(".")[1]

            if refresh_url is not None and refresh_token is not None:
                break

        assert len(refresh_token) > 0
        assert len(client_id) > 0
        assert len(refresh_url) > 0

        response = requests.post(
            refresh_url,
            headers={
                'content-type': goplay_be.AMZ_JSON,
                'x-amz-target': 'AWSCognitoIdentityProviderService.InitiateAuth'
            },
            data=json.dumps({
                "ClientId": client_id, "AuthFlow": "REFRESH_TOKEN_AUTH",
                "AuthParameters": {"REFRESH_TOKEN": refresh_token}
            })
        )
        response = response.content.decode()
        response = json.loads(response)
        return response["AuthenticationResult"]["AccessToken"]

    @staticmethod
    def initialize_service():
        if goplay_be.BEARER_TOKEN is None:
            goplay_be.BEARER_TOKEN = goplay_be.get_bearer()
            if goplay_be.BEARER_TOKEN is None:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=f'from {goplay_be.__name__}',
                    reason='Need account for this service',
                    solution='Sign into your account using Firefox'
                ))
        return goplay_be

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            goplay_be.LICENSE_URL, data=challenge,
            headers={"customdata": additional["drm_token"]}
        )
        licence.raise_for_status()
        return licence.content

    @staticmethod
    def extend_dict(input_dict, input_key, input_value):
        old_value = input_dict.get(input_key, None)
        if old_value is None:
            input_dict[input_key] = input_value
            return input_dict

        for k1, v1 in input_value.items():
            if v1 is None:
                continue
            if type(v1) is not list:
                v1 = [v1]

            v2 = old_value.get(k1, None)
            if v2 is None:
                old_value[k1] = v1
                continue
            if type(v2) is not list:
                v2 = [v2]

            v2.extend(v1)
            old_value[k1] = v2
        input_dict[input_key] = old_value

    @staticmethod
    def generate_master_mpd(source_element, mpd_content):
        xml_dict = xmltodict.parse(mpd_content)
        xml_node = xml_dict["MPD"]
        new_nodes = []

        xml_periods = xml_node["Period"]
        if type(xml_periods) is not list:
            xml_periods = [xml_periods]
        for period in xml_periods:
            if "-ad-" in period["@id"]:
                continue
            new_nodes.append(period)

        segment_dict = {}
        assert len(new_nodes) >= 1
        for loop in range(0, 2):
            if loop == 1:
                new_nodes = [new_nodes[0]]

            for node in new_nodes:
                adaptations = node["AdaptationSet"]
                if type(adaptations) is not list:
                    adaptations = [adaptations]

                for adaptation in adaptations:
                    representations = adaptation["Representation"]
                    if type(representations) is not list:
                        representations = [representations]

                    for representation in representations:
                        segment_key = representation.get("@width", representation.get("@audioSamplingRate", None))
                        if loop == 0:
                            goplay_be.extend_dict(
                                segment_dict, segment_key,
                                representation["SegmentTemplate"]["SegmentTimeline"]
                            )
                        else:
                            representation["SegmentTemplate"]["SegmentTimeline"] = segment_dict[segment_key]

        xml_dict["MPD"]["Period"] = new_nodes
        mpd_content = xmltodict.unparse(xml_dict, pretty=True)
        output_path = join(source_element.collection, source_element.element)
        if not os.path.exists(output_path):
            os.makedirs(output_path)
        output_path = join(str(output_path), "master.mpd")

        with open(output_path, "w") as f:
            f.write(mpd_content)
        return output_path

    @staticmethod
    def get_video_data(source_element):
        response = requests.get(source_element.url, headers={'Accept': 'application/json'})
        response = json.loads(response.content.decode())
        if response.get("uuid", None) in ["", None]:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        content_type = response["contentType"]
        content_type = re.sub(r'([a-z])([A-Z])', r'\1-\2', content_type).lower()
        response = requests.get(
            goplay_be.CONTENT_URL.format(content_type=content_type, uuid=response["uuid"]),
            headers={'Authorization': f'Bearer {goplay_be.BEARER_TOKEN}'},
        )
        status_code = response.status_code
        response = json.loads(response.content.decode())
        message = response.get("message", "").lower()

        if 400 <= status_code < 500 and "locked" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need Belgian IP to access content",
                solution="Use a VPN"
            ))

        if source_element.element is None:
            try:
                program = response["tracking"]["cimName"]
                assert len(program) > 0
            except:
                program = ""
            if program == "":
                try:
                    program = response["tracking"]["piano"]["program"]
                    assert len(program) > 0
                except:
                    program = ""
        else:
            program = ""

        try:
            title = response["title"]
        except:
            title = ""
        if title.lower() == program.lower():
            title = ""

        if source_element.element is None:
            source_element.element = ""
            for f in ["seasonNumber", "episodeNumber"]:
                try:
                    title += " " + f[0].upper() + str(int(response[f]))
                except:
                    pass

        source_element.element = get_valid_filename(source_element.element + " " + program + " " + title)
        if source_element.element in ["", None]:
            source_element.element = source_element.url.split("/video/")[-1]
            source_element.element = get_valid_filename(source_element.element)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                goplay_be.__name__
            )

        drm_token = None
        try:
            is_drm = response["flags"]["isDrm"]
            assert is_drm
            drm_token = response["drmXml"]
            assert len(drm_token) > 0 and type(drm_token) is str
            is_drm = True
        except:
            is_drm = False

        try:
            manifest = response["manifestUrls"]["dash"]
            assert len(manifest) > 0
        except:
            manifest = None

        if manifest is None:
            response = response["ssai"]
            response = requests.post(goplay_be.STREAM_URL.format(
                content_id=response["contentSourceID"],
                video_id=response["videoID"]
            ))

            try:
                assert 200 <= response.status_code < 300
                response = response.content.decode()
                response = json.loads(response)
            except:
                raise CustomException(ERR_MSG.format(
                    type=f'{USER_ERROR}/{APP_ERROR}',
                    url=source_element.url,
                    reason=f"Dash manifest not found",
                    solution=f"If you can watch the video in browser, then extend the {goplay_be.__name__} service"
                ))

            manifest = response["stream_manifest"]
            if response.get("manifest_format", "dash").lower() not in ["dash", "mpd"]:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}",
                    solution=f"Extend the {goplay_be.__name__} service"
                ))

        pssh_value = None
        additional = {"drm_token": drm_token}
        mpd_content = None
        if is_drm or builtins.CONFIG.get("BASIC", False) is False:
            mpd_content = requests.get(manifest).content.decode()

        if is_drm:
            try:
                pssh_value = get_pssh_from_cenc_pssh(mpd_content)
            except:
                pssh_value = None
            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {manifest}",
                    solution=f"Extend the {goplay_be.__name__} service"
                ))

        if builtins.CONFIG.get("BASIC", False) is True:
            return manifest, pssh_value, additional

        additional["manifest_url"] = manifest
        try:
            manifest = goplay_be.generate_master_mpd(source_element, mpd_content)
        except:
            raise CustomException(ERR_MSG.format(
                type=APP_ERROR,
                url=source_element.url,
                reason=f"Manifest format not supported: {manifest}",
                solution=f"Extend the {goplay_be.__name__} service"
            ))
        return manifest, pssh_value, additional

    @staticmethod
    def get_label_index(label, label_regex):
        if label is None or len(label) == 0:
            return None
        label = label.lower()
        label = re.sub(r'\s+', ' ', label)
        label = label.replace(' ', "_")
        for r in label_regex:
            try:
                return int(re.findall(r, label)[0])
            except:
                pass
        return None

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/live-kijken" in collection_url:
            return None
        if "/video/" in collection_url:
            return [BaseElement(url=collection_url)]

        response = requests.get(collection_url)
        response = response.content.decode()
        try:
            collection_title = re.findall(r'<title>([^<>]+)</title>', response)[0]
            collection_title = get_valid_filename(collection_title)
            assert len(collection_title) > 0
        except:
            collection_title = collection_url.split("/")[-1]
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                goplay_be.__name__
            ),
            get_valid_filename(collection_title)
        )

        videos = []
        visited = []
        for video in re.findall(
                fr'"([^"]*/video/{collection_url.split("/")[-1]}/[^\\"]+)[\\"]',
                response
        ):
            if not video.startswith("http"):
                video = goplay_be.BASE_URL + video
            if video in visited:
                continue
            visited.append(video)

            paths = video.split("/")[-2:]
            season_index = None
            episode_index = goplay_be.get_label_index(
                label=paths[-1],
                label_regex=["aflevering-(\\d+)"]
            )

            if episode_index is not None:
                for i in [-1, -2]:
                    season_index = goplay_be.get_label_index(
                        label=paths[i],
                        label_regex=["-s(\\d+)[-/]"]
                    )
                    if season_index is not None:
                        break
                if season_index is None:
                    episode_index = None

            videos.append((video, season_index, episode_index))

        extras = [v for v in videos if v[1] is None]
        videos = sorted([v for v in videos if v[1] is not None], key=lambda v: (v[1], v[2]))
        try:
            max_season = max(videos, key=lambda v: v[1])[1] + 1
        except:
            max_season = 1
        extras = [(v[0], max_season, i + 1) for i, v in enumerate(extras)]

        collection = []
        for episode_url, season_index, episode_index in videos + extras:
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

            season_title = "extras" if season_index == max_season else ""
            collection.append(BaseElement(
                url=episode_url,
                collection=join(collection_title, get_valid_filename(f'Season_{season_index} {season_title}')),
                element=f"Episode_{episode_index}"
            ))
        return collection
