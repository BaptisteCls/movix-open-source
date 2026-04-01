import base64
import builtins
import json
import re
from os.path import join

import requests
from cryptography.hazmat.backends import default_backend
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives.padding import PKCS7

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR, CACHE_DIR
from utils.main_service import main_service
from utils.structs import BaseElement, CustomException, BaseService
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_default_kid, get_pssh_from_cenc_pssh
from utils.tools.common import get_valid_filename, dict_to_file, file_to_dict, get_ext_from_url


class channel4_com(BaseService):
    DEMO_URLS = [
        "https://www.channel4.com/programmes/honest-thief/on-demand/74015-001",
        "https://www.channel4.com/programmes/dance-moms/on-demand/76149-003",
        "https://www.channel4.com/now/M4",
        "https://www.channel4.com/now/4S",
        "https://www.channel4.com/programmes/ugly-betty",
        "https://www.channel4.com/programmes/8-out-of-10-cats-does-countdown",
        "https://www.channel4.com/programmes/first-dates",
    ]

    BUNDLE_JS_URL = "https://static.c4assets.com/all4-player/latest/bundle.app.js"
    STREAM_URL = 'https://www.channel4.com/vod/stream/{stream_id}'
    CHANNEL_URL = 'https://www.channel4.com/simulcast/channels/{channel_id}'
    VIDEO_URL = "https://www.channel4.com/programmes/{program_title}/on-demand/{program_id}"
    ASSET_URL = 'https://www.channel4.com/player/{programme_title}/asset/{asset_id}'
    BASE_URL = "https://www.channel4.com"

    CACHE_FILE = None
    AES_INFO = None
    USER_AGENT = None

    @staticmethod
    def test_service():
        main_service.run_service(channel4_com)

    @staticmethod
    def is_content_livestream(content, additional):
        return "/now/" in content and "/on-demand/" not in content

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def get_aes_info():
        try:
            file_dict = file_to_dict(channel4_com.CACHE_FILE)
            assert len(file_dict.keys()) == 2
            return file_dict
        except:
            pass

        response = requests.get(channel4_com.BUNDLE_JS_URL).content.decode()
        aes_info = {
            "KEY": re.findall(r'"bytes1":"([^"]+)"', response)[0],
            "IV": re.findall(r'"bytes2":"([^"]+)"', response)[0]
        }
        dict_to_file(channel4_com.CACHE_FILE, aes_info)
        return aes_info

    @staticmethod
    def initialize_service():
        if channel4_com.USER_AGENT is None:
            channel4_com.USER_AGENT = builtins.CONFIG["USER_AGENT"]
        if channel4_com.CACHE_FILE is None:
            channel4_com.CACHE_FILE = join(CACHE_DIR, f'{channel4_com.__name__}.json')
            if builtins.CONFIG.get("FRESH", False) is True:
                dict_to_file(channel4_com.CACHE_FILE, {})

        if channel4_com.AES_INFO is None:
            channel4_com.AES_INFO = channel4_com.get_aes_info()
        return channel4_com

    @staticmethod
    def get_keys(challenge, additional):
        additional["json_data"]["message"] = base64.b64encode(challenge).decode()
        licence = requests.post(
            additional["license_url"],
            json=additional["json_data"],
        )
        licence.raise_for_status()
        return json.loads(licence.content.decode())["license"]

    @staticmethod
    def decrypt_message(message):
        cipher = Cipher(
            algorithms.AES(channel4_com.AES_INFO["KEY"].encode()),
            modes.CBC(channel4_com.AES_INFO["IV"].encode()),
            backend=default_backend()
        ).decryptor()
        unpadder = PKCS7(algorithms.AES.block_size).unpadder()

        message = cipher.update(base64.b64decode(message)) + cipher.finalize()
        message = (unpadder.update(message) + unpadder.finalize()).decode()
        return message

    @staticmethod
    def get_js_dict_from_page(page):
        try:
            pattern = re.compile(r'<script>window\.__PARAMS__[^={]*=[^{]*({.*?})</script>', re.DOTALL)
            js_dict = re.findall(pattern, page)[0]
            for f1 in ",]}":
                for f2, v2 in [("undefined", "null")]:
                    js_dict = js_dict.replace(f":{f2}{f1}", f":{v2}{f1}")

            return json.loads(js_dict)
        except:
            return {}

    @staticmethod
    def get_title_from_js_dict(js_dict, is_collection):
        init_data = js_dict.get("initialData", {})
        brand = init_data.get("brand", {})
        page_data = init_data.get("pageData", {})
        select_ep = init_data.get("selectedEpisode", {})
        og_tags = init_data.get("ogTags", {})

        video_title = ""
        if og_tags.get("title", None) not in ["", None]:
            video_title = og_tags["title"]
        if video_title not in ["", None]:
            return video_title

        brand_title = ""
        for f in ["title", "websafeTitle"]:
            if brand_title in ["", None] and brand.get(f, None) not in ["", None]:
                brand_title = brand[f]
            if brand_title not in ["", None]:
                break
        if brand_title in ["", None] and page_data.get("title", None) not in ["", None]:
            brand_title = page_data["title"]
        brand_title = brand_title.strip()

        if len(brand_title) == 0:
            return None
        if is_collection:
            return brand_title

        ep_title = ""
        for f in ["title", "fullTitle", "originalTitle", "secondaryTitle"]:
            if ep_title in ["", None] and select_ep.get(f, None) not in ["", None]:
                ep_title = select_ep[f]
            if ep_title not in ["", None]:
                break
        ep_title = ep_title.strip()

        if len(ep_title) == 0:
            return None

        video_title = ""
        if brand_title != ep_title:
            video_title = brand_title + " " + ep_title

        video_title = video_title.strip()
        if len(video_title) is None:
            video_title = None
        return video_title

    @staticmethod
    def process_video_profiles(profiles, source_url, is_live=False):
        profiles = list(filter(lambda p: p["name"].lower().split("-")[0].endswith("wv"), profiles))
        if len(profiles) == 0:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_url,
                reason=f"DRM not supported. Widevine wasn't found",
                solution="Do not attempt to download it"
            ))

        manifest_url = None
        manifest_token = None
        for profile in profiles:
            streams = profile.get("streams", [])
            streams = sorted(streams, key=lambda s: s.get("bitRate", 0), reverse=True)
            if len(streams) == 0:
                continue

            stream = streams[0]
            manifest_url, manifest_token = stream["uri"], stream["token"]
            if manifest_url is not None and manifest_token is not None:
                break

        assert manifest_url is not None
        additional = {}
        pssh = None

        if manifest_token not in ["", None]:
            try:
                message = channel4_com.decrypt_message(manifest_token)
            except:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_url,
                    reason="Can't access the video content because the AES key/iv was changed",
                    solution=f'Delete the {channel4_com.CACHE_FILE} cache manually or add the parameter --fresh to your command'
                ))

            if not is_live:
                message = message.split("|")
                additional["license_url"] = message[0]
                token = message[1]
                content_type = "ondemand"
            else:
                message = message.split("t=")
                additional["license_url"] = message[0].split("?")[0]
                token = message[1].split("&")[0]
                content_type = "simulcast"

            additional["json_data"] = {
                "video": {"type": content_type, "url": manifest_url},
                "token": token
            }

            manifest_content = requests.get(
                manifest_url, headers={'User-Agent': channel4_com.USER_AGENT}
            ).content.decode()
            try:
                pssh = get_pssh_from_default_kid(manifest_content)
            except:
                pssh = None

            if pssh is None:
                try:
                    pssh = get_pssh_from_cenc_pssh(manifest_content)
                except:
                    pssh = None

            if pssh is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_url,
                    reason=f"Manifest format not supported: {manifest_url}. Can't extract pssh",
                    solution=f"Extend the {channel4_com.__name__} service"
                ))

        if builtins.CONFIG.get("BASIC", False) is True:
            manifest_url = manifest_url.split("?")[0] + "?<PARAMETER_TIED_TO_TIME>"
        return manifest_url, pssh, additional

    @staticmethod
    def get_live_data(source_element):
        channel_id = re.search(r"/now/([^/?]+)", source_element.url).group(1)
        channel_id = channel_id.upper()
        response = requests.get(channel4_com.CHANNEL_URL.format(channel_id=channel_id))

        status = response.status_code
        response = json.loads(response.content.decode())
        message = response.get("error", {}).get("message", "").lower()

        if status == 403 or "failed to fetch" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need British IP to access content",
                solution="Use a VPN"
            ))

        if source_element.element is None:
            video_title = f"Livestream_{channel_id}"
            video_title += " " + response.get("slotInfo", {}).get("episodeTitle", "")
            source_element.element = get_valid_filename(video_title)

        profiles = response.get("channelInfo", {}).get("videoProfiles", [])
        return channel4_com.process_video_profiles(profiles, source_element.url, is_live=True)

    @staticmethod
    def get_video_data(source_element):
        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                channel4_com.__name__
            )
        if "/now/" in source_element.url and "/on-demand/" not in source_element.url:
            return channel4_com.get_live_data(source_element)

        stream_id = re.search(r"/on-demand/([^/?]+)", source_element.url).group(1)
        response = requests.get(channel4_com.STREAM_URL.format(stream_id=stream_id))

        status = response.status_code
        try:
            response = json.loads(response.content.decode())
        except:
            response = {}
        message = response.get("message", "").lower()

        if status in [404, 500]:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available or is paid",
                solution="Do not attempt to download it"
            ))
        if status == 403 or "playback blocked" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="Need British IP to access content",
                solution="Use a VPN"
            ))

        if source_element.element is None:
            video_title = response.get("brandTitle", None)

            if video_title in ["", None]:
                video_title = response.get("webSafeBrandTitle", None)
            if video_title in ["", None]:
                video_title = re.findall(r"/([^/?]+)/on-demand/", source_element.url)
                if len(video_title) == 0:
                    video_title = ""
                else:
                    video_title = video_title[0] + "_"
                video_title += stream_id

            episode_title = response.get("episodeTitle", None)
            if episode_title not in ["", None] and video_title != episode_title:
                video_title += "_" + str(episode_title)

            source_element.element = get_valid_filename(video_title)

        profiles = response.get("videoProfiles", [])
        manifest, pssh, additional = channel4_com.process_video_profiles(profiles, source_element.url)

        srt_assets = response.get("subtitlesAssets", [])
        if srt_assets is None:
            srt_assets = []

        srt_index = 0
        subtitles = []
        srt_path = join(source_element.collection, source_element.element)
        for srt_asset in srt_assets:
            if srt_asset.get("url", None) in ["", None]:
                continue

            srt_url = srt_asset["url"]
            srt_ext = get_ext_from_url(srt_url)
            if srt_ext not in [".srt", ".vtt"]:
                continue

            srt_index += 1
            subtitles.append((False, BaseElement(
                url=srt_url,
                collection=srt_path,
                element=f'subtitle_{srt_index}{srt_ext}'
            )))

        additional["SUBTITLES"] = subtitles
        return manifest, pssh, additional

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = collection_url.split("?")[0].split("#")[0].rstrip("/")
        if "/programmes/" not in collection_url:
            if "/now/" in collection_url:
                return [BaseElement(url=collection_url)]
            return None
        if "/on-demand/" in collection_url:
            return [BaseElement(url=collection_url)]

        programme_title = re.search(r"/programmes/([^/?]+)", collection_url).group(1)
        response = requests.get(collection_url)
        if response.status_code == 404:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=collection_url,
                reason="The content isn't available",
                solution="Do not attempt to download it"
            ))

        response = response.content.decode()
        js_dict = channel4_com.get_js_dict_from_page(response)

        collection_title = channel4_com.get_title_from_js_dict(js_dict, True)
        if collection_title is None:
            collection_title = programme_title
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                channel4_com.__name__
            ),
            get_valid_filename(collection_title)
        )

        contents = []
        try:
            episodes = js_dict.get("initialData", {}).get("brand", {}).get("episodes", [])
            assert type(episodes) is list and len(episodes) > 0
        except:
            episodes = []

        if len(episodes) == 0:
            asset_id = js_dict["initialData"]["selectedEpisode"]["assetId"]
            response = requests.get(
                channel4_com.ASSET_URL.format(
                    programme_title=programme_title,
                    asset_id=asset_id
                )
            )

            response = json.loads(response.content.decode())
            seasons = response.get("series", {})
            if seasons is None:
                seasons = {}

            for _, e in seasons.items():
                episodes.extend(e)

        for episode in episodes:
            season_index = None
            episode_index = None
            for f in ["title", "fullTitle", "originalTitle", "secondaryTitle", "episodeSecondaryTitle", "episodeTitle"]:
                try:
                    indexes = re.findall(r"series (\d+) episode (\d+)", episode[f].lower())[0]
                    season_index, episode_index = int(indexes[0]), int(indexes[1])
                    break
                except:
                    pass

            if season_index is None or episode_index is None:
                season_index = episode["seriesNumber"]
                episode_index = episode["episodeNumber"]

            found = False
            for c_s, c_e in contents:
                if c_s == season_index:
                    c_e.append((episode_index, episode))
                    found = True
                    break

            if not found:
                contents.append((season_index, [(episode_index, episode)]))

        collection = []
        contents = sorted(contents, key=lambda ct: ct[0])
        for season_index, episodes in contents:
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            episodes = sorted(episodes, key=lambda ep: ep[0])
            for episode_index, episode in episodes:
                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                episode_title = ""
                for f in ["originalTitle", "secondaryTitle", "episodeSecondaryTitle", "episodeTitle", "title",
                          "fullTitle"]:
                    if episode_title in ["", None] and episode.get(f, None) not in ["", None]:
                        episode_title = episode[f]
                    if episode_title not in ["", None]:
                        break

                if episode.get("programmeId", None) in ["", None]:
                    episode_url = channel4_com.BASE_URL + episode["hrefLink"]
                    programme_id = episode["hrefLink"].split("/")[-1]
                else:
                    programme_id = episode["programmeId"]
                    episode_url = channel4_com.VIDEO_URL.format(
                        program_title=programme_title,
                        program_id=programme_id
                    )

                if episode_title in ["", None]:
                    episode_title = programme_id
                collection.append(BaseElement(
                    url=episode_url,
                    collection=join(collection_title, f'Season_{season_index}'),
                    element=f'E{episode_index}_{get_valid_filename(episode_title)}'
                ))

        return collection
