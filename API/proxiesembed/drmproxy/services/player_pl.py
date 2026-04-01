import builtins
import json
import re
from os.path import join

import requests

from utils.constants.macros import ERR_MSG, USER_ERROR, APP_ERROR
from utils.main_service import main_service
from utils.structs import BaseService, CustomException, BaseElement
from utils.tools.args import check_range
from utils.tools.cdm import get_pssh_from_cenc_pssh, get_pssh_from_default_kid, get_pssh_from_playready
from utils.tools.common import get_valid_filename, clean_url


class player_pl(BaseService):
    DEMO_URLS = [
        "https://player.pl/filmy-online/1800-gramow,169874",
        "https://player.pl/filmy-online/podatek-od-milosci,106758",
        "https://player.pl/seriale-online/szkola-odcinki,2395/odcinek-2,S01E02,32279",
        "https://player.pl/seriale-online/na-wspolnej-odcinki,144/odcinek-2590,S01E2590,86158",
        "https://player.pl/programy-online/masterchef-odcinki,996/odcinek-12,S08E12,151746",
        "https://player.pl/programy-online/power-couple-odcinki,29479/odcinek-3,S01E03,198875",
        "https://player.pl/strefa-sport/motocyklicznie-odcinki,120/odcinek-4,S03E04,2063",
        "https://player.pl/strefa-sport/krolowie-driftu-odcinki,118/odcinek-3,S01E03,2013",
        "https://player.pl/seriale-online/prawo-agaty-odcinki,562",
        "https://player.pl/seriale-online/pulapka-odcinki,13643",
        "https://player.pl/programy-online/warsaw-shore-ekipa-z-warszawy-odcinki,4365",
        "https://player.pl/programy-online/projekt-lady-odcinki,4554",
        "https://player.pl/seriale-online/19--odcinki,4814",
        "https://player.pl/seriale-online/lab-odcinki,29386",
        "https://player.pl/programy-online/one-night-squad-odcinki,31426",
        "https://player.pl/programy-online/anatomia-piekna-odcinki,44796",
        "https://player.pl/strefa-sport/rajd-hiszpanii-odcinki,1334",
        "https://player.pl/strefa-sport/rajd-dakar-2016-odcinki,4256",
    ]

    PLAYLIST_URL = 'https://player.pl/playerapi/item/{item_id}/playlist'
    TRANSLATE_URL = 'https://player.pl/playerapi/item/translate'
    SERIAL_URL = 'https://player.pl/playerapi/product/vod/serial/{show_id}'
    SEASONS_URL = 'https://player.pl/playerapi/product/vod/serial/{show_id}/season/list'
    EPISODES_URL = 'https://player.pl/playerapi/product/vod/serial/{show_id}/season/{season_id}/episode/list'

    PLATFORM = "BROWSER"

    @staticmethod
    def test_service():
        main_service.run_service(player_pl)

    @staticmethod
    def credentials_needed():
        return {"NONE_NEEDED": True}

    @staticmethod
    def initialize_service():
        return player_pl

    @staticmethod
    def get_keys(challenge, additional):
        licence = requests.post(
            additional["license_url"],
            data=challenge
        )

        if licence.status_code == 403:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=additional["URL"],
                reason="Can't download paid content",
                solution='Do not attempt to download it'
            ))

        licence.raise_for_status()
        return licence.content

    @staticmethod
    def get_video_data(source_element):
        item_type = "MOVIE"
        item_key = "articleId"
        item_id = source_element.url.split(",")[-1]
        response = requests.get(
            player_pl.TRANSLATE_URL,
            params={item_key: item_id, 'platform': player_pl.PLATFORM}
        )

        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        message = response.get("code", "").lower()

        if status_code == 404 and "not_exists" in message:
            raise CustomException(ERR_MSG.format(
                type=f'{USER_ERROR}',
                url=source_element.url,
                reason="The content isn't available",
                solution="Don't attempt to download it"
            ))

        item_id = response["id"]
        response = requests.get(
            player_pl.PLAYLIST_URL.format(item_id=item_id),
            params={'type': item_type, 'platform': player_pl.PLATFORM}
        )

        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        message = response.get("code", "").lower()

        if status_code == 403 and "not_paid" in message:
            raise CustomException(ERR_MSG.format(
                type=USER_ERROR,
                url=source_element.url,
                reason="Can't download paid content",
                solution='Do not attempt to download it'
            ))

        if source_element.element is None:
            content_info = response["movie"].get("info", {})
            content_stats = response["movie"].get("stats", {})
            nl_data = content_stats.get("nl_data", {})

            title = content_info.get("series_title", None)
            if title not in ["", None]:
                for f in ["episode_title", "season_number", "episode_number"]:
                    try:
                        v = content_info[f]
                        assert v is not None
                        v = str(v)
                        assert len(v) > 0
                        assert v != content_info["series_title"]
                        title += " " + v
                    except:
                        pass

            else:
                title = nl_data.get("title", None)

                if title not in ["", None]:
                    for f in ["program"]:
                        try:
                            v = nl_data[f]
                            assert v is not None
                            v = str(v)
                            assert len(v) > 0
                            assert v != nl_data["title"]
                            title += " " + v
                        except:
                            pass

            if title in ["", None]:
                title = source_element.url.split("/")[-1]
            source_element.element = get_valid_filename(title)

        if source_element.collection is None:
            source_element.collection = join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                player_pl.__name__
            )

        manifest = None
        license_url = None
        pssh_value = None
        response = response["movie"]["video"]

        is_drm = len(response.get("protections", {}).keys()) > 0
        if is_drm:
            license_url = response["protections"].get("widevine", {}).get("src", None)
            if license_url is None:
                raise CustomException(ERR_MSG.format(
                    type=USER_ERROR,
                    url=source_element.url,
                    reason=f"DRM not supported. Widevine wasn't found",
                    solution="Do not attempt to download it"
                ))

            manifest = response["sources"]["dash"]["url"]
            manifest_content = requests.get(manifest).content.decode()
            try:
                pssh_value = get_pssh_from_default_kid(manifest_content, xml_node="default_KID")
            except:
                pass

            if pssh_value is None:
                try:
                    pssh_value = get_pssh_from_cenc_pssh(manifest_content)
                except:
                    pass

            if pssh_value is None:
                try:
                    pssh_value = get_pssh_from_playready(manifest_content)
                except:
                    pass

            if pssh_value is None:
                manifest = response["sources"]["smooth"]["url"]
                manifest_content = requests.get(manifest).content.decode()
                try:
                    pssh_value = get_pssh_from_playready(manifest_content)
                except:
                    pass

            if pssh_value is None:
                raise CustomException(ERR_MSG.format(
                    type=APP_ERROR,
                    url=source_element.url,
                    reason=f"Manifest format not supported: {str(manifest)}",
                    solution=f"Extend the {player_pl.__name__} service"
                ))
        else:
            for k, v in response["sources"].items():
                try:
                    manifest = v["url"]
                    break
                except:
                    pass

        return manifest, pssh_value, {
            "license_url": license_url,
            "URL": source_element.url
        }

    @staticmethod
    def get_collection_elements(collection_url):
        collection_url = clean_url(collection_url)
        if "/live/" in collection_url:
            return None
        if "/filmy-online" in collection_url:
            return [BaseElement(url=collection_url)]

        match = re.findall(r',S\d+E\d+,\d+$', collection_url.split("/")[-1])
        if len(match) > 0:
            return [BaseElement(url=collection_url)]

        content_id = collection_url.split(",")[-1]
        response = requests.get(
            player_pl.TRANSLATE_URL,
            params={'programId': content_id, 'platform': player_pl.PLATFORM}
        )

        status_code = response.status_code
        response = response.content.decode()
        response = json.loads(response)
        message = response.get("code", "").lower()

        if status_code == 404 and "not_exists" in message:
            return [BaseElement(url=collection_url)]

        content_id = response["id"]
        response = requests.get(
            player_pl.SERIAL_URL.format(show_id=content_id),
            params={'platform': player_pl.PLATFORM}
        )
        response = response.content.decode()
        response = json.loads(response)

        collection_title = response.get("title", collection_url.split("/")[-1])
        collection_title = join(
            join(
                str(builtins.CONFIG["DOWNLOAD_COMMANDS"]["OUTPUT_MEDIA_PATH"]),
                player_pl.__name__
            ),
            get_valid_filename(collection_title)
        )

        response = requests.get(
            player_pl.SEASONS_URL.format(show_id=content_id),
            params={'platform': player_pl.PLATFORM}
        )
        response = response.content.decode()
        response = json.loads(response)
        seasons = sorted(response, key=lambda s: s["number"])

        collection = []
        for season in seasons:
            season_index = season["number"]
            check = check_range(True, season_index, None)
            if check is True:
                continue
            elif check is False:
                return collection

            season_id = season["id"]
            response = requests.get(
                player_pl.EPISODES_URL.format(show_id=content_id, season_id=season_id),
                params={'platform': player_pl.PLATFORM}
            )
            response = response.content.decode()
            response = json.loads(response)
            episodes = sorted(response, key=lambda e: e["episode"])

            for episode in episodes:
                episode_index = episode["episode"]
                check = check_range(False, season_index, episode_index)
                if check is True:
                    continue
                elif check is False:
                    return collection

                episode_url = episode["shareUrl"]
                episode_title = episode.get("title", None)
                if episode_title in ["", None]:
                    episode_title = episode_url.split("/")[-1]
                episode_title = f'Episode_{episode_index}_{episode_title}'

                collection.append(BaseElement(
                    url=episode_url,
                    collection=join(collection_title, f'Season_{season_index}'),
                    element=get_valid_filename(episode_title)
                ))

        return collection
