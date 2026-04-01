import builtins
import json
import os
import re
from os.path import join

import requests

from utils.main_service import main_service
from utils.structs import BaseElement, BaseService
from utils.tools.args import check_range
from utils.tools.common import get_valid_filename


class netflix_com(BaseService):
    DEMO_URLS = [
        'https://www.netflix.com/tudum/articles/squid-game-the-challenge-winner',
        "https://www.netflix.com/tudum/articles/squid-game-the-challenge-where-are-they-now",
        "https://www.netflix.com/tudum/videos/squid-game-the-challenge-what-happens-on-set-between-games",
        "https://www.netflix.com/tudum/videos/squid-game-the-challenge-what-players-really-think-of-the-pink-guards",
        "https://www.netflix.com/tudum/articles/bridgerton-season-3-filming-cast-news",
        "https://www.netflix.com/tudum/wednesday-episode-8-finale-ending-explained",
        "https://www.netflix.com/tudum/articles/terminator-zero-first-six-minutes",
        "https://www.netflix.com/tudum/topics/what-to-watch",
    ]

    MANIFEST_URL = 'https://www.netflix.com/playapi/cadmium/manifest/1'
    PROFILES = [
        "heaac-2-dash", "heaac-2hq-dash", "vp9-profile0-L30-dash-cenc",
        "vp9-profile0-L31-dash-cenc", "av1-main-L30-dash-cbcs-prk", "av1-main-L31-dash-cbcs-prk",
        "vp9-profile0-L40-dash-cenc", "av1-main-L40-dash-cbcs-prk", "av1-main-L41-dash-cbcs-prk",
        "imsc1.1", "dfxp-ls-sdh", "simplesdh", "nflx-cmisc", "BIF240", "BIF320"
    ]

    @staticmethod
    def test_service():
        main_service.run_service(netflix_com)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        return netflix_com

    @staticmethod
    def get_keys(challenge, additional):
        raise Exception(
            f'{BaseService.get_keys.__name__} must not be called '
            f'for the {netflix_com.__name__} service'
        )

    @staticmethod
    def get_video_data(source_element):
        master_m3u8_output_path = join(source_element.collection, source_element.element)
        if not os.path.exists(master_m3u8_output_path):
            os.makedirs(master_m3u8_output_path)
        master_m3u8_output_path = str(master_m3u8_output_path)

        response = requests.post(
            netflix_com.MANIFEST_URL,
            params={'reqAttempt': '1', 'reqName': 'manifest'},
            cookies={"NetflixId": source_element.additional["netflix_id"]},
            data=json.dumps({
                "url": "manifest", "languages": ["en-US"],
                "params": {
                    "type": "standard", "manifestVersion": "v2",
                    "viewableId": source_element.additional["content_id"],
                    "profiles": netflix_com.PROFILES,
                    "isBranching": False, "useHttpsStreams": True
                }
            })
        ).json()["result"]
        master_m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"
        content_duration = response["duration"]

        all_tracks_index = 0
        for audio_track in response["audio_tracks"]:
            audio_codec = audio_track.get("codecName", None)
            if audio_codec is None:
                audio_codec = audio_track.get("profile", None)
                if audio_codec is not None:
                    audio_codec = audio_codec.split("-")[0]
            audio_profile = audio_track.get("profile", None)

            audio_streams = []
            for audio_stream in audio_track["streams"]:
                if audio_stream.get("isDrm", False) is True:
                    continue
                if len(audio_stream["urls"]) == 0:
                    continue

                audio_bitrate = audio_stream.get("bitrate", audio_stream.get("peakBitrate", 1))
                audio_streams.append((audio_bitrate, audio_stream))

            audio_streams = sorted(audio_streams, key=lambda a: a[0], reverse=True)
            for audio_bitrate, audio_stream in audio_streams:
                all_tracks_index += 1
                audio_m3u8_title = f"audio_{all_tracks_index}.m3u8"
                audio_m3u8_output_path = os.path.join(
                    master_m3u8_output_path,
                    audio_m3u8_title
                )

                audio_url = audio_stream["urls"][0]["url"]
                if audio_profile is None:
                    audio_profile = audio_stream["content_profile"]
                if audio_codec is None:
                    audio_codec = audio_profile.split("-")[0]
                master_m3u8_content += f'#EXT-X-MEDIA:TYPE=AUDIO,BANDWIDTH={audio_bitrate * 1000},NAME=\"{audio_bitrate} Kbps\",LANGUAGE=\"{audio_codec}\",CODECS=\"{audio_codec}\",GROUP-ID="Audio",URI="{audio_m3u8_title}\"\n'

                audio_m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"
                audio_m3u8_content += f"#EXTINF:{content_duration // 1000},\n{audio_url}\n"
                audio_m3u8_content += "#EXT-X-ENDLIST\n"
                with open(audio_m3u8_output_path, "w") as f:
                    f.write(audio_m3u8_content)

        for video_track in response["video_tracks"]:
            video_codec = video_track.get("flavor", None)
            video_profile = video_track.get("profile", None)

            for video_stream in video_track["streams"]:
                if video_stream.get("isDrm", False) is True:
                    continue
                if len(video_stream["urls"]) == 0:
                    continue
                all_tracks_index += 1
                video_m3u8_title = f"video_{all_tracks_index}.m3u8"
                video_m3u8_output_path = os.path.join(
                    master_m3u8_output_path,
                    video_m3u8_title
                )

                video_bitrate = video_stream.get("bitrate", video_stream.get("peakBitrate", 1))
                video_width = video_stream.get("res_w", video_stream["crop_w"])
                video_height = video_stream.get("res_h", video_stream["crop_h"])
                video_url = video_stream["urls"][0]["url"]

                if video_profile is None:
                    video_profile = video_stream["content_profile"]
                if video_codec is None:
                    video_codec = video_profile.split("-")[0]
                master_m3u8_content += f'#EXT-X-STREAM-INF:BANDWIDTH={video_bitrate * 1000},RESOLUTION={video_width}x{video_height},CODECS=\"{video_codec}\",TYPE=VIDEO,MIME-TYPE=\"{video_profile}\",AUDIO=\"Audio\"\n'
                master_m3u8_content += f"{video_m3u8_title}\n"

                video_m3u8_content = "#EXTM3U\n#EXT-X-VERSION:3\n\n"
                video_m3u8_content += f"#EXTINF:{content_duration // 1000},\n{video_url}\n"
                video_m3u8_content += "#EXT-X-ENDLIST\n"
                with open(video_m3u8_output_path, "w") as f:
                    f.write(video_m3u8_content)

        sub_index = 0
        subtitles = []
        for text_track in response["timedtexttracks"]:
            if len(text_track.get("ttDownloadables", {}).keys()) == 0:
                continue

            for _, downloadable in text_track["ttDownloadables"].items():
                sub_index += 1
                subtitle_url = list(downloadable["downloadUrls"].items())[0][1]
                subtitles.append((False, BaseElement(
                    url=subtitle_url,
                    collection=master_m3u8_output_path,
                    element=f'subtitle_{sub_index}.xml'
                )))

        master_m3u8_output_path = os.path.join(
            master_m3u8_output_path,
            "master.m3u8"
        )
        with open(master_m3u8_output_path, "w") as f:
            f.write(master_m3u8_content)
        return master_m3u8_output_path, None, {"SUBTITLES": subtitles}

    @staticmethod
    def get_collection_elements(collection_url):
        if "/tudum/" not in collection_url:
            return None

        collection_url = collection_url.split("?")[0].split("#")[0].rstrip("/")
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                netflix_com.__name__
            ),
            get_valid_filename(collection_url.split("/")[-1])
        )

        response = requests.get(collection_url)
        headers = response.headers['Set-cookie'].split(";")
        netflix_id = None
        for header in headers:
            if " NetflixId=" in header:
                netflix_id = header.split("NetflixId=")[1].split(" ")[0]
                break
        assert netflix_id is not None

        response = response.text
        content_ids = re.findall(r'id="VideoControls-(\d+)"', response)
        content_index = 0
        collection = []

        for content_id in content_ids:
            content_index += 1
            check = check_range(False, None, content_index)
            if check is True:
                continue
            elif check is False:
                return collection

            collection.append(BaseElement(
                url=f'{collection_url}/{content_id}',
                collection=collection_title,
                element=f'Media_{content_index}_{content_id}',
                additional={"netflix_id": netflix_id, "content_id": content_id}
            ))
        return collection
